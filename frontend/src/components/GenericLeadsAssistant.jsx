import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Download,
  LoaderCircle,
  MessageCircle,
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { fetchApi, getAuthToken } from "../utils/api";

const initialMessage = {
  role: "assistant",
  content: "Welcome! How can I help you with your leads today?",
};

const FAB_SIZE = 58;
const POSITION_GAP = 16;
const DEFAULT_POSITION_KEY = "generic-leads-assistant-position";
const DEFAULT_SESSION_KEY = "generic-leads-assistant-session";
const MAX_STORED_MESSAGES = 100;

function isGreeting(message) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening)(?: there)?[!,.?]*$/i.test(message.trim());
}

function casualReply(message) {
  const cleanMessage = message.trim();
  if (isGreeting(cleanMessage)) return "Hi! How can I help you with your leads today?";
  if (/^(how are you|how're you|how are you doing)(?: today)?[!,.?]*$/i.test(cleanMessage)) {
    return "I'm doing well, thank you! How can I help you with your leads, deals, or pipelines today?";
  }
  if (/^(who are you|what are you|tell me about yourself)[!,.?]*$/i.test(cleanMessage)) {
    return "I'm your Leads assistant. I can help you find leads, answer questions about records, filter the Leads view, and prepare reports.";
  }
  if (/^(what can you do|what do you do|how can you help(?: me)?(?: with my leads)?|help)[!,.?]*$/i.test(cleanMessage)) {
    return "I can help you search and filter leads, answer questions about records, manage lead and deal details, and prepare downloadable reports when you request them.";
  }
  if (/^(thanks|thank you|thx)[!,.?]*$/i.test(cleanMessage)) return "You're welcome! Let me know if you need anything with your leads.";
  if (/^(bye|goodbye|see you)[!,.?]*$/i.test(cleanMessage)) return "Goodbye! I'll be here when you need help with your leads.";
  return null;
}

function hasReportData(message) {
  const count = message?.report ? message.report.totalLeads : message?.filterSpec ? message.matchCount : null;
  return Number.isFinite(Number(count)) && Number(count) > 0;
}

function reportDownloadMessage(message) {
  const report = message?.report;
  const totalLeads = Number(report?.totalLeads ?? message?.matchCount ?? 0);
  const leadLabel = totalLeads === 1 ? "lead" : "leads";
  const isSingleLeadReport = Number.isInteger(Number(report?.filters?.leadId));

  if (isSingleLeadReport) {
    return "I prepared a detailed report for the requested lead with the complete lead record. Choose XLSX for spreadsheet analysis or PDF for a shareable document.";
  }

  if (report) {
    const reportType = String(report.reportType || "summary").toLowerCase();
    return `I prepared a detailed ${reportType} report covering ${totalLeads} matching ${leadLabel}. It includes the lead data that matches your request. Choose XLSX for spreadsheet analysis or PDF for a shareable document.`;
  }

  return `I found ${totalLeads} matching ${leadLabel} and prepared the complete matching lead data for download. Choose XLSX for spreadsheet analysis or PDF for a shareable document.`;
}

function viewportSize() {
  if (typeof window === "undefined") return { width: 1280, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function clampPosition(position) {
  const { width, height } = viewportSize();
  const maxLeft = Math.max(POSITION_GAP, width - FAB_SIZE - POSITION_GAP);
  const maxTop = Math.max(POSITION_GAP, height - FAB_SIZE - POSITION_GAP);
  return {
    left: Math.min(maxLeft, Math.max(POSITION_GAP, Number(position?.left) || 0)),
    top: Math.min(maxTop, Math.max(POSITION_GAP, Number(position?.top) || 0)),
  };
}

function readSavedPosition(storageKey) {
  if (typeof window === "undefined") return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (!Number.isFinite(saved?.left) || !Number.isFinite(saved?.top)) return null;
    return clampPosition(saved);
  } catch {
    return null;
  }
}

function initialPosition(storageKey) {
  const saved = readSavedPosition(storageKey);
  if (saved) return saved;
  const { width, height } = viewportSize();
  return clampPosition({
    left: width - FAB_SIZE - 24,
    top: height - FAB_SIZE - 24,
  });
}

function normalizeSavedMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((message) =>
      message &&
      ["user", "assistant"].includes(message.role) &&
      typeof message.content === "string",
    )
    .slice(-MAX_STORED_MESSAGES);
}

function readSavedSession(storageKey) {
  if (typeof window === "undefined") return null;
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey) || "null");
    if (Array.isArray(saved)) {
      const messages = normalizeSavedMessages(saved);
      return messages.length ? { messages, pendingAction: null } : null;
    }
    if (!saved || typeof saved !== "object") return null;
    const messages = normalizeSavedMessages(saved.messages);
    return messages.length
      ? { messages, pendingAction: saved.pendingAction || null }
      : null;
  } catch {
    return null;
  }
}

