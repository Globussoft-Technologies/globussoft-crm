import { useEffect, useState } from 'react';
import { Eye, EyeOff, MapPinned } from 'lucide-react';
import { fetchApi } from '../utils/api';
import { useNotify } from '../utils/notify';

export default function GoogleMapsSettingsCard() {
  const notify = useNotify();
  const [status, setStatus] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchApi('/api/settings/google-maps')
      .then((result) => {
        if (cancelled) return;
        setStatus(result);
        setEnabled(result?.enabled === true);
      })
      .catch((error) => {
        if (!cancelled) notify.error(error?.message || 'Could not load Google Maps settings.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [notify]);

  const save = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await fetchApi('/api/settings/google-maps', {
        method: 'PUT',
        body: JSON.stringify({
          enabled,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      setStatus(result);
      setEnabled(result.enabled === true);
      setApiKey('');
      setShowKey(false);
      notify.success(result.enabled ? 'Google Maps address suggestions enabled.' : 'Google Maps address suggestions disabled.');
    } catch (error) {
      notify.error(error?.message || 'Could not save Google Maps settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card" data-testid="google-maps-settings-card" style={{ padding: 'clamp(1.25rem, 3vw, 2rem)' }}>
      <h3 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <MapPinned size={20} color="var(--primary-color, var(--accent-color))" /> Google Maps Address Search
      </h3>
      <p style={{ margin: '0 0 1.25rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Enable exact Google address and Plus Code suggestions in Generic CRM pickup-location and plot/site forms. The API key is stored server-side and is never returned to the browser.
      </p>
      {loading ? <p style={{ color: 'var(--text-secondary)' }}>Loading Google Maps settings…</p> : (
        <form onSubmit={save} autoComplete="off">
          <label className="form-label" htmlFor="google-maps-api-key">Google Maps API key</label>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              id="google-maps-api-key"
              type={showKey ? 'text' : 'password'}
              className="input-field"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={status?.configured ? `Saved (${status.last4 || 'hidden'}) — leave blank to keep it` : 'AIzaSy…'}
              autoComplete="new-password"
              data-1p-ignore="true"
              style={{ flex: 1, minWidth: 0 }}
            />
            <button type="button" className="btn-secondary" aria-label={showKey ? 'Hide Google Maps API key' : 'Show Google Maps API key'} onClick={() => setShowKey((current) => !current)} style={{ padding: '0.6rem 0.8rem' }}>
              {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
            </button>
          </div>
          <p style={{ margin: '0.45rem 0 0', color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.45 }}>
            Create this in Google Cloud, enable Places API (New), and restrict the key to your backend server IP and that API.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', marginTop: '1rem', fontWeight: 600 }}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Enable Google Maps address suggestions
          </label>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '1.25rem' }}>
            <button type="submit" className="btn-primary" disabled={saving || (!status?.configured && !apiKey.trim())}>
              {saving ? 'Saving…' : 'Save Google Maps Settings'}
            </button>
            <span style={{ color: enabled && status?.configured ? 'var(--success-color, #16a34a)' : 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {enabled && status?.configured
                ? 'Enabled using this organization’s key.'
                : status?.configured
                  ? 'A key is saved, but Google address suggestions are disabled.'
                  : 'No Google Maps API key is configured.'}
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
