import { useState } from 'react';
import { api } from '../lib/api.js';
import { AVATARS } from '../lib/format.js';
import { Avatar } from '../components/Avatar.jsx';
import { BrandPanel } from '../components/BrandPanel.jsx';
import { useToast } from '../components/Toast.jsx';

function initialInvite() {
  try {
    return new URLSearchParams(window.location.search).get('invite')?.toUpperCase() || '';
  } catch {
    return '';
  }
}

export function AuthScreen({ clubName, onDone }) {
  const toast = useToast();
  const [mode, setMode] = useState('join');
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    password: '',
    inviteCode: initialInvite(),
    avatar: '🐼',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const update = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'join') {
        await api.register({
          displayName: form.displayName,
          username: form.username,
          password: form.password,
          inviteCode: form.inviteCode,
          avatar: form.avatar,
        });
        toast.push('Welcome to the club! 🎉', 'success');
      } else {
        await api.login({ username: form.username, password: form.password });
        toast.push('Welcome back! 👋', 'success');
      }
      onDone();
    } catch (submitError) {
      setError(submitError.message);
    } finally {
      setBusy(false);
    }
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setError('');
  }

  return (
    <div className="auth-layout">
      <BrandPanel />
      <main className="auth-main">
        <section className="auth-card">
          <header className="auth-head">
            <span className="auth-badge">{clubName || 'Our club'}</span>
            <h2>{mode === 'join' ? 'Join the clubhouse' : 'Welcome back'}</h2>
            <p className="auth-sub">
              {mode === 'join'
                ? 'Use the invite code from your grown-up to make your account.'
                : 'Log in to pick up right where you left off.'}
            </p>
          </header>

          <div className="segmented" role="tablist" aria-label="Join or log in">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'join'}
              className={mode === 'join' ? 'is-active' : ''}
              onClick={() => switchMode('join')}
            >
              Join with code
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'is-active' : ''}
              onClick={() => switchMode('login')}
            >
              Log in
            </button>
          </div>

          {error ? <div className="form-error">{error}</div> : null}

          <form onSubmit={handleSubmit} className="form">
            {mode === 'join' ? (
              <>
                <label className="field">
                  <span>Invite code</span>
                  <input
                    className="invite-input"
                    type="text"
                    value={form.inviteCode}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, inviteCode: event.target.value.toUpperCase().slice(0, 6) }))
                    }
                    placeholder="ABC123"
                    maxLength={6}
                    required
                    autoComplete="off"
                    aria-label="Invite code"
                  />
                </label>

                <label className="field">
                  <span>Your display name</span>
                  <input
                    type="text"
                    value={form.displayName}
                    onChange={update('displayName')}
                    placeholder="What should friends call you?"
                    maxLength={24}
                    required
                    autoComplete="nickname"
                    aria-label="Your display name"
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
              </>
            ) : null}

            <label className="field">
              <span>Username</span>
              <input
                type="text"
                value={form.username}
                onChange={update('username')}
                placeholder="your_username"
                minLength={3}
                maxLength={20}
                pattern="[A-Za-z0-9_]+"
                required
                autoComplete="username"
                aria-label="Username"
              />
            </label>

            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={form.password}
                onChange={update('password')}
                placeholder={mode === 'join' ? 'At least 6 characters' : 'Your password'}
                minLength={6}
                required
                autoComplete={mode === 'join' ? 'new-password' : 'current-password'}
                aria-label="Password"
              />
            </label>

            {mode === 'join' ? (
              <div className="form-preview">
                <Avatar user={{ id: form.displayName, displayName: form.displayName || 'You', avatar: form.avatar }} />
                <div>
                  <strong>{form.displayName || 'Your display name'}</strong>
                  <span>Club member</span>
                </div>
              </div>
            ) : null}

            <button type="submit" className="button button-primary button-wide" disabled={busy}>
              {busy ? 'One moment…' : mode === 'join' ? 'Join the club 🎈' : 'Log in →'}
            </button>

            <p className="fine-print">
              {mode === 'join'
                ? 'No invite code? Ask the grown-up who runs your club.'
                : 'Grown-ups use the same login, then unlock the safety tools with the Parental PIN.'}
            </p>
          </form>
        </section>
      </main>
    </div>
  );
}
