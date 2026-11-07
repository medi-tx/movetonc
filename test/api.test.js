import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diskids-test-'));
const SESSION_SECRET = 'test-secret-that-is-long-enough-for-the-suite';

let server = null;
let baseUrl = '';
let port = 0;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
}

async function startServer() {
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DATA_DIR,
      SESSION_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Keep waiting for the listener.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Server did not become healthy in time.');
}

async function stopServer() {
  if (!server) return;
  const child = server;
  server = null;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class Jar {
  constructor() {
    this.cookies = new Map();
  }

  store(response) {
    const values = response.headers.getSetCookie?.() || [];
    for (const header of values) {
      const [pair, ...attributes] = header.split(';');
      const index = pair.indexOf('=');
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /expires=thu, 01 jan 1970/i.test(attribute.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(urlPath, options = {}) {
    const headers = { ...(options.headers || {}) };
    const cookie = this.header();
    if (cookie) headers.cookie = cookie;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}${urlPath}`, {
      ...options,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    this.store(response);
    return response;
  }

  async json(urlPath, options = {}) {
    const response = await this.request(urlPath, options);
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }
}

const grownup = new Jar();
const kidOne = new Jar();
const kidTwo = new Jar();
const otherClub = new Jar();
let clubAInvite = '';
let clubBInvite = '';
let clubAChannel = null;
let messageId = null;
let crossClubMessageId = null;

before(async () => {
  await startServer();
});

after(async () => {
  await stopServer();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test('fresh deployment reports no clubs and serves the app shell', async () => {
  const state = await grownup.json('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.data.hasClubs, false);

  const page = await fetch(`${baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<div id="root"><\/div>/);
});

test('grown-up can create a club and receives an invite code', async () => {
  const result = await grownup.json('/api/setup', {
    method: 'POST',
    body: {
      clubName: 'Room 12 Explorers',
      displayName: 'Ms. Rivera',
      username: 'ms_rivera',
      password: 'prototype123',
      pin: '2468',
      avatar: '🦊',
    },
  });
  assert.equal(result.status, 201);
  assert.match(result.data.inviteCode, /^[A-Z2-9]{6}$/);
  clubAInvite = result.data.inviteCode;

  const state = await grownup.json('/api/state');
  assert.equal(state.data.user.role, 'grownup');
  assert.equal(state.data.clubName, 'Room 12 Explorers');
  assert.equal(state.data.channels.length, 4);
  assert.equal(state.data.inviteCode, null, 'invite code stays hidden until the PIN is unlocked');
});

test('a kid joins with the invite code and can chat', async () => {
  const joined = await kidOne.json('/api/register', {
    method: 'POST',
    body: {
      inviteCode: clubAInvite,
      displayName: 'Milo',
      username: 'milo_b',
      password: 'password123',
      avatar: '🐼',
    },
  });
  assert.equal(joined.status, 201);

  const state = await kidOne.json('/api/state');
  assert.equal(state.data.user.role, 'kid');
  clubAChannel = state.data.channels[1];

  const sent = await kidOne.json(`/api/channels/${clubAChannel.id}/messages`, {
    method: 'POST',
    body: { body: 'Hello class! 👋' },
  });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.body, 'Hello class! 👋');
  messageId = sent.data.id;
});

test('the parental PIN gates reports, invites, and safety settings', async () => {
  const wrong = await grownup.json('/api/unlock', {
    method: 'POST',
    body: { pin: '0000' },
  });
  assert.equal(wrong.status, 401);

  const locked = await grownup.json('/api/reports');
  assert.equal(locked.status, 403);
  assert.equal(locked.data.code, 'PIN_REQUIRED');

  const unlocked = await grownup.json('/api/unlock', {
    method: 'POST',
    body: { pin: '2468' },
  });
  assert.equal(unlocked.status, 200);

  const state = await grownup.json('/api/state');
  assert.equal(state.data.unlocked, true);
  assert.equal(state.data.inviteCode, clubAInvite);

  const saved = await grownup.json('/api/settings', {
    method: 'PATCH',
    body: { safety: { profanityFilter: true, allowLinks: false, slowModeSeconds: 0 } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.safety.slowModeSeconds, 0);
});

test('kindness filter rewrites banned words and link blocking rejects URLs', async () => {
  const filtered = await kidOne.json(`/api/channels/${clubAChannel.id}/messages`, {
    method: 'POST',
    body: { body: 'That was a stupid idea' },
  });
  assert.equal(filtered.status, 201);
  assert.equal(filtered.data.filtered, true);
  assert.doesNotMatch(filtered.data.body, /stupid/i);
  crossClubMessageId = filtered.data.id;

  const link = await kidOne.json(`/api/channels/${clubAChannel.id}/messages`, {
    method: 'POST',
    body: { body: 'Visit https://example.com please' },
  });
  assert.equal(link.status, 400);
  assert.match(link.data.error, /Links and email addresses/);
});

test('kids can report a message and grown-ups can resolve it by removing it', async () => {
  const joined = await kidTwo.json('/api/register', {
    method: 'POST',
    body: {
      inviteCode: clubAInvite,
      displayName: 'Ada',
      username: 'ada_l',
      password: 'password123',
      avatar: '🦄',
    },
  });
  assert.equal(joined.status, 201);

  const kidReports = await kidTwo.json('/api/reports');
  assert.equal(kidReports.status, 403);

  const report = await kidTwo.json(`/api/messages/${messageId}/report`, {
    method: 'POST',
    body: { reason: 'Mean words' },
  });
  assert.equal(report.status, 201);

  const duplicate = await kidTwo.json(`/api/messages/${messageId}/report`, {
    method: 'POST',
    body: { reason: 'Mean words' },
  });
  assert.equal(duplicate.status, 409);

  const reports = await grownup.json('/api/reports');
  assert.equal(reports.status, 200);
  assert.equal(reports.data.reports.length, 1);
  assert.equal(reports.data.reports[0].reporter.displayName, 'Ada');

  const removed = await grownup.json(`/api/messages/${messageId}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);

  const afterRemoval = await grownup.json('/api/reports');
  assert.equal(afterRemoval.data.reports.length, 0);
});

test('clubs are isolated from each other', async () => {
  const result = await otherClub.json('/api/setup', {
    method: 'POST',
    body: {
      clubName: 'Science Squad',
      displayName: 'Mr. Chen',
      username: 'mr_chen',
      password: 'prototype123',
      pin: '1357',
      avatar: '🦉',
    },
  });
  assert.equal(result.status, 201);
  assert.match(result.data.inviteCode, /^[A-Z2-9]{6}$/);
  clubBInvite = result.data.inviteCode;

  const otherState = await otherClub.json('/api/state');
  const otherChannel = otherState.data.channels[1];

  const peek = await kidOne.json(`/api/channels/${otherChannel.id}/messages`);
  assert.equal(peek.status, 404, 'a kid cannot read another club channel');

  const joined = await kidOne.json('/api/register', {
    method: 'POST',
    body: {
      inviteCode: clubBInvite,
      displayName: 'Milo Again',
      username: 'milo_b',
      password: 'password123',
      avatar: '🐼',
    },
  });
  assert.equal(joined.status, 409, 'usernames are unique across the deployment');

  const otherGrownup = await otherClub.json('/api/unlock', {
    method: 'POST',
    body: { pin: '1357' },
  });
  assert.equal(otherGrownup.status, 200);

  const crossDelete = await otherClub.json(`/api/messages/${crossClubMessageId}`, { method: 'DELETE' });
  assert.equal(crossDelete.status, 404, 'a grown-up cannot remove another club message');

  const crossSettings = await otherClub.json('/api/settings', {
    method: 'PATCH',
    body: { safety: { allowLinks: true } },
  });
  assert.equal(crossSettings.status, 200);

  const clubAKidState = await kidOne.json('/api/state');
  assert.equal(clubAKidState.data.clubName, 'Room 12 Explorers');
  assert.equal(clubAKidState.data.safety.allowLinks, false, 'safety settings do not leak between clubs');
});

test('data survives a server restart', async () => {
  const kidState = await kidOne.json('/api/state');
  const channel = kidState.data.channels[1];
  const saved = await kidOne.json(`/api/channels/${channel.id}/messages`, {
    method: 'POST',
    body: { body: 'This message should survive a restart.' },
  });
  assert.equal(saved.status, 201);
  const savedId = saved.data.id;

  await stopServer();
  await startServer();

  const login = await grownup.json('/api/login', {
    method: 'POST',
    body: { username: 'ms_rivera', password: 'prototype123' },
  });
  assert.equal(login.status, 200);

  const messages = await grownup.json(`/api/channels/${clubAChannel.id}/messages`);
  assert.equal(messages.status, 200);
  assert.ok(messages.data.messages.some((message) => message.id === savedId));
});
