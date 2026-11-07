import { colorFor } from '../lib/format.js';

export function Avatar({ user, size = 'md', online = false, showStatus = false }) {
  const name = user?.displayName || 'Friend';
  const emoji = user?.avatar || '🙂';
  const color = colorFor(user?.id || name);

  return (
    <span className={`avatar avatar-${size}`} style={{ '--avatar-color': color }} title={name}>
      <span className="avatar-emoji" aria-hidden="true">
        {emoji}
      </span>
      {showStatus ? <span className={`status-dot ${online ? 'is-online' : ''}`} aria-hidden="true" /> : null}
    </span>
  );
}