function confirmationSummary(pending) {
  const preview = pending?.preview || {};
  if (Array.isArray(preview.leads)) {
    return `Update ${preview.leads.length} lead${preview.leads.length === 1 ? "" : "s"}: ${Object.entries(preview.changes || {}).map(([key, value]) => `${key} → ${value ?? "unassigned"}`).join(", ")}`;
  }
  if (preview.lead) return `Create lead: ${preview.lead.name}${preview.lead.email ? ` (${preview.lead.email})` : ""}`;
  if (preview.deal?.title) return `Move deal “${preview.deal.title}” from ${preview.deal.stage || "current stage"}.`;
  return "Review the requested CRM change.";
}

export default function GenericLeadsAssistant({
  isGeneric,
  selectedLeadId = null,
  activeFilters = {},
  onApplyFilters,
  onRefresh,
  positionStorageKey = DEFAULT_POSITION_KEY,
  sessionStorageKey = `${DEFAULT_SESSION_KEY}.${positionStorageKey}`,
}) {
  const savedSession = readSavedSession(sessionStorageKey);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState(() => savedSession?.messages || [initialMessage]);
  const [pendingAction, setPendingAction] = useState(() => savedSession?.pendingAction || null);
  const [loading, setLoading] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [downloadingFormat, setDownloadingFormat] = useState("");
  const [position, setPosition] = useState(() => initialPosition(positionStorageKey));
  const [dragging, setDragging] = useState(false);
  const [hydratedSessionKey, setHydratedSessionKey] = useState(sessionStorageKey);
  const endRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const loggedOutRef = useRef(false);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [messages, open, pendingAction]);

  useEffect(() => {
    const handleResize = () => setPosition((current) => clampPosition(current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(positionStorageKey, JSON.stringify(position));
    } catch {
      // Position persistence is a convenience and should not affect the assistant.
    }
  }, [position, positionStorageKey]);

  useEffect(() => {
    loggedOutRef.current = false;
    const saved = readSavedSession(sessionStorageKey);
    setMessages(saved?.messages || [initialMessage]);
    setPendingAction(saved?.pendingAction || null);
    setHydratedSessionKey(sessionStorageKey);
  }, [sessionStorageKey]);

  useEffect(() => {
    if (hydratedSessionKey !== sessionStorageKey) return;
    if (loggedOutRef.current) return;
    try {
      window.localStorage.setItem(
        sessionStorageKey,
        JSON.stringify({
          messages: messages.slice(-MAX_STORED_MESSAGES),
          pendingAction,
        }),
      );
    } catch {
      // Conversation persistence is a convenience and should not affect chat.
    }
  }, [hydratedSessionKey, messages, pendingAction, sessionStorageKey]);

  useEffect(() => {
    const dismissAfterLogout = () => {
      loggedOutRef.current = true;
      setOpen(false);
      setDraft("");
      setMessages([initialMessage]);
      setPendingAction(null);
      setLoading(false);
      setConfirming(false);
      setDownloadingFormat("");
      setHydratedSessionKey(null);
      try {
        window.localStorage.removeItem(sessionStorageKey);
      } catch {
        // Logout cleanup should not fail if browser storage is unavailable.
      }
    };
    window.addEventListener("crm:auth-logout", dismissAfterLogout);
    return () => window.removeEventListener("crm:auth-logout", dismissAfterLogout);
  }, [sessionStorageKey]);

  const history = useMemo(
    () => messages.filter((message) => message.role === "user" || message.role === "assistant").slice(-20),
    [messages],
  );

  if (!isGeneric) return null;

  const sendMessage = async (event) => {
    event?.preventDefault?.();
    const message = draft.trim();
    if (!message || loading) return;
    setDraft("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    const localReply = casualReply(message);
    if (localReply) {
      setMessages((current) => [...current, { role: "assistant", content: localReply, directAnswer: true }]);
      return;
    }
    setLoading(true);
    try {
      const response = await fetchApi("/api/leads-assistant/message", {
        method: "POST",
        body: JSON.stringify({
          message,
          history,
          context: { selectedLeadId, activeFilters },
        }),
      });
      const clearFilters = response?.clearFilters === true;
      const filterSpec = !clearFilters && response?.filterSpec && typeof response.filterSpec === "object"
        ? response.filterSpec
        : null;
      const matchCount = Number(response?.matchCount);
      if (clearFilters) {
        onApplyFilters?.({});
      } else if (filterSpec && Object.keys(filterSpec).length > 0) {
        onApplyFilters?.(filterSpec);
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          content: response?.reply || "I could not find an answer.",
          report: response?.report || null,
          matchCount: Number.isFinite(matchCount) ? matchCount : null,
          directAnswer: response?.directAnswer === true,
          filterSpec,
        },
      ]);
      setPendingAction(response?.pendingAction || null);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { role: "assistant", content: error?.body?.error || error?.message || "The assistant is unavailable right now." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  const confirm = async () => {
    if (!pendingAction || confirming) return;
    setConfirming(true);
    try {
      const response = await fetchApi("/api/leads-assistant/confirm", {
        method: "POST",
        body: JSON.stringify({ action: pendingAction.action }),
      });
      setMessages((current) => [...current, { role: "assistant", content: response?.message || "The CRM action was completed." }]);
      setPendingAction(null);
      await onRefresh?.();
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error?.body?.error || error?.message || "The action could not be completed." }]);
    } finally {
      setConfirming(false);
    }
  };

  const clearChat = () => {
    if (loading || confirming) return;
    setMessages([initialMessage]);
    setPendingAction(null);
    setDraft("");
    try {
      window.localStorage.removeItem(sessionStorageKey);
    } catch {
      // Conversation persistence is a convenience and should not affect chat.
    }
  };

  const downloadReport = async (report, format) => {
    if (!report || downloadingFormat) return;
    setDownloadingFormat(format);
    try {
      const token = getAuthToken();
      const response = await fetch("/api/leads-assistant/report/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reportType: report.reportType || "summary", filters: report.filters || {}, format }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `Report download failed (${response.status})`);
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `leads-report-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(link.href);
    } catch (error) {
      setMessages((current) => [...current, { role: "assistant", content: error?.message || "The report could not be downloaded." }]);
    } finally {
      setDownloadingFormat("");
    }
  };

  const startDragging = (event) => {
    if (event.pointerType === "mouse" && event.button !== undefined && event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: position.left,
      top: position.top,
      moved: false,
    };
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveDragging = (event) => {
    const drag = dragRef.current;
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 4 || Math.abs(deltaY) > 4) drag.moved = true;
    setPosition(clampPosition({ left: drag.left + deltaX, top: drag.top + deltaY }));
    event.preventDefault?.();
  };

  const stopDragging = (event) => {
    const drag = dragRef.current;
    if (!drag || (event.pointerId !== undefined && event.pointerId !== drag.pointerId)) return;
    if (drag.moved) suppressClickRef.current = true;
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const { width: viewportWidth, height: viewportHeight } = viewportSize();
  const panelWidth = Math.min(410, Math.max(280, viewportWidth - POSITION_GAP * 2));
  const panelLeft = Math.max(POSITION_GAP, Math.min(position.left, viewportWidth - panelWidth - POSITION_GAP));
  const panelAbove = position.top > viewportHeight / 2;
  const panelPosition = panelAbove
    ? { bottom: Math.max(POSITION_GAP, viewportHeight - position.top + 12) }
    : { top: Math.min(viewportHeight - POSITION_GAP, position.top + FAB_SIZE + 12) };

  return (
    <>
      {open && (
        <section
          data-testid="generic-leads-assistant-panel"
          aria-label="Leads assistant"
          style={{
            position: "fixed",
            left: panelLeft,
            ...panelPosition,
            width: "min(410px, calc(100vw - 2rem))",
            height: "min(620px, calc(100vh - 7rem))",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            zIndex: 1200,
            border: "1px solid var(--border-color)",
            borderRadius: "16px",
            background: "#ffffff",
            color: "var(--text-primary)",
            boxShadow: "0 18px 50px rgba(15, 23, 42, 0.24)",
            isolation: "isolate",
          }}
        >
          <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.75rem", padding: "0.9rem 1rem", color: "#fff", background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", minWidth: 0 }}>
              <Sparkles size={18} />
              <div style={{ minWidth: 0 }}>
                <strong>Leads assistant</strong>
                <div style={{ fontSize: "0.72rem", opacity: 0.86 }}>Here to help with your leads</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", flexShrink: 0 }}>
              <button type="button" aria-label="Clear chat" title="Start a new chat" onClick={clearChat} disabled={loading || confirming} style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: "inherit", background: "rgba(255,255,255,0.12)", border: 0, borderRadius: 6, padding: "0.35rem 0.45rem", cursor: loading || confirming ? "not-allowed" : "pointer", fontSize: "0.72rem" }}>
                <Trash2 size={15} /> Clear
              </button>
              <button type="button" aria-label="Close leads assistant" onClick={() => setOpen(false)} style={{ color: "inherit", background: "transparent", border: 0, cursor: "pointer" }}>
                <X size={18} />
              </button>
            </div>
          </header>

          <div style={{ flex: 1, overflowY: "auto", padding: "0.9rem", display: "flex", flexDirection: "column", gap: "0.75rem", background: "#ffffff" }}>
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} style={{ alignSelf: message.role === "user" ? "flex-end" : "stretch", maxWidth: message.role === "user" ? "88%" : "100%" }}>
                <div style={{ padding: "0.65rem 0.75rem", borderRadius: message.role === "user" ? "12px 12px 3px 12px" : "12px", background: message.role === "user" ? "#eef2ff" : "var(--bg-color, #f8fafc)", whiteSpace: "pre-wrap", lineHeight: 1.45, fontSize: "0.86rem" }}>
                  {message.content}
                </div>
                {!message.directAnswer && hasReportData(message) && (message.report || message.filterSpec) && (
                  <div style={{ marginTop: "0.45rem", padding: "0.6rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 8, fontSize: "0.78rem" }}>
                    <strong>{message.report ? `${message.report.reportType} report` : "Matching leads report"}</strong>
                    <div style={{ marginTop: "0.35rem", lineHeight: 1.45 }}>{reportDownloadMessage(message)}</div>
                    {message.report ? (
                      <>
                        <div>Total leads: {message.report.totalLeads}</div>
                        {message.report.averageLeadScore !== undefined && <div>Average score: {message.report.averageLeadScore}</div>}
                        {message.report.linkedDeals !== undefined && <div>Linked deals: {message.report.linkedDeals}</div>}
                        {Array.isArray(message.report.breakdown) && message.report.breakdown.slice(0, 8).map((row, rowIndex) => <div key={rowIndex}>{row.label || row.stage || `Score ${row.score}`}: {row.count ?? row.deals}</div>)}
                      </>
                    ) : <div>Download the complete matching lead data.</div>}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginTop: "0.6rem" }}>
                      {["xlsx", "pdf"].map((format) => (
                        <button
                          key={format}
                          type="button"
                          data-testid={`generic-leads-assistant-download-${format}`}
                          disabled={Boolean(downloadingFormat)}
                          onClick={() => downloadReport(message.report || { reportType: "summary", filters: message.filterSpec }, format)}
                          style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", padding: "0.4rem 0.55rem", border: "1px solid var(--border-color)", borderRadius: 7, background: "var(--surface-color)", color: "var(--primary-color, var(--accent-color))", cursor: downloadingFormat ? "not-allowed" : "pointer", fontSize: "0.74rem" }}
                        >
                          <Download size={13} /> {downloadingFormat === format ? "Preparing…" : `Download ${format.toUpperCase()}`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {pendingAction && (
              <div data-testid="generic-leads-assistant-confirmation" style={{ padding: "0.75rem", border: "1px solid #f59e0b", borderRadius: 10, background: "#fffbeb", fontSize: "0.8rem" }}>
                <strong>Confirmation required</strong>
                <div style={{ marginTop: "0.35rem" }}>{confirmationSummary(pendingAction)}</div>
                <div style={{ display: "flex", gap: "0.45rem", marginTop: "0.65rem" }}>
                  <button type="button" disabled={confirming} onClick={confirm} className="btn-primary" style={{ display: "inline-flex", alignItems: "center", gap: "0.3rem", padding: "0.4rem 0.6rem", fontSize: "0.76rem" }}>
                    {confirming ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Confirm
                  </button>
                  <button type="button" disabled={confirming} onClick={() => setPendingAction(null)} className="btn-secondary" style={{ padding: "0.4rem 0.6rem", fontSize: "0.76rem" }}>Cancel</button>
                </div>
              </div>
            )}
            {loading && <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", color: "var(--text-secondary)", fontSize: "0.8rem" }}><LoaderCircle size={15} className="spin" /> Checking CRM data…</div>}
            <div ref={endRef} />
          </div>

          <form onSubmit={sendMessage} style={{ display: "flex", gap: "0.5rem", padding: "0.75rem", borderTop: "1px solid var(--border-color)", background: "#ffffff" }}>
            <input data-testid="generic-leads-assistant-input" aria-label="Ask the leads assistant" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about leads…" disabled={loading} style={{ flex: 1, minWidth: 0, padding: "0.65rem 0.7rem", border: "1px solid var(--border-color)", borderRadius: 8, background: "#ffffff", color: "var(--text-primary)" }} />
            <button data-testid="generic-leads-assistant-send" type="submit" aria-label="Send message" disabled={loading || !draft.trim()} className="btn-primary" style={{ flex: "0 0 44px", width: 44, minWidth: 44, height: 42, padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: 8, boxSizing: "border-box" }}><Send size={17} /></button>
          </form>
        </section>
      )}
      <button
        type="button"
        data-testid="generic-leads-assistant-fab"
        aria-label={open ? "Close leads assistant" : "Open leads assistant"}
        title="Drag to reposition"
        onPointerDown={startDragging}
        onPointerMove={moveDragging}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          setOpen((value) => !value);
        }}
        style={{ position: "fixed", left: position.left, top: position.top, zIndex: 1201, width: FAB_SIZE, height: FAB_SIZE, border: 0, borderRadius: "50%", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: dragging ? "grabbing" : "grab", color: "#fff", background: "linear-gradient(135deg, #4338ca, #6366f1)", boxShadow: "0 10px 24px rgba(67, 56, 202, 0.35)", touchAction: "none", userSelect: "none" }}
      >
        {open ? <X size={23} /> : <MessageCircle size={23} />}
      </button>
    </>
  );
}
