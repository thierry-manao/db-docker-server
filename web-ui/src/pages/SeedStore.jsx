import { useState, useEffect, useCallback } from 'react';
import { useApp } from '../App';
import { api } from '../api';
import { Database, Cloud, CloudUpload, CloudDownload, Upload, Trash2, RefreshCw, Check, AlertTriangle, HardDrive, Shield, Server } from 'lucide-react';

export default function SeedStore() {
  const { toast } = useApp();
  const [localFiles, setLocalFiles] = useState([]);
  const [minioFiles, setMinioFiles] = useState([]);
  const [minioConfig, setMinioConfig] = useState(null);
  const [minioService, setMinioService] = useState(null);
  const [loading, setLoading] = useState(true);
  const [configForm, setConfigForm] = useState({ endPoint: '', port: '', useSSL: false, accessKey: '', secretKey: '', bucket: 'dbserver-seeds' });
  const [serviceForm, setServiceForm] = useState({ rootUser: '', rootPassword: '', apiPort: '9002', consolePort: '9003' });
  const [showConfig, setShowConfig] = useState(false);
  const [showServiceConfig, setShowServiceConfig] = useState(false);
  const [testing, setTesting] = useState(false);
  const [serviceLoading, setServiceLoading] = useState(false);
  const [uploading, setUploading] = useState(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [seeds, cfg, svc] = await Promise.all([api.seedFiles(), api.getMinioConfig(), api.getMinioService()]);
      setLocalFiles(seeds.files || []);
      setMinioConfig(cfg);
      setMinioService(svc);
      if (cfg.configured) {
        try {
          const mf = await api.listMinioFiles();
          setMinioFiles(mf.files || []);
        } catch (err) {
          toast('MinIO: ' + err.message, 'danger');
          setMinioFiles([]);
        }
      }
    } catch (err) { toast('Erreur: ' + err.message, 'danger'); }
    finally { setLoading(false); }
  }, [toast]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const handleSaveConfig = async (e) => {
    e.preventDefault();
    try {
      await api.saveMinioConfig(configForm);
      toast('Configuration MinIO sauvegardée');
      setShowConfig(false);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    try {
      await api.testMinioConnection();
      toast('Connexion MinIO réussie !');
    } catch (err) { toast(err.message, 'danger'); }
    finally { setTesting(false); }
  };

  const handleRemoveConfig = async () => {
    if (!confirm('Supprimer la configuration MinIO ?')) return;
    try {
      await api.removeMinioConfig();
      toast('Configuration MinIO supprimée');
      setMinioConfig(null);
      setMinioFiles([]);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
  };

  const handleUpdateService = async (e) => {
    e.preventDefault();
    if (serviceForm.rootPassword.length < 4) { toast('Le mot de passe doit faire au moins 4 caractères', 'danger'); return; }
    setServiceLoading(true);
    try {
      const res = await api.updateMinioService(serviceForm);
      toast(res.message);
      setShowServiceConfig(false);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setServiceLoading(false); }
  };

  const handleUploadToMinio = async (file) => {
    setUploading(file);
    try {
      const res = await api.uploadToMinio(file);
      toast(res.message);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setUploading(null); }
  };

  const handleDownloadFromMinio = async (file) => {
    setUploading(file);
    try {
      const res = await api.downloadFromMinio(file);
      toast(res.message);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setUploading(null); }
  };

  const handleDeleteFromMinio = async (file) => {
    if (!confirm(`Supprimer '${file}' de MinIO ?`)) return;
    try {
      await api.deleteFromMinio(file);
      toast(`${file} supprimé de MinIO`);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
  };

  const handleBrowserUploadMinio = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(file.name);
    try {
      const res = await api.uploadFileToMinio(file);
      toast(res.message);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setUploading(null); e.target.value = ''; }
  };

  const handleBrowserUploadLocal = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(file.name);
    try {
      const res = await api.uploadSeedFile(file);
      toast(res.message);
      loadAll();
    } catch (err) { toast(err.message, 'danger'); }
    finally { setUploading(null); e.target.value = ''; }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  };

  const localSet = new Set(localFiles);
  const minioSet = new Set(minioFiles.map(f => f.name));

  if (loading) return <div className="text-center p-4"><span className="spinner" /></div>;

  return (
    <div className="flex flex-col gap-4">
      {/* MinIO Config */}
      <div className="card card-body">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">
            <Cloud size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
            MinIO / S3 Store
          </h4>
          <div className="flex gap-2">
            {minioConfig?.configured && (
              <>
                <button className="btn btn-outline btn-sm" onClick={handleTestConnection} disabled={testing}>
                  {testing ? <span className="spinner" /> : <><Check size={12} /> Tester</>}
                </button>
                <button className="btn btn-ghost btn-sm text-danger" onClick={handleRemoveConfig}>
                  <Trash2 size={12} />
                </button>
              </>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => { setShowConfig(!showConfig); if (minioConfig?.configured) setConfigForm({ endPoint: minioConfig.endPoint, port: minioConfig.port, useSSL: minioConfig.useSSL, accessKey: minioConfig.accessKey, secretKey: '', bucket: minioConfig.bucket }); }}>
              {minioConfig?.configured ? 'Modifier' : 'Configurer'}
            </button>
          </div>
        </div>

        {!minioConfig?.configured && !showConfig && (
          <p className="text-sm text-muted">Aucun stockage MinIO/S3 configuré. Configurez un endpoint pour synchroniser les seed files.</p>
        )}

        {minioConfig?.configured && !showConfig && (
          <div className="flex gap-4 text-xs text-muted">
            <span><strong>Endpoint:</strong> {minioConfig.endPoint}{minioConfig.port ? ':' + minioConfig.port : ''}</span>
            <span><strong>Bucket:</strong> {minioConfig.bucket}</span>
            <span><strong>SSL:</strong> {minioConfig.useSSL ? 'Oui' : 'Non'}</span>
          </div>
        )}

        {showConfig && (
          <form onSubmit={handleSaveConfig} className="mt-3">
            <div className="grid grid-2 gap-3 mb-3">
              <div>
                <label className="label">Endpoint *</label>
                <input className="input input-sm" value={configForm.endPoint} onChange={e => setConfigForm({ ...configForm, endPoint: e.target.value })} placeholder="minio.example.com" required />
              </div>
              <div>
                <label className="label">Port</label>
                <input className="input input-sm" type="number" value={configForm.port} onChange={e => setConfigForm({ ...configForm, port: e.target.value })} placeholder="9000" />
              </div>
              <div>
                <label className="label">Access Key *</label>
                <input className="input input-sm" value={configForm.accessKey} onChange={e => setConfigForm({ ...configForm, accessKey: e.target.value })} required />
              </div>
              <div>
                <label className="label">Secret Key *</label>
                <input className="input input-sm" type="password" value={configForm.secretKey} onChange={e => setConfigForm({ ...configForm, secretKey: e.target.value })} placeholder={minioConfig?.configured ? '(inchangé si vide)' : ''} required={!minioConfig?.configured} />
              </div>
              <div>
                <label className="label">Bucket</label>
                <input className="input input-sm" value={configForm.bucket} onChange={e => setConfigForm({ ...configForm, bucket: e.target.value })} placeholder="dbserver-seeds" />
              </div>
              <div className="flex items-center gap-2" style={{ paddingTop: 22 }}>
                <input type="checkbox" checked={configForm.useSSL} onChange={e => setConfigForm({ ...configForm, useSSL: e.target.checked })} />
                <label className="text-sm">Utiliser SSL (HTTPS)</label>
              </div>
            </div>
            <div className="flex gap-2">
              <button type="submit" className="btn btn-primary btn-sm">Sauvegarder</button>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => setShowConfig(false)}>Annuler</button>
            </div>
          </form>
        )}
      </div>

      {/* MinIO Service Credentials */}
      {minioService?.available && (
        <div className="card card-body">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">
              <Shield size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
              Service MinIO
              <span className={`badge ml-2 ${minioService.running ? 'badge-success' : 'badge-danger'}`} style={{ fontSize: '0.65rem' }}>
                {minioService.running ? 'Running' : 'Stopped'}
              </span>
            </h4>
            <button className="btn btn-outline btn-sm" onClick={() => { setShowServiceConfig(!showServiceConfig); setServiceForm({ rootUser: minioService.rootUser || 'minioadmin', rootPassword: '', apiPort: minioService.apiPort || '9002', consolePort: minioService.consolePort || '9003' }); }}>
              {showServiceConfig ? 'Annuler' : 'Modifier les identifiants'}
            </button>
          </div>

          {!showServiceConfig && (
            <div className="flex gap-4 text-xs text-muted">
              <span><strong>Utilisateur:</strong> {minioService.rootUser}</span>
              <span><strong>API Port:</strong> {minioService.apiPort}</span>
              <span><strong>Console:</strong> <a href={`http://${window.location.hostname}:${minioService.consolePort}`} target="_blank" rel="noreferrer">{window.location.hostname}:{minioService.consolePort}</a></span>
            </div>
          )}

          {showServiceConfig && (
            <form onSubmit={handleUpdateService}>
              <div className="grid grid-2 gap-3 mb-3">
                <div>
                  <label className="label">Utilisateur root *</label>
                  <input className="input input-sm" value={serviceForm.rootUser} onChange={e => setServiceForm({ ...serviceForm, rootUser: e.target.value })} required />
                </div>
                <div>
                  <label className="label">Mot de passe root *</label>
                  <input className="input input-sm" type="password" value={serviceForm.rootPassword} onChange={e => setServiceForm({ ...serviceForm, rootPassword: e.target.value })} required minLength={4} placeholder="Nouveau mot de passe" />
                </div>
                <div>
                  <label className="label">Port API</label>
                  <input className="input input-sm" type="number" value={serviceForm.apiPort} onChange={e => setServiceForm({ ...serviceForm, apiPort: e.target.value })} />
                </div>
                <div>
                  <label className="label">Port Console</label>
                  <input className="input input-sm" type="number" value={serviceForm.consolePort} onChange={e => setServiceForm({ ...serviceForm, consolePort: e.target.value })} />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button type="submit" className="btn btn-primary btn-sm" disabled={serviceLoading}>
                  {serviceLoading ? <span className="spinner" /> : 'Mettre à jour et redémarrer'}
                </button>
                <span className="text-xs text-muted">Le service MinIO sera redémarré. La config de connexion sera mise à jour automatiquement.</span>
              </div>
            </form>
          )}
        </div>
      )}

      {/* Two-column layout: Local + MinIO */}
      <div className="grid grid-2 gap-4">
        {/* Local seed/ files */}
        <div className="card card-body">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">
              <HardDrive size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
              Fichiers locaux (seed/)
            </h4>
            <div className="flex gap-2">
              <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
                <Upload size={12} /> Importer
                <input type="file" accept=".sql,.sql.gz" onChange={handleBrowserUploadLocal} hidden />
              </label>
              <button className="btn btn-ghost btn-sm" onClick={loadAll}><RefreshCw size={12} /></button>
            </div>
          </div>
          {localFiles.length === 0 ? (
            <p className="text-sm text-muted text-center p-4">Aucun fichier SQL dans seed/</p>
          ) : (
            <div className="flex flex-col gap-1">
              {localFiles.map(file => (
                <div key={file} className="flex items-center justify-between p-2" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
                  <div className="flex items-center gap-2">
                    <Database size={13} className="text-muted" />
                    <span className="text-sm font-medium">{file}</span>
                    {minioSet.has(file) && <span className="badge badge-success text-xs" title="Aussi sur MinIO">synced</span>}
                  </div>
                  {minioConfig?.configured && !minioSet.has(file) && (
                    <button className="btn btn-ghost btn-sm" onClick={() => handleUploadToMinio(file)} disabled={uploading === file} title="Envoyer vers MinIO">
                      {uploading === file ? <span className="spinner" /> : <CloudUpload size={14} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* MinIO files */}
        <div className="card card-body">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-semibold">
              <Cloud size={14} style={{ display: 'inline', verticalAlign: -2, marginRight: 6 }} />
              Fichiers MinIO
              {minioConfig?.configured && <span className="text-xs text-muted ml-2">({minioConfig.bucket})</span>}
            </h4>
            {minioConfig?.configured && (
              <div className="flex gap-2">
                <label className="btn btn-outline btn-sm" style={{ cursor: 'pointer' }}>
                  <Upload size={12} /> Upload
                  <input type="file" accept=".sql,.sql.gz" onChange={handleBrowserUploadMinio} hidden />
                </label>
                <button className="btn btn-ghost btn-sm" onClick={loadAll}><RefreshCw size={12} /></button>
              </div>
            )}
          </div>
          {!minioConfig?.configured ? (
            <p className="text-sm text-muted text-center p-4">Configurez MinIO pour accéder au store distant.</p>
          ) : minioFiles.length === 0 ? (
            <p className="text-sm text-muted text-center p-4">Aucun fichier dans le bucket.</p>
          ) : (
            <div className="flex flex-col gap-1">
              {minioFiles.map(f => (
                <div key={f.name} className="flex items-center justify-between p-2" style={{ background: 'var(--bg)', borderRadius: 'var(--radius-sm)' }}>
                  <div className="flex items-center gap-2">
                    <Cloud size={13} className="text-muted" />
                    <span className="text-sm font-medium">{f.name}</span>
                    <span className="text-xs text-muted">{formatSize(f.size)}</span>
                    {localSet.has(f.name) && <span className="badge badge-success text-xs">local</span>}
                  </div>
                  <div className="flex gap-1">
                    {!localSet.has(f.name) && (
                      <button className="btn btn-ghost btn-sm" onClick={() => handleDownloadFromMinio(f.name)} disabled={uploading === f.name} title="Télécharger en local">
                        {uploading === f.name ? <span className="spinner" /> : <CloudDownload size={14} />}
                      </button>
                    )}
                    <button className="btn btn-ghost btn-sm text-danger" onClick={() => handleDeleteFromMinio(f.name)} title="Supprimer de MinIO">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
