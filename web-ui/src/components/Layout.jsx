import { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useApp } from '../App';
import { Database, LayoutDashboard, Network, Sun, Moon, LogOut, RefreshCw, Plus, Shield, CloudCog, User } from 'lucide-react';
import TaskTracker from './TaskTracker';

function SidebarAvatar({ username, size = 26 }) {
  const [err, setErr] = useState(false);
  if (!err) {
    return (
      <img
        src={`/api/profile/avatar/${encodeURIComponent(username)}`}
        alt={username}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
        onError={() => setErr(true)}
      />
    );
  }
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      <User size={Math.round(size * 0.55)} style={{ color: 'white' }} />
    </div>
  );
}

export default function Layout() {
  const { user, instances, refresh, toast, theme, setTheme, handleLogout } = useApp();
  const navigate = useNavigate();
  const location = useLocation();

  const running = instances.filter((i) => i.running).length;

  return (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div style={{ padding: '1.25rem 1rem', borderBottom: '1px solid var(--panel-border)' }}>
          <div className="flex items-center gap-2" style={{ cursor: 'pointer' }} onClick={() => navigate('/')}>
            <Database size={20} style={{ color: 'var(--accent)' }} />
            <span className="font-semibold" style={{ fontSize: '1rem' }}>dbserver</span>
          </div>
          <div className="text-xs text-muted mt-2">
            {instances.length} instance{instances.length !== 1 ? 's' : ''} &middot; {running} active{running !== 1 ? 's' : ''}
          </div>
        </div>

        <nav style={{ padding: '0.75rem 0.5rem', flex: 1 }}>
          <div
            className={`sidebar-item ${location.pathname === '/' ? 'active' : ''}`}
            onClick={() => navigate('/')}
          >
            <LayoutDashboard size={16} />
            <span>Tableau de bord</span>
          </div>
          <div
            className={`sidebar-item ${location.pathname === '/ports' ? 'active' : ''}`}
            onClick={() => navigate('/ports')}
          >
            <Network size={16} />
            <span>Ports</span>
          </div>
          <div
            className={`sidebar-item ${location.pathname === '/seeds' ? 'active' : ''}`}
            onClick={() => navigate('/seeds')}
          >
            <CloudCog size={16} />
            <span>Seed Store</span>
          </div>

          <div style={{ padding: '0.75rem 1rem 0.35rem', fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-secondary)' }}>
            Instances
          </div>
          {instances.map((inst) => (
            <div
              key={inst.name}
              className={`sidebar-item ${location.pathname.startsWith(`/instance/${inst.name}`) ? 'active' : ''}`}
              onClick={() => navigate(`/instance/${inst.name}`)}
            >
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: inst.running ? 'var(--success)' : 'var(--ink-secondary)', flexShrink: 0 }} />
              <span className="truncate">{inst.name}</span>
              <span className="text-xs text-muted" style={{ marginLeft: 'auto' }}>{inst.config.DB_ENGINE}</span>
            </div>
          ))}
        </nav>

        <div style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--panel-border)' }}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2" style={{ cursor: 'pointer', minWidth: 0 }} onClick={() => navigate('/profile')} title="Profil">
              <SidebarAvatar username={user?.username} size={26} />
              <span className="text-xs text-muted truncate">{user?.username}</span>
            </div>
            <div className="flex gap-1" style={{ flexShrink: 0 }}>
              <button className="btn btn-ghost btn-icon" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} title="Thème">
                {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
              </button>
              <button className="btn btn-ghost btn-icon" onClick={handleLogout} title="Déconnexion">
                <LogOut size={14} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="main">
        <header className="topbar">
          <div className="flex items-center gap-2">
            <h2 style={{ fontSize: '0.9rem', fontWeight: 600 }}>
              {location.pathname === '/' && 'Tableau de bord'}
              {location.pathname === '/ports' && 'Allocation des ports'}
              {location.pathname === '/seeds' && 'Seed Store'}
              {location.pathname === '/profile' && 'Profil'}
              {location.pathname.startsWith('/instance/') && location.pathname.split('/')[2]}
            </h2>
          </div>
          <div className="flex items-center gap-2">
            <TaskTracker toast={toast} />
            {location.pathname !== '/profile' && (
              <button className="btn btn-outline btn-sm" onClick={refresh}>
                <RefreshCw size={14} /> Actualiser
              </button>
            )}
          </div>
        </header>
        <div className="content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
