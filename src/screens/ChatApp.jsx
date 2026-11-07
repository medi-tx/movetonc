import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.js';
import { connectSocket } from '../lib/socket.js';
import { colorFor, dayLabel, isSameDay, timeFor } from '../lib/format.js';
import { Avatar } from '../components/Avatar.jsx';
import { useToast } from '../components/Toast.jsx';
import {
  CreateChannelDialog,
  CreateClubDialog,
  GrownupDashboard,
  ReportDialog,
  UnlockDialog,
} from '../components/Dialogs.jsx';

function MessageRow({ message, currentUser, canModerate, onReport, onDelete }) {
  if (message.deleted) {
    return (
      <div className="message message-deleted">
        <span className="deleted-icon" aria-hidden="true">
          🧹
        </span>
        <em>{message.deletedBy ? `${message.deletedBy} removed this message.` : 'This message was removed.'}</em>
      </div>
    );
  }

  const own = message.userId === currentUser.id;
  const isSystem = message.user?.role === 'system';

  return (
    <article className={`message ${own ? 'is-own' : ''}`}>
      <Avatar user={message.user} size="md" />
      <div className="message-main">
        <header className="message-head">
          <strong style={{ color: colorFor(message.user?.id || 'friend') }}>
            {message.user?.displayName || 'Friend'}
          </strong>
          {message.user?.role === 'grownup' ? <span className="role-pill role-grownup">Grown-up</span> : null}
          {isSystem ? <span className="role-pill role-system">Club Guide</span> : null}
          <time dateTime={message.createdAt}>{timeFor(message.createdAt)}</time>
        </header>
        <p className="message-text">{message.body}</p>
        {message.filtered ? (
          <span className="filter-note">Some words were hidden by the kindness filter.</span>
        ) : null}
      </div>
      <div className="message-actions">
        {!own && !isSystem ? (
          <button type="button" onClick={() => onReport(message)} title="Report to a grown-up" aria-label="Report message">
            🚩
          </button>
        ) : null}
        {(canModerate || own) && !isSystem ? (
          <button type="button" onClick={() => onDelete(message)} title="Remove message" aria-label="Remove message">
            🗑️
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function ChatApp({ state, onState, onLoggedOut }) {
  const toast = useToast();
  const currentUser = state.user;
  const isGrownup = currentUser.role === 'grownup';
  const unlocked = isGrownup && Boolean(state.unlocked);
  const online = useMemo(() => new Set(state.online || []), [state.online]);

  const [activeClubId, setActiveClubId] = useState(state.clubs[0]?.id ?? null);
  const [activeChannelId, setActiveChannelId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [typers, setTypers] = useState({});
  const [, setTick] = useState(0);
  const [unread, setUnread] = useState({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [reportsTick, setReportsTick] = useState(0);

  const socketRef = useRef(null);
  const activeChannelIdRef = useRef(null);
  const lastTypingRef = useRef(0);
  const bottomRef = useRef(null);

  const activeClub = state.clubs.find((club) => club.id === activeClubId) || state.clubs[0] || null;
  const clubChannels = useMemo(
    () => state.channels.filter((channel) => channel.clubId === activeClub?.id),
    [state.channels, activeClub?.id],
  );
  const activeChannel = clubChannels.find((channel) => channel.id === activeChannelId) || clubChannels[0] || null;
  const sortedMembers = useMemo(
    () =>
      [...state.members].sort(
        (a, b) => Number(online.has(b.id)) - Number(online.has(a.id)) || a.displayName.localeCompare(b.displayName),
      ),
    [state.members, online],
  );

  /* Keep the selected club/channel valid as state refreshes. */
  useEffect(() => {
    if (!state.clubs.some((club) => club.id === activeClubId)) {
      setActiveClubId(state.clubs[0]?.id ?? null);
    }
  }, [state.clubs, activeClubId]);

  useEffect(() => {
    if (!clubChannels.some((channel) => channel.id === activeChannelId)) {
      setActiveChannelId(clubChannels[0]?.id ?? null);
    }
  }, [clubChannels, activeChannelId]);

  useEffect(() => {
    activeChannelIdRef.current = activeChannel?.id ?? null;
    if (activeChannel?.id) {
      setUnread((current) => {
        if (!current[activeChannel.id]) return current;
        const next = { ...current };
        delete next[activeChannel.id];
        return next;
      });
    }
  }, [activeChannel?.id]);

  /* Load messages for the selected channel. */
  useEffect(() => {
    if (!activeChannelId) {
      setMessages([]);
      return undefined;
    }
    let cancelled = false;
    setLoadingMessages(true);
    setMessages([]);
    api
      .messages(activeChannelId)
      .then((data) => {
        if (!cancelled) setMessages(data.messages);
      })
      .catch((error) => {
        if (!cancelled) toast.push(error.message, 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeChannelId, toast]);

  /* Realtime: messages, presence, typing, and refreshes. */
  useEffect(() => {
    const socket = connectSocket();
    socketRef.current = socket;

    socket.on('message:new', (message) => {
      if (message.channelId === activeChannelIdRef.current) {
        setMessages((current) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );
      } else {
        setUnread((current) => ({
          ...current,
          [message.channelId]: (current[message.channelId] || 0) + 1,
        }));
      }
    });

    socket.on('message:deleted', ({ id, channelId, deletedBy }) => {
      if (channelId !== activeChannelIdRef.current) return;
      setMessages((current) =>
        current.map((message) =>
          message.id === id ? { ...message, deleted: true, body: '', deletedBy: deletedBy || null } : message,
        ),
      );
    });

    socket.on('presence', (ids) => {
      onState((current) => (current ? { ...current, online: ids } : current));
    });

    socket.on('state:refresh', () => {
      api
        .state()
        .then(onState)
        .catch(() => {});
    });

    socket.on('safety:changed', ({ safety }) => {
      onState((current) => (current ? { ...current, safety } : current));
    });

    socket.on('reports:changed', () => setReportsTick((value) => value + 1));

    socket.on('typing', ({ channelId, user, at }) => {
      if (channelId !== activeChannelIdRef.current) return;
      setTypers((current) => ({ ...current, [user.id]: { user, at, channelId } }));
    });

    return () => socket.disconnect();
  }, [onState]);

  /* Prune stale typing indicators once a second. */
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, activeChannel?.id]);

  function switchChannel(channelId) {
    setActiveChannelId(channelId);
    setSidebarOpen(false);
  }

  function openTools() {
    if (!isGrownup) {
      toast.push('Only grown-up accounts have the safety tools.', 'info');
      return;
    }
    setDialog({ type: state.unlocked ? 'dashboard' : 'unlock' });
  }

  async function handleUnlocked() {
    const next = await api.state();
    onState(next);
    setDialog({ type: 'dashboard' });
  }

  async function handleClubCreated(club) {
    const next = await api.state();
    onState(next);
    setActiveClubId(club.id);
    setDialog(null);
    setSidebarOpen(false);
  }

  async function handleChannelCreated(channel) {
    const next = await api.state();
    onState(next);
    setActiveChannelId(channel.id);
    setDialog(null);
  }

  async function toggleLock() {
    if (!activeChannel) return;
    try {
      await api.updateChannel(activeChannel.id, { locked: !activeChannel.locked });
      const next = await api.state();
      onState(next);
      toast.push(activeChannel.locked ? 'Channel unpaused.' : 'Channel paused for kids.', 'success');
    } catch (error) {
      toast.push(error.message, 'error');
    }
  }

  function handleDraftChange(event) {
    const value = event.target.value;
    setDraft(value);
    if (!value.trim() || !activeChannel) return;
    const now = Date.now();
    if (now - lastTypingRef.current > 1200) {
      lastTypingRef.current = now;
      socketRef.current?.emit('typing', { channelId: activeChannel.id });
    }
  }

  async function handleSend(event) {
    event?.preventDefault();
    const body = draft.trim();
    const channelId = activeChannel?.id;
    if (!channelId || !body || sending) return;

    setSending(true);
    try {
      const message = await api.sendMessage(channelId, body);
      setDraft('');
      setMessages((current) =>
        current.some((item) => item.id === message.id) ? current : [...current, message],
      );
    } catch (error) {
      toast.push(error.message, 'error');
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSend();
    }
  }

  async function handleDelete(message) {
    try {
      await api.deleteMessage(message.id);
      setMessages((current) =>
        current.map((item) => (item.id === message.id ? { ...item, deleted: true, body: '' } : item)),
      );
      toast.push('Message removed.', 'success');
    } catch (error) {
      toast.push(error.message, 'error');
    }
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Logging out locally is still fine.
    }
    onLoggedOut();
  }

  const activeTypers = Object.values(typers).filter(
    (entry) => entry.channelId === activeChannel?.id && Date.now() - entry.at < 3200 && entry.user.id !== currentUser.id,
  );

  const canPost =
    activeChannel &&
    !(activeChannel.locked && !isGrownup) &&
    !(activeChannel.kind === 'announcement' && !isGrownup);

  const composerNote = !activeChannel
    ? 'Pick a channel to start chatting.'
    : activeChannel.kind === 'announcement' && !isGrownup
      ? 'Only grown-ups can post in announcements.'
      : activeChannel.locked && !isGrownup
        ? 'A grown-up paused this channel. Take a little break.'
        : state.safety.slowModeSeconds > 0 && !isGrownup
          ? `Slow mode: ${state.safety.slowModeSeconds}s between messages.`
          : state.safety.allowLinks || isGrownup
            ? 'Be kind. Include everyone. 💛'
            : 'Be kind. Links and emails are off for kids. 💛';

  return (
    <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : ''}`}>
      <nav className="rail" aria-label="Clubs">
        <div className="rail-logo" title="DisKids">
          🌈
        </div>
        <div className="rail-clubs">
          {state.clubs.map((club) => (
            <button
              key={club.id}
              type="button"
              className={`club-button ${club.id === activeClub?.id ? 'is-active' : ''}`}
              onClick={() => {
                setActiveClubId(club.id);
                setSidebarOpen(false);
              }}
              title={club.name}
              aria-label={`Open ${club.name}`}
              aria-pressed={club.id === activeClub?.id}
            >
              <span aria-hidden="true">{club.emoji}</span>
            </button>
          ))}
          {unlocked ? (
            <button
              type="button"
              className="club-button club-add"
              onClick={() => setDialog({ type: 'club' })}
              title="Create a club"
              aria-label="Create a club"
            >
              +
            </button>
          ) : null}
        </div>
        <div className="rail-spacer" />
        {isGrownup ? (
          <button
            type="button"
            className={`rail-action ${unlocked ? 'is-unlocked' : ''}`}
            onClick={openTools}
            title="Grown-up tools"
            aria-label="Grown-up tools"
          >
            🛡️
          </button>
        ) : null}
        <button type="button" className="rail-action" onClick={handleLogout} title="Log out" aria-label="Log out">
          🚪
        </button>
      </nav>

      <button
        type="button"
        className="sidebar-scrim"
        onClick={() => setSidebarOpen(false)}
        aria-label="Close menu"
        tabIndex={sidebarOpen ? 0 : -1}
      />

      <aside className="sidebar">
        <header className="club-head">
          <span className="club-emoji" aria-hidden="true">
            {activeClub?.emoji || '🏡'}
          </span>
          <div className="club-head-text">
            <h2>{activeClub?.name || 'Your club'}</h2>
            <p>
              {state.members.length} {state.members.length === 1 ? 'member' : 'members'} · {state.online.length} online
            </p>
          </div>
          <button
            type="button"
            className="icon-button sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
          >
            ×
          </button>
        </header>

        <div className="channel-section">
          <div className="section-label">
            <span>Channels</span>
            {unlocked ? (
              <button
                type="button"
                className="icon-button"
                onClick={() => setDialog({ type: 'channel' })}
                title="Add channel"
                aria-label="Add channel"
              >
                +
              </button>
            ) : null}
          </div>
          <ul className="channel-list">
            {clubChannels.map((channel) => (
              <li key={channel.id}>
                <button
                  type="button"
                  className={`channel-button ${channel.id === activeChannel?.id ? 'is-active' : ''}`}
                  onClick={() => switchChannel(channel.id)}
                  aria-current={channel.id === activeChannel?.id ? 'page' : undefined}
                >
                  <span className="channel-emoji" aria-hidden="true">
                    {channel.kind === 'announcement' ? '📣' : '#'}
                  </span>
                  <span className="channel-name">{channel.name}</span>
                  {channel.locked ? (
                    <span className="channel-lock" title="Paused" aria-label="Paused">
                      ⏸
                    </span>
                  ) : null}
                  {unread[channel.id] ? <span className="unread-badge">{unread[channel.id]}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          {clubChannels.length === 0 ? (
            <p className="sidebar-empty">No channels yet. A grown-up can add one.</p>
          ) : null}
        </div>

        <div className="sidebar-spacer" />

        <div className={`safety-card ${unlocked ? 'is-unlocked' : ''}`}>
          <span className="safety-card-icon" aria-hidden="true">
            🛡️
          </span>
          <div className="safety-card-text">
            <strong>{isGrownup ? (unlocked ? 'Tools unlocked' : 'Grown-up tools') : 'Safe clubhouse'}</strong>
            <p>
              {isGrownup
                ? unlocked
                  ? 'Reports and safety settings are open.'
                  : 'Reports, invites, and safety settings.'
                : 'See something mean? Report it and a grown-up will help.'}
            </p>
          </div>
          {isGrownup ? (
            <button type="button" className="button button-soft button-small" onClick={openTools}>
              {unlocked ? 'Open' : 'Unlock'}
            </button>
          ) : null}
        </div>

        <div className="user-card">
          <Avatar user={currentUser} online showStatus size="sm" />
          <div className="user-card-text">
            <strong>{currentUser.displayName}</strong>
            <span>{isGrownup ? 'Grown-up' : 'Club member'}</span>
          </div>
          <button type="button" className="icon-button" onClick={handleLogout} title="Log out" aria-label="Log out">
            ⏏
          </button>
        </div>
      </aside>

      <main className="chat">
        <header className="chat-head">
          <button
            type="button"
            className="icon-button menu-button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <div className="chat-title">
            <h1>
              <span aria-hidden="true">{activeChannel?.emoji || '#'}</span> {activeChannel?.name || 'Pick a channel'}
            </h1>
            <p>{activeChannel?.topic || 'Choose a channel to start chatting.'}</p>
          </div>
          <div className="chat-actions">
            {activeChannel?.locked ? <span className="chip chip-warn">⏸ Paused</span> : null}
            {activeChannel?.kind === 'announcement' ? <span className="chip">📣 Announcements</span> : null}
            <div className="online-stack">
              {sortedMembers.slice(0, 4).map((member) => (
                <Avatar key={member.id} user={member} size="xs" online={online.has(member.id)} showStatus />
              ))}
              <span className="online-label">{state.online.length} online</span>
            </div>
            {unlocked && activeChannel ? (
              <button type="button" className="button button-ghost button-small" onClick={toggleLock}>
                {activeChannel.locked ? 'Unpause' : 'Pause'}
              </button>
            ) : null}
          </div>
        </header>

        <div className="message-scroll">
          {loadingMessages ? <p className="chat-note">Loading messages…</p> : null}
          {!loadingMessages && messages.length === 0 && activeChannel ? (
            <div className="empty-panel chat-empty">
              <span aria-hidden="true">👋</span>
              <strong>No messages yet</strong>
              <p>Be the first to say hello in #{activeChannel.name}.</p>
            </div>
          ) : null}

          {messages.map((message, index) => {
            const showDay = index === 0 || !isSameDay(messages[index - 1].createdAt, message.createdAt);
            return (
              <div key={message.id}>
                {showDay ? <div className="day-divider">{dayLabel(message.createdAt)}</div> : null}
                <MessageRow
                  message={message}
                  currentUser={currentUser}
                  canModerate={unlocked}
                  onReport={(target) => setDialog({ type: 'report', message: target })}
                  onDelete={handleDelete}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <footer className="composer-wrap">
          {activeTypers.length > 0 ? (
            <p className="typing-line">
              <span className="typing-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {activeTypers.map((entry) => entry.user.displayName).join(', ')}{' '}
              {activeTypers.length === 1 ? 'is' : 'are'} typing…
            </p>
          ) : (
            <span className="typing-spacer" />
          )}

          {canPost ? (
            <form className="composer" onSubmit={handleSend}>
              <Avatar user={currentUser} size="sm" />
              <textarea
                value={draft}
                onChange={handleDraftChange}
                onKeyDown={handleKeyDown}
                placeholder={`Message #${activeChannel.name}`}
                rows={1}
                maxLength={500}
                aria-label={`Message #${activeChannel.name}`}
              />
              <button type="submit" className="send-button" disabled={!draft.trim() || sending} aria-label="Send message">
                {sending ? '…' : '➤'}
              </button>
            </form>
          ) : (
            <div className="composer-banner">⏸ {composerNote}</div>
          )}

          <div className="composer-meta">
            <span>{composerNote}</span>
            {canPost ? <span>{draft.length}/500</span> : null}
          </div>
        </footer>
      </main>

      <aside className="members-panel">
        <header className="members-head">
          <h3>In the club</h3>
          <span>{state.members.length}</span>
        </header>
        <div className="members-scroll">
          {sortedMembers.map((member) => (
            <div key={member.id} className={`member-row ${online.has(member.id) ? 'is-online' : ''}`}>
              <Avatar user={member} size="sm" online={online.has(member.id)} showStatus />
              <div className="member-row-text">
                <strong>
                  {member.displayName}
                  {member.id === currentUser.id ? ' (you)' : ''}
                </strong>
                <span>@{member.username}</span>
              </div>
              {member.role === 'grownup' ? (
                <span className="role-dot" title="Grown-up" aria-label="Grown-up">
                  🛡️
                </span>
              ) : null}
            </div>
          ))}
        </div>
        <div className="member-foot">
          <span aria-hidden="true">💛</span> Be kind. Include everyone.
        </div>
      </aside>

      {dialog?.type === 'unlock' ? (
        <UnlockDialog
          onClose={() => setDialog(null)}
          onUnlocked={handleUnlocked}
        />
      ) : null}

      {dialog?.type === 'dashboard' ? (
        <GrownupDashboard
          state={state}
          onClose={() => setDialog(null)}
          onState={onState}
          reportsTick={reportsTick}
          onReportsChanged={() => setReportsTick((value) => value + 1)}
        />
      ) : null}

      {dialog?.type === 'club' ? (
        <CreateClubDialog onClose={() => setDialog(null)} onCreated={handleClubCreated} />
      ) : null}

      {dialog?.type === 'channel' && activeClub ? (
        <CreateChannelDialog club={activeClub} onClose={() => setDialog(null)} onCreated={handleChannelCreated} />
      ) : null}

      {dialog?.type === 'report' ? (
        <ReportDialog message={dialog.message} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}
