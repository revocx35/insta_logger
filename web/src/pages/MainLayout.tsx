import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { api } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { IgStatePill } from '../components/ui';
import { useAppState } from '../state/AppState';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Chats', icon: 'chats', end: true },
  { to: '/deleted', label: 'Unsent', icon: 'deleted' },
  { to: '/search', label: 'Search', icon: 'search' },
  { to: '/instagram', label: 'Instagram', icon: 'monitor' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
];

export function MainLayout() {
  const { ig, refresh } = useAppState();
  const navigate = useNavigate();
  const location = useLocation();
  const inChat = location.pathname.startsWith('/chat/');

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      await refresh();
      navigate('/login', { replace: true });
    }
  };

  const needsAttention = ig && (ig.state === 'login' || ig.state === 'challenge');

  return (
    <div className={inChat ? 'app-shell in-chat' : 'app-shell'}>
      <nav className="rail" aria-label="Main">
        <div className="rail-top">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) => (isActive || (n.to === '/' && inChat) ? 'rail-item active' : 'rail-item')}
              title={n.label}
            >
              <Icon name={n.icon} size={22} />
              <span className="rail-label">{n.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="rail-bottom">
          <NavLink to="/instagram" className="rail-status" title={ig?.detail ?? 'Instagram status'}>
            <IgStatePill status={ig} compact />
          </NavLink>
          <button className="rail-item" onClick={logout} title="Log out">
            <Icon name="logout" size={22} />
            <span className="rail-label">Log out</span>
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
    </div>
  );
}
