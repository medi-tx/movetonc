import { useState } from 'react';
import { api } from '../lib/api.js';
import { AVATARS } from '../lib/format.js';
import { Avatar } from '../components/Avatar.jsx';
import { BrandPanel } from '../components/BrandPanel.jsx';
import { useToast } from '../components/Toast.jsx';

const EMPTY_FORM = {
  clubName: '',
  displayName: '',
  username: '',
  password: '',
  pin: '',
  avatar: '🦊',
};

export function SetupScreen({ clubName, onDone, onBack }) {
  const toast = useToast();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState(null);
  const [copied, setCopied] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await api.setup({
        clubName: form.clubName,
        displayName: form.displayName,
        username: form.username,
        password: form.password,
        pin: form.pin,
        avatar: form.avatar,
      });
      setInviteCode(result.inviteCode);
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteCode);
      setCopied(true);
      toast.push('Invite code copied!', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.push('Could not copy — write the code down instead.', 'error');
    }
  }

  if (inviteCode) {
    return (
      <div className="auth-layout">
        <BrandPanel />
        <main className="auth-main">
          <section className="auth-card success-screen">
            <span className="success-burst" aria-hidden="true">
              🎉
            </span>
            <h2>{form.clubName || clubName || 'Your clubhouse'} is ready!</h2>
            <p className="auth-sub">
              You are the grown-up in charge. Share this invite code with your kids so they can join.
            </p>
            <div className="invite-box">
              <span className="invite-code">{inviteCode}</span>
              <button type="button" className="button button-soft" onClick={copyInvite}>
                {copied ? 'Copied ✓' : 'Copy code'}
              </button>
            </div>
            <p className="fine-print">
              Keep this code inside your club. Your Parental PIN is separate — you will need it to open the
              grown-up tools.
            </p>
            <button type="button" className="button button-primary button-wide" onClick={onDone}>
              Enter the clubhouse →
            </button>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="auth-layout">
      <BrandPanel />
      <main className="auth-main">
        <section className="auth-card">
          <header className="auth-head">
            <span className="auth-badge">Grown-ups only · About 2 minutes</span>
            <h2>Create your clubhouse</h2>
            <p className="auth-sub">
              Start a private space for your classroom, crew, or club. We will make an invite code for the kids and
              give you the safety controls.
            </p>
            {onBack ? (
              <button type="button" className="link-button auth-back" onClick={onBack}>
                ← Back to login
              </button>
            ) : null}
          </header>

          {error ? <div className="form-error">{error}</div> : null}

          <form onSubmit={handleSubmit} className="form">
            <label className="field">
              <span>Club name</span>
              <input
                type="text"
                value={form.clubName}
                onChange={update('clubName')}
                placeholder="e.g. Room 12 Explorers"
                maxLength={32}
                required
                autoComplete="organization"
                aria-label="Club name"
              />
            </label>

            <div className="form-row">
              <label className="field">
                <span>Your name</span>
                <input
                  type="text"
                  value={form.displayName}
                  onChange={update('displayName')}
                  placeholder="Ms. Rivera"
                  maxLength={24}
                  required
                  autoComplete="name"
                  aria-label="Your name"
                />
              </label>
              <div className="field">
                <span>Pick an avatar</span>
                <div className="avatar-picker" role="group" aria-label="Choose an avatar">
                  {AVATARS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`avatar-choice ${form.avatar === emoji ? 'is-selected' : ''}`}
                      onClick={() => setForm((current) => ({ ...current, avatar: emoji }))}
                      aria-label={`Avatar ${emoji}`}
                      aria-pressed={form.avatar === emoji}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <label className="field">
              <span>Username</span>
              <input
                type="text"
                value={form.username}
                onChange={update('username')}
                placeholder="ms_rivera"
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9_]+"
                required
                autoComplete="username"
                aria-label="Username"
              />
              <small>Letters, numbers, and underscores only.</small>
            </label>

            <div className="form-row">
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={update('password')}
                  placeholder="At least 6 characters"
                  minLength={6}
                  required
                  autoComplete="new-password"
                  aria-label="Password"
                />
              </label>
              <label className="field">
                <span>Parental PIN</span>
                <input
                  type="password"
                  inputMode="numeric"
                  value={form.pin}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, pin: event.target.value.replace(/\D/g, '').slice(0, 6) }))
                  }
                  placeholder="4–6 digits"
                  pattern="\d{4,6}"
                  required
                  autoComplete="off"
                  aria-label="Parental PIN"
                />
                <small>Used to open reports and safety settings.</small>
              </label>
            </div>

            <div className="form-preview">
              <Avatar user={{ id: form.displayName, displayName: form.displayName || 'You', avatar: form.avatar }} />
              <div>
                <strong>{form.displayName || 'Your grown-up name'}</strong>
                <span>Grown-up · Club owner</span>
              </div>
            </div>

            <button type="submit" className="button button-primary button-wide" disabled={busy}>
              {busy ? 'Building your clubhouse…' : 'Create our clubhouse 🌈'}
            </button>
            <p className="fine-print">
              By continuing, you confirm you are the grown-up responsible for this club and its members. DisKids
              stores only the names, usernames, and messages you enter — no email addresses or ads.
            </p>
          </form>
        </section>
      </main>
    </div>
  );
}
