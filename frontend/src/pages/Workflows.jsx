import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Check,
  CreditCard,
  ChevronDown,
  Copy,
  FileText,
  GripVertical,
  Mail,
  MoreVertical,
  Pencil,
  Play,
  Plus,
  Search,
  Send,
  ShieldCheck,
  UserCheck,
  Trash2,
  Users,
  Webhook,
  X,
} from "lucide-react";
import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";

const MODULES = [
  { value: "contact", label: "Contacts", icon: Users },
  { value: "deal", label: "Deals", icon: Activity },
  { value: "task", label: "Tasks", icon: Check },
  { value: "ticket", label: "Tickets", icon: Activity },
  { value: "invoice", label: "Invoices", icon: FileText },
  { value: "payment", label: "Payments", icon: CreditCard },
  { value: "lead", label: "Leads", icon: UserCheck },
  { value: "approval", label: "Approvals", icon: ShieldCheck },
];

const TEMPLATE_CATEGORIES = [
  { value: "all", label: "All templates" },
  { value: "get_started", label: "Get started" },
  { value: "qualify_leads", label: "Qualify leads" },
  { value: "close_deals", label: "Close deals" },
  { value: "increase_productivity", label: "Increase productivity" },
];

const TEMPLATES = [
  {
    name: "Junk Lead Suppression to Meta",
    category: "qualify_leads",
    module: "contact",
    triggerType: "contact.created_or_updated",
    execution: "once",
    description: "Notify Meta when a lead is identified as junk so future campaign data can be improved.",
    groups: [
      {
        name: "Identify junk leads",
        match: "any",
        clauses: [
          { entity: "contact", field: "tags", op: "icontains", value: "junk" },
          { entity: "contact", field: "status", op: "eq", value: "Junk" },
          { entity: "contact", field: "callifiedLeadStatus", op: "eq", value: "junk" },
        ],
      },
      {
        name: "Require Meta lead ID",
        match: "all",
        clauses: [{ entity: "contact", field: "metaLeadgenId", op: "exists", value: true }],
      },
    ],
    actions: [{
      type: "send_webhook",
      config: {
        url: "https://globussoft.ai/wp-json/junk-suppression/v1/webhook",
        method: "POST",
        encoding: "json",
        bodyMode: "advanced",
        bodyTemplate: JSON.stringify({
          event: "junk_lead",
          contact_id: "{{contactId}}",
          meta_leadgen_id: "{{metaLeadgenId}}",
          external_id: "{{externalId}}",
          name: "{{name}}",
          email: "{{email}}",
          phone: "{{phone}}",
          source: "{{source}}",
          tags: "{{tags}}",
          status: "{{status}}",
          callified_lead_status: "{{callifiedLeadStatus}}",
          callified_lead_status_reason: "{{callifiedLeadStatusReason}}",
          meta_signal: "{{metaSignal}}",
        }, null, 2),
      },
    }],
  },
  { name: "Send welcome email to new leads", category: "get_started", module: "contact", action: "send_email" },
  { name: "Set reminder to call new website leads", category: "get_started", module: "contact", action: "create_task" },
  { name: "Add deal for qualified leads", category: "get_started", module: "deal", action: "create_task" },
  { name: "Follow up on new deals", category: "close_deals", module: "deal", action: "create_task" },
  { name: "Notify your team when deals are won", category: "close_deals", module: "deal", action: "send_notification" },
  { name: "Change contact status to Interested", category: "qualify_leads", module: "contact", action: "update_field" },
  { name: "Follow up on cold leads", category: "qualify_leads", module: "contact", action: "create_task" },
  { name: "Notify your team about new leads", category: "qualify_leads", module: "contact", action: "send_notification" },
  { name: "Start customer onboarding after deal closure", category: "close_deals", module: "deal", action: "create_task" },
  { name: "Follow up on upcoming contract renewal", category: "close_deals", module: "deal", action: "create_task" },
  { name: "Manage contact ownership based on account", category: "increase_productivity", module: "contact", action: "assign_agent" },
  { name: "Manage deal ownership based on account", category: "increase_productivity", module: "deal", action: "assign_agent" },
  { name: "Send LinkedIn connection to new leads", category: "increase_productivity", module: "contact", action: "send_webhook" },
  { name: "Send welcome email to new leads", category: "increase_productivity", module: "contact", action: "send_email" },
  { name: "Notify your team when deals are lost", category: "close_deals", module: "deal", action: "send_notification" },
];

const TRIGGERS = [
  { module: "contact", value: "contact.created_or_updated", label: "When contact is created or updated" },
  { module: "contact", value: "contact.created", label: "When contact is created" },
  { module: "contact", value: "contact.updated", label: "When contact is updated" },
  { module: "contact", value: "lead.converted", label: "When a lead is converted" },
  { module: "deal", value: "deal.created", label: "When deal is created" },
  { module: "deal", value: "deal.updated", label: "When deal is created or updated" },
  { module: "deal", value: "deal.stage_changed", label: "When deal stage changes" },
  { module: "deal", value: "deal.won", label: "When deal is won" },
  { module: "deal", value: "deal.lost", label: "When deal is lost" },
  { module: "task", value: "task.created", label: "When task is created" },
  { module: "task", value: "task.completed", label: "When task is completed" },
  { module: "ticket", value: "ticket.created", label: "When ticket is created" },
  { module: "ticket", value: "ticket.updated", label: "When ticket is created or updated" },
  { module: "ticket", value: "sla.breached", label: "When a ticket SLA is breached" },
  { module: "invoice", value: "invoice.created", label: "When invoice is created" },
  { module: "invoice", value: "invoice.paid", label: "When invoice is paid" },
  { module: "invoice", value: "invoice.completed", label: "When invoice is completed" },
  { module: "invoice", value: "invoice.voided", label: "When invoice is voided" },
  { module: "invoice", value: "invoice.refunded", label: "When invoice is refunded" },
  { module: "invoice", value: "invoice.overdue", label: "When invoice is overdue" },
  { module: "payment", value: "payment.collected", label: "When payment is collected" },
  { module: "lead", value: "lead.converted", label: "When a lead is converted" },
  { module: "approval", value: "approval.created", label: "When approval is created" },
  { module: "approval", value: "approval.approved", label: "When approval is approved" },
  { module: "approval", value: "approval.rejected", label: "When approval is rejected" },
];

