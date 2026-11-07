import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { AVATARS, timeFor } from '../lib/format.js';
import { Avatar } from './Avatar.jsx';
import { Modal } from './Modal.jsx';
import { useToast } from './Toast.jsx';

/* ------------------------------------------------------------------ */
/* Parental PIN                                                        */
/* ------------------------------------------------------------------ */

export function UnlockDialog({ onClose, onUnlocked }) {
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.unlock(pin);
      toast.push('Grown-up tools unlocked. 🛡️', 'success');
      onUnlocked();
    } catch (unlockError) {
      setError(unlockError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Grown-up tools"
      subtitle="Enter the Parental PIN you chose during setup."
      icon="🛡️"
      onClose={onClose}
    >
      <form onSubmit={submit} className="form">
        {error ? <div className="form-error">{error}</div> : null}
        <label className="field">
          <span>Parental PIN</span>
          <input
            className="pin-input"
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder="••••"
            autoFocus
            autoComplete="off"
            required
          />
        </label>
        <button type="submit" className="button button-primary button-wide" disabled={busy || pin.length < 4}>
          {busy ? 'Checking…' : 'Unlock safety tools'}
        </button>
        <p className="fine-print">
          Kids never see this PIN. It protects reports and safety settings even if a child is logged in as a grown-up.
        </p>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Grown-up dashboard                                                  */
/* ------------------------------------------------------------------ */

const TABS = [
  { id: 'reports', label: 'Reports', icon: '🚩' },
  { id: 'safety', label: 'Safety', icon: '🛡️' },
  { id: 'invite', label: 'Invite', icon: '🎟️' },
  { id: 'members', label: 'Members', icon: '👥' },
];

export function GrownupDashboard({ state, onClose, onState, reportsTick, onReportsChanged }) {
  const toast = useToast();
  const [tab, setTab] = useState('reports');
  const [reports, setReports] = useState(null);
  const [reportsError, setReportsError] = useState('');
  const [savingSafety, setSavingSafety] = useState(false);
  const [localTick, setLocalTick] = useState(0);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    if (tab !== 'reports') return undefined;
    let cancelled = false;
    setReportsError('');
    api
      .reports()
      .then((data) => {
        if (!cancelled) setReports(data.reports);
      })
      .catch((error) => {
        if (!cancelled) setReportsError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, reportsTick, localTick]);

  const online = useMemo(() => new Set(state.online || []), [state.online]);

  async function changeSafety(patch) {
    setSavingSafety(true);
    try {
      const data = await api.updateSafety(patch);
      onState((current) => ({ ...current, safety: data.safety }));
      toast.push('Safety settings saved.', 'success');
    } catch (error) {
      toast.push(error.message, 'error');
    } finally {
      setSavingSafety(false);
    }
  }

  async function removeMessage(report) {
    try {
      await api.deleteMessage(report.message.id);
      setReports((current) => (current || []).filter((item) => item.id !== report.id));
      toast.push('Message removed and report closed.', 'success');
      onReportsChanged?.();
    } catch (error) {
      toast.push(error.message, 'error');
    }
  }

  async function resolveReport(report) {
    try {
      await api.resolveReport(report.id);
      setReports((current) => (current || []).filter((item) => item.id !== report.id));
      toast.push('Report marked as handled.', 'success');
      onReportsChanged?.();
    } catch (error) {
      toast.push(error.message, 'error');
    }
  }

  async function copy(value, kind) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(''), 2000);
      toast.push('Copied!', 'success');
    } catch {
      toast.push('Could not copy. Select the text instead.', 'error');
    }
  }

  const inviteLink = state.inviteCode
    ? `${window.location.origin}${window.location.pathname}?invite=${state.inviteCode}`
    : '';

  return (
    <Modal
      title="Grown-up dashboard"
      subtitle={`${state.clubName} · safety and moderation`}
      icon="🛡️"
      wide
      onClose={onClose}
    >
      <div className="dash-tabs" role="tablist" aria-label="Grown-up tools">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={tab === entry.id ? 'is-active' : ''}
            onClick={() => setTab(entry.id)}
          >
            <span aria-hidden="true">{entry.icon}</span> {entry.label}
            {entry.id === 'reports' && reports?.length ? <span className="tab-count">{reports.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'reports' ? (
        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <h3>Open reports</h3>
              <p>Kids can flag messages that feel mean, scary, or spammy.</p>
            </div>
            <button type="button" className="button button-ghost" onClick={() => setLocalTick((value) => value + 1)}>
              Refresh
            </button>
          </div>

          {reportsError ? <div className="form-error">{reportsError}</div> : null}
          {reports === null && !reportsError ? <p className="muted">Checking reports…</p> : null}
          {reports && reports.length === 0 ? (
            <div className="empty-panel">
              <span aria-hidden="true">🌤️</span>
              <strong>No open reports</strong>
              <p>All quiet in the clubhouse. Reports will show up here.</p>
            </div>
          ) : null}

          <div className="report-list">
            {(reports || []).map((report) => (
              <article key={report.id} className="report-card">
                <header>
                  <span className="report-reason">{report.reason}</span>
                  <span className="report-time">{timeFor(report.createdAt)}</span>
                </header>
                <div className="report-message">
                  <Avatar user={report.message.user} size="sm" />
                  <div>
                    <strong>{report.message.user?.displayName || 'Someone'}</strong>
                    <span className="report-channel">#{report.message.channelName}</span>
                    <p>{report.message.body || 'Message removed'}</p>
                  </div>
                </div>
                <footer>
                  <span className="report-by">Reported by {report.reporter?.displayName || 'a member'}</span>
                  <div className="report-actions">
                    <button type="button" className="button button-ghost" onClick={() => resolveReport(report)}>
                      Mark handled
                    </button>
                    <button type="button" className="button button-danger" onClick={() => removeMessage(report)}>
                      Remove message
                    </button>
                  </div>
                </footer>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {tab === 'safety' ? (
        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <h3>Club safety</h3>
              <p>These settings apply to every kid in this club.</p>
            </div>
          </div>

          <div className="setting-row">
            <div>
              <strong>Kindness filter</strong>
              <p>Hides unkind words and replaces them with dots.</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.safety.profanityFilter}
                disabled={savingSafety}
                onChange={(event) => changeSafety({ ...state.safety, profanityFilter: event.target.checked })}
              />
              <span aria-hidden="true" />
            </label>
          </div>

          <div className="setting-row">
            <div>
              <strong>Let kids share links</strong>
              <p>When off, kids cannot post links or email addresses. Grown-ups always can.</p>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={state.safety.allowLinks}
                disabled={savingSafety}
                onChange={(event) => changeSafety({ ...state.safety, allowLinks: event.target.checked })}
              />
              <span aria-hidden="true" />
            </label>
          </div>

          <div className="setting-row">
            <div>
              <strong>Slow mode</strong>
              <p>A short pause between messages gives everyone room to breathe.</p>
            </div>
            <select
              className="select"
              value={state.safety.slowModeSeconds}
              disabled={savingSafety}
              onChange={(event) => changeSafety({ ...state.safety, slowModeSeconds: Number(event.target.value) })}
            >
              <option value={0}>Off</option>
              <option value={2}>2 seconds</option>
              <option value={5}>5 seconds</option>
              <option value={10}>10 seconds</option>
              <option value={30}>30 seconds</option>
            </select>
          </div>

          <div className="safety-note">
            <span aria-hidden="true">💡</span>
            <p>
              Tip: if something feels urgent, remove the message and check in with the kid in person. DisKids
              supports grown-up supervision; it does not replace it.
            </p>
          </div>
        </section>
      ) : null}

      {tab === 'invite' ? (
        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <h3>Invite kids</h3>
              <p>Share this code only with the kids in your club.</p>
            </div>
          </div>
          <div className="invite-box">
            <span className="invite-code">{state.inviteCode || 'Unlock again'}</span>
            <button
              type="button"
              className="button button-soft"
              disabled={!state.inviteCode}
              onClick={() => copy(state.inviteCode, 'code')}
            >
              {copied === 'code' ? 'Copied ✓' : 'Copy code'}
            </button>
          </div>
          {inviteLink ? (
            <div className="invite-link-row">
              <input readOnly value={inviteLink} onFocus={(event) => event.target.select()} />
              <button type="button" className="button button-soft" onClick={() => copy(inviteLink, 'link')}>
                {copied === 'link' ? 'Copied ✓' : 'Copy link'}
              </button>
            </div>
          ) : null}
          <p className="fine-print">
            The code is checked when a kid joins. You can always come back here to copy it again.
          </p>
        </section>
      ) : null}

      {tab === 'members' ? (
        <section className="dash-panel">
          <div className="dash-panel-head">
            <div>
              <h3>Club members</h3>
              <p>{state.members.length} people in {state.clubName}.</p>
            </div>
          </div>
          <ul className="member-list">
            {state.members.map((member) => (
              <li key={member.id}>
                <Avatar user={member} online={online.has(member.id)} showStatus />
                <div className="member-info">
                  <strong>{member.displayName}</strong>
                  <span>@{member.username}</span>
                </div>
                <span className={`role-pill role-${member.role}`}>
                  {member.role === 'grownup' ? 'Grown-up' : 'Kid'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Channel                                                             */
/* ------------------------------------------------------------------ */

export function CreateChannelDialog({ club, onClose, onCreated }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', topic: '', kind: 'text' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const data = await api.createChannel({
        clubId: club.id,
        name: form.name,
        topic: form.topic,
        kind: form.kind,
      });
      toast.push(`#${data.channel.name} is open!`, 'success');
      onCreated(data.channel);
    } catch (createError) {
      setError(createError.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a channel"
      subtitle={`New space inside ${club.name}`}
      icon="💬"
      onClose={onClose}
    >
      <form onSubmit={submit} className="form">
        {error ? <div className="form-error">{error}</div> : null}
        <label className="field">
          <span>Channel name</span>
          <input
            type="text"
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="e.g. book-club"
            maxLength={24}
            required
            autoFocus
            aria-label="Channel name"
          />
          <small>We will turn spaces into dashes.</small>
        </label>
        <label className="field">
          <span>Topic</span>
          <input
            type="text"
            value={form.topic}
            onChange={(event) => setForm((current) => ({ ...current, topic: event.target.value }))}
            placeholder="What happens in this channel?"
            maxLength={80}
            aria-label="Channel topic"
          />
        </label>
        <label className="field">
          <span>Channel type</span>
          <select
            className="select"
            value={form.kind}
            onChange={(event) => setForm((current) => ({ ...current, kind: event.target.value }))}
          >
            <option value="text">Text chat — everyone can post</option>
            <option value="announcement">Announcements — grown-ups post, kids read</option>
          </select>
        </label>
        <button type="submit" className="button button-primary button-wide" disabled={busy}>
          {busy ? 'Opening…' : 'Create channel'}
        </button>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Report a message                                                    */
/* ------------------------------------------------------------------ */

const REPORT_REASONS = [
  { label: 'Mean words', icon: '💔' },
  { label: 'Spam', icon: '🌀' },
  { label: 'Scary or unsafe', icon: '🚨' },
  { label: 'Something else', icon: '💭' },
];

export function ReportDialog({ message, onClose }) {
  const toast = useToast();
  const [busyReason, setBusyReason] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function report(reason) {
    setBusyReason(reason);
    setError('');
    try {
      await api.reportMessage(message.id, reason);
      setDone(true);
      toast.push('Thanks for telling a grown-up. 💛', 'success');
    } catch (reportError) {
      setError(reportError.message);
    } finally {
      setBusyReason('');
    }
  }

  if (done) {
    return (
      <Modal title="A grown-up will check" icon="💛" onClose={onClose}>
        <div className="empty-panel">
          <span aria-hidden="true">🌻</span>
          <strong>Thank you for speaking up.</strong>
          <p>You did the right thing. A grown-up in the club can see your report now.</p>
          <button type="button" className="button button-primary" onClick={onClose}>
            Okay
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title="Tell a grown-up"
      subtitle="What feels wrong about this message?"
      icon="🚩"
      onClose={onClose}
    >
      <div className="report-preview">
        <Avatar user={message.user} size="sm" />
        <div>
          <strong>{message.user?.displayName || 'Someone'}</strong>
          <p>{message.body}</p>
        </div>
      </div>
      {error ? <div className="form-error">{error}</div> : null}
      <div className="reason-grid">
        {REPORT_REASONS.map((reason) => (
          <button
            key={reason.label}
            type="button"
            className="reason-button"
            disabled={Boolean(busyReason)}
            onClick={() => report(reason.label)}
          >
            <span aria-hidden="true">{reason.icon}</span>
            {busyReason === reason.label ? 'Sending…' : reason.label}
          </button>
        ))}
      </div>
      <p className="fine-print">Your name is shared with the grown-ups so they can help.</p>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Shared emoji picker used by other dialogs                           */
/* ------------------------------------------------------------------ */

export function EmojiField({ value, onChange, options = AVATARS, label = 'Pick an avatar' }) {
  return (
    <div className="field">
      <span>{label}</span>
      <div className="avatar-picker" role="group" aria-label={label}>
        {options.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={`avatar-choice ${value === emoji ? 'is-selected' : ''}`}
            onClick={() => onChange(emoji)}
            aria-pressed={value === emoji}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  );
}
