import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';

const { Pool } = pg;

export const DEFAULT_SAFETY = {
  profanityFilter: true,
  allowLinks: false,
  slowModeSeconds: 2,
};

export function emptyDb() {
  return {
    version: 2,
    users: [],
    clubs: [],
    channels: [],
    messages: [],
    reports: [],
  };
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Bring both first-run and v1 prototype databases up to the current shape.
 * v1 kept club settings globally and had no clubId on users/messages.
 */
export function migrateDb(input) {
  const db = { ...emptyDb(), ...(input || {}) };
  db.users = array(db.users);
  db.clubs = array(db.clubs);
  db.channels = array(db.channels);
  db.messages = array(db.messages);
  db.reports = array(db.reports);

  const legacy = db.settings && typeof db.settings === 'object' ? db.settings : null;
  const firstClub = db.clubs[0];

  if (legacy && firstClub) {
    firstClub.inviteCode = firstClub.inviteCode || legacy.inviteCode || '';
    firstClub.parentalPinHash = firstClub.parentalPinHash || legacy.parentalPinHash || '';
    firstClub.safety = { ...DEFAULT_SAFETY, ...(firstClub.safety || {}), ...(legacy.safety || {}) };
    firstClub.createdAt = firstClub.createdAt || new Date().toISOString();
  }

  if (firstClub) {
    for (const user of db.users) user.clubId = user.clubId || firstClub.id;
    for (const channel of db.channels) channel.clubId = channel.clubId || firstClub.id;
    for (const message of db.messages) {
      if (!message.clubId) {
        const channel = db.channels.find((item) => item.id === message.channelId);
        message.clubId = channel?.clubId || firstClub.id;
      }
    }
    for (const report of db.reports) {
      if (!report.clubId) {
        const message = db.messages.find((item) => item.id === report.messageId);
        report.clubId = message?.clubId || firstClub.id;
      }
    }
  }

  for (const club of db.clubs) {
    club.safety = { ...DEFAULT_SAFETY, ...(club.safety || {}) };
    club.inviteCode = String(club.inviteCode || '').toUpperCase();
    club.parentalPinHash = club.parentalPinHash || '';
  }

  delete db.settings;
  db.version = 2;
  return db;
}

function writeJsonAtomically(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function createJsonStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'db.json');
  let queue = Promise.resolve();

  return {
    mode: 'json',
    async load() {
      try {
        return migrateDb(JSON.parse(fs.readFileSync(dbPath, 'utf8')));
      } catch {
        return migrateDb(emptyDb());
      }
    },
    save(db) {
      const snapshot = JSON.parse(JSON.stringify(db));
      queue = queue.catch(() => {}).then(() => writeJsonAtomically(dbPath, snapshot));
      return queue;
    },
    async flush() {
      await queue.catch(() => {});
    },
    async close() {
      await queue.catch(() => {});
    },
    async health() {
      return { ok: true };
    },
    // Local development uses express-session's in-memory store.
    sessionStore: undefined,
  };
}

async function createPostgresStorage(connectionString) {
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS diskids_state (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const loaded = await pool.query('SELECT data FROM diskids_state WHERE id = $1', ['main']);
  let initial;
  if (loaded.rows[0]) {
    initial = migrateDb(loaded.rows[0].data);
  } else {
    initial = migrateDb(emptyDb());
    await pool.query('INSERT INTO diskids_state (id, data) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [
      'main',
      JSON.stringify(initial),
    ]);
  }

  const PgSession = connectPgSimple(session);
  const sessionStore = new PgSession({
    pool,
    tableName: 'diskids_sessions',
    createTableIfMissing: true,
    pruneSessionInterval: 60 * 15,
  });

  let queue = Promise.resolve();

  return {
    mode: 'postgres',
    initial,
    async load() {
      return initial;
    },
    save(db) {
      const snapshot = JSON.stringify(db);
      queue = queue
        .catch(() => {})
        .then(() =>
          pool.query(
            `INSERT INTO diskids_state (id, data, updated_at)
             VALUES ($1, $2::jsonb, now())
             ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
            ['main', snapshot],
          ),
        );
      return queue;
    },
    async flush() {
      await queue.catch(() => {});
    },
    async close() {
      await queue.catch(() => {});
      await pool.end();
    },
    async health() {
      await pool.query('SELECT 1');
      return { ok: true };
    },
    sessionStore,
  };
}

export async function createStorage({ dataDir, databaseUrl }) {
  if (databaseUrl) return createPostgresStorage(databaseUrl);
  return createJsonStorage(dataDir);
}