const ACTIONS = [
  { value: "send_email", label: "Send email", icon: Mail },
  { value: "send_sms", label: "Send SMS", icon: Send },
  { value: "send_notification", label: "Send notification", icon: Activity },
  { value: "create_task", label: "Create task", icon: Check },
  { value: "update_field", label: "Update field", icon: Pencil },
  { value: "assign_agent", label: "Assign agent", icon: Users },
  { value: "send_webhook", label: "Trigger webhook", icon: Webhook },
  { value: "create_approval", label: "Create approval request", icon: ShieldCheck },
];

const OPERATORS = [
  ["eq", "is"], ["neq", "is not"], ["contains", "contains"], ["icontains", "contains (case-insensitive)"],
  ["startsWith", "starts with"], ["gt", "greater than"], ["gte", "at least"],
  ["lt", "less than"], ["lte", "at most"], ["in", "is in"],
];

const FIELD_OPTIONS = {
  contact: ["contactId", "name", "email", "phone", "company", "title", "status", "source", "tags", "aiScore", "assignedToId", "firstTouchSource", "lastTouchSource", "callifiedLeadStatus", "callifiedLeadStatusReason", "externalId", "metaLeadgenId", "metaSignal", "metaIsJunk", "metaIsQualified", "changedFields"],
  deal: ["dealId", "title", "amount", "stage", "contactId", "userId"],
  task: ["taskId", "title", "contactId", "assignedToId", "status"],
  ticket: ["ticketId", "subject", "priority", "status", "contactId", "userId"],
  invoice: ["invoiceId", "contactId", "dealId", "status", "amount", "dueDate", "currency"],
  payment: ["paymentId", "invoiceId", "contactId", "amount", "status", "method"],
  lead: ["contactId", "name", "email", "company", "source", "status", "assignedToId"],
  approval: ["approvalId", "entity", "entityId", "status", "requesterId"],
};

const defaultWebhookConfig = (module) => ({
  url: "",
  method: "POST",
  encoding: "json",
  bodyMode: "simple",
  selectedFields: FIELD_OPTIONS[module] || [],
  headers: [],
  bodyTemplate: JSON.stringify({
    lead_id: "{{contactId}}",
    classification: "{{status}}",
    tags: "{{tags}}",
    source: "{{source}}",
  }, null, 2),
});

const MUTABLE_FIELD_OPTIONS = {
  contact: ["name", "email", "phone", "company", "title", "status", "source", "assignedToId"],
  deal: ["title", "amount", "currency", "probability", "stage", "expectedClose", "lostReason", "ownerId"],
  task: ["title", "dueDate", "status", "priority", "notes", "userId"],
  ticket: ["subject", "description", "status", "priority", "assigneeId"],
};

const defaultTriggerForModule = (module) => TRIGGERS.find((trigger) => trigger.module === module)?.value || "contact.created";
const triggersForModule = (module) => TRIGGERS.filter((trigger) => trigger.module === module);
const actionsForModule = (module) => ACTIONS.filter((action) => !["update_field", "assign_agent"].includes(action.value) || ["contact", "deal", "task", "ticket"].includes(module));
const defaultCondition = (module = "contact") => ({ entity: module, field: "", op: "eq", value: "" });
const defaultGroup = (module = "contact") => ({ name: "", match: "all", clauses: [defaultCondition(module)] });

function formatDate(value) {
  if (!value) return "Not run yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not run yet" : date.toLocaleDateString();
}

function workflowOrder(workflow) {
  try {
    const targetState = typeof workflow.targetState === "string" ? JSON.parse(workflow.targetState) : workflow.targetState;
    const order = Number(targetState?.order);
    return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
  } catch (_error) {
    return Number.POSITIVE_INFINITY;
  }
}

function emptyRule(template) {
  const selected = template || {};
  return {
    id: null,
    name: selected.name || "Untitled workflow",
    description: selected.description || "",
    module: selected.module || "contact",
    triggerType: selected.triggerType || defaultTriggerForModule(selected.module || "contact"),
    execution: selected.execution || "once",
    groups: selected.groups || [defaultGroup(selected.module || "contact")],
    actions: selected.actions || [{ type: selected.action || "send_email", config: selected.actionConfig || {} }],
    order: null,
    isActive: false,
  };
}

