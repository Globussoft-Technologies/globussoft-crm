import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchApi } from '../../utils/api';

export default function GenericPickupPlotSelection() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [pickupLocationId, setPickupLocationId] = useState('');
  const [plotSiteId, setPlotSiteId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const endpoint = `/api/pickup-plot-inventory/public/selection/${encodeURIComponent(token || '')}`;

  useEffect(() => {
    let active = true;
    fetchApi(endpoint, { silent: true })
      .then((response) => { if (active) setData(response); })
      .catch((requestError) => { if (active) setError(requestError.message || 'This selection link is unavailable.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [endpoint]);

  const submit = async (event) => {
    event.preventDefault(); setSaving(true); setError('');
    try {
      const response = await fetchApi(endpoint, { method: 'POST', body: JSON.stringify({ pickupLocationId: Number(pickupLocationId), plotSiteId: Number(plotSiteId) }), silent: true });
      setData({ ...response, completed: true, contact: data?.contact });
    } catch (requestError) {
      if (requestError.code === 'SELECTION_ALREADY_COMPLETED') setData((current) => ({ ...current, completed: true }));
      else setError(requestError.message || 'Unable to save your selection. Please try again.');
    } finally { setSaving(false); }
  };

  return <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20, background: 'var(--background-color, #f4f7fb)' }}>
    <section style={{ width: 'min(100%, 720px)', padding: 32, borderRadius: 18, background: 'var(--card-bg, #fff)', color: 'var(--text-primary, #172033)', boxShadow: '0 20px 60px rgba(15,23,42,.12)' }} aria-labelledby="selection-title">
      <h1 id="selection-title">Choose your pickup location and plot</h1>
      {loading && <p role="status">Loading your options…</p>}
      {error && <div role="alert">{error}</div>}
      {!loading && data?.completed && <div role="status"><h2>Selection received</h2><p>Thank you{data.contact?.name ? `, ${data.contact.name}` : ''}. Your choices have been saved.</p></div>}
      {!loading && data && !data.completed && <form onSubmit={submit} style={{ display: 'grid', gap: 18 }}>
        {data.contact?.name && <p>Hi {data.contact.name}, select the pickup point and plot you prefer.</p>}
        <label>Pickup location<select className="input-field" required value={pickupLocationId} onChange={(event) => setPickupLocationId(event.target.value)}><option value="">Select a pickup location</option>{(data.pickupLocations || []).map((location) => <option key={location.id} value={location.id}>{location.name}{location.address ? ` — ${location.address}` : ''}</option>)}</select></label>
        <label>Interested plot<select className="input-field" required value={plotSiteId} onChange={(event) => setPlotSiteId(event.target.value)}><option value="">Select an available plot</option>{(data.plots || []).map((plot) => <option key={plot.id} value={plot.id}>{plot.plotNumber ? `Plot ${plot.plotNumber} — ` : ''}{plot.name}</option>)}</select></label>
        <button type="submit" className="btn-primary" disabled={saving || !pickupLocationId || !plotSiteId}>{saving ? 'Saving…' : 'Confirm selection'}</button>
      </form>}
    </section>
  </main>;
}
