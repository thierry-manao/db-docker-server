import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../App';
import { api } from '../api';
import { Shield, User, Lock, UserPlus, Trash2, KeyRound, Crown, X, Pencil } from 'lucide-react';

function Modal({ title, onClose, children }) {
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>{title}</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function Profile() {
  const { user, toast, handleLogout } = useApp();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);

  // Admin management
  const [admins, setAdmins] = useState([]);
  const [adminsLoading, setAdminsLoading] = useState(false);

  // Modals
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [resetTarget, setResetTarget] = useState(null);
  const [roleTarget, setRoleTarget] = useState(null);

  // Forms
  const [pwForm, setPwForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '', username: '' });
  const [createForm, setCreateForm] = useState({ username: '', password: '', role: 'admin' });
  const [resetPwValue, setResetPwValue] = useState('');

  const isSuperadmin = user?.role === 'superadmin';

  const loadAdmins = useCallback(async () => {
    setAdminsLoading(true);
    try {
      const data = await api.listAdmins();
      setAdmins(data.admins || []);
    } catch (err) {
      toast('Erreur chargement admins: ' + err.message, 'danger');
    } finally {
      setAdminsLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadAdmins(); }, [loadAdmins]);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      return toast('Les mots de passe ne correspondent pas.', 'danger');
    }
    setLoading(true);
    try {
      await api.changeAdminPassword(pwForm.currentPassword, pwForm.newPassword, pwForm.username || undefined);
      toast('Identifiants mis à jour. Reconnectez-vous.');
      handleLogout();
      navigate('/login');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAdmin = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.createAdminUser(createForm.username, createForm.password, createForm.role);
      toast(`Utilisateur '${createForm.username}' créé.`);
      setCreateForm({ username: '', password: '', role: 'admin' });
      setShowCreateModal(false);
      loadAdmins();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAdmin = async (admin) => {
    if (!confirm(`Supprimer l'utilisateur '${admin.username}' ?`)) return;
    try {
      await api.deleteAdminUser(admin.id);
      toast(`Utilisateur '${admin.username}' supprimé.`);
      loadAdmins();
    } catch (err) {
      toast(err.message, 'danger');
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!resetPwValue || resetPwValue.length < 4) return toast('4 caractères minimum.', 'danger');
    setLoading(true);
    try {
      await api.resetAdminPassword(resetTarget.id, resetPwValue);
      toast(`Mot de passe de '${resetTarget.username}' réinitialisé.`);
      setResetTarget(null);
      setResetPwValue('');
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleToggleRole = async () => {
    if (!roleTarget) return;
    const newRole = roleTarget.role === 'superadmin' ? 'admin' : 'superadmin';
    setLoading(true);
    try {
      await api.updateAdminRole(roleTarget.id, newRole);
      toast(`Rôle de '${roleTarget.username}' → ${newRole}`);
      setRoleTarget(null);
      loadAdmins();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 780 }}>
      {/* Profile header */}
      <div className="card card-body mb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'var(--primary)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <User size={20} style={{ color: 'white' }} />
            </div>
            <div>
              <div className="text-sm font-semibold">{user?.username}</div>
              <div className="flex items-center gap-2">
                <span className="badge" style={{ fontSize: 10 }}>
                  {user?.role === 'superadmin' && <Crown size={10} style={{ display: 'inline', verticalAlign: -1, marginRight: 2 }} />}
                  {user?.role}
                </span>
              </div>
            </div>
          </div>
          <button className="btn btn-sm" onClick={() => setShowPasswordModal(true)}>
            <Lock size={14} /> Changer le mot de passe
          </button>
        </div>
      </div>

      {/* Admin management table */}
      {isSuperadmin && (
        <div className="card card-body">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">
              <Shield size={16} style={{ display: 'inline', verticalAlign: -3, marginRight: 6 }} />
              Administrateurs
            </h3>
            <button className="btn btn-primary btn-sm" onClick={() => setShowCreateModal(true)}>
              <UserPlus size={14} /> Ajouter
            </button>
          </div>

          {adminsLoading ? <div className="spinner" /> : (
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th className="text-xs">Utilisateur</th>
                  <th className="text-xs">Rôle</th>
                  <th className="text-xs">Créé le</th>
                  <th className="text-xs" style={{ textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {admins.map((a) => {
                  const isSelf = a.username === user?.username;
                  return (
                    <tr key={a.id}>
                      <td className="text-sm">
                        <div className="flex items-center gap-2">
                          <User size={13} className="text-muted" />
                          <span className="font-semibold">{a.username}</span>
                          {isSelf && <span className="text-xs text-muted">(vous)</span>}
                        </div>
                      </td>
                      <td>
                        <span className="badge" style={{ fontSize: 10 }}>
                          {a.role === 'superadmin' && <Crown size={10} style={{ display: 'inline', verticalAlign: -1, marginRight: 2 }} />}
                          {a.role}
                        </span>
                      </td>
                      <td className="text-xs text-muted">{new Date(a.created_at).toLocaleDateString('fr-FR')}</td>
                      <td style={{ textAlign: 'right' }}>
                        {!isSelf && (
                          <div className="flex gap-1 justify-end">
                            <button className="btn btn-ghost btn-icon" title="Changer le rôle"
                              onClick={() => setRoleTarget(a)}>
                              <Pencil size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon" title="Réinitialiser le mot de passe"
                              onClick={() => { setResetTarget(a); setResetPwValue(''); }}>
                              <KeyRound size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon" style={{ color: 'var(--danger)' }}
                              title="Supprimer" onClick={() => handleDeleteAdmin(a)}>
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Change password modal */}
      {showPasswordModal && (
        <Modal title="Changer le mot de passe" onClose={() => setShowPasswordModal(false)}>
          <form onSubmit={handleChangePassword}>
            <div className="modal-body flex flex-col gap-3">
              <div>
                <label className="label">Nouveau nom d'utilisateur (optionnel)</label>
                <input className="input" type="text" value={pwForm.username}
                  onChange={(e) => setPwForm({ ...pwForm, username: e.target.value })}
                  placeholder={user?.username} autoComplete="username" />
              </div>
              <div>
                <label className="label">Mot de passe actuel *</label>
                <input className="input" type="password" value={pwForm.currentPassword}
                  onChange={(e) => setPwForm({ ...pwForm, currentPassword: e.target.value })}
                  required autoComplete="current-password" />
              </div>
              <div>
                <label className="label">Nouveau mot de passe *</label>
                <input className="input" type="password" value={pwForm.newPassword}
                  onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                  required minLength={4} autoComplete="new-password" />
              </div>
              <div>
                <label className="label">Confirmer *</label>
                <input className="input" type="password" value={pwForm.confirmPassword}
                  onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                  required minLength={4} autoComplete="new-password" />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setShowPasswordModal(false)}>Annuler</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !pwForm.currentPassword || !pwForm.newPassword}>
                {loading ? <span className="spinner" /> : 'Mettre à jour'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Create admin modal */}
      {showCreateModal && (
        <Modal title="Nouvel administrateur" onClose={() => setShowCreateModal(false)}>
          <form onSubmit={handleCreateAdmin}>
            <div className="modal-body flex flex-col gap-3">
              <div>
                <label className="label">Nom d'utilisateur</label>
                <input className="input" type="text" value={createForm.username}
                  onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                  required placeholder="username" autoFocus />
              </div>
              <div>
                <label className="label">Mot de passe</label>
                <input className="input" type="password" value={createForm.password}
                  onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                  required minLength={4} placeholder="••••" />
              </div>
              <div>
                <label className="label">Rôle</label>
                <select className="input" value={createForm.role}
                  onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}>
                  <option value="admin">admin</option>
                  <option value="superadmin">superadmin</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setShowCreateModal(false)}>Annuler</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !createForm.username || !createForm.password}>
                {loading ? <span className="spinner" /> : 'Créer'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Reset password modal */}
      {resetTarget && (
        <Modal title={`Réinitialiser le mot de passe — ${resetTarget.username}`} onClose={() => setResetTarget(null)}>
          <form onSubmit={handleResetPassword}>
            <div className="modal-body flex flex-col gap-3">
              <div>
                <label className="label">Nouveau mot de passe</label>
                <input className="input" type="password" value={resetPwValue}
                  onChange={(e) => setResetPwValue(e.target.value)}
                  required minLength={4} placeholder="••••" autoFocus />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-sm" onClick={() => setResetTarget(null)}>Annuler</button>
              <button type="submit" className="btn btn-primary btn-sm" disabled={loading || !resetPwValue}>
                {loading ? <span className="spinner" /> : 'Réinitialiser'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* Change role modal */}
      {roleTarget && (
        <Modal title={`Changer le rôle — ${roleTarget.username}`} onClose={() => setRoleTarget(null)}>
          <div className="modal-body">
            <p className="text-sm mb-3">
              Changer le rôle de <strong>{roleTarget.username}</strong> de{' '}
              <span className="badge" style={{ fontSize: 10 }}>{roleTarget.role}</span> vers{' '}
              <span className="badge" style={{ fontSize: 10 }}>{roleTarget.role === 'superadmin' ? 'admin' : 'superadmin'}</span> ?
            </p>
          </div>
          <div className="modal-footer">
            <button className="btn btn-sm" onClick={() => setRoleTarget(null)}>Annuler</button>
            <button className="btn btn-primary btn-sm" disabled={loading} onClick={handleToggleRole}>
              {loading ? <span className="spinner" /> : 'Confirmer'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
