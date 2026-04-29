import { useState } from 'react';
import { useApp } from '../App';
import { api } from '../api';
import { X } from 'lucide-react';

export default function CreateInstanceModal({ onClose }) {
  const { seedFiles, refresh, toast } = useApp();
  const [form, setForm] = useState({ name: '', engine: 'mariadb', version: '', db: '', rootPassword: 'root', port: '', adminPort: '' });
  const [selectedSeeds, setSelectedSeeds] = useState({});
  const [loading, setLoading] = useState(false);

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const toggleSeed = (file) => {
    setSelectedSeeds((prev) => {
      const copy = { ...prev };
      if (copy[file]) delete copy[file];
      else copy[file] = file.replace(/\.sql(\.gz)?$/i, '');
      return copy;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const seedParts = Object.entries(selectedSeeds).map(([file, db]) => db ? `${file}:${db}` : file);
      await api.createInstance({
        ...form,
        seed: seedParts.length > 0 ? seedParts.join(',') : undefined,
        port: form.port ? Number(form.port) : undefined,
        adminPort: form.adminPort ? Number(form.adminPort) : undefined,
      });
      toast(`Instance '${form.name}' créée`);
      await refresh();
      onClose();
    } catch (err) {
      toast('Erreur: ' + err.message, 'danger');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h3>Nouvelle instance</h3>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={16} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body flex flex-col gap-3">
            <div>
              <label className="label">Nom de l'instance</label>
              <input className="input" value={form.name} onChange={set('name')} placeholder="ex: gescom" required pattern="[a-zA-Z0-9_-]+" />
            </div>
            <div className="grid grid-2 gap-3">
              <div>
                <label className="label">Moteur</label>
                <select className="input select" value={form.engine} onChange={set('engine')}>
                  <option value="mariadb">MariaDB</option>
                  <option value="mysql">MySQL</option>
                  <option value="postgres">PostgreSQL</option>
                </select>
              </div>
              <div>
                <label className="label">Version</label>
                <input className="input" value={form.version} onChange={set('version')} placeholder={form.engine === 'postgres' ? '16' : form.engine === 'mysql' ? '8.0' : '11'} />
              </div>
            </div>
            <div>
              <label className="label">Base par défaut</label>
              <input className="input" value={form.db} onChange={set('db')} placeholder="Optionnel" />
            </div>
            <div>
              <label className="label">Mot de passe root</label>
              <input className="input" value={form.rootPassword} onChange={set('rootPassword')} placeholder="root" />
            </div>
            <div className="grid grid-2 gap-3">
              <div>
                <label className="label">Port DB (auto si vide)</label>
                <input className="input" type="number" value={form.port} onChange={set('port')} placeholder="Auto" />
              </div>
              <div>
                <label className="label">Port Admin (auto si vide)</label>
                <input className="input" type="number" value={form.adminPort} onChange={set('adminPort')} placeholder="Auto" />
              </div>
            </div>
            {seedFiles.length > 0 && (
              <div>
                <label className="label">Fichiers seed</label>
                <div className="flex flex-col gap-2">
                  {seedFiles.map((file) => (
                    <div key={file} className="flex items-center gap-2">
                      <input type="checkbox" checked={!!selectedSeeds[file]} onChange={() => toggleSeed(file)} style={{ accentColor: 'var(--accent)' }} />
                      <span className="text-sm" style={{ minWidth: 130 }}>{file}</span>
                      {selectedSeeds[file] !== undefined && (
                        <input className="input input-sm" value={selectedSeeds[file]} onChange={(e) => setSelectedSeeds({ ...selectedSeeds, [file]: e.target.value })} placeholder="Base cible" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Annuler</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <span className="spinner" /> : 'Créer'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
