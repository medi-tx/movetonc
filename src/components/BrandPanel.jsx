const PROMISES = [
  { icon: '🔐', title: 'Invite-only', text: 'Only kids with your club code can join.' },
  { icon: '🛡️', title: 'Grown-up tools', text: 'Reports, slow mode, and a Parental PIN.' },
  { icon: '🌱', title: 'Kind by design', text: 'A gentle word filter and no strangers.' },
];

export function BrandPanel() {
  return (
    <aside className="brand-panel">
      <div className="brand-top">
        <div className="brand-mark" aria-hidden="true">
          🌈
        </div>
        <div>
          <p className="brand-eyebrow">A safe place to chat</p>
          <h1 className="brand-name">DisKids</h1>
        </div>
      </div>

      <div className="brand-copy">
        <h2>A little clubhouse for your classroom, crew, or club.</h2>
        <p>
          Chat in cozy channels, share ideas, and keep grown-ups in the loop — without the wild west of the internet.
        </p>
      </div>

      <ul className="promise-list">
        {PROMISES.map((promise) => (
          <li key={promise.title}>
            <span aria-hidden="true">{promise.icon}</span>
            <div>
              <strong>{promise.title}</strong>
              <p>{promise.text}</p>
            </div>
          </li>
        ))}
      </ul>

      <p className="brand-foot">Built for classrooms, clubs, and after-school crews. 🌟</p>
    </aside>
  );
}
