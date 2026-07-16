import { Fragment, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Info,
  Loader2,
  AlertCircle,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Rectangle,
} from "recharts";
import "./status-page.css";

const API_BASE = import.meta.env.VITE_API_URL || "";

const STATUS_META = {
  operational: { label: "Operational", color: "#16a34a", className: "operational" },
  degraded: { label: "Degraded Performance", color: "#ca8a04", className: "degraded" },
  partial_outage: { label: "Partial Outage", color: "#ea580c", className: "partial_outage" },
  major_outage: { label: "Major Outage", color: "#dc2626", className: "major_outage" },
  maintenance: { label: "Maintenance", color: "#9333ea", className: "maintenance" },
  no_data: { label: "No Data", color: "#6b7280", className: "no_data" },
};

const STATUS_ORDER = {
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
  no_data: 5,
};

function formatTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.no_data;
  return (
    <span className={`status-page__status status-page__status--${meta.className}`}>
      <span className="status-page__status-dot" />
      {meta.label}
    </span>
  );
}

function Banner({ overall, updatedAt }) {
  const meta = STATUS_META[overall] || STATUS_META.no_data;
  let Icon = CheckCircle2;
  if (overall === "degraded") Icon = AlertTriangle;
  if (overall === "partial_outage" || overall === "maintenance") Icon = Info;
  if (overall === "major_outage") Icon = XCircle;

  return (
    <div className={`status-page__banner status-page__banner--${meta.className}`}>
      <Icon size={36} className="status-page__banner-icon" />
      <div>
        <h2 className="status-page__banner-title">{meta.label}</h2>
        <p className="status-page__banner-subtitle">
          Last updated: {formatTime(updatedAt)}
        </p>
      </div>
    </div>
  );
}

function BarShape(props) {
  const { fill, payload, ...rest } = props;
  return <Rectangle {...rest} fill={payload?.fill || fill} />;
}

function ComponentList({ components }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const c of components) {
      if (!map.has(c.group)) map.set(c.group, []);
      map.get(c.group).push(c);
    }
    return Array.from(map.entries());
  }, [components]);

  return (
    <div className="status-page__section">
      <h3 className="status-page__section-title">Current Status by Service</h3>
      <div className="status-page__card">
        {groups.map(([group, items]) => (
          <Fragment key={group}>
            {items.map((c) => (
              <div key={c.id} className="status-page__component">
                <div>
                  <p className="status-page__component-name">{c.name}</p>
                  <p className="status-page__component-group">{group}</p>
                </div>
                <StatusPill status={c.status} />
              </div>
            ))}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function UptimeChart({ history }) {
  const data = useMemo(() => {
    if (!history?.rows?.length) return [];
    // Show the component with the worst recent status, or the first one.
    const worstRow = history.rows.reduce((worst, row) => {
      const worstDay = row.days[row.days.length - 1];
      const currentWorst = worst.days[worst.days.length - 1];
      if (!worstDay) return worst;
      if (!currentWorst) return row;
      return (STATUS_ORDER[worstDay.worstStatus] || 0) >=
        (STATUS_ORDER[currentWorst.worstStatus] || 0)
        ? row
        : worst;
    }, history.rows[0]);

    return (worstRow?.days || []).map((d) => ({
      date: d.date.slice(5),
      status: d.worstStatus,
      uptimePct: d.uptimePct,
      fill: (STATUS_META[d.worstStatus] || STATUS_META.no_data).color,
    }));
  }, [history]);

  if (!data.length) {
    return (
      <div className="status-page__section">
        <h3 className="status-page__section-title">Uptime History</h3>
        <div className="status-page__card status-page__chart-empty">
          <AlertCircle size={24} style={{ marginBottom: 8 }} />
          <div>No uptime data yet — history will appear after the first daily snapshot.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="status-page__section">
      <h3 className="status-page__section-title">Uptime History (30 Days)</h3>
      <div className="status-page__card status-page__chart">
        <ResponsiveContainer width="100%" height={180}>
          <BarChart data={data}>
            <XAxis dataKey="date" tick={{ fontSize: 12 }} interval="preserveStartEnd" />
            <YAxis hide domain={[0, 100]} />
            <Tooltip
              formatter={(value, _name, props) => {
                const s = props?.payload?.status;
                return [`${value}% — ${STATUS_META[s]?.label || s}`, "Uptime"];
              }}
              labelFormatter={(label) => label}
            />
            <Bar dataKey="uptimePct" radius={[4, 4, 0, 0]} shape={BarShape} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function IncidentList({ title, incidents }) {
  if (!incidents?.length) return null;

  return (
    <div className="status-page__section">
      <h3 className="status-page__section-title">{title}</h3>
      <div className="status-page__card">
        {incidents.map((inc) => (
          <div key={inc.id} className="status-page__incident">
            <div className="status-page__incident-header">
              <h4 className="status-page__incident-title">{inc.title}</h4>
              <StatusPill status={inc.status} />
            </div>
            <p className="status-page__incident-meta">
              {formatTime(inc.createdAt)} — Affected: {inc.components?.join(", ") || "All systems"}
            </p>
            {(inc.updates || []).map((u) => (
              <div key={u.id} className="status-page__incident-update">
                <p className="status-page__incident-update-meta">
                  {u.status} — {formatTime(u.createdAt)}
                </p>
                <p className="status-page__incident-update-message">{u.message}</p>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function StatusPage() {
  const [status, setStatus] = useState(null);
  const [history, setHistory] = useState(null);
  const [incidents, setIncidents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [statusRes, historyRes, incidentsRes] = await Promise.all([
          fetch(`${API_BASE}/api/status`),
          fetch(`${API_BASE}/api/status/history?days=30`),
          fetch(`${API_BASE}/api/status/incidents?limit=20`),
        ]);

        if (cancelled) return;

        const [statusJson, historyJson, incidentsJson] = await Promise.all([
          statusRes.json(),
          historyRes.json(),
          incidentsRes.json(),
        ]);

        if (statusJson.success) setStatus(statusJson.data);
        if (historyJson.success) setHistory(historyJson.data);
        if (incidentsJson.success) setIncidents(incidentsJson.data.incidents);
      } catch (err) {
        console.error("[StatusPage] load failed:", err);
        setError("Unable to load status information. Please try again later.");
      }
    }

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (error) {
    return (
      <div className="status-page">
        <div className="status-page__container">
          <div className="status-page__error">
            <AlertTriangle size={40} style={{ marginBottom: 12 }} />
            <div>{error}</div>
          </div>
        </div>
      </div>
    );
  }

  if (!status) {
    return (
      <div className="status-page">
        <div className="status-page__container">
          <div className="status-page__loading">
            <Loader2 size={36} className="spin" style={{ marginBottom: 12 }} />
            <div>Loading status...</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="status-page">
      <div className="status-page__container">
        <header className="status-page__header">
          <div className="status-page__logo">G</div>
          <h1 className="status-page__title">Globussoft CRM Status</h1>
        </header>

        <Banner overall={status.overall} updatedAt={status.updatedAt} />

        <ComponentList components={status.components} />

        <UptimeChart history={history} />

        <IncidentList title="Active Incidents" incidents={status.activeIncidents} />

        <IncidentList title="Past Incidents" incidents={incidents} />

        <footer className="status-page__footer">
          <a href="/api/status/feed.rss" target="_blank" rel="noreferrer">
            RSS
          </a>
          {' · '}
          <a href="/api/status/feed.atom" target="_blank" rel="noreferrer">
            Atom
          </a>
          {' · '}
          <span>Refreshes automatically every 60 seconds</span>
        </footer>
      </div>
    </div>
  );
}
