import { useState } from 'react';
import { useApp } from '../App';
import { api } from '../api';
import { Database, CheckCircle, ArrowRight, Lock, Server } from 'lucide-react';

const STEPS = ['Sécuriser le compte', 'Configurer MinIO', 'Terminé'];

export default function Setup({ onComplete }) {
  const { user, toast } = useApp();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);

  // Step 1: change admin password + optionally rename
  const [pwForm, setPwForm] = useState({ username: '', newPassword: '', confirmPassword: '' });

  // Step 2: MinIO config
  const [minioForm, setMinioForm] = useState({
    endPoint: 'localhost', port: '9002', useSSL: false,
    accessKey: '', secretKey: '', bucket: 'dbserver-seeds',
  });
  const [minioTested, setMinioTested] = useState(false);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (pwForm.newPassword !== pwForm.confirmPassword) {
      return toast('Les mots de passe ne correspondent pas.', 'danger');
    }
    if (pwForm.newPassword.length < 4) return toast('4 caractères minimum.', 'danger');
    setLoading(true);
    try {
      // Get current admin ID via admin list
      const { admins } = await api.listAdmins();
      const me = admins.find(a => a.username === user.username);
      if (!me) throw new Error('Admin introuvable');
      // Reset password via superadmin endpoint (no session invalidation)
      await api.resetAdminPassword(me.id, pwForm.newPassword);
      toast('Mot de passe mis à jour.');
      setStep(1);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleTestMinio = async () => {
    setLoading(true);
    try {
      await api.saveMinioConfig({
        ...minioForm,
        port: minioForm.port ? Number(minioForm.port) : undefined,
      });
      await api.testMinioConnection();
      setMinioTested(true);
      toast('Connexion MinIO réussie !');
    } catch (err) {
      setMinioTested(false);
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  const handleFinish = async () => {
    setLoading(true);
    try {
      await api.completeSetup();
      toast('Configuration initiale terminée !');
      onComplete();
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', padding: '2rem' }}>
      <div style={{ maxWidth: 520, width: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <Database size={40} style={{ color: 'var(--primary)', marginBottom: 8 }} />
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700 }}>Configuration initiale</h1>
          <p className="text-sm text-muted">Sécurisez votre installation avant de commencer</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-4">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <div style={{
                width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 600,
                background: i <= step ? 'var(--primary)' : 'var(--panel-border)',
                color: i <= step ? 'white' : 'var(--text-muted)',
              }}>{i < step ? '✓' : i + 1}</div>
              {i < STEPS.length - 1 && <div style={{ width: 32, height: 2, background: i < step ? 'var(--primary)' : 'var(--panel-border)' }} />}
            </div>
          ))}
        </div>
        <div className="text-xs text-muted" style={{ textAlign: 'center', marginBottom: '1.5rem' }}>{STEPS[step]}</div>

        <div className="card card-body">
          {/* Step 1: Change password */}
          {step === 0 && (
            <form onSubmit={handleChangePassword}>
              <h3 className="text-sm font-semibold mb-3">
                <Lock size={16} style={{ display: 'inline', verticalAlign: -3, marginRight: 6 }} />
                Changez le mot de passe par défaut
              </h3>
              <p className="text-xs text-muted mb-4">
                Le compte par défaut est <strong>admin / admin</strong>. Vous devez le sécuriser.
              </p>
              <div className="flex flex-col gap-3 mb-4">
                <div>
                  <label className="label">Nouveau mot de passe *</label>
                  <input className="input" type="password" value={pwForm.newPassword}
                    onChange={(e) => setPwForm({ ...pwForm, newPassword: e.target.value })}
                    required minLength={4} autoComplete="new-password" autoFocus />
                </div>
                <div>
                  <label className="label">Confirmer *</label>
                  <input className="input" type="password" value={pwForm.confirmPassword}
                    onChange={(e) => setPwForm({ ...pwForm, confirmPassword: e.target.value })}
                    required minLength={4} autoComplete="new-password" />
                </div>
              </div>
              <button type="submit" className="btn btn-primary" style={{ width: '100%' }}
                disabled={loading || !pwForm.newPassword || !pwForm.confirmPassword}>
                {loading ? <span className="spinner" /> : <>Sécuriser le compte <ArrowRight size={14} /></>}
              </button>
            </form>
          )}

          {/* Step 2: MinIO config */}
          {step === 1 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">
                <Server size={16} style={{ display: 'inline', verticalAlign: -3, marginRight: 6 }} />
                Configuration MinIO (Seed Store)
              </h3>
              <p className="text-xs text-muted mb-4">
                Configurez la connexion au service de stockage MinIO pour les fichiers seed.
              </p>
              <div className="flex flex-col gap-3 mb-4">
                <div className="flex gap-2">
                  <div style={{ flex: 1 }}>
                    <label className="label">Endpoint</label>
                    <input className="input" value={minioForm.endPoint}
                      onChange={(e) => { setMinioForm({ ...minioForm, endPoint: e.target.value }); setMinioTested(false); }} />
                  </div>
                  <div style={{ width: 80 }}>
                    <label className="label">Port</label>
                    <input className="input" value={minioForm.port}
                      onChange={(e) => { setMinioForm({ ...minioForm, port: e.target.value }); setMinioTested(false); }} />
                  </div>
                </div>
                <div className="flex gap-2">
                  <div style={{ flex: 1 }}>
                    <label className="label">Access Key</label>
                    <input className="input" value={minioForm.accessKey}
                      onChange={(e) => { setMinioForm({ ...minioForm, accessKey: e.target.value }); setMinioTested(false); }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="label">Secret Key</label>
                    <input className="input" type="password" value={minioForm.secretKey}
                      onChange={(e) => { setMinioForm({ ...minioForm, secretKey: e.target.value }); setMinioTested(false); }} />
                  </div>
                </div>
                <div>
                  <label className="label">Bucket</label>
                  <input className="input" value={minioForm.bucket}
                    onChange={(e) => { setMinioForm({ ...minioForm, bucket: e.target.value }); setMinioTested(false); }} />
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={minioForm.useSSL}
                    onChange={(e) => { setMinioForm({ ...minioForm, useSSL: e.target.checked }); setMinioTested(false); }} />
                  Utiliser SSL
                </label>
              </div>
              <div className="flex gap-2">
                <button className="btn" onClick={handleTestMinio} disabled={loading || !minioForm.endPoint || !minioForm.accessKey || !minioForm.secretKey}>
                  {loading ? <span className="spinner" /> : 'Tester la connexion'}
                </button>
                <button className="btn btn-primary" onClick={() => setStep(2)} disabled={!minioTested}>
                  Continuer <ArrowRight size={14} />
                </button>
                <button className="btn btn-ghost text-xs" onClick={() => setStep(2)}>Passer</button>
              </div>
            </div>
          )}

          {/* Step 3: Done */}
          {step === 2 && (
            <div style={{ textAlign: 'center' }}>
              <CheckCircle size={48} style={{ color: 'var(--success)', margin: '0 auto 1rem' }} />
              <h3 className="text-sm font-semibold mb-2">Configuration terminée</h3>
              <p className="text-xs text-muted mb-4">
                Votre installation est sécurisée. Vous pouvez maintenant utiliser db-docker-server.
              </p>
              <button className="btn btn-primary" style={{ width: '100%' }} onClick={handleFinish} disabled={loading}>
                {loading ? <span className="spinner" /> : <>Accéder au tableau de bord <ArrowRight size={14} /></>}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