function fromRule(rule) {
  let target = {};
  try { target = rule.targetState ? JSON.parse(rule.targetState) : {}; } catch { target = {}; }
  let groups = [];
  try {
    const parsed = rule.condition ? JSON.parse(rule.condition) : [];
    groups = parsed?.groups || (Array.isArray(parsed) && parsed.length ? [{ name: "", match: "all", clauses: parsed }] : []);
  } catch { groups = []; }
  return {
    id: rule.id,
    name: rule.name || "Untitled workflow",
    description: target.description || "",
    module: target.module || "contact",
    triggerType: rule.triggerType,
    execution: target.execution || "once",
    groups: groups.length ? groups : [defaultGroup(target.module || "contact")],
    actions: target.actions?.length ? target.actions : [{ type: rule.actionType, config: target }],
    order: Number.isFinite(Number(target.order)) ? Number(target.order) : null,
    isActive: !!rule.isActive,
  };
}

function Select({ value, onChange, children, "aria-label": ariaLabel, disabled = false }) {
  return <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled} className="workflow-select">{children}</select>;
}

function ConditionGroup({ group, index, module, updateGroup, removeGroup }) {
  const updateClause = (clauseIndex, patch) => {
    const clauses = group.clauses.map((clause, currentIndex) => currentIndex === clauseIndex ? { ...clause, ...patch } : clause);
    updateGroup(index, { clauses });
  };
  return (
    <div className="workflow-condition-group">
      <div className="workflow-group-head">
        <span className="workflow-group-number">{index + 1}</span>
        <input aria-label={`Condition group ${index + 1} name`} value={group.name} onChange={(event) => updateGroup(index, { name: event.target.value })} placeholder="Add a name for this group of conditions" />
        <label className="workflow-match">Match <b>{group.match === "all" ? "ALL" : "ANY"}</b> conditions
          <input type="checkbox" checked={group.match === "any"} onChange={(event) => updateGroup(index, { match: event.target.checked ? "any" : "all" })} />
          <span className="workflow-switch" />
        </label>
        {index > 0 && <button type="button" className="workflow-icon-button" onClick={() => removeGroup(index)} aria-label={`Remove condition group ${index + 1}`}><Trash2 size={15} /></button>}
      </div>
      {group.clauses.map((clause, clauseIndex) => (
        <div className="workflow-condition-row" key={`${index}-${clauseIndex}`}>
          <Select aria-label={`Condition ${index + 1} entity ${clauseIndex + 1}`} value={clause.entity} onChange={(entity) => updateClause(clauseIndex, { entity, field: "" })}>
            {MODULES.map((module) => <option key={module.value} value={module.value}>{module.label.replace(/s$/, "")}</option>)}
          </Select>
          <Select aria-label={`Condition ${index + 1} field ${clauseIndex + 1}`} value={clause.field} onChange={(field) => updateClause(clauseIndex, { field })}>
            <option value="">Select field</option>{(FIELD_OPTIONS[clause.entity] || []).map((field) => <option key={field} value={field}>{field}</option>)}
          </Select>
          <Select aria-label={`Condition ${index + 1} operator ${clauseIndex + 1}`} value={clause.op} onChange={(op) => updateClause(clauseIndex, { op })}>
            {OPERATORS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
          <input aria-label={`Condition ${index + 1} value ${clauseIndex + 1}`} value={Array.isArray(clause.value) ? clause.value.join(", ") : clause.value} onChange={(event) => updateClause(clauseIndex, { value: event.target.value })} placeholder="Enter value" />
          <button type="button" className="workflow-icon-button" onClick={() => updateGroup(index, { clauses: group.clauses.filter((_, currentIndex) => currentIndex !== clauseIndex) })} aria-label={`Remove condition ${clauseIndex + 1}`}><Trash2 size={15} /></button>
          {clauseIndex < group.clauses.length - 1 && <span className="workflow-or">{group.match === "any" ? "OR" : "AND"}</span>}
        </div>
      ))}
      <button type="button" className="workflow-link-button" onClick={() => updateGroup(index, { clauses: [...group.clauses, defaultCondition(module)] })}><Plus size={15} /> Add condition</button>
    </div>
  );
}

function WebhookSettingsModal({ initialConfig, module, workflowId, onSave, onClose }) {
  const notify = useNotify();
  const [draft, setDraft] = useState({ ...defaultWebhookConfig(module), ...initialConfig });
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  const update = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const updateHeader = (headerIndex, patch) => update({ headers: draft.headers.map((header, index) => index === headerIndex ? { ...header, ...patch } : header) });
  const testWebhook = async () => {
    if (!draft.url.trim()) { notify.error("Callback URL is required"); return; }
    setTesting(true);
    try {
      const response = await fetchApi("/api/workflows/test-webhook", {
        method: "POST",
        body: JSON.stringify({ config: draft, event: `${module}.updated`, workflowId }),
      });
      notify.success(`Webhook responded with HTTP ${response.result?.status || 200}`);
    } catch (_error) { /* fetchApi already toasted */ }
    finally { setTesting(false); }
  };
  return <div className="workflow-webhook-overlay" onMouseDown={onClose}>
    <div className="workflow-webhook-panel" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Webhook settings">
      <div className="workflow-webhook-head"><h2>WEBHOOK SETTINGS</h2><button type="button" className="workflow-icon-button" onClick={onClose} aria-label="Close webhook settings"><X size={18} /></button></div>
      <div className="workflow-webhook-body">
        <div className="workflow-webhook-help"><b>Configure how this workflow sends the matching CRM record.</b><span>Use placeholders such as <code>{"{{contactId}}"}</code> or <code>{"{{status}}"}</code> in an advanced JSON body.</span></div>
        <label>Request method<Select aria-label="Webhook request method" value={draft.method} onChange={(method) => update({ method })}><option>POST</option><option>PUT</option><option>PATCH</option></Select></label>
        <label>Callback URL<input aria-label="Webhook callback URL" value={draft.url} onChange={(event) => update({ url: event.target.value })} placeholder="https://your-domain.com/meta/lead-feedback" /></label>
        <fieldset><legend>Custom headers</legend>{draft.headers.map((header, headerIndex) => <div className="workflow-webhook-header-row" key={headerIndex}>
          <input aria-label={`Webhook header ${headerIndex + 1} name`} value={header.key || ""} onChange={(event) => updateHeader(headerIndex, { key: event.target.value })} placeholder="X-Webhook-Secret" />
          <input aria-label={`Webhook header ${headerIndex + 1} value`} type={header.secret ? "password" : "text"} value={header.value || ""} onChange={(event) => updateHeader(headerIndex, { value: event.target.value })} placeholder="Header value" />
          <label className="workflow-webhook-secret"><input type="checkbox" checked={!!header.secret} onChange={(event) => updateHeader(headerIndex, { secret: event.target.checked })} /> Secret</label>
          <button type="button" className="workflow-icon-button" onClick={() => update({ headers: draft.headers.filter((_, index) => index !== headerIndex) })} aria-label={`Remove webhook header ${headerIndex + 1}`}><Trash2 size={15} /></button>
        </div>)}<button type="button" className="workflow-link-button" onClick={() => update({ headers: [...draft.headers, { key: "", value: "", secret: true }] })}><Plus size={15} /> Add custom header</button></fieldset>
        <fieldset><legend>Encoding format</legend><div className="workflow-webhook-options">{[["json", "JSON"], ["xml", "XML"], ["form", "Form URL encoded"]].map(([value, label]) => <label key={value}><input type="radio" checked={draft.encoding === value} onChange={() => update({ encoding: value })} /> {label}</label>)}</div></fieldset>
        <fieldset><legend>Request body</legend><div className="workflow-webhook-options"><label><input type="radio" checked={draft.bodyMode === "simple"} onChange={() => update({ bodyMode: "simple" })} /> Simple</label><label><input type="radio" checked={draft.bodyMode === "advanced"} onChange={() => update({ bodyMode: "advanced" })} /> Advanced JSON</label></div>
          {draft.bodyMode === "simple" ? <div className="workflow-webhook-fields">{(FIELD_OPTIONS[module] || []).map((field) => <label key={field}><input type="checkbox" checked={(draft.selectedFields || []).includes(field)} onChange={(event) => update({ selectedFields: event.target.checked ? [...(draft.selectedFields || []), field] : (draft.selectedFields || []).filter((item) => item !== field) })} /> {field}</label>)}</div> : <textarea aria-label="Advanced webhook JSON body" value={draft.bodyTemplate || ""} onChange={(event) => update({ bodyTemplate: event.target.value })} rows={10} spellCheck="false" />}
        </fieldset>
      </div>
      <div className="workflow-webhook-footer"><button type="button" className="workflow-secondary" onClick={testWebhook} disabled={testing}>{testing ? "Testing..." : "Test this webhook"}</button><span /><button type="button" className="workflow-secondary" onClick={onClose}>Cancel</button><button type="button" className="workflow-primary" onClick={() => { onSave(draft); onClose(); }}>Save settings</button></div>
    </div>
  </div>;
}

function ActionCard({ action, index, module, workflowId, updateAction, removeAction }) {
  const [showWebhookSettings, setShowWebhookSettings] = useState(false);
  const selected = ACTIONS.find((item) => item.value === action.type) || ACTIONS[0];
  const ActionIcon = selected.icon;
  const config = action.config || {};
  const updateConfig = (key, value) => updateAction(index, { config: { ...config, [key]: value } });
  return (
    <div className="workflow-action-card">
      <div className="workflow-action-row">
        <span className="workflow-group-number">{index + 1}</span>
        <div className="workflow-action-content">
          <div className="workflow-action-title">Action for: {MODULES.find((item) => item.value === module)?.label || "Contacts"} <ChevronDown size={14} /></div>
          <Select aria-label={`Action ${index + 1}`} value={action.type} onChange={(type) => updateAction(index, { type, config: type === "update_field" ? { entity: module } : {} })}>
            {actionsForModule(module).map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select>
          {(action.type === "send_email" || action.type === "send_sms") && <input aria-label={`Action ${index + 1} recipient`} value={config.to || ""} onChange={(event) => updateConfig("to", event.target.value)} placeholder={action.type === "send_email" ? "Recipient email or record field" : "Recipient phone or record field"} />}
          {action.type === "send_notification" && <input aria-label={`Action ${index + 1} recipient user`} value={config.userId || ""} onChange={(event) => updateConfig("userId", event.target.value)} placeholder="Recipient user ID (optional)" inputMode="numeric" />}
          {action.type === "send_email" && <input aria-label={`Action ${index + 1} subject`} value={config.subject || ""} onChange={(event) => updateConfig("subject", event.target.value)} placeholder="Subject" />}
          {(action.type === "send_email" || action.type === "send_sms" || action.type === "send_notification") && <textarea aria-label={`Action ${index + 1} message`} value={config.message || config.body || ""} onChange={(event) => updateConfig(action.type === "send_email" ? "body" : "message", event.target.value)} placeholder="Message or body" rows={2} />}
          {action.type === "create_task" && <input aria-label={`Action ${index + 1} task title`} value={config.title || ""} onChange={(event) => updateConfig("title", event.target.value)} placeholder="Task title" />}
          {action.type === "create_task" && <input aria-label={`Action ${index + 1} task due days`} type="number" min="0" value={config.dueInDays || ""} onChange={(event) => updateConfig("dueInDays", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Due in days (default: 3)" />}
          {action.type === "create_task" && <input aria-label={`Action ${index + 1} task assignee`} inputMode="numeric" value={config.assignToId || ""} onChange={(event) => updateConfig("assignToId", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Assignee user ID (optional)" />}
          {action.type === "update_field" && <Select aria-label={`Action ${index + 1} field name`} value={config.field || ""} onChange={(field) => updateConfig("field", field)}><option value="">Select field</option>{(MUTABLE_FIELD_OPTIONS[module] || []).map((field) => <option key={field} value={field}>{field}</option>)}</Select>}
          {action.type === "update_field" && <input aria-label={`Action ${index + 1} field value`} value={config.value || ""} onChange={(event) => updateConfig("value", event.target.value)} placeholder="Field value" />}
          {action.type === "assign_agent" && <input aria-label={`Action ${index + 1} assignee`} inputMode="numeric" value={config.userId || ""} onChange={(event) => updateConfig("userId", event.target.value === "" ? "" : Number(event.target.value))} placeholder="Assignee user ID" />}
          {action.type === "create_approval" && <Select aria-label={`Action ${index + 1} approval entity`} value={config.entity || "Deal"} onChange={(entity) => updateConfig("entity", entity)}><option>Deal</option><option>Contact</option><option>Invoice</option><option>Ticket</option></Select>}
          {action.type === "create_approval" && <input aria-label={`Action ${index + 1} approval reason`} value={config.reasonTemplate || ""} onChange={(event) => updateConfig("reasonTemplate", event.target.value)} placeholder="Reason, e.g. Discount review for {{title}}" />}
          {action.type === "send_webhook" && <input aria-label={`Action ${index + 1} webhook URL`} value={config.url || ""} onChange={(event) => updateConfig("url", event.target.value)} placeholder="https://example.com/webhook" />}
          {action.type === "send_webhook" && <button type="button" className="workflow-link-button" onClick={() => setShowWebhookSettings(true)}><Pencil size={14} /> Edit webhook settings</button>}
        </div>
        <ActionIcon size={18} className="workflow-action-icon" />
        <button type="button" className="workflow-icon-button" onClick={() => removeAction(index)} aria-label={`Remove action ${index + 1}`}><Trash2 size={15} /></button>
      </div>
      {showWebhookSettings && <WebhookSettingsModal initialConfig={config} module={module} workflowId={workflowId} onSave={(nextConfig) => updateAction(index, { config: nextConfig })} onClose={() => setShowWebhookSettings(false)} />}
    </div>
  );
}

export default function Workflows() {
  const notify = useNotify();
  const [view, setView] = useState("all");
  const [templateCategory, setTemplateCategory] = useState("all");
  const [templateSearch, setTemplateSearch] = useState("");
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState(null);
  const [history, setHistory] = useState(null);
  const [openMenu, setOpenMenu] = useState(null);
  const [saving, setSaving] = useState(false);
  const [actionStats, setActionStats] = useState({});

  useEffect(() => {
    if (openMenu === null) return undefined;
    const closeMenu = (event) => {
      if (!event.target.closest(".workflow-menu-wrap")) setOpenMenu(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const [itemsResult, statsResult] = await Promise.all([
        fetchApi("/api/workflows"),
        fetchApi("/api/workflows/stats/actions").catch(() => ({})),
      ]);
      const items = itemsResult || [];
      setActionStats(statsResult || {});
      const hasStoredOrder = items.some((workflow) => Number.isFinite(workflowOrder(workflow)));
      setWorkflows(hasStoredOrder ? [...items].sort((a, b) => workflowOrder(a) - workflowOrder(b)) : items);
    }
    catch (_error) { /* fetchApi already toasted */ }
    finally { setLoading(false); }
  };
  // The loader is intentionally stable for this page lifetime. It no longer
  // closes over `notify`, so exhaustive-deps is satisfied without a suppression.
  useEffect(() => { loadWorkflows(); }, []);

  const filteredWorkflows = useMemo(() => workflows.filter((workflow) => view === "all" || (view === "active" ? workflow.isActive : !workflow.isActive)), [workflows, view]);
  const filteredTemplates = TEMPLATES
    .filter((template) => (templateCategory === "all" || template.category === templateCategory) && template.name.toLowerCase().includes(templateSearch.toLowerCase()))
    .sort((a, b) => Number(a.name === "Junk Lead Suppression to Meta") - Number(b.name === "Junk Lead Suppression to Meta"));

  const save = async (activate, options = {}) => {
    if (!editor.name.trim()) { notify.error("Workflow name is required"); return null; }
    setSaving(true);
    const conditionGroups = editor.groups.map((group) => ({
      ...group,
      clauses: group.clauses
        .filter((clause) => clause.field)
        .map((clause) => (["in", "nin"].includes(clause.op) && typeof clause.value === "string"
          ? { ...clause, value: clause.value.split(",").map((value) => value.trim()).filter(Boolean) }
          : clause)),
    }));
    const actions = editor.actions.map((action) => ["update_field", "assign_agent"].includes(action.type) ? { ...action, config: { ...action.config, entity: action.config.entity || editor.module } } : action);
    const targetState = { module: editor.module, execution: editor.execution, description: editor.description, actions, ...(editor.order !== null ? { order: editor.order } : {}) };
    const payload = { name: editor.name.trim(), triggerType: editor.triggerType, actionType: editor.actions[0]?.type || "send_notification", targetState, condition: JSON.stringify({ groups: conditionGroups }) };
    try {
      const saved = editor.id
        ? await fetchApi(`/api/workflows/${editor.id}`, { method: "PUT", body: JSON.stringify({ ...payload, isActive: activate }) })
        : await fetchApi("/api/workflows", { method: "POST", body: JSON.stringify({ ...payload, isActive: activate }) });
      if (!options.silent) notify.success(activate ? "Workflow enabled" : "Workflow saved as draft");
      if (options.keepOpen) setEditor(fromRule(saved));
      else setEditor(null);
      await loadWorkflows();
      return saved;
    } catch (_error) { /* fetchApi already toasted; falls through to return null */ }
    finally { setSaving(false); }
    return null;
  };

  const toggleWorkflow = async (workflow) => {
    try { const updated = await fetchApi(`/api/workflows/${workflow.id}/toggle`, { method: "PUT" }); setWorkflows((items) => items.map((item) => item.id === workflow.id ? updated : item)); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const deleteWorkflow = async (workflow) => {
    if (!window.confirm(`Delete workflow "${workflow.name}"?`)) return;
    try { await fetchApi(`/api/workflows/${workflow.id}`, { method: "DELETE" }); setWorkflows((items) => items.filter((item) => item.id !== workflow.id)); notify.success("Workflow deleted"); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const testWorkflow = async (workflow) => {
    try { const response = await fetchApi(`/api/workflows/${workflow.id}/test`, { method: "POST", body: JSON.stringify({}) }); if (response.success) notify.success(response.message || "Workflow test completed"); else notify.error(response.result?.error || response.message || "Workflow test failed"); await loadWorkflows(); }
    catch (_error) { /* fetchApi already toasted */ }
  };
  const testEditor = async () => {
    let workflow = editor;
    if (!workflow.id) {
      const saved = await save(false, { keepOpen: true, silent: true });
      if (!saved) return;
      workflow = saved;
    }
    await testWorkflow(workflow);
  };

  const reorderWorkflows = async (fromIndex, toIndex) => {
    if (view !== "all" || fromIndex === toIndex) return;
    const next = [...workflows];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    setWorkflows(next);
    try {
      await fetchApi("/api/workflows/order", {
        method: "PUT",
        body: JSON.stringify({ workflowIds: next.map((workflow) => workflow.id) }),
      });
    } catch (_error) {
      // fetchApi already toasted — just roll the optimistic reorder back.
      await loadWorkflows();
    }
  };

  if (editor) {
    return <WorkflowEditor editor={editor} setEditor={setEditor} saving={saving} save={save} onTest={testEditor} onCancel={() => setEditor(null)} />;
  }

  if (history) return <HistoryPanel workflow={history} onClose={() => setHistory(null)} />;

  return (
    <div className="workflow-page">
      <div className="workflow-topbar"><div className="workflow-breadcrumb"><b>Workflows</b></div><button className="workflow-primary" onClick={() => setEditor(emptyRule())}><Plus size={17} /> Create workflow</button></div>
      <div className="workflow-layout">
        <aside className="workflow-sidebar">
          <h2>Workflow templates</h2>
          <nav>{TEMPLATE_CATEGORIES.map((category) => <button key={category.value} className={templateCategory === category.value ? "is-selected" : ""} onClick={() => { setTemplateCategory(category.value); setView("templates"); }}><span>{category.label}</span><small>{category.value === "all" ? TEMPLATES.length : TEMPLATES.filter((template) => template.category === category.value).length}</small></button>)}</nav>
          <div className="workflow-status-nav"><h2>Workflows by status</h2>{[["all", "All workflows"], ["active", "Active"], ["inactive", "Inactive"]].map(([value, label]) => <button key={value} className={view === value ? "is-selected" : ""} onClick={() => setView(value)}><span><i className={`workflow-status-dot ${value}`} />{label}</span><small>{value === "all" ? workflows.length : workflows.filter((workflow) => value === "active" ? workflow.isActive : !workflow.isActive).length}</small></button>)}</div>
          <div className="workflow-help"><b>What are workflows?</b><p>Automate repetitive CRM work when records change.</p></div>
        </aside>
        <main className="workflow-main">
          {view === "templates" ? <TemplateGallery search={templateSearch} setSearch={setTemplateSearch} category={templateCategory} templates={filteredTemplates} onUse={(template) => setEditor(emptyRule(template))} onCreate={() => setEditor(emptyRule())} /> : <WorkflowList workflows={filteredWorkflows} actionStats={actionStats} loading={loading} onEdit={(workflow) => setEditor(fromRule(workflow))} onToggle={toggleWorkflow} onDelete={deleteWorkflow} onTest={testWorkflow} onHistory={setHistory} openMenu={openMenu} setOpenMenu={setOpenMenu} view={view} onCreate={() => setEditor(emptyRule())} onReorder={reorderWorkflows} />}
        </main>
      </div>
    </div>
  );
}

function WorkflowList({ workflows, actionStats, loading, onEdit, onToggle, onDelete, onTest, onHistory, openMenu, setOpenMenu, view, onCreate, onReorder }) {
  const [dragIndex, setDragIndex] = useState(null);
  const canReorder = view === "all";
  const drop = (toIndex) => {
    if (dragIndex === null || dragIndex === toIndex) { setDragIndex(null); return; }
    onReorder(dragIndex, toIndex);
    setDragIndex(null);
  };
  return <>
    <div className="workflow-usage"><Activity size={16} /> <b>{workflows.filter((workflow) => workflow.isActive).length}</b> active workflows.</div>
    <div className="workflow-heading"><div><h1>{view === "active" ? "Active workflows" : view === "inactive" ? "Inactive workflows" : "All workflows"}</h1><p>{view === "inactive" ? "Use the toggle to enable a workflow." : "All your workflows are executed in the order below. Feel free to reorder them."}</p></div></div>
    {loading ? <div className="workflow-empty">Loading workflows...</div> : workflows.length === 0 ? <div className="workflow-empty"><Activity size={42} /><h3>No workflows found</h3><button className="workflow-primary" onClick={onCreate}>Create workflow</button></div> : <div className="workflow-list"><div className="workflow-list-header"><span>ORDER OF EXECUTION</span><span>NAME</span><span>TYPE</span><span>ACTIONS EXECUTED</span></div>{workflows.map((workflow, index) => <div className={`workflow-list-row ${dragIndex === index ? "is-dragging" : ""}`} key={workflow.id} draggable={canReorder} onDragStart={() => canReorder && setDragIndex(index)} onDragOver={(event) => canReorder && event.preventDefault()} onDrop={() => canReorder && drop(index)} onDragEnd={() => setDragIndex(null)}><div className="workflow-order"><GripVertical size={16} /><b>{index + 1}</b><button type="button" className={`workflow-toggle ${workflow.isActive ? "on" : ""}`} onClick={() => onToggle(workflow)} aria-label={`${workflow.isActive ? "Disable" : "Enable"} ${workflow.name}`}><span /></button></div><div className="workflow-name"><button onClick={() => onEdit(workflow)}>{workflow.name}</button><p>{workflow.isActive ? "Runs when its trigger conditions are met" : "Inactive workflow"}</p><small>Last updated {formatDate(workflow.updatedAt || workflow.createdAt)}</small></div><div className="workflow-type">{workflow.triggerType?.split(".")[0] || "CRM"}</div><div className="workflow-actions-summary"><b>{actionStats[String(workflow.id)] || 0} successful actions</b><span>in the last 7 days.</span><button onClick={() => onHistory(workflow)}>View history <ArrowLeft size={13} /></button></div><div className="workflow-menu-wrap"><button className="workflow-icon-button" onClick={() => setOpenMenu(openMenu === workflow.id ? null : workflow.id)} aria-label={`Actions for ${workflow.name}`}><MoreVertical size={18} /></button>{openMenu === workflow.id && <div className={`workflow-menu ${index >= workflows.length - 2 ? "menu-up" : ""}`}><button onClick={() => onEdit(workflow)}><Pencil size={14} /> Edit</button><button onClick={() => onTest(workflow)}><Play size={14} /> Test workflow</button><button onClick={() => onEdit({ ...workflow, id: null, name: `${workflow.name} copy` })}><Copy size={14} /> Clone</button><button onClick={() => onDelete(workflow)}><Trash2 size={14} /> Delete</button></div>}</div></div>)}</div>}
  </>;
}

function TemplateGallery({ search, setSearch, category, templates, onUse, onCreate }) {
  return <div className="workflow-template-main"><div className="workflow-heading"><div><h1>Start by selecting a workflow template</h1><p>Choose a ready-made workflow or create your own.</p></div></div><label className="workflow-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search for a template" /></label><h2>{TEMPLATE_CATEGORIES.find((item) => item.value === category)?.label || "All templates"}</h2><div className="workflow-template-grid">{templates.map((template, index) => <article className="workflow-template-card" key={`${template.name}-${index}`}><div className="workflow-template-icon"><Activity size={21} /></div><h3>{template.name}</h3><button className="workflow-dark-button" onClick={() => onUse(template)}>Use template</button></article>)}</div>{templates.length === 0 && <div className="workflow-empty">No templates match your search.</div>}<div className="workflow-create-footer">Could not find a template which works for you?<button className="workflow-dark-button" onClick={onCreate}>Create your own workflow</button></div></div>;
}

function WorkflowEditor({ editor, setEditor, saving, save, onTest, onCancel }) {
  const update = (patch) => setEditor((current) => ({ ...current, ...patch }));
  const updateGroup = (index, patch) => update({ groups: editor.groups.map((group, currentIndex) => currentIndex === index ? { ...group, ...patch } : group) });
  const updateAction = (index, patch) => update({ actions: editor.actions.map((action, currentIndex) => currentIndex === index ? { ...action, ...patch } : action) });
  const selectModule = (module) => update({
    module,
    triggerType: defaultTriggerForModule(module),
    groups: editor.groups.map((group) => ({ ...group, clauses: group.clauses.map((clause) => ({ ...clause, entity: module, field: "" })) })),
  });
  return (
    <div className="workflow-page workflow-editor-page">
      <div className="workflow-editor-topbar">
        <button className="workflow-back" onClick={onCancel}><ArrowLeft size={16} /> Workflows</button>
        <div>
          <button className="workflow-secondary" onClick={onCancel}>Cancel</button>
          <button className="workflow-secondary" onClick={() => save(false)} disabled={saving}>Save as draft</button>
          <button className="workflow-secondary" onClick={onTest} disabled={saving}><Play size={14} /> Test workflow</button>
          <button className="workflow-primary" onClick={() => save(true)} disabled={saving}><Check size={16} /> {saving ? "Saving..." : "Enable"}</button>
        </div>
      </div>
      <div className="workflow-editor-content">
        <input className="workflow-title-input" value={editor.name} onChange={(event) => update({ name: event.target.value })} aria-label="Workflow name" />
        <textarea className="workflow-description" value={editor.description} onChange={(event) => update({ description: event.target.value })} placeholder="Add description" aria-label="Workflow description" rows={1} />
        <section>
          <h2>Run this workflow for</h2>
          <div className="workflow-module-buttons">{MODULES.map((module) => <button key={module.value} className={editor.module === module.value ? "is-selected" : ""} onClick={() => selectModule(module.value)}><module.icon size={18} /> {module.label}</button>)}</div>
        </section>
        <section>
          <h2>When to trigger this workflow?</h2>
          <div className="workflow-trigger-line">
            <span>Trigger</span>
            <Select aria-label="Workflow trigger" value={editor.triggerType} onChange={(triggerType) => update({ triggerType })}>{triggersForModule(editor.module).map((trigger) => <option key={trigger.value} value={trigger.value}>{trigger.label}</option>)}</Select>
            <span>and run this workflow</span>
            <Select aria-label="Workflow execution frequency" value={editor.execution} onChange={(execution) => update({ execution })}><option value="once">once for each {editor.module}</option><option value="every">every time conditions match</option></Select>
          </div>
        </section>
        <section>
          <h2>What conditions should be met?</h2>
          {editor.groups.map((group, index) => <ConditionGroup key={index} group={group} index={index} module={editor.module} updateGroup={updateGroup} removeGroup={(groupIndex) => update({ groups: editor.groups.filter((_, currentIndex) => currentIndex !== groupIndex) })} />)}
          <button className="workflow-add-group" onClick={() => update({ groups: [...editor.groups, defaultGroup(editor.module)] })}><Plus size={15} /> Add group</button>
        </section>
        <section>
          <h2>What actions should be executed?</h2>
          {editor.actions.map((action, index) => <ActionCard key={index} action={action} index={index} module={editor.module} workflowId={editor.id} updateAction={updateAction} removeAction={(actionIndex) => update({ actions: editor.actions.filter((_, currentIndex) => currentIndex !== actionIndex) })} />)}
          <button className="workflow-link-button" onClick={() => update({ actions: [...editor.actions, { type: "send_notification", config: {} }] })}><Plus size={15} /> Add action</button>
        </section>
      </div>
    </div>
  );
}

function HistoryPanel({ workflow, onClose }) {
  const [logs, setLogs] = useState([]);
  const [filter, setFilter] = useState("all");
  const [contactFilter, setContactFilter] = useState("");
  useEffect(() => { fetchApi(`/api/workflows/history?limit=50`).then((data) => setLogs((data?.logs || []).filter((log) => !workflow.id || log.entityId === workflow.id))).catch(() => setLogs([])); }, [workflow.id]);
  const logDetails = (log) => {
    try { return typeof log.details === "string" ? JSON.parse(log.details) : log.details || {}; }
    catch { return {}; }
  };
  const logContact = (log) => {
    const payload = logDetails(log).payload || {};
    return payload.name || payload.email || payload.contactId;
  };
  const contacts = [...new Set(logs.map(logContact).filter(Boolean))];
  const visible = logs.filter((log) => {
    const details = logDetails(log);
    const failed = log.action === "WORKFLOW_FAILED" || !!details.error;
    const statusMatches = filter === "all" || (filter === "failed" ? failed : !failed);
    const contactMatches = !contactFilter || String(logContact(log)) === contactFilter;
    return statusMatches && contactMatches;
  });
  return <div className="workflow-history-overlay"><div className="workflow-history-panel"><div className="workflow-history-head"><h2>ACTION HISTORY</h2><button className="workflow-icon-button" onClick={onClose} aria-label="Close history"><X size={18} /></button></div><div className="workflow-history-meta"><div className="workflow-history-name">Workflow name<br /><b>{workflow.name}</b></div><div className="workflow-history-filters"><div>Showing: {[["all", "All actions"], ["failed", "Failed actions"], ["success", "Successful actions"]].map(([value, label]) => <label key={value}><input type="radio" checked={filter === value} onChange={() => setFilter(value)} /> {label}</label>)}</div><Select aria-label="History period" value="7" onChange={() => {}}><option value="7">Last 7 days</option></Select></div><label className="workflow-contact-filter">Filter by contact<Select aria-label="Filter by contact" value={contactFilter} onChange={setContactFilter}><option value="">Click to select</option>{contacts.map((contact) => <option key={contact} value={contact}>{contact}</option>)}</Select></label></div><div className="workflow-history-table"><div className="workflow-list-header"><span>ACTION</span><span>TRIGGERED ON</span><span>STATUS</span><span>CONTACT</span></div>{visible.length === 0 ? <div className="workflow-empty">No actions found.</div> : visible.map((log) => <div className="workflow-history-row" key={log.id}><div><b>{log.action || "Workflow action"}</b><small>{log.method || ""}{log.url ? ` URL: ${log.url}` : ""}</small></div><span>{formatDate(log.createdAt)}</span><span className="workflow-history-status">{/fail/i.test(log.details || "") ? "Failed" : "Successful"}</span><span>{log.contactName || log.contact || log.entityId || "-"}</span></div>)}</div><div className="workflow-history-footer"><button className="workflow-history-page-button" disabled>Previous</button><span>•</span><button className="workflow-history-page-button" disabled>Next</button><button className="workflow-secondary workflow-history-close" onClick={onClose}>Close</button></div></div></div>;
}
