import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { IgStatePill, Wordmark } from '../components/ui';
import { useAppState } from '../state/AppState';

type NavEntry = { to: string; label: string; icon: IconName; end?: boolean };

/** Instagram-style navigation: a sidebar on wide screens, a bottom tab bar (+ "More" sheet) on phones. */
const NAV: NavEntry[] = [
  { to: '/', label: 'Messages', icon: 'chats', end: true },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/reels', label: 'Reels', icon: 'reels' },
  { to: '/stories', label: 'Stories', icon: 'stories' },
  { to: '/deleted', label: 'Unsent', icon: 'deleted' },
  { to: '/instagram', label: 'Instagram', icon: 'monitor' },
];
/** The phone tab bar keeps Instagram's five slots; the rest lives under "More". */
const TABS = ['/', '/search', '/reels', '/stories'];

export function MainLayout() {
  const { ig, refresh, state } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const inChat = location.pathname.startsWith('/chat/');
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMoreOpen(false), [location.pathname]);
  useEffect(() => {
    if (!moreOpen) return;
    const away = (e: MouseEvent) => !moreRef.current?.contains(e.target as Node) && setMoreOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [moreOpen]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
      navigate('/login', { replace: true });
    }
  };

  const needsAttention = ig && (ig.state === 'login' || ig.state === 'challenge');
  const igDown = !ig || !(ig.state === 'ready' || ig.state === 'syncing');
  // The messages pages and reels use the narrow (icons only) sidebar, like Instagram's own.
  const narrow = inChat || location.pathname === '/' || location.pathname === '/reels';
  const extra: NavEntry[] = [
    ...(state?.role === 'admin' ? [{ to: '/admin', label: 'Users', icon: 'group' as IconName }] : []),
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  const isActive = (to: string, active: boolean) => active || (to === '/' && inChat);

  const item = (n: NavEntry, tab = false) => (
    <NavLink
      key={n.to}
      to={n.to}
      end={n.end}
      className={({ isActive: a }) => `${tab ? 'tab-item' : 'rail-item'}${isActive(n.to, a) ? ' active' : ''}`}
      title={n.label}
      aria-label={n.label}
    >
      <span className="rail-icon">
        <Icon name={n.icon} size={26} />
        {n.to === '/instagram' && igDown ? <span className="nav-dot" aria-label="Needs attention" /> : null}
      </span>
      {tab ? null : <span className="rail-label">{n.label}</span>}
    </NavLink>
  );

  const menu = (
    <div className="more-menu" role="menu">
      {[...NAV.filter((n) => !TABS.includes(n.to)), ...extra].map((n) => (
        <NavLink key={n.to} to={n.to} role="menuitem" className={({ isActive: a }) => (a ? 'more-item active' : 'more-item')}>
          <Icon name={n.icon} size={22} />
          <span>{n.label}</span>
          {n.to === '/instagram' ? <IgStatePill status={ig} compact /> : null}
        </NavLink>
      ))}
      <div className="more-sep" />
      <button role="menuitem" className="more-item" onClick={() => void logout()}>
        <Icon name="logout" size={22} />
        <span>Log out{state?.username ? ` @${state.username}` : ''}</span>
      </button>
    </div>
  );

  return (
    <div className={`app-shell${inChat ? ' in-chat' : ''}${narrow ? ' narrow' : ''}${location.pathname === '/reels' ? ' on-reels' : ''}`}>
      <nav className="rail" aria-label="Main">
        <NavLink to="/" className="rail-brand" aria-label="insta logger home">
          <Wordmark />
          <span className="rail-brand-icon wordmark">Il</span>
        </NavLink>
        <div className="rail-top">
          {NAV.map((n) => item(n))}
          {extra.map((n) => item(n))}
        </div>
        <div className="rail-bottom" ref={moreRef}>
          {moreOpen ? menu : null}
          <button className={moreOpen ? 'rail-item active' : 'rail-item'} onClick={() => setMoreOpen((v) => !v)} aria-haspopup="menu" aria-expanded={moreOpen} title="More">
            <span className="rail-icon">
              <Icon name="menu" size={26} />
            </span>
            <span className="rail-label">More</span>
          </button>
        </div>
      </nav>
      <main className="app-main">
        {needsAttention ? (
          <div className="banner warn">
            <Icon name="warning" size={18} />
            <span>
              {ig.state === 'login' ? 'Instagram is logged out' : 'Instagram asks for a confirmation'} — new messages are not being logged.{' '}
              <NavLink to="/instagram">Open the Instagram screen</NavLink> to fix it.
            </span>
          </div>
        ) : null}
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Tabs">
        {NAV.filter((n) => TABS.includes(n.to)).map((n) => item(n, true))}
        <button className={moreOpen ? 'tab-item active' : 'tab-item'} onClick={() => setMoreOpen((v) => !v)} aria-label="More" aria-haspopup="menu" aria-expanded={moreOpen}>
          <span className="rail-icon">
            <Icon name="menu" size={26} />
            {igDown ? <span className="nav-dot" /> : null}
          </span>
        </button>
      </nav>
      {moreOpen ? (
        <div className="more-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div className="more-sheet" onClick={(e) => e.stopPropagation()}>
            <span className="sheet-grip" />
            {menu}
          </div>
        </div>
      ) : null}
    </div>
  );
}
