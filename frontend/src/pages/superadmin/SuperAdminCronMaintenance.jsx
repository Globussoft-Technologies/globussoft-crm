import { useEffect, useState, useCallback, useMemo } from "react";
import {
  RefreshCw,
  Plus,
  Play,
  Trash2,
  Power,
  PowerOff,
  Pencil,
  X,
  ListFilter,
  Search,
} from "lucide-react";
import { superAdminFetch } from "../../utils/superAdminApi";
import { useNotify } from "../../utils/notify";
import CalendarRangePicker from "../../components/CalendarRangePicker";

function useHandlerCatalog() {
  const [handlers, setHandlers] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    superAdminFetch("/cron/cron-handlers")
      .then((data) => {
        if (!mounted) return;
        setHandlers(data.handlers || []);
      })
      .catch(() => {
        if (!mounted) return;
        setHandlers([]);
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  return { handlers, loading };
}

// Quick-pick presets for the schedule editor so most admins never need to
// type a raw cron expression. "Custom" (the plain input below) covers
// anything else, including the odd offsets (":13", ":37") the built-in
// engines use to avoid a top-of-the-hour thundering herd.
const SCHEDULE_PRESETS = [
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 9:00 AM", value: "0 9 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekly (Monday 1 AM)", value: "0 1 * * 1" },
];

function StatusPill({ status }) {
  const colors = {
    success: { bg: "rgba(46,125,50,0.15)", fg: "#6fcf73" },
    failed: { bg: "rgba(239,68,68,0.15)", fg: "#f28b82" },
    running: { bg: "rgba(59,130,246,0.15)", fg: "#60a5fa" },
  };
  const c = colors[status] || { bg: "rgba(154,160,171,0.15)", fg: "#9aa0ab" };
  return (
    <span style={{ background: c.bg, color: c.fg, padding: "2px 8px", borderRadius: 10, fontSize: "0.7rem", fontWeight: 700, textTransform: "uppercase" }}>
      {status || "—"}
    </span>
  );
}

function fmtDate(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString();
  } catch {
    return String(d);
  }
}

// Plain-English relative time ("2 minutes ago") — falls back to the full
// date once it's more than a week old, since "312 hours ago" stops being
// useful and an admin scanning the table wants an absolute date at that point.
function fmtRelative(d) {
  if (!d) return "—";
  const then = new Date(d).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = Date.now() - then;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return fmtDate(d);
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtHour12(h, m) {
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * Translates a 5-field cron expression into a plain-English phrase for
 * non-technical admins. Falls back to the raw expression (still shown
 * alongside, in monospace) for anything this doesn't recognize — this is
 * a readability aid, not a full cron parser.
 */
function describeCronSchedule(expr) {
  const raw = String(expr || "").trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;

  // Every N minutes/seconds — "*/N * * * *"
  if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const n = min.slice(2);
    return `Every ${n} minute${n === "1" ? "" : "s"}`;
  }
  // Every minute
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }
  // Every N hours — "0 */N * * *"
  if (/^\d+$/.test(min) && /^\*\/\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
    const n = hour.slice(2);
    return `Every ${n} hour${n === "1" ? "" : "s"}`;
  }
  // Every hour, on the :MM
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return `Every hour, at :${min.padStart(2, "0")}`;
  }
  // Multiple fixed minutes every hour — "13,43 * * * *"
  if (/^\d+(,\d+)+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    const minutes = min.split(",");
    const paddedList = minutes.map((m) => `:${m.padStart(2, "0")}`).join(", ");
    return `${minutes.length}x per hour (at ${paddedList})`;
  }
  // Daily at fixed time — "M H * * *"
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && dow === "*") {
    return `Every day at ${fmtHour12(parseInt(hour, 10), parseInt(min, 10))}`;
  }
  // Weekly at fixed time on one day — "M H * * D"
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && month === "*" && /^\d$/.test(dow)) {
    const dayName = DAY_NAMES[parseInt(dow, 10)] || `day ${dow}`;
    return `Every ${dayName} at ${fmtHour12(parseInt(hour, 10), parseInt(min, 10))}`;
  }
  return null; // unrecognized shape — caller falls back to raw expression only
}

