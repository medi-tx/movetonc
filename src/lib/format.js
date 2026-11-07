export const AVATARS = [
  '🦊', '🐼', '🐸', '🦄', '🐙', '🐨', '🦖', '🐝', '🐳', '🦉',
  '🐱', '🐶', '🍀', '🌈', '🚀', '⭐', '🎨', '⚽',
];

const AVATAR_COLORS = [
  '#ff8fab', '#6ee7b7', '#a78bfa', '#ffd166', '#7dd3fc',
  '#fca5a5', '#86efac', '#c4b5fd', '#f9a8d4', '#5eead4',
];

export function colorFor(seed = '') {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

export function timeFor(iso) {
  const date = new Date(iso);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function dayLabel(iso) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

export function isSameDay(a, b) {
  const first = new Date(a);
  const second = new Date(b);
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}
