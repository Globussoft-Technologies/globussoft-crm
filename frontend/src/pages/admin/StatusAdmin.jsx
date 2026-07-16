import { useEffect, useState } from "react";
import { fetchApi } from "../../utils/api";
import "./status-admin.css";

const IMPACTS = ["none", "minor", "major", "critical", "maintenance"];
const STATUSES = ["investigating", "identified", "monitoring", "resolved"];

function formatTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

export default function StatusAdmin() {
  const [components, setComponents] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [form, setForm] = useState({
    title: "",
    impact: "minor",
    status: "investigating",
    message: "",
    componentIds: [],
  });

  async function load() {
    try {
      setError(null);
      const [compRes, incRes] = await Promise.all([
        fetchApi("/api/status"),
        fetchApi("/api/status/incidents?limit=50"),
      ]);
      setComponents(compRes.data?.components || []);
      setIncidents(incRes.data?.incidents || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.message.trim()) return;
    try {
      await fetchApi("/api/status/incidents", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({
        title: "",
        impact: "minor",
        status: "investigating",
        message: "",
        componentIds: [],
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  async function postUpdate(incidentId, status, message) {
    if (!message.trim()) return;
    try {
      await fetchApi(`/api/status/incidents/${incidentId}/updates`, {
        method: "POST",
        body: JSON.stringify({ status, message }),
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleComponent(id) {
    setForm((prev) => ({
      ...prev,
      componentIds: prev.componentIds.includes(id)
        ? prev.componentIds.filter((x) => x !== id)
        : [...prev.componentIds, id],
    }));
  }

  if (loading) {
    return <div className="status-admin__loading">Loading status admin...</div>;
  }

  return (
    <div className="status-admin">
      <h1 className="status-admin__title">Status Incident Management</h1>

      {error && <div className="status-admin__error">{error}</div>}

      <section className="status-admin__section">
        <h2 className="status-admin__section-title">Declare New Incident</h2>
        <form onSubmit={handleCreate} className="status-admin__form">
          <label className="status-admin__field">
            Title{' '}
            <input
              type="text"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="e.g. Database maintenance window"
              maxLength={200}
              required
            />
          </label>

          <div className="status-admin__row">
            <label className="status-admin__field">
              Impact{' '}
              <select
                value={form.impact}
                onChange={(e) => setForm({ ...form, impact: e.target.value })}
              >
                {IMPACTS.map((i) => (
                  <option key={i} value={i}>
                    {i}
                  </option>
                ))}
              </select>
            </label>

            <label className="status-admin__field">
              Status{' '}
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value })}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="status-admin__field">
            Initial update message{' '}
            <textarea
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              rows={3}
              maxLength={2000}
              required
            />
          </label>

          <fieldset className="status-admin__fieldset">
            <legend>Affected components</legend>
            <div className="status-admin__checkboxes">
              {components.map((c) => (
                <label key={c.id} className="status-admin__checkbox">
                  <input
                    type="checkbox"
                    checked={form.componentIds.includes(c.id)}
                    onChange={() => toggleComponent(c.id)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
          </fieldset>

          <button type="submit" className="status-admin__button">
            Create Incident
          </button>
        </form>
      </section>

      <section className="status-admin__section">
        <h2 className="status-admin__section-title">Active Incidents</h2>
        {incidents.filter((i) => i.status !== "resolved").length === 0 ? (
          <p className="status-admin__empty">No active incidents.</p>
        ) : (
          incidents
            .filter((i) => i.status !== "resolved")
            .map((inc) => (
              <IncidentCard
                key={inc.id}
                incident={inc}
                components={components}
                onPostUpdate={postUpdate}
              />
            ))
        )}
      </section>

      <section className="status-admin__section">
        <h2 className="status-admin__section-title">Recent Resolved Incidents</h2>
        {incidents.filter((i) => i.status === "resolved").length === 0 ? (
          <p className="status-admin__empty">No resolved incidents yet.</p>
        ) : (
          incidents
            .filter((i) => i.status === "resolved")
            .slice(0, 10)
            .map((inc) => (
              <IncidentCard
                key={inc.id}
                incident={inc}
                components={components}
                onPostUpdate={postUpdate}
              />
            ))
        )}
      </section>
    </div>
  );
}

function IncidentCard({ incident, components, onPostUpdate }) {
  const [updateText, setUpdateText] = useState("");
  const [updateStatus, setUpdateStatus] = useState(
    incident.status === "resolved" ? "resolved" : "monitoring",
  );

  const affected = incident.components
    .map((c) => components.find((x) => x.id === c.id)?.name || c.name)
    .join(", ");

  return (
    <div className="status-admin__card">
      <div className="status-admin__card-header">
        <h3 className="status-admin__card-title">{incident.title}</h3>
        <span className={`status-admin__badge status-admin__badge--${incident.status}`}>
          {incident.status}
        </span>
      </div>
      <p className="status-admin__card-meta">
        {formatTime(incident.createdAt)} — Impact: {incident.impact} — Affected: {affected || "All systems"}
      </p>

      <div className="status-admin__updates">
        {(incident.updates || []).map((u) => (
          <div key={u.id} className="status-admin__update">
            <strong>{u.status}</strong> — {formatTime(u.createdAt)}
            <p>{u.message}</p>
          </div>
        ))}
      </div>

      {incident.status !== "resolved" && (
        <div className="status-admin__update-form">
          <label className="status-admin__field">
            New update{' '}
            <textarea
              value={updateText}
              onChange={(e) => setUpdateText(e.target.value)}
              rows={2}
              maxLength={2000}
              placeholder="Post an update..."
            />
          </label>
          <div className="status-admin__row">
            <label className="status-admin__field">
              Update status{' '}
              <select
                value={updateStatus}
                onChange={(e) => setUpdateStatus(e.target.value)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="status-admin__button status-admin__button--secondary"
              onClick={() => {
                onPostUpdate(incident.id, updateStatus, updateText);
                setUpdateText("");
              }}
            >
              Post Update
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