function ScheduleDisplay({ schedule }) {
  const plain = describeCronSchedule(schedule);
  return (
    <div>
      <div>{plain || <span style={{ fontFamily: "monospace" }}>{schedule}</span>}</div>
      {plain && (
        <div style={{ fontSize: "0.68rem", color: "var(--text-secondary, #9aa0ab)", fontFamily: "monospace" }}>
          {schedule}
        </div>
      )}
    </div>
  );
}

export default function SuperAdminCronMaintenance() {
  const notify = useNotify();
  const { handlers } = useHandlerCatalog();
  const [tab, setTab] = useState("crons"); // 'crons' | 'logs' | 'settings'
  const [crons, setCrons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState(null); // cron object being edited, or null
  const [scheduleEditing, setScheduleEditing] = useState(null); // cron name whose schedule is being edited
  const [scheduleDraft, setScheduleDraft] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState(""); // '' | 'enabled' | 'disabled'

  const filteredCrons = useMemo(() => {
    const q = search.trim().toLowerCase();
    return crons.filter((c) => {
      if (statusFilter === "enabled" && !c.enabled) return false;
      if (statusFilter === "disabled" && c.enabled) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || (c.description || "").toLowerCase().includes(q);
    });
  }, [crons, search, statusFilter]);

  const loadCrons = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await superAdminFetch("/cron/crons");
      setCrons(data.crons || []);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadCrons();
  }, [loadCrons]);

  const handleToggleEnabled = async (cron) => {
    try {
      const data = await superAdminFetch(`/cron/crons/${encodeURIComponent(cron.name)}/${cron.enabled ? "disable" : "enable"}`, {
        method: "POST",
      });
      // Patch just this row in place — avoids a full reload flashing the
      // table to "Loading…" and losing scroll position for a one-field change.
      // data.cron is the raw CronConfig row (no isRegisteredInProcess/lastExecutionAt/
      // lastStatus decoration), so merge onto the existing row rather than replace it.
      setCrons((prev) => prev.map((c) => (c.name === cron.name ? { ...c, ...data.cron } : c)));
    } catch (e) {
      notify.error(e.message);
    }
  };

  const handleRunNow = async (cron) => {
    try {
      const data = await superAdminFetch(`/cron/crons/${encodeURIComponent(cron.name)}/run-now`, { method: "POST" });
      notify.success(`Ran "${cron.name}": ${data.result.status}${data.result.errorMessage ? " — " + data.result.errorMessage : ""}`);
      // Patch just this row in place — the run just completed, so reflect
      // it immediately instead of a full reload that flashes "Loading…".
      setCrons((prev) =>
        prev.map((c) =>
          c.name === cron.name ? { ...c, lastExecutionAt: new Date().toISOString(), lastStatus: data.result.status } : c,
        ),
      );
    } catch (e) {
      notify.error(e.message);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await superAdminFetch(`/cron/crons/${encodeURIComponent(deleteTarget.name)}`, { method: "DELETE" });
      setCrons((prev) => prev.filter((c) => c.name !== deleteTarget.name));
      setDeleteTarget(null);
    } catch (e) {
      notify.error(e.message);
    }
  };

  const openScheduleEdit = (cron) => {
    setScheduleEditing(cron.name);
    setScheduleDraft(cron.schedule);
  };

  const submitScheduleEdit = async () => {
    try {
      const data = await superAdminFetch(`/cron/crons/${encodeURIComponent(scheduleEditing)}/schedule`, {
        method: "PUT",
        body: JSON.stringify({ schedule: scheduleDraft }),
      });
      setCrons((prev) => prev.map((c) => (c.name === scheduleEditing ? { ...c, ...data.cron } : c)));
      setScheduleEditing(null);
    } catch (e) {
      notify.error(e.message);
    }
  };

  return (
    <div>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.25rem", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, margin: 0 }}>Cron Maintenance</h1>
          <p style={{ color: "var(--text-secondary, #9aa0ab)", fontSize: "0.85rem", margin: "4px 0 0" }}>
            View, schedule, enable/disable, and audit every cron engine on this server.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-secondary" onClick={loadCrons} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <RefreshCw size={15} /> Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)} style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Plus size={15} /> Create Cron
          </button>
        </div>
      </header>

      <div style={{ display: "flex", gap: 6, marginBottom: "1rem", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
        {[
          { key: "crons", label: "All Crons" },
          { key: "logs", label: "Execution Logs" },
          { key: "settings", label: "Log Retention" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              background: "none",
              border: "none",
              borderBottom: tab === t.key ? "2px solid var(--accent-color, #3b82f6)" : "2px solid transparent",
              color: tab === t.key ? "var(--accent-color, #3b82f6)" : "var(--text-primary, #fff)",
              padding: "0.6rem 0.9rem",
              fontSize: "0.85rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "crons" && (
        <>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "0.85rem", alignItems: "center" }}>
            <div style={{ position: "relative", maxWidth: 320, flex: "1 1 260px" }}>
              <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary, #9aa0ab)" }} />
              <input
                className="input-field"
                style={{ paddingLeft: 30, width: "100%" }}
                placeholder="Search crons by name or description…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <select
              className="input-field"
              style={{ width: 160 }}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
            >
              <option value="">All statuses</option>
              <option value="enabled">Enabled</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          <CronsTable
            crons={filteredCrons}
            loading={loading}
            error={error}
            onToggleEnabled={handleToggleEnabled}
            onRunNow={handleRunNow}
            onEdit={setEditing}
            onEditSchedule={openScheduleEdit}
            onDelete={setDeleteTarget}
            emptyMessage={
              search || statusFilter
                ? `No ${statusFilter || ""} crons match${search ? ` "${search}"` : ""}.`
                : "No crons registered yet."
            }
          />
        </>
      )}
      {tab === "logs" && <LogsTab crons={crons} />}
      {tab === "settings" && <RetentionSettingsTab />}

      {showCreate && (
        <CreateCronModal
          handlers={handlers}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            loadCrons();
          }}
        />
      )}

      {editing && (
        <EditCronModal
          handlers={handlers}
          cron={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            loadCrons();
          }}
        />
      )}

      {scheduleEditing && (
        <div style={overlayStyle} onClick={(e) => e.target === e.currentTarget && setScheduleEditing(null)}>
          <div style={modalStyle}>
            <ModalHeader title="Edit Schedule" onClose={() => setScheduleEditing(null)} />
            <div style={{ padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: 10 }}>
              <label style={{ fontSize: "0.8rem", display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Run how often?</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {SCHEDULE_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() => setScheduleDraft(p.value)}
                      className={scheduleDraft === p.value ? "btn-primary" : "btn-secondary"}
                      style={{ fontSize: "0.75rem", padding: "0.35rem 0.6rem" }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </label>
              <label style={{ fontSize: "0.8rem", display: "flex", flexDirection: "column", gap: 4 }}>
                <span>Or enter a custom cron expression</span>
                <input className="input-field" style={{ fontFamily: "monospace" }} value={scheduleDraft} onChange={(e) => setScheduleDraft(e.target.value)} placeholder="*/15 * * * *" />
              </label>
              <p style={{ fontSize: "0.8rem", margin: 0 }}>
                This will run: <strong>{describeCronSchedule(scheduleDraft) || "(unrecognized expression — will still be validated on save)"}</strong>
              </p>
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary, #9aa0ab)", margin: 0 }}>
                Takes effect immediately — no restart required.
              </p>
            </div>
            <ModalFooter onCancel={() => setScheduleEditing(null)} onConfirm={submitScheduleEdit} confirmLabel="Save schedule" />
          </div>
        </div>
      )}

      {deleteTarget && (
        <div style={overlayStyle} onClick={(e) => e.target === e.currentTarget && setDeleteTarget(null)}>
          <div style={modalStyle}>
            <ModalHeader title="Delete cron?" onClose={() => setDeleteTarget(null)} />
            <div style={{ padding: "1rem 1.25rem" }}>
              <p style={{ fontSize: "0.85rem" }}>
                This permanently deletes <strong>{deleteTarget.name}</strong> and stops it from running. This cannot be undone.
              </p>
            </div>
            <ModalFooter onCancel={() => setDeleteTarget(null)} onConfirm={handleDelete} confirmLabel="Delete" danger />
          </div>
        </div>
      )}
    </div>
  );
}

function CronsTable({ crons, loading, error, onToggleEnabled, onRunNow, onEdit, onEditSchedule, onDelete, emptyMessage }) {
  if (loading) return <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>;
  if (error) return <p style={{ color: "#f28b82" }}>{error}</p>;
  if (crons.length === 0) return <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>{emptyMessage || "No crons registered yet."}</p>;

  return (
    <div style={{ overflowX: "auto", border: "1px solid var(--border-color, rgba(255,255,255,0.08))", borderRadius: 8 }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
        <thead style={{ background: "rgba(107,114,128,0.08)" }}>
          <tr>
            {["Name", "Description", "Status", "Schedule", "Last Execution", "Last Status", "Created By", "Updated At", "Actions"].map((h) => (
              <th key={h} style={{ padding: "0.6rem 0.7rem", textAlign: "left", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {crons.map((c) => (
            <tr key={c.name} style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
              <td style={{ padding: "0.55rem 0.7rem", fontWeight: 600 }}>
                {c.name}
                {!c.isSystem && (
                  <span style={{ marginLeft: 6, fontSize: "0.65rem", color: "var(--accent-color, #3b82f6)", fontWeight: 700 }}>DYNAMIC</span>
                )}
                {!c.isRegisteredInProcess && (
                  <div style={{ fontSize: "0.68rem", color: "#f2b82e" }}>not live in this process — restart may be needed</div>
                )}
              </td>
              <td style={{ padding: "0.55rem 0.7rem", maxWidth: 260, color: "var(--text-secondary, #9aa0ab)" }}>{c.description || "—"}</td>
              <td style={{ padding: "0.55rem 0.7rem" }}>
                <span style={{ color: c.enabled ? "#6fcf73" : "#9aa0ab", fontWeight: 700 }}>{c.enabled ? "Enabled" : "Disabled"}</span>
              </td>
              <td style={{ padding: "0.55rem 0.7rem" }}><ScheduleDisplay schedule={c.schedule} /></td>
              <td style={{ padding: "0.55rem 0.7rem", whiteSpace: "nowrap" }} title={fmtDate(c.lastExecutionAt)}>{fmtRelative(c.lastExecutionAt)}</td>
              <td style={{ padding: "0.55rem 0.7rem" }}><StatusPill status={c.lastStatus} /></td>
              <td style={{ padding: "0.55rem 0.7rem" }}>{c.createdBy || "—"}</td>
              <td style={{ padding: "0.55rem 0.7rem", whiteSpace: "nowrap" }}>{fmtDate(c.updatedAt)}</td>
              <td style={{ padding: "0.55rem 0.7rem" }}>
                <div style={{ display: "flex", gap: 4 }}>
                  <button title="Run now" onClick={() => onRunNow(c)} className="btn-secondary" style={{ padding: "0.3rem" }}>
                    <Play size={13} />
                  </button>
                  <button title={c.enabled ? "Disable" : "Enable"} onClick={() => onToggleEnabled(c)} className="btn-secondary" style={{ padding: "0.3rem" }}>
                    {c.enabled ? <PowerOff size={13} /> : <Power size={13} />}
                  </button>
                  <button title="Edit schedule" onClick={() => onEditSchedule(c)} className="btn-secondary" style={{ padding: "0.3rem" }}>
                    <Pencil size={13} />
                  </button>
                  {!c.isSystem && (
                    <button title="Delete" onClick={() => onDelete(c)} className="btn-secondary" style={{ padding: "0.3rem", color: "#f28b82" }}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CreateCronModal({ handlers, onClose, onCreated }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [schedule, setSchedule] = useState("*/15 * * * *");
  const [handlerKey, setHandlerKey] = useState(handlers[0]?.key || "");
  const [metadataJson, setMetadataJson] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      await superAdminFetch("/cron/crons", {
        method: "POST",
        body: JSON.stringify({ name, description, schedule, handlerKey, metadataJson: metadataJson || undefined }),
      });
      onCreated();
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  return (
    <div style={overlayStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modalStyle}>
        <ModalHeader title="Create New Cron" onClose={onClose} />
        <div style={{ padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Cron Name">
            <input className="input-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="my_custom_ping" />
          </Field>
          <Field label="Description">
            <input className="input-field" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Run how often?">
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
              {SCHEDULE_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setSchedule(p.value)}
                  className={schedule === p.value ? "btn-primary" : "btn-secondary"}
                  style={{ fontSize: "0.75rem", padding: "0.35rem 0.6rem" }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <input className="input-field" style={{ fontFamily: "monospace" }} value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder="*/15 * * * *" />
            <p style={{ fontSize: "0.78rem", margin: "4px 0 0" }}>
              This will run: <strong>{describeCronSchedule(schedule) || "(unrecognized expression)"}</strong>
            </p>
          </Field>
          <Field label="Handler">
            <select className="input-field" value={handlerKey} onChange={(e) => setHandlerKey(e.target.value)} disabled={handlers.length === 0}>
              {handlers.map((h) => (
                <option key={h.key} value={h.key}>{h.label}</option>
              ))}
            </select>
            {handlers.length === 0 && (
              <p style={{ fontSize: "0.75rem", color: "var(--text-secondary, #9aa0ab)", margin: "4px 0 0" }}>Loading handlers…</p>
            )}
          </Field>
          <Field label="Metadata (JSON, optional)">
            <textarea
              className="input-field"
              style={{ fontFamily: "monospace" }}
              rows={3}
              value={metadataJson}
              onChange={(e) => setMetadataJson(e.target.value)}
              placeholder={handlerKey === "http_webhook_ping" ? '{"url":"https://example.com/webhook"}' : '{"message":"hello"}'}
            />
          </Field>
          {error && <p style={{ color: "#f28b82", fontSize: "0.8rem", margin: 0 }}>{error}</p>}
        </div>
        <ModalFooter onCancel={onClose} onConfirm={submit} confirmLabel={submitting ? "Creating…" : "Create"} disabled={submitting || !name || !schedule} />
      </div>
    </div>
  );
}

function EditCronModal({ handlers, cron, onClose, onSaved }) {
  const [description, setDescription] = useState(cron.description || "");
  const [handlerKey, setHandlerKey] = useState(cron.handlerKey || handlers[0]?.key || "");
  const [metadataJson, setMetadataJson] = useState(cron.metadataJson || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      await superAdminFetch(`/cron/crons/${encodeURIComponent(cron.name)}`, {
        method: "PUT",
        body: JSON.stringify({ description, handlerKey, metadataJson }),
      });
      onSaved();
    } catch (e) {
      setError(e.message);
    }
    setSubmitting(false);
  };

  return (
    <div style={overlayStyle} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={modalStyle}>
        <ModalHeader title={`Edit ${cron.name}`} onClose={onClose} />
        <div style={{ padding: "1rem 1.25rem", display: "flex", flexDirection: "column", gap: 10 }}>
          <Field label="Description">
            <input className="input-field" value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Handler">
            <select className="input-field" value={handlerKey} onChange={(e) => setHandlerKey(e.target.value)} disabled={handlers.length === 0}>
              {handlers.map((h) => (
                <option key={h.key} value={h.key}>{h.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Metadata (JSON)">
            <textarea className="input-field" style={{ fontFamily: "monospace" }} rows={3} value={metadataJson} onChange={(e) => setMetadataJson(e.target.value)} />
          </Field>
          {error && <p style={{ color: "#f28b82", fontSize: "0.8rem", margin: 0 }}>{error}</p>}
        </div>
        <ModalFooter onCancel={onClose} onConfirm={submit} confirmLabel={submitting ? "Saving…" : "Save"} disabled={submitting} />
      </div>
    </div>
  );
}

function LogsTab({ crons }) {
  const notify = useNotify();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ cronName: "", status: "", search: "" });
  // Date range — single pill button + calendar-grid popover (click a start
  // date then an end date directly on the calendar), not two bare
  // <input type="date"> boxes or a preset dropdown.
  const [dateRange, setDateRange] = useState({ from: "", to: "" });
  const { from, to } = dateRange;
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const data = await superAdminFetch(`/cron/logs?${params.toString()}`);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  }, [page, filters, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const clearLogs = async (cronName) => {
    const ok = await notify.confirm({
      title: "Clear logs?",
      message: cronName ? `Clear all logs for ${cronName}?` : "Clear ALL cron logs?",
      confirmText: "Clear logs",
      destructive: true,
    });
    if (!ok) return;
    try {
      await superAdminFetch("/cron/logs/clear", { method: "POST", body: JSON.stringify({ cronName: cronName || undefined }) });
      setPage(1);
      load();
    } catch (e) {
      notify.error(e.message);
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "1rem", alignItems: "center" }}>
        <ListFilter size={15} color="var(--text-secondary, #9aa0ab)" />
        <select className="input-field" style={{ width: 200 }} value={filters.cronName} onChange={(e) => { setFilters((f) => ({ ...f, cronName: e.target.value })); setPage(1); }}>
          <option value="">All crons</option>
          {crons.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>
        <select className="input-field" style={{ width: 140 }} value={filters.status} onChange={(e) => { setFilters((f) => ({ ...f, status: e.target.value })); setPage(1); }}>
          <option value="">All statuses</option>
          <option value="success">Success</option>
          <option value="failed">Failed</option>
          <option value="running">Running</option>
        </select>
        <CalendarRangePicker
          value={dateRange}
          onChange={(next) => { setDateRange(next); setPage(1); }}
          label="Date range"
        />
        <input className="input-field" style={{ width: 200 }} placeholder="Search error/name…" value={filters.search} onChange={(e) => { setFilters((f) => ({ ...f, search: e.target.value })); setPage(1); }} />
        <button className="btn-secondary" onClick={() => clearLogs(filters.cronName)} style={{ marginLeft: "auto", color: "#f28b82" }}>
          Clear {filters.cronName ? `"${filters.cronName}"` : "all"} logs
        </button>
      </div>

      {loading ? (
        <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>
      ) : logs.length === 0 ? (
        <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>No logs match these filters.</p>
      ) : (
        <div style={{ overflowX: "auto", border: "1px solid var(--border-color, rgba(255,255,255,0.08))", borderRadius: 8 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead style={{ background: "rgba(107,114,128,0.08)" }}>
              <tr>
                {["Cron", "Started", "Finished", "Duration", "Status", "Trigger", "Error"].map((h) => (
                  <th key={h} style={{ padding: "0.55rem 0.7rem", textAlign: "left", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} style={{ borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))" }}>
                  <td style={{ padding: "0.5rem 0.7rem", fontWeight: 600 }}>{l.cronName}</td>
                  <td style={{ padding: "0.5rem 0.7rem", whiteSpace: "nowrap" }} title={fmtDate(l.startedAt)}>{fmtRelative(l.startedAt)}</td>
                  <td style={{ padding: "0.5rem 0.7rem", whiteSpace: "nowrap" }} title={fmtDate(l.finishedAt)}>{fmtRelative(l.finishedAt)}</td>
                  <td style={{ padding: "0.5rem 0.7rem" }}>{l.durationMs != null ? `${l.durationMs}ms` : "—"}</td>
                  <td style={{ padding: "0.5rem 0.7rem" }}><StatusPill status={l.status} /></td>
                  <td style={{ padding: "0.5rem 0.7rem" }}>{l.triggerType}</td>
                  <td style={{ padding: "0.5rem 0.7rem", maxWidth: 280, color: "#f28b82" }}>{l.errorMessage || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.75rem", fontSize: "0.8rem" }}>
        <span style={{ color: "var(--text-secondary, #9aa0ab)" }}>{total} total log{total === 1 ? "" : "s"}</span>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="btn-secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
          <span style={{ padding: "0.4rem 0.6rem" }}>{page} / {totalPages}</span>
          <button className="btn-secondary" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}

function RetentionSettingsTab() {
  const notify = useNotify();
  const [retainDays, setRetainDays] = useState(30);
  const [custom, setCustom] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const presets = [7, 15, 30, 60, 90];

  useEffect(() => {
    superAdminFetch("/cron/settings/log-retention")
      .then((d) => setRetainDays(d.retainDays))
      .finally(() => setLoading(false));
  }, []);

  const save = async (days) => {
    setSaving(true);
    setSaved(false);
    try {
      await superAdminFetch("/cron/settings/log-retention", {
        method: "PUT",
        body: JSON.stringify({ retainDays: days }),
      });
      setRetainDays(days);
      setSaved(true);
    } catch (e) {
      notify.error(e.message);
    }
    setSaving(false);
  };

  if (loading) return <p style={{ color: "var(--text-secondary, #9aa0ab)" }}>Loading…</p>;

  return (
    <div style={{ maxWidth: 480 }}>
      <p style={{ fontSize: "0.85rem", color: "var(--text-secondary, #9aa0ab)" }}>
        Execution logs older than this window are purged automatically by the daily retention sweep (03:15).
      </p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "1rem" }}>
        {presets.map((d) => (
          <button
            key={d}
            onClick={() => save(d)}
            className={retainDays === d ? "btn-primary" : "btn-secondary"}
            disabled={saving}
          >
            {d} Days
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input
          className="input-field"
          type="number"
          min={1}
          max={3650}
          style={{ width: 120 }}
          placeholder="Custom"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
        />
        <button className="btn-secondary" disabled={saving || !custom} onClick={() => save(parseInt(custom, 10))}>
          Set custom
        </button>
      </div>
      <p style={{ fontSize: "0.8rem", marginTop: "1rem" }}>
        Current setting: <strong>{retainDays} days</strong>
        {saved && <span style={{ color: "#6fcf73", marginLeft: 8 }}>Saved ✓</span>}
      </p>
    </div>
  );
}

// ── Small shared UI helpers ─────────────────────────────────────────────

function Field({ label, children }) {
  return (
    <label style={{ fontSize: "0.8rem", display: "flex", flexDirection: "column", gap: 4 }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function ModalHeader({ title, onClose }) {
  return (
    <header style={{ padding: "1rem 1.25rem", borderBottom: "1px solid var(--border-color, rgba(255,255,255,0.08))", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>{title}</h3>
      <button onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "var(--text-secondary, #9aa0ab)", cursor: "pointer" }}>
        <X size={18} />
      </button>
    </header>
  );
}

function ModalFooter({ onCancel, onConfirm, confirmLabel, disabled, danger }) {
  return (
    <footer style={{ padding: "0.75rem 1.25rem", borderTop: "1px solid var(--border-color, rgba(255,255,255,0.08))", display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <button className="btn-secondary" onClick={onCancel}>Cancel</button>
      <button
        className="btn-primary"
        onClick={onConfirm}
        disabled={disabled}
        style={danger ? { background: "#dc2626" } : undefined}
      >
        {confirmLabel}
      </button>
    </footer>
  );
}

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  zIndex: 1000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "2rem",
};

const modalStyle = {
  background: "var(--card-bg, #1a1a1a)",
  color: "var(--text-primary, #fff)",
  borderRadius: 12,
  width: "min(480px, 100%)",
  border: "1px solid var(--border-color, rgba(255,255,255,0.08))",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  maxHeight: "90vh",
};
