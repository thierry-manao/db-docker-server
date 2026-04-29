import { useState, useEffect, createContext, useContext, useCallback } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api } from './api';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import InstanceDetail from './pages/InstanceDetail';
import Ports from './pages/Ports';
import Profile from './pages/Profile';
import SeedStore from './pages/SeedStore';
import Setup from './pages/Setup';
import Layout from './components/Layout';

export const AppContext = createContext(null);

export function useApp() {
  return useContext(AppContext);
}

export default function App() {
  const [user, setUser] = useState(null);
  const [setupRequired, setSetupRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [instances, setInstances] = useState([]);
  const [seedFiles, setSeedFiles] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem('dbserver-theme') || 'light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('dbserver-theme', theme);
  }, [theme]);

  const toast = useCallback((message, type = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [instData, seedData] = await Promise.all([api.listInstances(), api.seedFiles()]);
      setInstances(instData.instances);
      setSeedFiles(seedData.files);
    } catch (err) {
      toast('Erreur de chargement: ' + err.message, 'danger');
    }
  }, [toast]);

  useEffect(() => {
    api.session().then((data) => {
      setUser({ username: data.username, role: data.role });
      setSetupRequired(!!data.setupRequired);
      refresh();
    }).catch(() => {}).finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!user) return;
    const interval = setInterval(refresh, 15000);
    return () => clearInterval(interval);
  }, [user, refresh]);

  const handleLogin = async (username, password) => {
    const data = await api.login(username, password);
    setUser({ username: data.username, role: data.role });
    setSetupRequired(!!data.setupRequired);
    await refresh();
  };

  const handleLogout = async () => {
    await api.logout();
    setUser(null);
    setInstances([]);
  };

  if (loading) return <div className="login-page"><div className="spinner" /></div>;

  if (user && setupRequired) {
    return (
      <AppContext.Provider value={{ user, instances, seedFiles, refresh, toast, theme, setTheme, handleLogout }}>
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
          ))}
        </div>
        <Setup onComplete={() => setSetupRequired(false)} />
      </AppContext.Provider>
    );
  }

  const ctx = { user, instances, seedFiles, refresh, toast, theme, setTheme, handleLogout };

  return (
    <AppContext.Provider value={ctx}>
      <div className="toast-container">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.type}`}>{t.message}</div>
        ))}
      </div>
      <Routes>
        <Route path="/login" element={user ? <Navigate to="/" /> : <Login onLogin={handleLogin} />} />
        <Route element={user ? <Layout /> : <Navigate to="/login" />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/instance/:name" element={<InstanceDetail />} />
          <Route path="/instance/:name/:tab" element={<InstanceDetail />} />
          <Route path="/ports" element={<Ports />} />
          <Route path="/seeds" element={<SeedStore />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
      </Routes>
    </AppContext.Provider>
  );
}
