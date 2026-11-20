import { useEffect, useMemo, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, Bold, Eye, Italic, Mail, Pause, Play, Plus, RefreshCw, Save, Sparkles, Trash2, Underline, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import Pagination from "../../components/ui/Pagination";
import "../../styles/travel-email-automation.css";

const EMPTY = { name: "", eventKey: "", subBrand: "all", subject: "", body: "", isActive: false };
const HISTORY_PAGE_SIZE = 15;
const brandLabel = value => value === "all" ? "All subbrands" : ({ tmc: "TMC", rfu: "RFU", travelstall: "Travel Stall", visasure: "Visa Sure" }[value] || value);
const fields = [
  { label: "Recipient Name", key: "recipient.name" },
  { label: "Recipient Email", key: "recipient.email" },
  { label: "First Name", key: "contact.first_name" },
  { label: "Parent Name", key: "event.parentName" },
  { label: "Parent Email", key: "event.parentEmail" },
  { label: "Parent Phone", key: "event.parentPhone" },
  { label: "Student Name", key: "event.studentName" },
  { label: "Student School", key: "event.studentSchool" },
  { label: "Student Class", key: "event.studentClass" },
  { label: "Sender Name", key: "sender.name" },
  { label: "Tenant Name", key: "tenant.name" },
  { label: "Registration ID", key: "event.registrationId" },
  { label: "Registration Status", key: "event.registrationStatus" },
  { label: "Trip ID", key: "event.tripId" },
  { label: "Trip Name", key: "trip.name" },
  { label: "Trip Code", key: "trip.code" },
  { label: "Trip Destination", key: "trip.destination" },
  { label: "Trip Start Date", key: "trip.startDate" },
  { label: "Trip End Date", key: "trip.endDate" },
  { label: "Trip Status", key: "trip.status" },
  { label: "Payment Amount", key: "payment.amount" },
  { label: "Payment Link", key: "payment.link" },
  { label: "Review Link", key: "review.url" },
  { label: "Account Setup Link", key: "account.setupLink" },
  { label: "Account Sign-in Link", key: "account.signInLink" },
  { label: "Tenant Email", key: "tenant.email" },
  { label: "Sender Email", key: "sender.email" },
  { label: "Student Name (Contact)", key: "student.name" },
  { label: "Diagnostic Report Link", key: "diagnostic.reportUrl" },
  { label: "Site Visit Date & Time", key: "site_visit.date_time" },
  { label: "Site Visit Location", key: "site_visit.location" },
  { label: "Catalogue Name", key: "catalogue.name" },
  { label: "Booking Reference", key: "booking.reference" },
  { label: "Booking Status", key: "booking.status" },
  { label: "Trip Code (Booking)", key: "booking.tripCode" },
  { label: "Payment Amount (Transaction)", key: "payment.transactionAmount" },
  { label: "Payment Date", key: "payment.date" },
  { label: "Payment Reference", key: "payment.reference" },
  { label: "Payment Balance", key: "payment.balance" },
  { label: "Payment Due Date", key: "payment.dueDate" },
  { label: "Refund Amount", key: "refund.amount" },
  { label: "Refund Reference", key: "refund.reference" },
  { label: "Refund Date", key: "refund.date" },
  { label: "Refund Method", key: "refund.method" },
  { label: "Cancellation Reason", key: "trip.cancellationReason" },
  { label: "Deletion Reason", key: "account.deletionReason" },
];
if (typeof document !== "undefined" && !window.__travelEditorCaretBound) {
  window.__travelEditorCaretBound = true;
  document.addEventListener("input", event => {
    const editor = event.target.closest?.(".travel-rich-editor");
    if (!editor) return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const before = range.cloneRange();
    before.selectNodeContents(editor);
    before.setEnd(range.startContainer, range.startOffset);
    const caretOffset = before.toString().length;
    requestAnimationFrame(() => {
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let node; let remaining = caretOffset;
      while ((node = walker.nextNode())) { if (remaining <= node.nodeValue.length) break; remaining -= node.nodeValue.length; }
      if (!node) return;
      const restored = document.createRange(); restored.setStart(node, remaining); restored.collapse(true); selection.removeAllRanges(); selection.addRange(restored);
    });
  }, true);
}
if (typeof document !== "undefined" && !window.__travelTemplateDeleteConfirmBound) {
  window.__travelTemplateDeleteConfirmBound = true;
  let approvedDelete = false;
  document.addEventListener("click", event => {
    const button = event.target.closest?.(".travel-template-actions button.danger");
    if (!button || approvedDelete) return;
    event.preventDefault();
    event.stopPropagation();
    const overlay = document.createElement("div");
    overlay.className = "travel-confirm-overlay";
    const dialog = document.createElement("section");
    dialog.className = "travel-leave-dialog card";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "Delete template");
    const name = button.getAttribute("aria-label")?.replace(/^Delete\s+/, "") || "this template";
    const safeName = name.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
    dialog.innerHTML = `<h3>Delete template?</h3><p>Delete template "${safeName}"?</p><div class="travel-leave-actions"><button type="button" class="btn-secondary">Cancel</button><button type="button" class="btn-primary">Delete template</button></div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    dialog.querySelector(".btn-secondary").addEventListener("click", close);
    dialog.querySelector(".btn-primary").addEventListener("click", () => {
      close();
      approvedDelete = true;
      const nativeConfirm = window.confirm;
      window.confirm = () => true;
      button.click();
      window.confirm = nativeConfirm;
      requestAnimationFrame(() => { approvedDelete = false; });
    });
  }, true);
}

function Field({ label, children }) { return <label style={{ display: "grid", gap: 6, fontSize: ".78rem", fontWeight: 700 }}>{label}{children}</label>; }

function aiDraftToHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replace(/\r?\n/g, "<br />");
}

function TravelTemplateEditor({ draft, setDraft, catalog, onSave, onClose }) { const notify = useNotify(); const editorRef = useRef(null); const [generating, setGenerating] = useState(false); const [fieldQuery, setFieldQuery] = useState(""); const visibleFields = fields.filter(item => item.label.toLowerCase().includes(fieldQuery.trim().toLowerCase()) || item.key.toLowerCase().includes(fieldQuery.trim().toLowerCase())); const insert = value => setDraft(current => ({ ...current, body: `${current.body || ""} {{${value}}}` })); const command = name => { if (editorRef.current) { editorRef.current.focus(); document.execCommand(name); setDraft(current => ({ ...current, body: editorRef.current.innerHTML })); } }; const writeWithAi = async () => { const subject = String(draft.subject || "").trim(); if (!subject) { notify.error("Add a subject before writing with AI."); return; } const event = catalog.essential.concat(catalog.optional).find(item => item.value === draft.eventKey); setGenerating(true); try { const result = await fetchApi("/api/ai/draft", { method: "POST", body: JSON.stringify({ subject, context: `Travel email template "${draft.name || "Untitled"}" for the ${event?.label || draft.eventKey || "selected"} event and ${brandLabel(draft.subBrand || "all")}. Use relevant Travel CRM merge fields such as {{recipient.name}} or {{trip.destination}} where appropriate.`, tone: "professional and warm" }) }); const body = aiDraftToHtml(result?.draft); if (!body) throw new Error("AI returned an empty draft."); setDraft(current => ({ ...current, body })); if (editorRef.current) editorRef.current.innerHTML = body; notify.success("AI draft added to the email message."); } catch (error) { notify.error(error?.message || "AI could not write this template."); } finally { setGenerating(false); } }; return <div className="travel-modal" role="dialog" aria-modal="true"><form className="travel-template-editor card" onSubmit={onSave}><header className="travel-template-editor-header"><h2>{draft.id ? "Edit Template" : "New Template"}</h2><div><button type="button" className="btn-secondary" onClick={() => setDraft({ ...EMPTY, eventKey: catalog.essential[0]?.value || "" })}>Clear draft</button><button type="button" className="travel-icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></div></header><div className="travel-template-editor-layout"><section className="travel-template-editor-main"><div className="travel-template-fields"><Field label="Template Name *"><input className="input-field" required placeholder="Template name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></Field><Field label="Category"><input className="input-field" value="General" readOnly /></Field></div><Field label="Template Type *"><select className="input-field" value="EMAIL" disabled><option>Email</option></select></Field><div className="travel-template-fields"><Field label="Event trigger *"><select className="input-field" required value={draft.eventKey} onChange={e => setDraft({ ...draft, eventKey: e.target.value })}>{catalog.essential.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}<optgroup label="Optional - no default template">{catalog.optional.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</optgroup></select></Field><Field label="Subbrand"><select className="input-field" value={draft.subBrand} onChange={e => setDraft({ ...draft, subBrand: e.target.value })}><option value="all">All subbrands</option>{catalog.subBrands.map(item => <option key={item} value={item}>{brandLabel(item)}</option>)}</select></Field></div><Field label="Subject *"><input className="input-field" required placeholder="Subject" value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} /></Field><div className="travel-message-label">Message *</div><div className="travel-editor-toolbar"><button type="button" className="btn-secondary travel-ai-write" onClick={writeWithAi} disabled={generating}><Sparkles size={14} /> {generating ? "Writing..." : "Write with AI"}</button><button type="button" className="btn-secondary" onClick={() => command("bold")}><Bold size={14} /></button><button type="button" className="btn-secondary" onClick={() => command("italic")}><Italic size={14} /></button><button type="button" className="btn-secondary" onClick={() => command("underline")}><Underline size={14} /></button><button type="button" className="btn-secondary" onClick={() => command("justifyLeft")}><AlignLeft size={14} /></button><button type="button" className="btn-secondary" onClick={() => command("justifyCenter")}><AlignCenter size={14} /></button><button type="button" className="btn-secondary" onClick={() => command("justifyRight")}><AlignRight size={14} /></button><button type="button" className="btn-secondary" onClick={() => insert("recipient.name")}>Insert Personalization</button></div><div ref={editorRef} className="travel-rich-editor" contentEditable suppressContentEditableWarning role="textbox" aria-label="Email message" onInput={e => setDraft({ ...draft, body: e.currentTarget.innerHTML })} dangerouslySetInnerHTML={{ __html: draft.body || "" }} /><p className="travel-editor-note">Recipients are resolved automatically from the event. Passwords are never sent.</p></section><aside className="travel-personalization"><div className="travel-personalization-heading"><strong>Personalization</strong><small>{fieldQuery.trim() ? `${visibleFields.length} of ${fields.length}` : fields.length} fields</small></div><p>Travel CRM fields can be inserted into the subject or message.</p><input className="input-field" placeholder="Filter merge fields..." value={fieldQuery} onChange={event => setFieldQuery(event.target.value)} /><div className="travel-personalization-fields">{visibleFields.map(item => <button type="button" key={item.key} onClick={() => insert(item.key)}>{item.label}</button>)}</div></aside></div><footer className="travel-template-editor-footer"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary"><Save size={14} /> Save</button></footer></form></div>; }

function DeliveryHistory({ logs, pagination, selectedIds, busy, onTogglePage, onToggleOne, onDelete, onOpen, onPageChange }) {
  const allSelected = logs.length > 0 && logs.every(item => selectedIds.includes(item.id));
  return <section className="card travel-delivery-history">
    <div className="travel-history-heading"><div><h2>Delivery history</h2><p>Click a record to view the subject and exact message.</p></div><div className="travel-history-actions"><label><input type="checkbox" checked={allSelected} onChange={onTogglePage} /> Select page</label><button type="button" className="btn-secondary danger" disabled={!selectedIds.length || busy} onClick={onDelete}><Trash2 size={14} /> Delete selected{selectedIds.length ? ` (${selectedIds.length})` : ""}</button></div></div>
    {busy && !logs.length ? <p>Loading delivery history...</p> : logs.length ? <div className="travel-history-list">{logs.map(item => <article className="travel-delivery-row" key={item.id} role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") onOpen(item); }}><input type="checkbox" aria-label={`Select delivery to ${item.recipientEmail}`} checked={selectedIds.includes(item.id)} onClick={event => event.stopPropagation()} onChange={() => onToggleOne(item.id)} /><span><time>{new Date(item.createdAt).toLocaleString()}</time><b>{item.eventKey}</b><small>{item.recipientEmail}</small><em>{item.subject}</em></span><strong className={String(item.status).toLowerCase()}>{item.status}{item.errorMessage ? ` · ${item.errorMessage}` : ""}</strong></article>)}</div> : <p className="travel-history-empty">No delivery history yet.</p>}
    <Pagination page={pagination.page || 1} pageSize={pagination.limit || HISTORY_PAGE_SIZE} total={pagination.total || 0} onChange={onPageChange} className="travel-history-pagination" />
  </section>;
}

export default function TravelEmailAutomation() {
  const notify = useNotify();
  const [catalog, setCatalog] = useState({ essential: [], optional: [], subBrands: [] });
  const [templates, setTemplates] = useState([]);
  const [logs, setLogs] = useState([]);
  const [logPagination, setLogPagination] = useState({ page: 1, limit: HISTORY_PAGE_SIZE, total: 0, totalPages: 1 });
  const [historyPage, setHistoryPage] = useState(1);
  const [selectedLogIds, setSelectedLogIds] = useState([]);
  const [logDetail, setLogDetail] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [templateDraft, setTemplateDraft] = useState(null);
  const [previewData, setPreviewData] = useState(null);
  const [tab, setTab] = useState("templates");
  const [templateSearch, setTemplateSearch] = useState("");
  const [templateSubBrand, setTemplateSubBrand] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const applyLogResponse = (response, requestedPage) => {
    if (Array.isArray(response)) {
      setLogs(response);
      setLogPagination({ page: requestedPage, limit: HISTORY_PAGE_SIZE, total: response.length, totalPages: 1 });
      return;
    }
    setLogs(response?.logs || []);
    setLogPagination(response?.pagination || { page: requestedPage, limit: HISTORY_PAGE_SIZE, total: 0, totalPages: 1 });
  };

  const loadHistory = async (page = historyPage) => {
    setHistoryBusy(true);
    try {
      const response = await fetchApi(`/api/travel/email-automation/delivery-logs?page=${page}&limit=${HISTORY_PAGE_SIZE}`);
      applyLogResponse(response, page);
      setSelectedLogIds([]);
    } catch (e) {
      notify.error(e?.message || "Delivery history could not be loaded.");
    } finally {
      setHistoryBusy(false);
    }
  };

  const load = async () => {
    setLoading(true);
    try {
      const [meta, templateRows, logRows] = await Promise.all([
        fetchApi("/api/travel/email-automation/catalog"),
        fetchApi("/api/travel/email-automation/templates"),
        fetchApi(`/api/travel/email-automation/delivery-logs?page=${historyPage}&limit=${HISTORY_PAGE_SIZE}`),
      ]);
      setCatalog(meta);
      setTemplates(templateRows || []);
      applyLogResponse(logRows, historyPage);
      setSelectedLogIds([]);
      setError("");
    } catch (e) {
      setError(e?.message || "Could not load automation");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const eventLabel = key => catalog.essential.concat(catalog.optional).find(item => item.value === key)?.label || key;
  const visibleTemplates = useMemo(() => {
    const query = templateSearch.trim().toLowerCase();
    return templates.filter(item =>
      (templateSubBrand === "all" || (item.subBrand || "all") === templateSubBrand) &&
      (!query || [item.name, item.subject, item.eventLabel, item.eventKey, item.body]
        .some(value => String(value || "").toLowerCase().includes(query))),
    ).sort((a, b) => Number(Boolean(b.isActive)) - Number(Boolean(a.isActive)));
  }, [templates, templateSearch, templateSubBrand]);
  const grouped = useMemo(() => visibleTemplates.reduce((map, item) => {
    (map[item.eventKey] ||= []).push(item);
    return map;
  }, {}), [visibleTemplates]);

  const saveTemplate = async event => {
    event.preventDefault();
    try {
      const method = templateDraft.id ? "PUT" : "POST";
      const url = templateDraft.id ? `/api/travel/email-automation/templates/${templateDraft.id}` : "/api/travel/email-automation/templates";
      await fetchApi(url, { method, body: JSON.stringify(templateDraft) });
      notify.success("Template saved.");
      setTemplateDraft(null);
      await load();
    } catch (e) {
      notify.error(e?.message || "Template could not be saved.");
    }
  };

  const removeTemplate = async item => {
    if (!window.confirm(`Delete template "${item.name}"?`)) return;
    try {
      await fetchApi(`/api/travel/email-automation/templates/${item.id}`, { method: "DELETE" });
      notify.success("Template deleted.");
      await load();
    } catch (e) {
      notify.error(e?.message || "Template could not be deleted.");
    }
  };

  const preview = async item => setPreviewData(await fetchApi(`/api/travel/email-automation/templates/${item.id}/preview`));
  const toggleTemplate = async item => {
    try {
      await fetchApi(`/api/travel/email-automation/templates/${item.id}`, { method: "PUT", body: JSON.stringify({ isActive: !item.isActive }) });
      notify.success(item.isActive ? "Template paused." : "Template resumed.");
      await load();
    } catch (e) {
      notify.error(e?.message || "Template status could not be changed.");
    }
  };

  const changeHistoryPage = async page => {
    setHistoryPage(page);
    await loadHistory(page);
  };

  const toggleLogSelection = id => {
    setSelectedLogIds(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id]);
  };

  const toggleCurrentPage = () => {
    const pageIds = logs.map(item => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every(id => selectedLogIds.includes(id));
    setSelectedLogIds(allSelected ? selectedLogIds.filter(id => !pageIds.includes(id)) : [...new Set([...selectedLogIds, ...pageIds])]);
  };

  const deleteSelectedLogs = async () => {
    if (!selectedLogIds.length || !window.confirm(`Delete ${selectedLogIds.length} selected delivery record${selectedLogIds.length === 1 ? "" : "s"}?`)) return;
    setHistoryBusy(true);
    try {
      const result = await fetchApi("/api/travel/email-automation/delivery-logs/bulk-delete", { method: "POST", body: JSON.stringify({ ids: selectedLogIds }) });
      notify.success(`${result?.deleted || selectedLogIds.length} delivery record${(result?.deleted || selectedLogIds.length) === 1 ? "" : "s"} deleted.`);
      const nextPage = logs.length === selectedLogIds.length && historyPage > 1 ? historyPage - 1 : historyPage;
      setHistoryPage(nextPage);
      await loadHistory(nextPage);
    } catch (e) {
      notify.error(e?.message || "Delivery records could not be deleted.");
      setHistoryBusy(false);
    }
  };

  const openLogDetail = async item => {
    setHistoryBusy(true);
    try {
      setLogDetail(await fetchApi(`/api/travel/email-automation/delivery-logs/${item.id}`));
    } catch (e) {
      notify.error(e?.message || "Delivery message could not be loaded.");
    } finally {
      setHistoryBusy(false);
    }
  };

  return <main className="travel-page" style={{ padding: "1.5rem 2rem 2.5rem", maxWidth: 1500, margin: "0 auto" }}>
    <header className="travel-email-header"><Mail size={26} /><div><h1>Email automation</h1><p>Create Travel email templates and event triggers.</p></div><span /><button className="btn-secondary" onClick={load}><RefreshCw size={15} /> Refresh</button>{tab === "templates" && <button className="btn-primary" onClick={() => setTemplateDraft({ ...EMPTY, eventKey: catalog.essential[0]?.value || "" })}><Plus size={15} /> Create new template</button>}</header>
    <nav className="travel-email-tabs">{[["templates", "Email templates"], ["logs", "Delivery history"]].map(([key, label]) => <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>{label}</button>)}</nav>
    <div className="travel-email-info"><strong>Travel CRM only.</strong> Templates, recipients, and delivery history are separate from Generic and Wellness. Recipients are resolved automatically; passwords are never sent.</div>
    {loading ? <p>Loading...</p> : error ? <p>{error}</p> : tab === "templates" ? <section><div className="travel-section-heading"><div><h2>Email templates</h2><p>Each active template sends when its event trigger occurs.</p></div><span>{visibleTemplates.length}{visibleTemplates.length !== templates.length ? ` of ${templates.length}` : ""} templates</span></div><div className="travel-template-filter"><select className="input-field" aria-label="Filter templates by subbrand" value={templateSubBrand} onChange={e => setTemplateSubBrand(e.target.value)}><option value="all">All subbrands</option>{catalog.subBrands.map(item => <option key={item} value={item}>{brandLabel(item)}</option>)}</select><input className="input-field" aria-label="Search Travel email templates" placeholder="Search templates..." value={templateSearch} onChange={e => setTemplateSearch(e.target.value)} /></div><div className="travel-template-grid">{Object.keys(grouped).flatMap(key => grouped[key].map(item => <article className="card" key={item.id}><div className="travel-card-heading"><div><h3>{item.name}</h3><small>{brandLabel(item.subBrand)}</small></div><button className="btn-secondary" onClick={() => preview(item)} aria-label={`Preview ${item.name}`}><Eye size={14} /></button></div><div><strong>Event:</strong> {eventLabel(key)}</div><div><strong>Subject:</strong> {item.subject}</div><p>{String(item.body || "").replace(/<[^>]+>/g, "").slice(0, 150)}</p><div className="travel-template-actions"><span className={`travel-template-status-badge ${item.isActive ? "running" : "paused"}`}>{item.isActive ? "Running" : "Paused"}</span><button className={`btn-secondary travel-template-action ${item.isActive ? "pause" : "run"}`} onClick={() => toggleTemplate(item)}>{item.isActive ? <Pause size={14} /> : <Play size={14} />} {item.isActive ? "Pause" : "Run"}</button><button className="btn-secondary travel-template-action edit" onClick={() => setTemplateDraft({ ...item, subBrand: item.subBrand || "all" })}>Edit</button>{!item.isDefault && <button className="btn-secondary travel-template-action danger" aria-label={`Delete ${item.name}`} onClick={() => removeTemplate(item)}><Trash2 size={14} /> Delete</button>}</div></article>))}</div></section> : <DeliveryHistory logs={logs} pagination={logPagination} selectedIds={selectedLogIds} busy={historyBusy} onTogglePage={toggleCurrentPage} onToggleOne={toggleLogSelection} onDelete={deleteSelectedLogs} onOpen={openLogDetail} onPageChange={changeHistoryPage} />}
    {templateDraft && <TravelTemplateEditor draft={templateDraft} setDraft={setTemplateDraft} catalog={catalog} onSave={saveTemplate} onClose={() => setTemplateDraft(null)} />}
    {previewData && <div className="travel-modal"><div className="card travel-modal-card"><h2>{previewData.subject}</h2><div dangerouslySetInnerHTML={{ __html: previewData.body }} /><button className="btn-secondary" onClick={() => setPreviewData(null)}>Close</button></div></div>}
    {logDetail && <div className="travel-modal" role="dialog" aria-modal="true" aria-label="Sent email details"><div className="card travel-modal-card travel-history-detail"><header><div><small>{logDetail.eventKey}</small><h2>{logDetail.subject}</h2></div><button type="button" className="travel-icon-button" aria-label="Close sent email details" onClick={() => setLogDetail(null)}><X size={18} /></button></header><dl><div><dt>To</dt><dd>{logDetail.recipientEmail}</dd></div><div><dt>Status</dt><dd>{logDetail.status}</dd></div><div><dt>Sent</dt><dd>{new Date(logDetail.sentAt || logDetail.createdAt).toLocaleString()}</dd></div></dl><section><h3>Message</h3>{logDetail.bodyHtml ? <div className="travel-history-message" dangerouslySetInnerHTML={{ __html: logDetail.bodyHtml }} /> : <p className="travel-history-unavailable">The message body was not recorded for this older delivery.</p>}</section><footer><button type="button" className="btn-secondary" onClick={() => setLogDetail(null)}>Close</button></footer></div></div>}
  </main>;
}

