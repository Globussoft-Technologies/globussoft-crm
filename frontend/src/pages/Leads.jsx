import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { formatDateMedium as formatDate } from "../utils/date";
import { useState, useEffect, useContext, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import {
  UserPlus,
  Search,
  ArrowRightCircle,
  Plus,
  X,
  Pencil,
  Trash2,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Phone,
  FileText,
  Filter,
  SlidersHorizontal,
  Info,
  Settings,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { AuthContext } from "../App";
import ColumnPicker from "../components/ColumnPicker";
import FilterPanel from "../components/FilterPanel";
import InlineCellEditor from "../components/InlineCellEditor";
import TopScrollSync from "../components/TopScrollSync";
import { SUB_BRAND_IDS, subBrandShortLabel } from "../utils/travelSubBrand";
import CallifiedLeadCallDialog from "../components/CallifiedLeadCallDialog";
import CallifiedCallDetailsDrawer from "../components/CallifiedCallDetailsDrawer";
import CallifiedCallStatusDrawer from "../components/CallifiedCallStatusDrawer";
import CsvImportExportToolbar from "../components/wellness/CsvImportExportToolbar";

const SOURCE_OPTIONS = [
  "Organic",
  "Referral",
  "LinkedIn",
  "Cold Call",
  "Website",
  "Event",
  "Other",
];
// Built-in lead columns available for auto-campaign assignment rules.
const BUILTIN_RULE_COLUMNS = [
  { key: "source", label: "Source" },
  { key: "status", label: "Status" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "industry", label: "Industry" },
  { key: "companySize", label: "Company Size" },
  { key: "subBrand", label: "Sub-brand" },
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "aiScore", label: "Lead Score" },
];
// #600  wellness vertical replaces the generic CRM source taxonomy with one
// that matches Patient-intake channels. WhatsApp is the dominant inbound
// channel for clinics; LinkedIn / Cold Call don't apply.
const TRAVEL_SOURCE_OPTIONS = [
  { value: "tmc_registration", label: "TMC Registration" },
  { value: "brochure_request", label: "Brochure Request" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "referral", label: "Referral" },
  { value: "website", label: "Website" },
  { value: "phone", label: "Phone Call" },
  { value: "event", label: "Event / Expo" },
  { value: "other", label: "Other" },
];
const WELLNESS_SOURCE_OPTIONS = [
  { value: "walk-in", label: "Walk-in" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Phone" },
  { value: "website", label: "Website" },
  { value: "referral", label: "Referral" },
  { value: "organic", label: "Organic" },
  { value: "event", label: "Event" },
  { value: "other", label: "Other" },
];
// Accept either a bare 10-digit Indian mobile (starting 6-9) OR with
// an optional `+91` / `91` prefix. The wellness phone validator strips
// whitespace/dashes/parens before testing.
const INDIAN_MOBILE_RE = /^(?:\+?91)?[6-9]\d{9}$/;
const FIELD_LIMITS = {
  name: 191,
  email: 191,
  company: 191,
  title: 200,
  phone: 20,
};
const LEADS_PAGE_SIZE_OPTIONS = [25, 50, 100];
const LEADS_AUTO_REFRESH_MS = 15000;
const sourceBadgeStyle = {
  padding: "0.25rem 0.75rem",
  borderRadius: "999px",
  fontSize: "0.75rem",
  fontWeight: 600,
  backgroundColor: "var(--source-badge-bg, rgba(139, 92, 246, 0.16))",
  color: "var(--source-badge-text, var(--text-primary))",
  border: "1px solid var(--border-color)",
  whiteSpace: "nowrap",
  display: "inline-block",
};

const leadSourceLabel = (lead) =>
  lead?.source ||
  lead?.firstTouchSource ||
  lead?.submitSource ||
  lead?.submittedSource ||
  lead?.customFields?.submit_source ||
  lead?.customFields?.submitSource ||
  lead?.customFields?.lead_source ||
  lead?.customFields?.leadSource ||
  "Organic";
// Reject all C0 controls (NUL/BEL/etc.) + DEL. \t \n \r are intentionally
// included  text inputs shouldn't carry them either, and any paste-from-
// malicious-source typically smuggles via NUL or BEL. Detecting control
// chars requires control chars in the pattern; the eslint rule is for
// preventing accidental control chars, so disable it here intentionally.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/;
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/;
const stripDangerousTags = (str) => {
  const DANGEROUS_TAG_RE =
    /<(script|iframe|object|embed|style|link|meta|form|svg|img|video|audio|source|applet|base|input|textarea)[^>]*>/gi;
  const stripped = str.replace(DANGEROUS_TAG_RE, "");
  return { value: stripped, stripped: stripped !== str };
};

const COUNTRY_CODES = [
  { code: "+1", country: "USA" },
  { code: "+44", country: "UK" },
  { code: "+91", country: "India" },
  { code: "+61", country: "Australia" },
  { code: "+33", country: "France" },
  { code: "+49", country: "Germany" },
  { code: "+39", country: "Italy" },
  { code: "+34", country: "Spain" },
  { code: "+81", country: "Japan" },
  { code: "+86", country: "China" },
  { code: "+55", country: "Brazil" },
  { code: "+27", country: "South Africa" },
  { code: "+971", country: "UAE" },
  { code: "+65", country: "Singapore" },
  { code: "+60", country: "Malaysia" },
];

function buildLeadStatusTooltip(lead, { maxRetries = 3 } = {}) {
  const source = lead.callifiedLeadStatusSource;
  const reason = lead.callifiedLeadStatusReason;
  const updatedAt = lead.callifiedLeadStatusUpdatedAt;
  const sourceLabel =
    source === "gemini"
      ? "Gemini AI"
      : source === "score"
        ? "Callified score / appointment"
        : source === "manual"
          ? "Manual override"
          : source === "auto_dial"
            ? "Auto-dial"
            : source || "Unknown";
  const parts = [`Basis: ${sourceLabel}`];
  if (reason) parts.push(`Reason: ${reason}`);
  if (
    lead.callifiedLeadStatus === CALL_STATUS.DNP &&
    typeof lead.callifiedDnpRetryCount === "number"
  ) {
    parts.push(`Retry: ${lead.callifiedDnpRetryCount}/${maxRetries}`);
  }
  if (updatedAt) {
    try {
      const d = new Date(updatedAt);
      if (!Number.isNaN(d.getTime())) {
        parts.push(
          `Updated: ${d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        );
      }
    } catch (_) {
      /* ignore */
    }
  }
  return parts.join("\n");
}

// Canonical call-status values for the generic CRM "Call Status" column.
// Legacy "hot" / "cold" values are mapped forward so existing rows render
// correctly without a data migration.
const CALL_STATUS = {
  YET_TO_CALL: "yet_to_call",
  CONNECTED: "connected",
  DNP: "dnp",
  QUALIFIED: "qualified",
  JUNK: "junk",
};

const CALL_STATUS_OPTIONS = [
  {
    value: CALL_STATUS.QUALIFIED,
    label: "Qualified",
    color: "#fff",
    bg: "#22c55e",
  },
  { value: CALL_STATUS.JUNK, label: "Junk", color: "#fff", bg: "#ef4444" },
  { value: CALL_STATUS.DNP, label: "DNP", color: "#fff", bg: "#6b7280" },
  {
    value: CALL_STATUS.CONNECTED,
    label: "Connecting",
    color: "#fff",
    bg: "#f59e0b",
  },
  {
    value: CALL_STATUS.YET_TO_CALL,
    label: "New",
    color: "var(--text-secondary)",
    bg: "var(--surface-hover)",
  },
];

function normalizeCallStatus(raw) {
  if (!raw) return CALL_STATUS.YET_TO_CALL;
  const s = String(raw).toLowerCase().trim().replace(/\s+/g, "_");
  if (s === "hot" || s.includes("qualified")) return CALL_STATUS.QUALIFIED;
  if (s === "cold" || s.includes("junk")) return CALL_STATUS.JUNK;
  if (s.includes("dnp") || s.includes("not_picked") || s.includes("no_answer"))
    return CALL_STATUS.DNP;
  if (
    s.includes("connected") ||
    s.includes("in_progress") ||
    s.includes("calling")
  )
    return CALL_STATUS.CONNECTED;
  if (s.includes("yet")) return CALL_STATUS.YET_TO_CALL;
  return CALL_STATUS.YET_TO_CALL;
}

function getCallStatusMeta(raw) {
  const normalized = normalizeCallStatus(raw);
  return (
    CALL_STATUS_OPTIONS.find((o) => o.value === normalized) ||
    CALL_STATUS_OPTIONS.find((o) => o.value === CALL_STATUS.YET_TO_CALL)
  );
}

const Leads = () => {
  const navigate = useNavigate();
  const notify = useNotify();
  // #600  vertical-aware Lead form. Wellness tenants get the Patient-intake
  // field set (Phone required, wellness sources, treatment of interest,
  // preferred location/practitioner); generic CRM keeps the original fields.
  const auth = useContext(AuthContext);
  const isWellness = auth?.tenant?.vertical === "wellness";
  const isTravel = auth?.tenant?.vertical === "travel";
  // Callified AI calling is only available in the generic CRM vertical.
  const isGeneric = !isWellness && !isTravel;
  // Only ADMINs may assign / reassign leads. All other roles see the
  // assignee name as plain text and have no checkbox / bulk-assign surface.
  const isAdmin = auth?.user?.role === "ADMIN";
  const [leads, setLeads] = useState([]);
  const [staff, setStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [leadsPage, setLeadsPage] = useState(0);
  const [leadsPageSize, setLeadsPageSize] = useState(25);
  const [pageInput, setPageInput] = useState("1");
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [bulkAgent, setBulkAgent] = useState("");
  const [bulkCampaignId, setBulkCampaignId] = useState("");
  const [bulkCampaignDropdownOpen, setBulkCampaignDropdownOpen] =
    useState(false);
  const [bulkCampaignSaving, setBulkCampaignSaving] = useState(false);
  // Callified AI calling state
  const [callifiedCallLead, setCallifiedCallLead] = useState(null);
  const [callifiedDetailsLead, setCallifiedDetailsLead] = useState(null);
  const [callifiedConfigured, setCallifiedConfigured] = useState(null); // null = loading
  const [callifiedCampaigns, setCallifiedCampaigns] = useState([]);
  const [callifiedSummaries, setCallifiedSummaries] = useState({});
  const [selectedCampaignIds, setSelectedCampaignIds] = useState([]);
  const [campaignDropdownOpen, setCampaignDropdownOpen] = useState(false);
  // Generic CRM Leads page — auto-campaign assignment rules (replaces the
  // single auto-campaign dropdown). Toolbar dropdown shows a rule grid.
  const [autoCampaignRulesOpen, setAutoCampaignRulesOpen] = useState(false);
  const [autoCampaignRulesEnabled, setAutoCampaignRulesEnabled] =
    useState(false);
  const [autoCampaignRules, setAutoCampaignRules] = useState([]);
  const [savedAutoCampaignRuleIds, setSavedAutoCampaignRuleIds] = useState(
    new Set(),
  );
  const [autoCampaignRulesLoading, setAutoCampaignRulesLoading] =
    useState(false);
  const [autoCampaignRulesSaving, setAutoCampaignRulesSaving] = useState(false);
  // #892  Create Lead surface is a header CTA + drawer (not the inline
  // always-visible form). `creating` drives whether the drawer is rendered.
  const [creating, setCreating] = useState(false);
  const [sourceFilter, setSourceFilter] = useState("");
  const [subBrandFilter, setSubBrandFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  // Generic CRM Callified filters
  const [campaignFilter, setCampaignFilter] = useState("");
  const [leadStatusFilter, setLeadStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  // Freshsales-style "Filter by" panel (components/FilterPanel.jsx) — a
  // dynamic field-picker + operator + checkbox-values panel that also
  // surfaces admin-defined Lead custom fields (Settings > Lead Fields),
  // separate from the fixed dropdowns above. Applied server-side via
  // ?filters=<JSON> (backend/routes/contacts.js FILTERABLE_FIELDS) so it
  // isn't bounded by the same ?limit=500 cap fetchLeads already applies.
  const [advancedFilters, setAdvancedFilters] = useState([]);
  // Sequential one-by-one call queue
  const [callQueue, setCallQueue] = useState([]);
  const [callQueueActive, setCallQueueActive] = useState(false);
  const [callStatusDrawerOpen, setCallStatusDrawerOpen] = useState(false);
  const [classifyingLeads, setClassifyingLeads] = useState(new Set());
  // Generic CRM Leads page — AI transcript classification toggle (gear menu next
  // to the Lead Status column). Default true matches the tenant-setting default.
  const [aiTranscriptEnabled, setAiTranscriptEnabled] = useState(true);
  const [aiTranscriptSaving, setAiTranscriptSaving] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  // Generic CRM Leads page — DNP retry settings (max retries + interval).
  const [dnpRetryEnabled, setDnpRetryEnabled] = useState(true);
  const [dnpMaxRetries, setDnpMaxRetries] = useState(3);
  const [dnpIntervalMinutes, setDnpIntervalMinutes] = useState(60);
  const [dnpSettingsLoading, setDnpSettingsLoading] = useState(false);
  const [dnpSettingsSaving, setDnpSettingsSaving] = useState({
    enabled: false,
    maxRetries: false,
    interval: false,
  });
  // Generic CRM Leads page — auto-dial new leads toggle.
  const [autoDialNewLeadsEnabled, setAutoDialNewLeadsEnabled] = useState(true);
  const [autoDialNewLeadsSaving, setAutoDialNewLeadsSaving] = useState(false);
  // Generic CRM Leads page — qualified lead auto-assignment settings.
  const [assignStaffEnabled, setAssignStaffEnabled] = useState(true);
  const [assignStaffLogic, setAssignStaffLogic] = useState("round_robin");
  const [assignStaffLeadsPerUser, setAssignStaffLeadsPerUser] = useState(1);
  const [assignSettingsLoading, setAssignSettingsLoading] = useState(false);
  const [assignSettingsSaving, setAssignSettingsSaving] = useState({
    enabled: false,
    logic: false,
    leadsPerUser: false,
  });
  const [pipelineStages, setPipelineStages] = useState([]);
  const [dealsByContact, setDealsByContact] = useState({});
  const [bookingValueByContact, setBookingValueByContact] = useState({});
  // TMC instalment paid totals keyed by parent contact email  supplements
  // itinerary advancePaidAmount for leads that have no itinerary row yet.
  const [tmcPaidByEmail, setTmcPaidByEmail] = useState({});
  const [editing, setEditing] = useState(null);
  const [editForm, setEditForm] = useState({
    name: "",
    email: "",
    company: "",
    title: "",
    source: "",
    customFields: {},
  });
  const [editSaving, setEditSaving] = useState(false);
  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  // Fetched once; empty array for wellness/travel (no fetch attempted) or
  // for a generic tenant that hasn't defined any fields yet.
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  // Generic-vertical-only "Customize table" column-visibility picker
  // (personal per-user preference  see components/ColumnPicker.jsx).
  // null = "not loaded yet, show every builtin column" so the table never
  // flashes empty while the preference GET is in flight.
  const [visibleColumns, setVisibleColumns] = useState(null);
  const isColVisible = (key) =>
    visibleColumns === null || visibleColumns.includes(key);
  const handleCustomFieldChangeNew = (fieldKey, value) => {
    setNewLead((prev) => ({
      ...prev,
      customFields: {
        ...(prev.customFields || {}),
        [fieldKey]: value,
      },
    }));
  };
  const handleCustomFieldChangeEdit = (fieldKey, value) => {
    setEditForm((prev) => ({
      ...prev,
      customFields: {
        ...(prev.customFields || {}),
        [fieldKey]: value,
      },
    }));
  };
  // #600  Initial source defaults differ per vertical: wellness leads
  // typically arrive walk-in/WhatsApp; generic CRM leads default to Organic.
  const [newLead, setNewLead] = useState({
    name: "",
    email: "",
    phone: "",
    company: "",
    title: "",
    countryCode: isWellness || isTravel ? "+91" : "+1",
    source: isWellness ? "walk-in" : isTravel ? "tmc_registration" : "Organic",
    status: "Lead",
    treatmentOfInterest: "",
    preferredLocationId: "",
    preferredPractitionerId: "",
    customFields: {},
  });

  const fetchLeads = async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    try {
      const filtersQs =
        advancedFilters.length > 0
          ? `&filters=${encodeURIComponent(JSON.stringify(advancedFilters.map(({ field, operator, values }) => ({ field, operator, values }))))}`
          : "";
      const data = await fetchApi(
        `/api/contacts?status=Lead&limit=500${filtersQs}`,
      );
      const rows = Array.isArray(data) ? data : [];
      setLeads(rows);
      return rows;
    } catch {
      if (!background) notify.error("Failed to load leads");
      return [];
    } finally {
      if (!background) setLoading(false);
    }
  };

  const fetchStaff = async () => {
    try {
      const data = await fetchApi("/api/staff");
      setStaff(Array.isArray(data) ? data : []);
    } catch {
      setStaff([]);
    }
  };

  const loadAutoCampaignRules = useCallback(async () => {
    if (!isGeneric) return;
    setAutoCampaignRulesLoading(true);
    try {
      const d = await fetchApi("/api/callified/auto-campaign-rules");
      const enabled = !!d?.enabled;
      const rules = Array.isArray(d?.rules)
        ? d.rules.map((r, idx) => ({
            ...r,
            id: r.id || `rule-${idx}-${Date.now()}`,
          }))
        : [];
      setAutoCampaignRulesEnabled(enabled);
      setAutoCampaignRules(rules);
      setSavedAutoCampaignRuleIds(
        new Set(rules.map((r) => r.id).filter(Boolean)),
      );
    } catch {
      // leave existing state intact on error
    } finally {
      setAutoCampaignRulesLoading(false);
    }
  }, [isGeneric]);

  const saveAutoCampaignRules = useCallback(
    async ({ enabled, rules, markSavedId } = {}) => {
      if (!isGeneric) return;
      setAutoCampaignRulesSaving(true);
      const nextEnabled =
        enabled !== undefined ? enabled : autoCampaignRulesEnabled;
      const nextRules = rules !== undefined ? rules : autoCampaignRules;
      const cleanRules = nextRules
        .map((r) => ({
          ...(r.id ? { id: String(r.id) } : {}),
          enabled: !!r.enabled,
          column: String(r.column || "").trim(),
          value: String(r.value || "").trim(),
          campaignId: Number(r.campaignId) || 0,
        }))
        .filter((r) => r.column && r.campaignId > 0);
      try {
        const d = await fetchApi("/api/callified/auto-campaign-rules", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled, rules: cleanRules }),
        });
        const returnedRules = Array.isArray(d?.rules) ? d.rules : cleanRules;
        setAutoCampaignRulesEnabled(!!d?.enabled);
        setAutoCampaignRules(returnedRules);
        if (markSavedId) {
          setSavedAutoCampaignRuleIds((prev) => {
            const next = new Set(prev);
            next.add(markSavedId);
            return next;
          });
        }
        notify.success("Auto-assign Callified Campaigns rules saved");
      } catch (err) {
        notify.error(
          err?.body?.error ||
            err?.message ||
            "Failed to save auto-assign rules",
        );
      } finally {
        setAutoCampaignRulesSaving(false);
      }
    },
    [isGeneric, autoCampaignRulesEnabled, autoCampaignRules, notify],
  );

  // Refresh everything visible on the Leads page without a full reload.
  // Recomputes AI scores and re-classifies Qualified/Junk/DNP only for leads
  // that were actually called, so a real call that just completed updates both
  // the Lead Score and the Call Status without a browser reload.
  const refreshAll = async () => {
    const [freshLeads] = await Promise.all([
      fetchLeads(),
      fetchStaff(),
      loadCallifiedCampaigns(),
      loadAutoCampaignRules(),
    ]);
    if (isGeneric && Array.isArray(freshLeads) && freshLeads.length > 0) {
      // Score + classify only leads that were actually called. This avoids
      // burning Gemini credits / HTTP time on hundreds of untouched leads while
      // still updating status/score for contacts that have fresh Callified data.
      const visibleIds = freshLeads.map((l) => l.id);
      try {
        const summaryRes = await fetchApi(
          `/api/callified/leads/call-summary?contactIds=${visibleIds.join(",")}`,
        );
        const summaries = summaryRes?.summaries || {};
        const calledLeadIds = freshLeads
          .filter((l) => (summaries[l.id]?.callCount || 0) > 0)
          .map((l) => l.id);

        if (calledLeadIds.length > 0) {
          await fetchApi("/api/ai_scoring/contacts", {
            method: "POST",
            body: JSON.stringify({ contactIds: calledLeadIds }),
          });
          const scoredLeads = await fetchLeads({ background: true });
          // Re-classify called leads so Qualified/Junk/DNP refreshes from the
          // latest transcript/score (e.g. a preliminary Junk gets corrected to Qualified).
          if (Array.isArray(scoredLeads) && scoredLeads.length > 0) {
            const calledSet = new Set(calledLeadIds);
            classifyVisibleLeads(
              scoredLeads.filter((l) => calledSet.has(l.id)),
              { force: true },
            );
          }
        }
      } catch (e) {
        console.error("[leads] aiScore/classify refresh failed:", e?.message);
      }
    }
    notify.success("Refreshed");
  };

  // Backfill assignment for qualified leads that slipped through without an owner.
  // Handles existing leads created before auto-assignment, transient backend
  // failures, or leads that became qualified outside the normal classify flow.
  const ensureQualifiedLeadsAssigned = async (leadRows) => {
    if (!isGeneric || !Array.isArray(leadRows) || leadRows.length === 0) return;
    const qualifiedUnassigned = leadRows.filter(
      (l) =>
        l?.id &&
        normalizeCallStatus(l.callifiedLeadStatus) === CALL_STATUS.QUALIFIED &&
        !l.assignedToId,
    );
    if (qualifiedUnassigned.length === 0) return;
    try {
      const ids = qualifiedUnassigned.map((l) => l.id);
      await fetchApi("/api/callified/leads/ensure-assigned", {
        method: "POST",
        body: JSON.stringify({ contactIds: ids }),
      });
      await fetchLeads({ background: true });
    } catch (e) {
      console.error("[leads] ensureQualifiedLeadsAssigned failed:", e?.message);
    }
  };

  // Classify visible generic-CRM leads. In normal (non-force) mode it only
  // touches leads with no status yet. In force mode it re-classifies leads
  // that have a Callified campaign assigned or any existing status, so refresh
  // and post-call flows pick up the latest transcript/score.
  const classifyVisibleLeads = async (leadRows, options = {}) => {
    if (!isGeneric || !Array.isArray(leadRows)) return;
    const { force = false } = options;
    const candidates = leadRows.filter((l) => {
      if (!l?.id) return false;
      if (force) {
        // Re-classify leads that have a campaign, have any prior status, or
        // have at least one Callified call recorded.
        return (
          Boolean(l.callifiedCampaignId) ||
          Boolean(l.callifiedLeadStatus) ||
          (callifiedSummaries[l.id]?.callCount || 0) > 0
        );
      }
      return !l.callifiedLeadStatus;
    });
    if (candidates.length === 0) return;
    const next = new Set(classifyingLeads);
    for (const lead of candidates) {
      next.add(lead.id);
    }
    setClassifyingLeads(next);
    try {
      // Classify one lead at a time. Bulk dials can produce hundreds of completed
      // calls; firing that many classify requests in parallel hammers the backend
      // and can hit rate limits. Sequential keeps it predictable and safe.
      const resultById = new Map();
      for (const lead of candidates) {
        try {
          const r = await fetchApi(`/api/callified/leads/${lead.id}/classify`, {
            method: "POST",
          });
          if (r?.id) resultById.set(r.id, r);
        } catch (e) {
          console.error(`[leads] classify ${lead.id} failed:`, e?.message);
        }
      }
      // Optimistically merge classification results + auto-assignment into local
      // state so the Call Status badge and Assigned To column update immediately.
      if (resultById.size > 0) {
        setLeads((prev) =>
          prev.map((l) => {
            const r = resultById.get(l.id);
            if (!r) return l;
            return {
              ...l,
              callifiedLeadStatus:
                r.callifiedLeadStatus ?? l.callifiedLeadStatus,
              callifiedLeadStatusSource:
                r.callifiedLeadStatusSource ?? l.callifiedLeadStatusSource,
              callifiedLeadStatusReason:
                r.reason ?? l.callifiedLeadStatusReason,
              callifiedLeadStatusUpdatedAt:
                r.callifiedLeadStatusUpdatedAt ??
                l.callifiedLeadStatusUpdatedAt,
              assignedToId: r.assignedToId ?? l.assignedToId,
              assignedTo: r.assignedTo ?? l.assignedTo,
            };
          }),
        );
      }
      await fetchLeads({ background: true });
      // The score/call-count badges read from a separate summary cache; refresh
      // that cache so the Callified Score column updates without a reload.
      const ids = candidates.map((l) => l.id);
      try {
        const d = await fetchApi(
          `/api/callified/leads/call-summary?contactIds=${ids.join(",")}`,
        );
        setCallifiedSummaries((prev) => ({
          ...(prev || {}),
          ...(d?.summaries || {}),
        }));
      } catch (e) {
        console.error("[leads] summary refresh failed:", e?.message);
      }
    } finally {
      setClassifyingLeads((prev) => {
        const updated = new Set(prev);
        candidates.forEach((l) => updated.delete(l.id));
        return updated;
      });
    }
  };

  useEffect(() => {
    fetchLeads().then((rows) => {
      if (isGeneric && Array.isArray(rows) && rows.length > 0) {
        ensureQualifiedLeadsAssigned(rows);
      }
    });
    fetchStaff();
    loadAutoCampaignRules();
    if (isTravel) {
      fetchApi("/api/pipeline_stages")
        .then((data) => setPipelineStages(Array.isArray(data) ? data : []))
        .catch(() => setPipelineStages([]));
      fetchApi("/api/deals?limit=500")
        .then((data) => {
          const map = {};
          const rows = Array.isArray(data) ? data : [];
          for (const d of rows) {
            if (d.contactId) {
              if (!map[d.contactId]) map[d.contactId] = [];
              map[d.contactId].push(d);
            }
          }
          setDealsByContact(map);
        })
        .catch(() => setDealsByContact({}));
      // Booking value from itineraries  show what the customer has actually paid.
      // Priority: advancePaidAmount (actual cash received) when it's recorded and > 0.
      // Fallback: totalAmount for committed statuses (accepted/advance_paid/fully_paid)
      // so that legacy itineraries without advancePaidAmount still show their value.
      fetchApi("/api/travel/itineraries?limit=200")
        .then((res) => {
          const rows = Array.isArray(res?.itineraries)
            ? res.itineraries
            : Array.isArray(res)
              ? res
              : [];
          const COMMITTED = new Set(["accepted", "advance_paid", "fully_paid"]);
          const map = {};
          for (const it of rows) {
            if (it?.contactId == null) continue;
            const cur = it.currency || "INR";
            const advancePaid = Number(it.advancePaidAmount || 0);
            // If advance payment is recorded, always show it (covers partial-paid leads
            // whose itinerary status hasn't been flipped yet).
            // Otherwise fall back to totalAmount for committed itineraries.
            const amt =
              advancePaid > 0
                ? advancePaid
                : COMMITTED.has(it.status)
                  ? Number(it.totalAmount)
                  : 0;
            if (!Number.isFinite(amt) || amt <= 0) continue;
            if (!map[it.contactId])
              map[it.contactId] = { value: 0, currency: cur };
            map[it.contactId].value += amt;
          }
          setBookingValueByContact(map);
        })
        .catch(() => setBookingValueByContact({}));
      // Fetch TMC paid instalment totals keyed by parent email  covers leads
      // whose parent contact has no Itinerary row (common for TMC school trips).
      fetchApi("/api/travel/trip-billing/paid-by-contact")
        .then((res) => setTmcPaidByEmail(res?.byEmail || {}))
        .catch(() => setTmcPaidByEmail({}));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let stopped = false;
    let inFlight = false;

    const refreshVisibleLeads = async () => {
      if (stopped || inFlight) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      )
        return;
      inFlight = true;
      try {
        await fetchLeads({ background: true });
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(
      refreshVisibleLeads,
      LEADS_AUTO_REFRESH_MS,
    );
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshVisibleLeads();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopped = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch (server-side) whenever the FilterPanel's filter set changes.
  // Skips the very first render — the mount effect above already fetched
  // once with the (empty) initial advancedFilters.
  const isFirstFiltersRender = useRef(true);
  useEffect(() => {
    if (isFirstFiltersRender.current) {
      isFirstFiltersRender.current = false;
      return;
    }
    fetchLeads();
  }, [advancedFilters]); // eslint-disable-line react-hooks/exhaustive-deps

  // #600  load wellness service catalogue + clinic locations only when the
  // current tenant is the wellness vertical. Avoids 401 / empty-response
  // chatter from the generic tenant hitting wellness-only endpoints.
  useEffect(() => {
    if (!isWellness) return;
    fetchApi("/api/wellness/services")
      .then((d) => setServices(Array.isArray(d) ? d : d?.services || []))
      .catch(() => setServices([]));
    fetchApi("/api/wellness/locations")
      .then((d) => setLocations(Array.isArray(d) ? d : d?.locations || []))
      .catch(() => setLocations([]));
  }, [isWellness]);

  // Generic-vertical-only Lead custom fields (Settings > Lead Fields).
  // Skipped entirely for wellness/travel tenants.
  useEffect(() => {
    if (isWellness || isTravel) return;
    fetchApi("/api/lead-custom-fields")
      .then((d) => setCustomFieldDefs(Array.isArray(d) ? d : []))
      .catch(() => setCustomFieldDefs([]));
  }, [isWellness, isTravel]);

  // Check whether Callified AI calling is configured for this tenant (generic only).
  useEffect(() => {
    if (!isGeneric) {
      setCallifiedConfigured(false);
      return;
    }
    fetchApi("/api/integrations/callified/config")
      .then((d) => setCallifiedConfigured(!!d?.isActive))
      .catch(() => setCallifiedConfigured(false));
  }, [isGeneric]);

  // Load Callified campaigns for campaign assignment + bulk dial (generic only).
  const loadCallifiedCampaigns = useCallback(async () => {
    if (!isGeneric || !callifiedConfigured) return;
    try {
      const d = await fetchApi("/api/callified/campaigns/with-lead-counts");
      const list = Array.isArray(d?.campaigns) ? d.campaigns : [];
      setCallifiedCampaigns(list);
    } catch {
      setCallifiedCampaigns([]);
    }
  }, [isGeneric, callifiedConfigured]);

  useEffect(() => {
    loadCallifiedCampaigns();
  }, [loadCallifiedCampaigns]);

  // Generic CRM Leads page — load the AI transcript classification tenant setting.
  const loadAiTranscriptSetting = useCallback(async () => {
    if (!isGeneric) return;
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.ai_transcript.enabled",
      );
      setAiTranscriptEnabled(String(d?.value).toLowerCase() !== "false");
    } catch (_e) {
      setAiTranscriptEnabled(true);
    }
  }, [isGeneric]);

  // Generic CRM Leads page — load auto-dial new leads tenant setting.
  const loadAutoDialNewLeadsSetting = useCallback(async () => {
    if (!isGeneric) return;
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.auto_dial_new_leads.enabled",
      );
      setAutoDialNewLeadsEnabled(String(d?.value).toLowerCase() !== "false");
    } catch (_e) {
      setAutoDialNewLeadsEnabled(true);
    }
  }, [isGeneric]);

  const saveAiTranscriptEnabled = async (next) => {
    if (!isAdmin) {
      notify.info(
        "Only admins can change AI transcript classification settings.",
      );
      return;
    }
    setAiTranscriptSaving(true);
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.ai_transcript.enabled",
        {
          method: "PUT",
          body: JSON.stringify({
            value: next ? "true" : "false",
            category: "feature-flag",
          }),
        },
      );
      setAiTranscriptEnabled(String(d?.value).toLowerCase() !== "false");
      notify.success(
        `AI transcript classification ${next ? "enabled" : "disabled"}`,
      );
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save AI transcript setting");
      // Re-sync so the toggle reflects the server truth.
      loadAiTranscriptSetting();
    } finally {
      setAiTranscriptSaving(false);
    }
  };

  // Generic CRM Leads page — load DNP retry tenant settings.
  const loadDnpRetrySettings = useCallback(async () => {
    if (!isGeneric) return;
    setDnpSettingsLoading(true);
    try {
      const [enabledRes, maxRes, intervalRes] = await Promise.all([
        fetchApi("/api/tenant-settings/feature.callified.dnp_retry.enabled"),
        fetchApi(
          "/api/tenant-settings/feature.callified.dnp_retry.max_retries",
        ),
        fetchApi(
          "/api/tenant-settings/feature.callified.dnp_retry.interval_minutes",
        ),
      ]);
      setDnpRetryEnabled(String(enabledRes?.value).toLowerCase() !== "false");
      const parsedMax = Number(maxRes?.value);
      setDnpMaxRetries(Number.isFinite(parsedMax) ? parsedMax : 3);
      const parsedInterval = Number(intervalRes?.value);
      setDnpIntervalMinutes(
        Number.isFinite(parsedInterval) ? parsedInterval : 60,
      );
    } catch (_e) {
      // Keep defaults on error.
      setDnpRetryEnabled(true);
      setDnpMaxRetries(3);
      setDnpIntervalMinutes(60);
    } finally {
      setDnpSettingsLoading(false);
    }
  }, [isGeneric]);

  const saveDnpRetryEnabled = async (next) => {
    if (!isAdmin) {
      notify.info("Only admins can change DNP retry settings.");
      return;
    }
    setDnpSettingsSaving((prev) => ({ ...prev, enabled: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.dnp_retry.enabled",
        {
          method: "PUT",
          body: JSON.stringify({
            value: next ? "true" : "false",
            category: "feature-flag",
          }),
        },
      );
      setDnpRetryEnabled(String(d?.value).toLowerCase() !== "false");
      notify.success(`DNP auto-retry ${next ? "enabled" : "disabled"}`);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save DNP retry setting");
      loadDnpRetrySettings();
    } finally {
      setDnpSettingsSaving((prev) => ({ ...prev, enabled: false }));
    }
  };

  const saveDnpMaxRetries = async (next) => {
    if (!isAdmin) return;
    const value = Math.max(1, Math.min(Number(next) || 3, 10));
    setDnpSettingsSaving((prev) => ({ ...prev, maxRetries: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.dnp_retry.max_retries",
        {
          method: "PUT",
          body: JSON.stringify({
            value: String(value),
            category: "feature-flag",
          }),
        },
      );
      const parsed = Number(d?.value);
      setDnpMaxRetries(Number.isFinite(parsed) ? parsed : value);
      notify.success(`Max retries set to ${value}`);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save max retries");
      loadDnpRetrySettings();
    } finally {
      setDnpSettingsSaving((prev) => ({ ...prev, maxRetries: false }));
    }
  };

  const saveDnpIntervalMinutes = async (next) => {
    if (!isAdmin) return;
    const value = Math.max(5, Math.min(Number(next) || 60, 24 * 60));
    setDnpSettingsSaving((prev) => ({ ...prev, interval: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.dnp_retry.interval_minutes",
        {
          method: "PUT",
          body: JSON.stringify({
            value: String(value),
            category: "feature-flag",
          }),
        },
      );
      const parsed = Number(d?.value);
      setDnpIntervalMinutes(Number.isFinite(parsed) ? parsed : value);
      notify.success("Retry interval updated");
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save retry interval");
      loadDnpRetrySettings();
    } finally {
      setDnpSettingsSaving((prev) => ({ ...prev, interval: false }));
    }
  };

  // Generic CRM Leads page — auto-dial new leads toggle.
  const saveAutoDialNewLeadsEnabled = async (next) => {
    if (!isAdmin) {
      notify.info("Only admins can change call settings.");
      return;
    }
    setAutoDialNewLeadsSaving(true);
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.auto_dial_new_leads.enabled",
        {
          method: "PUT",
          body: JSON.stringify({
            value: next ? "true" : "false",
            category: "feature-flag",
          }),
        },
      );
      setAutoDialNewLeadsEnabled(String(d?.value).toLowerCase() !== "false");
      notify.success(`Auto-dial new leads ${next ? "enabled" : "disabled"}`);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save auto-dial setting");
      loadCallSettings();
    } finally {
      setAutoDialNewLeadsSaving(false);
    }
  };

  // Generic CRM Leads page — qualified lead auto-assignment settings.
  const loadAssignStaffSettings = useCallback(async () => {
    if (!isGeneric) return;
    setAssignSettingsLoading(true);
    try {
      const [enabledRes, logicRes, leadsPerUserRes] = await Promise.all([
        fetchApi("/api/tenant-settings/feature.callified.assign_staff.enabled"),
        fetchApi("/api/tenant-settings/feature.callified.assign_staff.logic"),
        fetchApi(
          "/api/tenant-settings/feature.callified.assign_staff.leads_per_user",
        ),
      ]);
      setAssignStaffEnabled(
        String(enabledRes?.value).toLowerCase() !== "false",
      );
      const logic = ["round_robin", "random"].includes(
        String(logicRes?.value).toLowerCase(),
      )
        ? String(logicRes?.value).toLowerCase()
        : "round_robin";
      setAssignStaffLogic(logic);
      const parsedLeads = Number(leadsPerUserRes?.value);
      setAssignStaffLeadsPerUser(
        Number.isFinite(parsedLeads) ? parsedLeads : 1,
      );
    } catch (_e) {
      setAssignStaffEnabled(true);
      setAssignStaffLogic("round_robin");
      setAssignStaffLeadsPerUser(1);
    } finally {
      setAssignSettingsLoading(false);
    }
  }, [isGeneric]);

  const saveAssignStaffEnabled = async (next) => {
    if (!isAdmin) {
      notify.info("Only admins can change call settings.");
      return;
    }
    setAssignSettingsSaving((prev) => ({ ...prev, enabled: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.assign_staff.enabled",
        {
          method: "PUT",
          body: JSON.stringify({
            value: next ? "true" : "false",
            category: "feature-flag",
          }),
        },
      );
      setAssignStaffEnabled(String(d?.value).toLowerCase() !== "false");
      notify.success(
        `Auto-assign qualified leads ${next ? "enabled" : "disabled"}`,
      );
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save assignment setting");
      loadAssignStaffSettings();
    } finally {
      setAssignSettingsSaving((prev) => ({ ...prev, enabled: false }));
    }
  };

  const saveAssignStaffLogic = async (next) => {
    if (!isAdmin) return;
    const value = ["round_robin", "random"].includes(String(next).toLowerCase())
      ? String(next).toLowerCase()
      : "round_robin";
    setAssignSettingsSaving((prev) => ({ ...prev, logic: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.assign_staff.logic",
        {
          method: "PUT",
          body: JSON.stringify({ value, category: "feature-flag" }),
        },
      );
      const saved = String(d?.value).toLowerCase();
      setAssignStaffLogic(
        ["round_robin", "random"].includes(saved) ? saved : value,
      );
      notify.success(
        `Assignment logic set to ${value === "round_robin" ? "Round robin" : "Random"}`,
      );
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save assignment logic");
      loadAssignStaffSettings();
    } finally {
      setAssignSettingsSaving((prev) => ({ ...prev, logic: false }));
    }
  };

  const saveAssignStaffLeadsPerUser = async (next) => {
    if (!isAdmin) return;
    const value = Math.max(1, Math.min(Number(next) || 1, 50));
    setAssignSettingsSaving((prev) => ({ ...prev, leadsPerUser: true }));
    try {
      const d = await fetchApi(
        "/api/tenant-settings/feature.callified.assign_staff.leads_per_user",
        {
          method: "PUT",
          body: JSON.stringify({
            value: String(value),
            category: "feature-flag",
          }),
        },
      );
      const parsed = Number(d?.value);
      setAssignStaffLeadsPerUser(Number.isFinite(parsed) ? parsed : value);
      notify.success(`Leads per user set to ${value}`);
    } catch (e) {
      notify.error(e?.body?.error || "Failed to save leads per user");
      loadAssignStaffSettings();
    } finally {
      setAssignSettingsSaving((prev) => ({ ...prev, leadsPerUser: false }));
    }
  };

  const dnpIntervalHours = Math.floor(dnpIntervalMinutes / 60);
  const dnpIntervalMins = dnpIntervalMinutes % 60;

  // Generic CRM Leads page — load all call settings in one place.
  const loadCallSettings = useCallback(async () => {
    await Promise.all([
      loadAiTranscriptSetting(),
      loadAutoDialNewLeadsSetting(),
      loadDnpRetrySettings(),
      loadAssignStaffSettings(),
    ]);
  }, [
    loadAiTranscriptSetting,
    loadAutoDialNewLeadsSetting,
    loadDnpRetrySettings,
    loadAssignStaffSettings,
  ]);

  useEffect(() => {
    loadCallSettings();
  }, [loadCallSettings]);
  // is open so we don't trap key events for users not actively creating.
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setCreating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);
  useEffect(() => {
    if (!aiSettingsOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setAiSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aiSettingsOpen]);

  const openCreate = () => setCreating(true);
  const closeCreate = () => setCreating(false);

  const handleCreateLead = async (e) => {
    e.preventDefault();

    // #557 (HI-08)  client-side hardening. Order:
    //   1. Trim required fields + reject whitespace-only (preserves #337).
    //   2. Per-field length caps (rejects, doesn't silently truncate, so the
    //      user knows they need to shorten the input).
    //   3. Control-character rejection (NUL, BEL, VT, DEL, etc.)  these are
    //      never legitimate in name/email/company/title and usually signal a
    //      paste-from-malicious-source.
    //   4. HTML/script tag pre-strip (defence-in-depth  backend's
    //      sanitizeBody also strips, but surfacing a notice is better UX
    //      than the user wondering why their input looks different).
    //   5. Email shape sanity check (cheap regex  backend stays the source
    //      of truth for the strict validation).
    // The backend at routes/contacts.js + sanitizeBody is still the source
    // of truth; these are just guard rails for fast feedback.
    const trimmedName = (newLead.name || "").trim();
    if (trimmedName.length < 1) {
      // #337: reject whitespace-only names. Toast via global notify helper.
      notify.error("Name is required");
      return;
    }

    // 2. Length caps  match backend Contact column limits (191) for name/
    //    email/company; cap title at 200 (the issue ask). Reject so the user
    //    sees a clear "too long" message rather than a server-side 400.
    const lengthErrors = [];
    for (const [field, max] of Object.entries(FIELD_LIMITS)) {
      const v = String(newLead[field] || "");
      if (v.length > max) {
        lengthErrors.push(`${field} is too long (${v.length}/${max} chars)`);
      }
    }
    if (lengthErrors.length > 0) {
      notify.error(lengthErrors.join("; "));
      return;
    }

    // 3. Control-character rejection across all text fields.
    for (const field of ["name", "email", "company", "title"]) {
      const v = String(newLead[field] || "");
      if (v && CONTROL_CHAR_RE.test(v)) {
        notify.error(`${field} contains invalid control characters`);
        return;
      }
    }

    // 4. HTML/script tag pre-strip  surface what was removed so the user
    //    isn't surprised. We strip just the dangerous TAGS (matching the
    //    server-side sanitizeBody contract); the inner text content is kept.
    const stripped = {};
    let anyStripped = false;
    for (const field of ["name", "company", "title"]) {
      const v = String(newLead[field] || "");
      const result = stripDangerousTags(v);
      stripped[field] = result.value;
      if (result.stripped) anyStripped = true;
    }
    if (anyStripped) {
      notify.info("HTML markup was removed from your input before submitting.");
    }
    // Re-trim the stripped name in case stripping the tags reduced it to
    // whitespace (e.g. the user submitted JUST `<img onerror=>`). Use
    // nullish-coalesce, NOT logical-OR, so an empty-string result of the
    // strip falls through to the empty-name guard rather than reverting
    // to the un-stripped original.
    const finalName = String(stripped.name ?? trimmedName).trim();
    if (finalName.length < 1) {
      notify.error("Name is required");
      return;
    }

    // 5. Email shape  basic regex (matches backend lib/validateContactInput
    //    + CSV importer). The backend rejects with 400 either way.
    //    #600: under wellness, email is OPTIONAL (Patient intake mirrors this);
    //    phone becomes the required identifier instead.
    const email = String(newLead.email || "").trim();
    if (isWellness) {
      if (email && !EMAIL_RE.test(email)) {
        notify.error("Please enter a valid email address");
        return;
      }
    } else if (!email || !EMAIL_RE.test(email)) {
      notify.error("Please enter a valid email address");
      return;
    }

    // Phone handling per vertical:
    //   wellness  required, validated against Indian-mobile pattern
    //   travel    optional, free-form (prepend country code if provided)
    //   generic   optional, free-form (prepend country code if provided)
    let phone = String(newLead.phone || "").trim();
    if (isWellness) {
      const phoneClean = phone.replace(/[\s\-()]/g, "");
      if (!phoneClean) {
        notify.error("Phone is required");
        return;
      }
      if (!INDIAN_MOBILE_RE.test(phoneClean)) {
        notify.error(
          "Enter a valid mobile number (10 digits, starting 6-9; +91 prefix optional).",
        );
        return;
      }
      phone = phoneClean;
    }

    // #315: refetch leads after a successful create so the "All Leads" pipeline
    // counter chip in the header (which reads `leads.length`) refreshes
    // immediately. Pre-fix the await on the create call could throw and skip
    // the refetch, leaving the header counter stuck on the stale count even
    // when the row was inserted server-side. Wrap in try/finally so the
    // refresh always runs and the form is reset on success.
    try {
      // Generic CRM: prepend the picker's country code (the input field
      // is the local-part). Wellness: phone is already canonicalised by
      // the +91-optional regex above  store as-is.
      const phoneOut = isWellness
        ? phone
        : newLead.phone
          ? `${newLead.countryCode} ${newLead.phone}`
          : "";
      await fetchApi("/api/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...newLead,
          name: trimmedName,
          phone: phoneOut,
          countryCode: undefined,
          skipInitialAssignee: isGeneric ? true : undefined,
        }),
      });
      setNewLead({
        name: "",
        email: "",
        company: "",
        title: "",
        countryCode: "+1",
        phone: "",
        source: "Organic",
        status: "Lead",
        customFields: {},
      });
      // #892  close the drawer on successful create; the list refresh
      // below puts the new row at the top so the user sees the result.
      setCreating(false);
    } finally {
      fetchLeads({ background: true });
    }
  };

  const handleConvert = async (id) => {
    // Bug #283: pipeline is Lead -> Prospect -> Customer -> Churned. The
    // Convert button must move the lead one step (to Prospect), not jump
    // straight to Customer. ConvertedLeads.jsx defaults to the "Prospect"
    // tab, so this is also where the user expects to find the row next.
    const body = { status: "Prospect" };

    await fetchApi(`/api/contacts/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    fetchLeads({ background: true });
  };

  const openEdit = (lead) => {
    setEditForm({
      name: lead.name || "",
      email: lead.email || "",
      company: lead.company || "",
      title: lead.title || "",
      source: lead.source || "",
      customFields: { ...(lead.customFields || {}) },
    });
    setEditing(lead);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    if (!editForm.name.trim()) {
      notify.error("Name is required");
      return;
    }
    setEditSaving(true);
    try {
      await fetchApi(`/api/contacts/${editing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editForm.name.trim(),
          email: editForm.email.trim(),
          company: editForm.company.trim(),
          title: editForm.title.trim(),
          source: editForm.source,
          customFields: editForm.customFields || {},
        }),
      });
      notify.success("Lead updated");
      setEditing(null);
      fetchLeads({ background: true });
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to update lead");
    } finally {
      setEditSaving(false);
    }
  };

  const handleDelete = async (lead) => {
    const ok = await notify.confirm({
      title: "Delete lead?",
      message: `Delete "${lead.name}"? This permanently removes the contact. This can't be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;
    try {
      await fetchApi(`/api/contacts/${lead.id}`, { method: "DELETE" });
      notify.success("Lead deleted");
      fetchLeads({ background: true });
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete lead");
    }
  };

  const handleAssign = async (contactId, assignedToId) => {
    await fetchApi(`/api/contacts/${contactId}/assign`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignedToId: assignedToId || null }),
    });
    fetchLeads({ background: true });
  };

  const handleBulkAssign = async () => {
    if (selectedLeads.length === 0) return;
    await fetchApi("/api/contacts/bulk-assign", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contactIds: selectedLeads,
        assignedToId: bulkAgent || null,
      }),
    });
    setSelectedLeads([]);
    setBulkAgent("");
    fetchLeads({ background: true });
  };

  const handleBulkAssignCampaign = async (campaignId) => {
    if (selectedLeads.length === 0) return;
    setBulkCampaignSaving(true);
    const nextId = campaignId ? Number(campaignId) : null;
    // Optimistically update all selected rows so the UI feels instant.
    setLeads((prev) =>
      prev.map((l) =>
        selectedLeads.includes(l.id)
          ? { ...l, callifiedCampaignId: nextId }
          : l,
      ),
    );
    try {
      const res = await fetchApi("/api/contacts/bulk-assign-campaign", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactIds: selectedLeads,
          callifiedCampaignId: nextId,
        }),
      });
      notify.success(
        `Campaign assigned to ${res?.updated || selectedLeads.length} lead${selectedLeads.length === 1 ? "" : "s"}`,
      );
      setBulkCampaignId("");
      setBulkCampaignDropdownOpen(false);
      setSelectedLeads([]);
      await fetchLeads({ background: true });
      loadCallifiedCampaigns();
    } catch (err) {
      notify.error(
        err?.body?.error || err?.message || "Failed to assign campaign",
      );
      await fetchLeads({ background: true });
    } finally {
      setBulkCampaignSaving(false);
    }
  };

  const handleCampaignChange = async (lead, campaignId) => {
    const previousId = lead.callifiedCampaignId
      ? String(lead.callifiedCampaignId)
      : "";
    const nextId = campaignId ? String(campaignId) : "";
    // Optimistically update the local row so the dropdown feels instant even
    // on high-latency deploys.
    setLeads((prev) =>
      prev.map((l) =>
        l.id === lead.id
          ? { ...l, callifiedCampaignId: nextId ? Number(nextId) : null }
          : l,
      ),
    );
    try {
      await fetchApi(`/api/contacts/${lead.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          callifiedCampaignId: nextId ? Number(nextId) : null,
        }),
      });
      // Refetch leads once; reload campaign counts in the background so the
      // dropdown counts stay fresh without blocking the optimistic update.
      await fetchLeads({ background: true });
      loadCallifiedCampaigns();
    } catch (err) {
      // Roll back on failure.
      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id
            ? {
                ...l,
                callifiedCampaignId: previousId ? Number(previousId) : null,
              }
            : l,
        ),
      );
      notify.error(
        err?.body?.error || err?.message || "Failed to assign campaign",
      );
    }
  };

  // Poll Callified until a lead's latest call has a transcript, or a timeout
  // passes. The post-call classify reads the latest review from Callified; if
  // the review is still preliminary, the Refresh button re-classifies called
  // leads so the status corrects itself once the final review is available.
  const pollCallCompletion = async (
    lead,
    { callifiedLeadId, timeoutMs = 120_000, intervalMs = 3000 } = {},
  ) => {
    const start = Date.now();
    let resolvedId = callifiedLeadId || null;
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        if (!resolvedId) {
          const latest = await fetchApi(
            `/api/callified/calls/lead/${lead.id}/latest`,
          );
          resolvedId = latest?.callifiedLeadId || null;
          if (!resolvedId) continue;
        }
        const details = await fetchApi(
          `/api/callified/calls/${resolvedId}/details`,
        );
        const transcripts = details?.transcripts || [];
        if (transcripts.length > 0) {
          return { completed: true, callifiedLeadId: resolvedId, details };
        }
      } catch (e) {
        console.error(
          `[leads] poll call completion for ${lead.id} failed:`,
          e?.message,
        );
      }
    }
    return { completed: false, callifiedLeadId: resolvedId };
  };

  // Sequential one-by-one call queue. Accepts an array of { lead, campaignId }.
  const runCallQueue = async (items) => {
    if (!Array.isArray(items) || items.length === 0) return;
    setCallQueue(items.map((it) => ({ ...it, status: "pending" })));
    setCallQueueActive(true);
    const completed = [];
    const failed = [];

    for (let i = 0; i < items.length; i += 1) {
      const { lead, campaignId } = items[i];
      setCallQueue((prev) =>
        prev.map((it, idx) => (idx === i ? { ...it, status: "calling" } : it)),
      );
      let result;
      try {
        result = await fetchApi(`/api/callified/leads/${lead.id}/call`, {
          method: "POST",
          body: JSON.stringify({ campaignId: Number(campaignId) }),
        });
      } catch (err) {
        const msg = err?.body?.error || err?.message || "Call failed";
        failed.push({ lead, error: msg });
        setCallQueue((prev) =>
          prev.map((it, idx) =>
            idx === i ? { ...it, status: "failed", error: msg } : it,
          ),
        );
        continue;
      }

      // Wait for the call to actually finish at Callified before moving on so
      // the queue never dials two people at the same time.
      setCallQueue((prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: "waiting_for_completion" } : it,
        ),
      );
      const poll = await pollCallCompletion(lead, {
        callifiedLeadId: result?.callifiedLeadId,
      });
      completed.push({ lead, callifiedLeadId: poll.callifiedLeadId });
      setCallQueue((prev) =>
        prev.map((it, idx) =>
          idx === i ? { ...it, status: "completed" } : it,
        ),
      );
    }

    setCallQueueActive(false);
    setTimeout(() => setCallQueue([]), 4000);
    const freshLeads = await fetchLeads({ background: true });
    if (isGeneric && completed.length > 0 && freshLeads?.length > 0) {
      // Re-classify the leads we just called so their Call Status updates
      // from the latest transcript/score without requiring a browser reload.
      const dialedIds = new Set(completed.map((c) => c.lead.id));
      classifyVisibleLeads(
        freshLeads.filter((l) => dialedIds.has(l.id)),
        { force: true },
      );
    }

    const parts = [];
    if (completed.length) parts.push(`${completed.length} called`);
    if (failed.length) parts.push(`${failed.length} failed`);
    if (parts.length) notify.success(`Dial queue done: ${parts.join(", ")}`);
  };

  const handleDialSelectedLeads = async () => {
    if (selectedLeads.length === 0) return;
    const selectedRows = leads.filter((l) => selectedLeads.includes(l.id));
    const missingPhone = selectedRows.filter((l) => !l.phone);
    const missingCampaign = selectedRows.filter((l) => !l.callifiedCampaignId);
    const dialable = selectedRows.filter(
      (l) => l.phone && l.callifiedCampaignId,
    );

    if (dialable.length === 0) {
      notify.error(
        `No dialable leads selected. ${missingPhone.length} missing phone, ${missingCampaign.length} missing campaign.`,
      );
      return;
    }

    if (missingPhone.length || missingCampaign.length) {
      notify.info(
        `Dialing ${dialable.length} leads. Skipped ${missingPhone.length} without phone and ${missingCampaign.length} without campaign.`,
      );
    }

    const items = dialable.map((l) => ({
      lead: l,
      campaignId: l.callifiedCampaignId,
    }));
    runCallQueue(items);
  };

  const handleDialSelectedCampaigns = async () => {
    if (selectedCampaignIds.length === 0) return;
    const campaigns = callifiedCampaigns.filter((c) =>
      selectedCampaignIds.includes(String(c.id)),
    );
    const allLeadIds = new Set();
    const items = [];
    for (const campaign of campaigns) {
      const campaignLeads = leads.filter(
        (l) =>
          String(l.callifiedCampaignId) === String(campaign.id) &&
          l.phone &&
          !allLeadIds.has(l.id),
      );
      for (const lead of campaignLeads) {
        allLeadIds.add(lead.id);
        items.push({ lead, campaignId: campaign.id });
      }
    }

    const targetCount = campaigns.reduce(
      (sum, c) => sum + (c.leadCount || 0),
      0,
    );
    const skippedNoPhone = targetCount - items.length;

    if (items.length === 0) {
      notify.error(
        "No dialable leads found in the selected campaigns (missing phone numbers).",
      );
      return;
    }

    const ok = await notify.confirm({
      title: "Dial selected campaigns?",
      message: `This will call ${items.length} leads across ${campaigns.length} campaign(s) one by one. ${skippedNoPhone > 0 ? `${skippedNoPhone} lead(s) will be skipped (no phone).` : ""}`,
      confirmText: "Dial All",
      cancelText: "Cancel",
      destructive: false,
    });
    if (!ok) return;

    runCallQueue(items);
  };

  const handleSingleDial = (lead, campaignId) => {
    if (!lead.phone) {
      notify.error("Lead has no phone number");
      return;
    }
    if (!campaignId) {
      notify.error("Please assign a campaign first");
      return;
    }
    runCallQueue([{ lead, campaignId: Number(campaignId) }]);
  };

  const handleLeadStatusChange = async (lead, status) => {
    try {
      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id ? { ...l, callifiedLeadStatus: status } : l,
        ),
      );
      const result = await fetchApi(
        `/api/callified/leads/${lead.id}/lead-status`,
        {
          method: "PUT",
          body: JSON.stringify({ status }),
        },
      );
      setLeads((prev) =>
        prev.map((l) =>
          l.id === lead.id
            ? {
                ...l,
                callifiedLeadStatus: result?.callifiedLeadStatus ?? status,
                callifiedLeadStatusSource:
                  result?.callifiedLeadStatusSource ?? "manual",
                callifiedLeadStatusReason:
                  result?.callifiedLeadStatusReason ??
                  "Status changed manually by user.",
                callifiedLeadStatusUpdatedAt:
                  result?.callifiedLeadStatusUpdatedAt ??
                  new Date().toISOString(),
                assignedToId: result?.assignedToId ?? l.assignedToId,
                assignedTo: result?.assignedTo ?? l.assignedTo,
              }
            : l,
        ),
      );
    } catch (err) {
      notify.error(
        err?.body?.error || err?.message || "Failed to update lead status",
      );
    } finally {
      await fetchLeads({ background: true });
    }
  };

  const resetFilters = () => {
    setSourceFilter("");
    setSubBrandFilter("");
    setStageFilter("");
    setCampaignFilter("");
    setLeadStatusFilter("");
    setAssigneeFilter("");
    setSearchTerm("");
    setAdvancedFilters([]);
    setLeadsPage(0);
  };

  const toggleSelect = (id) => {
    setSelectedLeads((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const toggleSelectAll = () => {
    if (selectedLeads.length === filteredLeads.length) {
      setSelectedLeads([]);
    } else {
      setSelectedLeads(filteredLeads.map((l) => l.id));
    }
  };

  const handleChange = (field, value) => {
    setNewLead((prev) => ({ ...prev, [field]: value }));
  };

  const sourceFilterOptions = isWellness
    ? WELLNESS_SOURCE_OPTIONS
    : isTravel
      ? TRAVEL_SOURCE_OPTIONS
      : SOURCE_OPTIONS.map((src) => ({ value: src, label: src }));

  const matchesSource = (leadSource, filterValue) => {
    if (!filterValue) return true;
    return (
      String(leadSource || "").toLowerCase() ===
      String(filterValue).toLowerCase()
    );
  };

  const sourceCounts = sourceFilterOptions.reduce((acc, opt) => {
    acc[opt.value] = leads.filter((lead) =>
      matchesSource(lead.source, opt.value),
    ).length;
    return acc;
  }, {});

  const travelSubBrandOptions = SUB_BRAND_IDS.map((id) => ({
    value: id,
    label: subBrandShortLabel(id),
  }));
  const travelStageOptions = pipelineStages.map((stage) => ({
    value: String(stage.id ?? stage.name ?? stage.title),
    label: stage.title || stage.name || `Stage ${stage.id}`,
  }));
  const leadMatchesStage = (lead) => {
    if (!stageFilter) return true;
    const deals = dealsByContact[lead.id] || [];
    return deals.some((deal) =>
      [
        deal.pipelineStageId,
        deal.stageId,
        deal.stage,
        deal.pipelineStage?.id,
        deal.pipelineStage?.name,
        deal.pipelineStage?.title,
      ].some((value) => String(value ?? "") === stageFilter),
    );
  };
  const visibleCfCols = customFieldDefs.filter((f) =>
    isColVisible(`cf_${f.fieldKey}`),
  ).length;
  const leadsTableMinWidth = isTravel
    ? "1720px"
    : isWellness
      ? "1500px"
      : isGeneric
        ? `${1080 + visibleCfCols * 84}px`
        : customFieldDefs.length
          ? `${900 + customFieldDefs.length * 84}px`
          : undefined;

  const leadDetailPath = (lead) => {
    if (isTravel) return `/travel/leads/${lead.id}`;
    return `/contacts/${lead.id}`;
  };

  const filteredLeads = leads.filter((lead) => {
    if (!matchesSource(lead.source, sourceFilter)) return false;
    if (isTravel && subBrandFilter && lead.subBrand !== subBrandFilter)
      return false;
    if (isTravel && !leadMatchesStage(lead)) return false;
    if (
      isGeneric &&
      campaignFilter &&
      String(lead.callifiedCampaignId) !== String(campaignFilter)
    )
      return false;
    if (
      isGeneric &&
      leadStatusFilter &&
      normalizeCallStatus(lead.callifiedLeadStatus) !== leadStatusFilter
    )
      return false;
    if (assigneeFilter) {
      if (assigneeFilter === "unassigned") {
        if (lead.assignedToId) return false;
      } else if (String(lead.assignedToId) !== String(assigneeFilter)) {
        return false;
      }
    }
    const term = searchTerm.trim().toLowerCase();
    if (!term) return true;
    const campaign = callifiedCampaigns.find(
      (c) => String(c.id) === String(lead.callifiedCampaignId),
    );
    return [
      lead.name,
      lead.email,
      lead.company,
      lead.phone,
      lead.source,
      lead.assignedTo?.name,
      lead.assignedTo?.email,
      campaign?.name,
      lead.callifiedLeadStatus,
    ].some((value) =>
      String(value || "")
        .toLowerCase()
        .includes(term),
    );
  });

  /* eslint-disable react-hooks/exhaustive-deps */
  // Batch-load Callified call summaries for visible leads (counts + last score).
  useEffect(() => {
    if (!isGeneric || filteredLeads.length === 0) {
      setCallifiedSummaries({});
      return;
    }
    let cancelled = false;
    const ids = filteredLeads.map((l) => l.id).slice(0, 100);
    fetchApi(`/api/callified/leads/call-summary?contactIds=${ids.join(",")}`)
      .then((d) => {
        if (cancelled) return;
        setCallifiedSummaries(d?.summaries || {});
      })
      .catch(() => {
        if (cancelled) return;
        setCallifiedSummaries({});
      });
    return () => {
      cancelled = true;
    };
  }, [isGeneric, filteredLeads.map((l) => l.id).join(",")]);
  /* eslint-enable react-hooks/exhaustive-deps */

  // Safety net: any Qualified lead that is unassigned (or assigned to a user outside
  // the active ADMIN/MANAGER/USER pool used by the round-robin picker) should be
  // round-robin assigned. This catches existing Qualified leads, manually-overridden
  // Qualified leads, and cases where the classify-time assignment missed.
  useEffect(() => {
    if (!isGeneric || staff.length === 0 || filteredLeads.length === 0) return;
    const assignableStaffIds = new Set(
      staff
        .filter(
          (s) =>
            ["ADMIN", "MANAGER", "USER"].includes(s.role) && !s.deactivatedAt,
        )
        .map((s) => String(s.id)),
    );
    const qualifiedUnassigned = filteredLeads.filter(
      (l) =>
        normalizeCallStatus(l.callifiedLeadStatus) === CALL_STATUS.QUALIFIED &&
        (!l.assignedToId || !assignableStaffIds.has(String(l.assignedToId))),
    );
    if (qualifiedUnassigned.length === 0) return;

    let cancelled = false;
    const run = async () => {
      let assignedCount = 0;
      for (const lead of qualifiedUnassigned) {
        if (cancelled) return;
        try {
          const result = await fetchApi(
            `/api/callified/leads/${lead.id}/ensure-hot-assigned`,
            { method: "POST" },
          );
          if (result?.assignedToId) {
            assignedCount += 1;
            setLeads((prev) =>
              prev.map((l) =>
                l.id === lead.id
                  ? {
                      ...l,
                      assignedToId: result.assignedToId,
                      assignedTo: result.assignedTo,
                    }
                  : l,
              ),
            );
          }
        } catch (e) {
          console.error(
            `[leads] ensure-qualified-assigned ${lead.id} failed:`,
            e?.body || e?.message,
          );
        }
      }
      if (assignedCount > 0) {
        notify.success(`Auto-assigned ${assignedCount} qualified lead(s)`);
      }
      // Refresh once at the end so the round-robin pointer and relations are consistent.
      fetchLeads({ background: true });
    };

    const timeout = setTimeout(run, 600);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isGeneric,
    staff.length,
    filteredLeads
      .map((l) => `${l.id}:${l.callifiedLeadStatus}:${l.assignedToId}`)
      .join(","),
  ]);

  const leadsPageCount = Math.max(
    1,
    Math.ceil(filteredLeads.length / leadsPageSize),
  );
  const currentLeadsPage = Math.min(leadsPage, leadsPageCount - 1);
  const pageStart =
    filteredLeads.length === 0 ? 0 : currentLeadsPage * leadsPageSize + 1;
  const pageEnd =
    filteredLeads.length === 0
      ? 0
      : Math.min(
          filteredLeads.length,
          currentLeadsPage * leadsPageSize + leadsPageSize,
        );
  const paginatedLeads = filteredLeads.slice(
    currentLeadsPage * leadsPageSize,
    currentLeadsPage * leadsPageSize + leadsPageSize,
  );

  const goToLeadsPage = () => {
    const nextPage = Number(pageInput);
    if (!Number.isFinite(nextPage) || nextPage < 1) {
      setLeadsPage(0);
      setPageInput("1");
      return;
    }
    const clampedPage = Math.min(nextPage, leadsPageCount);
    setLeadsPage(clampedPage - 1);
    setPageInput(String(clampedPage));
  };

  useEffect(() => {
    setPageInput(String(currentLeadsPage + 1));
  }, [currentLeadsPage]);
  // Generic-vertical-only Lead custom fields  renders the right input
  // widget per admin-defined field type (Settings > Lead Fields). Shared
  // between the Create and Edit forms; each caller passes its own
  // `values`/`onChange` so this stays a pure render helper with no state
  // of its own.
  const renderCustomFieldInputs = (values, onChange) => {
    if (isWellness || isTravel || customFieldDefs.length === 0) return null;
    return customFieldDefs.map((f) => {
      const value = values?.[f.fieldKey] ?? "";
      const handle = (v) => onChange(f.fieldKey, v);
      const label = f.label;
      const placeholder =
        f.placeholder || (f.isRequired ? label : `${label} (optional)`);
      const titleAttr = f.tooltip ? { title: f.tooltip } : {};

      if (f.fieldType === "checkbox") {
        return (
          <label
            key={f.id}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            {...titleAttr}
          >
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => handle(e.target.checked)}
            />
            {label}
          </label>
        );
      }

      if (f.fieldType === "dropdown" || f.fieldType === "radio") {
        return (
          <select
            key={f.id}
            className="input-field"
            required={f.isRequired}
            value={value}
            onChange={(e) => handle(e.target.value)}
            {...titleAttr}
          >
            <option value="">{placeholder}</option>
            {(f.options || []).map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        );
      }

      if (f.fieldType === "multiselect") {
        const selected = Array.isArray(value) ? value : value ? [value] : [];
        return (
          <div
            key={f.id}
            style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}
            {...titleAttr}
          >
            {label}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
              {(f.options || []).map((opt) => (
                <label
                  key={opt}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.8rem",
                    padding: "0.2rem 0.5rem",
                    borderRadius: 6,
                    border: "1px solid var(--border-color)",
                    background: "var(--surface-color)",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(opt)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...selected, opt]
                        : selected.filter((s) => s !== opt);
                      handle(next);
                    }}
                  />
                  {opt}
                </label>
              ))}
            </div>
          </div>
        );
      }

      if (f.fieldType === "textarea") {
        return (
          <textarea
            key={f.id}
            className="input-field"
            required={f.isRequired}
            value={value}
            placeholder={placeholder}
            maxLength={2000}
            rows={3}
            onChange={(e) => handle(e.target.value)}
            {...titleAttr}
            style={{ padding: "0.45rem", fontSize: "0.85rem" }}
          />
        );
      }

      const inputType =
        f.fieldType === "date"
          ? "date"
          : f.fieldType === "number"
            ? "number"
            : f.fieldType === "url"
              ? "url"
              : "text";
      return (
        <input
          key={f.id}
          type={inputType}
          className="input-field"
          required={f.isRequired}
          value={value}
          placeholder={placeholder}
          onChange={(e) => handle(e.target.value)}
          {...titleAttr}
          style={{ padding: "0.45rem", fontSize: "0.85rem" }}
        />
      );
    });
  };

  const activeSearchTerm = searchTerm.trim();
  const leadsSummary = activeSearchTerm
    ? `${filteredLeads.length} of ${leads.length} leads match "${activeSearchTerm}"`
    : `${leads.length} leads in pipeline`;
  const leadsColSpan =
    2 +
    (isAdmin ? 1 : 0) +
    [
      "email",
      "company",
      "phone",
      "aiScore",
      "source",
      "assignedTo",
      "createdAt",
    ].filter(isColVisible).length +
    (isGeneric ? 4 : 0) +
    (isTravel ? 2 : 0) +
    visibleCfCols;
  return (
    <div style={{ padding: "2rem", animation: "fadeIn 0.3s ease" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.5rem",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            minWidth: 0,
            flex: "1 1 240px",
          }}
        >
          <UserPlus size={24} color="var(--text-primary)" />
          <div style={{ minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "1.5rem",
                color: "var(--text-primary)",
              }}
            >
              Leads
            </h1>
            <p
              style={{
                margin: "0.2rem 0 0",
                color: "var(--text-secondary)",
                fontSize: "0.875rem",
              }}
            >
              {leadsSummary}
            </p>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            className="btn-secondary"
            onClick={refreshAll}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
            }}
          >
            <RefreshCw size={15} /> Refresh
          </button>

          {isGeneric && (
            <CsvImportExportToolbar
              entity="contacts"
              label="Leads"
              formats={["csv", "xlsx"]}
              endpoints={{
                export: "/api/csv/contacts/export.csv",
                template: "/api/csv/contacts/template.csv",
                meta: "/api/csv/contacts",
                import: "/api/csv/contacts/import.csv",
              }}
            />
          )}

          {isGeneric && callifiedConfigured && (
            <>
              {/* Auto-assign campaign rules: dropdown shows a grid where each
                  rule maps a lead column + value to a Callified campaign. */}
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  className="input-field"
                  onClick={() => setAutoCampaignRulesOpen((o) => !o)}
                  disabled={autoCampaignRulesLoading || autoCampaignRulesSaving}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    minWidth: "200px",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                    position: "relative",
                  }}
                  aria-label="Auto-assign Callified Campaigns rules"
                  title="Configure rules to automatically assign Callified campaigns to new leads"
                >
                  <Settings size={14} />
                  Auto-assign Callified Campaigns
                  {autoCampaignRulesEnabled && (
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: "var(--success-color, #22c55e)",
                        marginLeft: "0.25rem",
                      }}
                    />
                  )}
                </button>

                {autoCampaignRulesOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 50 }}
                      onClick={() => setAutoCampaignRulesOpen(false)}
                    />
                    <div
                      className="card"
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        right: 0,
                        zIndex: 51,
                        minWidth: 520,
                        maxWidth: 560,
                        padding: "1rem",
                        boxShadow: "0 10px 24px rgba(0,0,0,0.2)",
                        background: "var(--bg-color)",
                        border: "1px solid var(--border-color)",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginBottom: "0.75rem",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            color: "var(--text-primary)",
                          }}
                        >
                          Auto-assign Callified Campaigns rules
                        </span>
                        <label
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: "0.4rem",
                            cursor: isAdmin ? "pointer" : "not-allowed",
                            fontSize: "0.8rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={autoCampaignRulesEnabled}
                            disabled={autoCampaignRulesSaving || !isAdmin}
                            onChange={() => {
                              const next = !autoCampaignRulesEnabled;
                              setAutoCampaignRulesEnabled(next);
                              saveAutoCampaignRules({
                                enabled: next,
                                rules: autoCampaignRules,
                              });
                            }}
                          />
                          {autoCampaignRulesEnabled ? "On" : "Off"}
                        </label>
                      </div>

                      <div
                        style={{
                          fontSize: "0.75rem",
                          color: "var(--text-secondary)",
                          marginBottom: "0.75rem",
                        }}
                      >
                        When a new lead arrives, the first matching rule assigns
                        the chosen campaign. Values match ignoring case, spaces,
                        and punctuation.
                      </div>

                      {autoCampaignRulesEnabled && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: "0.5rem",
                          }}
                        >
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "34px 1fr 1fr 1fr 80px 32px",
                              gap: "0.5rem",
                              alignItems: "center",
                              fontSize: "0.7rem",
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              padding: "0 0.25rem",
                            }}
                          >
                            <span>On</span>
                            <span>Lead column</span>
                            <span>Value</span>
                            <span>Campaign</span>
                            <span style={{ textAlign: "center" }}>Save</span>
                            <span />
                          </div>

                          {autoCampaignRules.map((rule) => {
                            const columnOptions = [
                              ...BUILTIN_RULE_COLUMNS,
                              ...customFieldDefs.map((f) => ({
                                key: `cf_${f.fieldKey}`,
                                label: f.label,
                              })),
                            ];
                            const ruleIsSaved = savedAutoCampaignRuleIds.has(
                              rule.id,
                            );
                            const ruleIsValid =
                              rule.column &&
                              String(rule.value || "").trim() &&
                              rule.campaignId;
                            const removeSavedStatus = () => {
                              setSavedAutoCampaignRuleIds((prev) => {
                                if (!prev.has(rule.id)) return prev;
                                const next = new Set(prev);
                                next.delete(rule.id);
                                return next;
                              });
                            };
                            return (
                              <div
                                key={rule.id}
                                style={{
                                  display: "grid",
                                  gridTemplateColumns:
                                    "34px 1fr 1fr 1fr 80px 32px",
                                  gap: "0.5rem",
                                  alignItems: "center",
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={!!rule.enabled}
                                  disabled={autoCampaignRulesSaving || !isAdmin}
                                  onChange={() => {
                                    const next = autoCampaignRules.map((r) =>
                                      r.id === rule.id
                                        ? { ...r, enabled: !r.enabled }
                                        : r,
                                    );
                                    setAutoCampaignRules(next);
                                    removeSavedStatus();
                                  }}
                                  style={{
                                    cursor: isAdmin ? "pointer" : "not-allowed",
                                  }}
                                />
                                <select
                                  className="input-field"
                                  value={rule.column || ""}
                                  disabled={autoCampaignRulesSaving || !isAdmin}
                                  onChange={(e) => {
                                    const next = autoCampaignRules.map((r) =>
                                      r.id === rule.id
                                        ? { ...r, column: e.target.value }
                                        : r,
                                    );
                                    setAutoCampaignRules(next);
                                    removeSavedStatus();
                                  }}
                                  style={{
                                    padding: "0.35rem 0.5rem",
                                    fontSize: "0.8rem",
                                    minWidth: 0,
                                  }}
                                >
                                  <option value="">Select column</option>
                                  {columnOptions.map((col) => (
                                    <option key={col.key} value={col.key}>
                                      {col.label}
                                    </option>
                                  ))}
                                </select>
                                <input
                                  type="text"
                                  value={rule.value || ""}
                                  disabled={autoCampaignRulesSaving || !isAdmin}
                                  placeholder="e.g. web-form"
                                  onChange={(e) => {
                                    const next = autoCampaignRules.map((r) =>
                                      r.id === rule.id
                                        ? { ...r, value: e.target.value }
                                        : r,
                                    );
                                    setAutoCampaignRules(next);
                                    removeSavedStatus();
                                  }}
                                  style={{
                                    padding: "0.35rem 0.5rem",
                                    fontSize: "0.8rem",
                                    borderRadius: 6,
                                    border: "1px solid var(--border-color)",
                                    background: "var(--surface)",
                                    color: "var(--text-primary)",
                                    minWidth: 0,
                                  }}
                                />
                                <select
                                  className="input-field"
                                  value={rule.campaignId || ""}
                                  disabled={autoCampaignRulesSaving || !isAdmin}
                                  onChange={(e) => {
                                    const next = autoCampaignRules.map((r) =>
                                      r.id === rule.id
                                        ? { ...r, campaignId: e.target.value }
                                        : r,
                                    );
                                    setAutoCampaignRules(next);
                                    removeSavedStatus();
                                  }}
                                  style={{
                                    padding: "0.35rem 0.5rem",
                                    fontSize: "0.8rem",
                                    minWidth: 0,
                                  }}
                                >
                                  <option value="">Select campaign</option>
                                  {callifiedCampaigns.map((c) => (
                                    <option key={c.id} value={String(c.id)}>
                                      {c.name || `Campaign ${c.id}`}
                                    </option>
                                  ))}
                                </select>
                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "0.4rem",
                                  }}
                                >
                                  <button
                                    type="button"
                                    disabled={
                                      !ruleIsValid ||
                                      autoCampaignRulesSaving ||
                                      !isAdmin
                                    }
                                    onClick={() => {
                                      saveAutoCampaignRules({
                                        enabled: autoCampaignRulesEnabled,
                                        rules: autoCampaignRules,
                                        markSavedId: rule.id,
                                      });
                                    }}
                                    style={{
                                      padding: "0.35rem 0.6rem",
                                      borderRadius: 6,
                                      border: "1px solid var(--border-color)",
                                      background: "var(--surface)",
                                      color: "var(--text-primary)",
                                      fontSize: "0.75rem",
                                      cursor:
                                        isAdmin &&
                                        ruleIsValid &&
                                        !autoCampaignRulesSaving
                                          ? "pointer"
                                          : "not-allowed",
                                      opacity: ruleIsValid ? 1 : 0.5,
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    Save
                                  </button>
                                  {ruleIsSaved && (
                                    <span
                                      title="Saved"
                                      style={{
                                        width: 8,
                                        height: 8,
                                        borderRadius: "50%",
                                        background:
                                          "var(--success-color, #22c55e)",
                                        flexShrink: 0,
                                      }}
                                    />
                                  )}
                                </div>
                                <button
                                  type="button"
                                  disabled={autoCampaignRulesSaving || !isAdmin}
                                  onClick={() => {
                                    const next = autoCampaignRules.filter(
                                      (r) => r.id !== rule.id,
                                    );
                                    setAutoCampaignRules(next);
                                    setSavedAutoCampaignRuleIds((prev) => {
                                      const s = new Set(prev);
                                      s.delete(rule.id);
                                      return s;
                                    });
                                    saveAutoCampaignRules({
                                      enabled: autoCampaignRulesEnabled,
                                      rules: next,
                                    });
                                  }}
                                  style={{
                                    background: "none",
                                    border: "none",
                                    color: "var(--danger-color, #ef4444)",
                                    cursor: isAdmin ? "pointer" : "not-allowed",
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    padding: "0.25rem",
                                  }}
                                  title="Remove rule"
                                >
                                  <Trash2 size={16} />
                                </button>
                              </div>
                            );
                          })}

                          <button
                            type="button"
                            disabled={autoCampaignRulesSaving || !isAdmin}
                            onClick={() => {
                              const next = [
                                ...autoCampaignRules,
                                {
                                  id: `rule-${Date.now()}`,
                                  enabled: true,
                                  column: "",
                                  value: "",
                                  campaignId: "",
                                },
                              ];
                              setAutoCampaignRules(next);
                            }}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              justifyContent: "center",
                              gap: "0.35rem",
                              marginTop: "0.5rem",
                              padding: "0.45rem 0.75rem",
                              borderRadius: 6,
                              border: "1px dashed var(--border-color)",
                              background: "transparent",
                              color: "var(--text-secondary)",
                              cursor: isAdmin ? "pointer" : "not-allowed",
                              fontSize: "0.8rem",
                              alignSelf: "flex-start",
                            }}
                          >
                            <Plus size={14} /> Add rule
                          </button>

                          {!isAdmin && (
                            <div
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--text-secondary)",
                                marginTop: "0.5rem",
                              }}
                            >
                              Only admins can change auto-assign rules.
                            </div>
                          )}
                        </div>
                      )}

                      {autoCampaignRulesSaving && (
                        <div
                          style={{
                            fontSize: "0.75rem",
                            color: "var(--text-secondary)",
                            marginTop: "0.75rem",
                          }}
                        >
                          Saving…
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* Multi-select campaign dropdown for bulk dial. */}
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  className="input-field"
                  onClick={() => setCampaignDropdownOpen((o) => !o)}
                  disabled={callQueueActive}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.4rem",
                    minWidth: "200px",
                    fontSize: "0.85rem",
                    cursor: "pointer",
                  }}
                >
                  <Filter size={14} />
                  {selectedCampaignIds.length === 0
                    ? "Select campaigns to dial"
                    : `${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? "" : "s"} selected`}
                </button>
                {campaignDropdownOpen && (
                  <>
                    <div
                      style={{ position: "fixed", inset: 0, zIndex: 50 }}
                      onClick={() => setCampaignDropdownOpen(false)}
                    />
                    <div
                      className="card"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        right: 0,
                        zIndex: 51,
                        minWidth: 260,
                        maxHeight: 320,
                        overflowY: "auto",
                        padding: "0.5rem",
                        background: "var(--bg-color)",
                        border: "1px solid var(--border-color)",
                        boxShadow: "0 10px 24px rgba(0,0,0,0.2)",
                      }}
                    >
                      {callifiedCampaigns.length === 0 ? (
                        <div
                          style={{
                            padding: "0.5rem",
                            fontSize: "0.85rem",
                            color: "var(--text-secondary)",
                          }}
                        >
                          No campaigns
                        </div>
                      ) : (
                        callifiedCampaigns.map((c) => (
                          <label
                            key={c.id}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              padding: "0.4rem 0.5rem",
                              fontSize: "0.85rem",
                              cursor: "pointer",
                              borderRadius: 6,
                            }}
                            className="table-row-hover"
                          >
                            <input
                              type="checkbox"
                              checked={selectedCampaignIds.includes(
                                String(c.id),
                              )}
                              onChange={() => {
                                setSelectedCampaignIds((prev) =>
                                  prev.includes(String(c.id))
                                    ? prev.filter((id) => id !== String(c.id))
                                    : [...prev, String(c.id)],
                                );
                              }}
                            />
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {c.name || `Campaign ${c.id}`}
                            </span>
                            <span
                              style={{
                                fontSize: "0.75rem",
                                color: "var(--text-secondary)",
                              }}
                            >
                              {c.leadCount || 0}
                            </span>
                          </label>
                        ))
                      )}
                    </div>
                  </>
                )}
              </div>

              <button
                type="button"
                className="btn-primary"
                onClick={handleDialSelectedCampaigns}
                disabled={callQueueActive || selectedCampaignIds.length === 0}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.85rem",
                }}
              >
                {callQueueActive ? (
                  <>
                    <RefreshCw
                      size={14}
                      style={{ animation: "spin 1s linear infinite" }}
                    />{" "}
                    Dialling…
                  </>
                ) : (
                  <>
                    <Phone size={14} /> Dial Campaigns
                  </>
                )}
              </button>

              <button
                type="button"
                className="btn-secondary"
                onClick={() => setCallStatusDrawerOpen(true)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.85rem",
                }}
              >
                <Phone size={14} /> Call Status
              </button>
            </>
          )}

          {isGeneric && selectedLeads.length > 0 && (
            <button
              type="button"
              className="btn-primary"
              onClick={handleDialSelectedLeads}
              disabled={callQueueActive}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.35rem",
                fontSize: "0.85rem",
              }}
            >
              {callQueueActive ? (
                <>
                  <RefreshCw
                    size={14}
                    style={{ animation: "spin 1s linear infinite" }}
                  />{" "}
                  Dialling…
                </>
              ) : (
                <>
                  <Phone size={14} /> Dial Selected ({selectedLeads.length})
                </>
              )}
            </button>
          )}

          {isGeneric && selectedLeads.length > 0 && callifiedConfigured && (
            <div style={{ position: "relative" }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setBulkCampaignDropdownOpen((o) => !o)}
                disabled={bulkCampaignSaving}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.85rem",
                }}
              >
                <Filter size={14} />
                {bulkCampaignDropdownOpen ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                Assign Campaign ({selectedLeads.length})
              </button>
              {bulkCampaignDropdownOpen && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 50 }}
                    onClick={() => setBulkCampaignDropdownOpen(false)}
                  />
                  <div
                    className="card"
                    style={{
                      position: "absolute",
                      top: "calc(100% + 4px)",
                      right: 0,
                      zIndex: 51,
                      minWidth: 260,
                      maxHeight: 320,
                      overflowY: "auto",
                      padding: "0.5rem",
                      background: "var(--bg-color)",
                      border: "1px solid var(--border-color)",
                      boxShadow: "0 10px 24px rgba(0,0,0,0.2)",
                    }}
                  >
                    {callifiedCampaigns.length === 0 ? (
                      <div
                        style={{
                          padding: "0.5rem",
                          fontSize: "0.85rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        No campaigns
                      </div>
                    ) : (
                      <>
                        <div
                          style={{
                            padding: "0.4rem 0.5rem",
                            fontSize: "0.85rem",
                            cursor: "pointer",
                            borderRadius: 6,
                            color: "var(--text-secondary)",
                          }}
                          className="table-row-hover"
                          onClick={() => handleBulkAssignCampaign(null)}
                        >
                          No campaign
                        </div>
                        {callifiedCampaigns.map((c) => (
                          <div
                            key={c.id}
                            style={{
                              padding: "0.4rem 0.5rem",
                              fontSize: "0.85rem",
                              cursor: "pointer",
                              borderRadius: 6,
                            }}
                            className="table-row-hover"
                            onClick={() => handleBulkAssignCampaign(c.id)}
                          >
                            {c.name || `Campaign ${c.id}`}{" "}
                            {c.product_name ? `— ${c.product_name}` : ""}
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <button
            type="button"
            className="btn-primary"
            aria-label="Create a new lead"
            onClick={openCreate}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.45rem",
            }}
          >
            <Plus size={16} /> Create Lead
          </button>
        </div>
      </header>

      {/* Source chips row. */}
      <div
        className="card"
        style={{
          padding: "0.6rem 0.75rem",
          display: "flex",
          alignItems: "center",
          gap: "0.4rem",
          flexWrap: "wrap",
          marginBottom: "0.75rem",
        }}
      >
        <button
          type="button"
          onClick={() => {
            setSourceFilter("");
            setLeadsPage(0);
          }}
          style={!sourceFilter ? chipActiveStyle : chipStyle}
        >
          All <span style={chipCountStyle}>{leads.length}</span>
        </button>
        {sourceFilterOptions.map((opt) => (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              setSourceFilter(opt.value);
              setLeadsPage(0);
            }}
            style={sourceFilter === opt.value ? chipActiveStyle : chipStyle}
          >
            {opt.label}{" "}
            <span style={chipCountStyle}>{sourceCounts[opt.value] || 0}</span>
          </button>
        ))}
      </div>

      {/* Filters panel for generic CRM. */}
      {isGeneric && (
        <div
          className="card"
          style={{
            padding: "0.75rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
          }}
        >
          <SlidersHorizontal
            size={16}
            style={{ color: "var(--text-secondary)" }}
          />
          <select
            className="input-field"
            value={campaignFilter}
            onChange={(e) => {
              setCampaignFilter(e.target.value);
              setLeadsPage(0);
            }}
            style={{ width: "auto", minWidth: 160, fontSize: "0.85rem" }}
            aria-label="Filter by campaign"
          >
            <option value="">All campaigns</option>
            {callifiedCampaigns.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name || `Campaign ${c.id}`}
              </option>
            ))}
          </select>
          <select
            className="input-field"
            value={leadStatusFilter}
            onChange={(e) => {
              setLeadStatusFilter(e.target.value);
              setLeadsPage(0);
            }}
            style={{ width: "auto", minWidth: 140, fontSize: "0.85rem" }}
            aria-label="Filter by call status"
          >
            <option value="">All statuses</option>
            {CALL_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="input-field"
            value={assigneeFilter}
            onChange={(e) => {
              setAssigneeFilter(e.target.value);
              setLeadsPage(0);
            }}
            style={{ width: "auto", minWidth: 150, fontSize: "0.85rem" }}
            aria-label="Filter by assignee"
          >
            <option value="">Staff</option>
            <option value="unassigned">Unassigned</option>
            {staff.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.name || s.email}
              </option>
            ))}
          </select>
          <FilterPanel
            fieldsUrl="/api/contacts/filter-fields?status=Lead"
            valuesUrl={(field) =>
              `/api/contacts/filter-values/${field}?status=Lead`
            }
            filters={advancedFilters}
            onChange={setAdvancedFilters}
          />
          <button
            type="button"
            onClick={resetFilters}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--accent-color)",
              cursor: "pointer",
              fontSize: "0.85rem",
              display: "inline-flex",
              alignItems: "center",
              gap: "0.25rem",
            }}
          >
            <RefreshCw size={13} /> Reset filters
          </button>
          <span
            style={{
              marginLeft: "auto",
              color: "var(--text-secondary)",
              fontSize: "0.8125rem",
            }}
          >
            {filteredLeads.length} leads
          </span>
        </div>
      )}

      {isTravel && (
        <div
          className="card"
          style={{
            padding: "0.75rem 1rem",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            flexWrap: "wrap",
            marginBottom: "0.75rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              flexWrap: "wrap",
            }}
          >
            <Filter size={15} style={{ color: "var(--text-secondary)" }} />
            <select
              className="input-field"
              value={subBrandFilter}
              onChange={(e) => {
                setSubBrandFilter(e.target.value);
                setLeadsPage(0);
              }}
              aria-label="Filter by sub-brand"
              style={{ width: "auto", minWidth: 140 }}
            >
              <option value="">All sub-brands</option>
              {travelSubBrandOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
            <select
              className="input-field"
              value={stageFilter}
              onChange={(e) => {
                setStageFilter(e.target.value);
                setLeadsPage(0);
              }}
              aria-label="Filter by stage"
              style={{ width: "auto", minWidth: 160 }}
            >
              <option value="">All stages</option>
              {travelStageOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          <span
            style={{ color: "var(--text-secondary)", fontSize: "0.8125rem" }}
          >
            {filteredLeads.length} leads
          </span>
        </div>
      )}

      {callQueueActive && (
        <div
          className="card"
          style={{
            padding: "0.75rem 1rem",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "0.75rem",
            flexWrap: "wrap",
          }}
        >
          <RefreshCw
            size={16}
            style={{
              animation: "spin 1s linear infinite",
              color: "var(--accent-color)",
              flexShrink: 0,
            }}
          />
          <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>
            Call queue
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              flexWrap: "wrap",
            }}
          >
            {callQueue.map((it, idx) => {
              const isActive =
                it.status === "calling" ||
                it.status === "waiting_for_completion";
              const label =
                it.status === "completed"
                  ? " — completed"
                  : it.status === "failed"
                    ? ` — ${it.error || "failed"}`
                    : it.status === "calling"
                      ? " — calling…"
                      : it.status === "waiting_for_completion"
                        ? " — on call / wrapping up…"
                        : " — pending";
              return (
                <span
                  key={idx}
                  style={{
                    padding: "0.2rem 0.5rem",
                    borderRadius: "999px",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    background:
                      it.status === "completed"
                        ? "rgba(16,185,129,0.12)"
                        : it.status === "failed"
                          ? "rgba(239,68,68,0.12)"
                          : isActive
                            ? "rgba(245,158,11,0.12)"
                            : "var(--surface-hover)",
                    color:
                      it.status === "completed"
                        ? "var(--success-color)"
                        : it.status === "failed"
                          ? "#ef4444"
                          : isActive
                            ? "var(--warning-color)"
                            : "var(--text-secondary)",
                  }}
                >
                  {it.lead.name || it.lead.phone || `Lead ${idx + 1}`}
                  {label}
                </span>
              );
            })}
          </div>
          <span
            style={{
              marginLeft: "auto",
              fontSize: "0.8125rem",
              color: "var(--text-secondary)",
              whiteSpace: "nowrap",
            }}
          >
            {
              callQueue.filter(
                (it) => it.status === "completed" || it.status === "failed",
              ).length
            }{" "}
            / {callQueue.length} done
          </span>
        </div>
      )}

      <div
        className="card"
        style={{ overflow: "hidden", maxHeight: "unset", minHeight: "auto" }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "0.75rem",
            flexWrap: "wrap",
            padding: "1rem",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          <div style={{ position: "relative", width: "min(100%, 300px)" }}>
            <Search
              size={18}
              style={{
                position: "absolute",
                left: "1rem",
                top: "50%",
                transform: "translateY(-50%)",
                color: "var(--text-secondary)",
              }}
            />
            <input
              type="search"
              className="input-field"
              placeholder="Search leads..."
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setLeadsPage(0);
              }}
              style={{
                paddingLeft: "2.5rem",
                backgroundColor: "var(--surface-hover)",
              }}
            />
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            {isGeneric && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  aria-label="Call settings"
                  title="Call settings"
                  onClick={(e) => {
                    e.stopPropagation();
                    setAiSettingsOpen((o) => !o);
                  }}
                  disabled={aiTranscriptSaving}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                  }}
                >
                  <Settings size={14} />
                  Call Settings
                </button>
                {aiSettingsOpen &&
                  createPortal(
                    <>
                      <div
                        style={{
                          position: "fixed",
                          inset: 0,
                          zIndex: 1100,
                          background: "rgba(0,0,0,0.45)",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          padding: "1rem",
                        }}
                        onClick={() => setAiSettingsOpen(false)}
                        aria-hidden="true"
                      />
                      <div
                        role="dialog"
                        aria-label="Call settings"
                        aria-modal="true"
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          position: "fixed",
                          top: "50%",
                          left: "50%",
                          transform: "translate(-50%, -50%)",
                          zIndex: 1101,
                          width: "min(90vw, 420px)",
                          maxHeight: "85vh",
                          overflowY: "auto",
                          background: "var(--bg-color)",
                          border: "1px solid var(--border-color)",
                          borderRadius: "12px",
                          boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
                          padding: "1.25rem",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            marginBottom: "1rem",
                          }}
                        >
                          <h3
                            style={{
                              margin: 0,
                              fontSize: "1rem",
                              color: "var(--text-primary)",
                            }}
                          >
                            Call Settings
                          </h3>
                          <button
                            type="button"
                            onClick={() => setAiSettingsOpen(false)}
                            aria-label="Close call settings"
                            style={{
                              background: "none",
                              border: "none",
                              color: "var(--text-secondary)",
                              cursor: "pointer",
                              padding: "0.25rem",
                              display: "inline-flex",
                            }}
                          >
                            <X size={18} />
                          </button>
                        </div>

                        {/* 1. Auto Dial New Leads */}
                        <div style={{ marginBottom: "1rem" }}>
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              marginBottom: "0.5rem",
                            }}
                          >
                            Auto Dial New Leads
                          </div>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              cursor: isAdmin ? "pointer" : "not-allowed",
                              fontSize: "0.85rem",
                              color: "var(--text-primary)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={autoDialNewLeadsEnabled}
                              disabled={autoDialNewLeadsSaving || !isAdmin}
                              onChange={(e) => {
                                saveAutoDialNewLeadsEnabled(e.target.checked);
                              }}
                            />
                            Enable automatic dialing for new leads
                          </label>
                        </div>

                        <div
                          style={{
                            height: "1px",
                            background: "var(--border-color)",
                            margin: "0.75rem 0",
                          }}
                        />

                        {/* 2. DNP Settings */}
                        <div style={{ marginBottom: "1rem" }}>
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              marginBottom: "0.5rem",
                            }}
                          >
                            DNP Settings
                          </div>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              cursor: isAdmin ? "pointer" : "not-allowed",
                              fontSize: "0.85rem",
                              color: "var(--text-primary)",
                              marginBottom: "0.75rem",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={dnpRetryEnabled}
                              disabled={
                                dnpSettingsLoading ||
                                dnpSettingsSaving.enabled ||
                                !isAdmin
                              }
                              onChange={(e) => {
                                saveDnpRetryEnabled(e.target.checked);
                              }}
                            />
                            Enable automatic DNP retries
                          </label>

                          {dnpRetryEnabled && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.75rem",
                              }}
                            >
                              <div>
                                <label
                                  htmlFor="dnp-max-retries"
                                  style={{
                                    display: "block",
                                    fontSize: "0.8rem",
                                    color: "var(--text-secondary)",
                                    marginBottom: "0.35rem",
                                  }}
                                >
                                  Max retries
                                </label>
                                <input
                                  id="dnp-max-retries"
                                  type="number"
                                  min={1}
                                  max={10}
                                  value={dnpMaxRetries}
                                  disabled={
                                    dnpSettingsLoading ||
                                    dnpSettingsSaving.maxRetries ||
                                    !isAdmin
                                  }
                                  onChange={(e) => {
                                    setDnpMaxRetries(Number(e.target.value));
                                  }}
                                  onBlur={(e) => {
                                    saveDnpMaxRetries(Number(e.target.value));
                                  }}
                                  style={{
                                    width: "70px",
                                    padding: "0.35rem 0.5rem",
                                    borderRadius: "6px",
                                    border: "1px solid var(--border-color)",
                                    background: "var(--surface)",
                                    color: "var(--text-primary)",
                                  }}
                                />
                              </div>

                              <div>
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    marginBottom: "0.35rem",
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: "0.8rem",
                                      color: "var(--text-secondary)",
                                    }}
                                  >
                                    Retry interval
                                  </span>
                                  <span
                                    style={{
                                      fontSize: "0.8rem",
                                      fontWeight: 600,
                                      color: "var(--text-primary)",
                                    }}
                                  >
                                    Retry after {dnpIntervalHours}h{" "}
                                    {dnpIntervalMins}m
                                  </span>
                                </div>

                                <div
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "0.75rem",
                                  }}
                                >
                                  <div>
                                    <label
                                      htmlFor="dnp-interval-hours"
                                      style={{
                                        display: "block",
                                        fontSize: "0.75rem",
                                        color: "var(--text-secondary)",
                                        marginBottom: "0.2rem",
                                      }}
                                    >
                                      Hours
                                    </label>
                                    <input
                                      id="dnp-interval-hours"
                                      type="number"
                                      min={0}
                                      max={24}
                                      step={1}
                                      value={dnpIntervalHours}
                                      disabled={
                                        dnpSettingsLoading ||
                                        dnpSettingsSaving.interval ||
                                        !isAdmin
                                      }
                                      onChange={(e) => {
                                        const hours = Math.max(
                                          0,
                                          Math.min(
                                            24,
                                            Number(e.target.value) || 0,
                                          ),
                                        );
                                        const minutes =
                                          hours === 0
                                            ? Math.max(5, dnpIntervalMins)
                                            : hours === 24
                                              ? 0
                                              : dnpIntervalMins;
                                        const nextMinutes =
                                          hours * 60 + minutes;
                                        setDnpIntervalMinutes(nextMinutes);
                                        saveDnpIntervalMinutes(nextMinutes);
                                      }}
                                      style={{
                                        width: "70px",
                                        padding: "0.35rem 0.5rem",
                                        borderRadius: "6px",
                                        border: "1px solid var(--border-color)",
                                        background: "var(--surface)",
                                        color: "var(--text-primary)",
                                      }}
                                    />
                                  </div>

                                  <div>
                                    <label
                                      htmlFor="dnp-interval-minutes"
                                      style={{
                                        display: "block",
                                        fontSize: "0.75rem",
                                        color: "var(--text-secondary)",
                                        marginBottom: "0.2rem",
                                      }}
                                    >
                                      Minutes
                                    </label>
                                    <input
                                      id="dnp-interval-minutes"
                                      type="number"
                                      min={dnpIntervalHours === 0 ? 5 : 0}
                                      max={59}
                                      step={1}
                                      value={dnpIntervalMins}
                                      disabled={
                                        dnpSettingsLoading ||
                                        dnpSettingsSaving.interval ||
                                        !isAdmin ||
                                        dnpIntervalHours === 24
                                      }
                                      onChange={(e) => {
                                        const minutes =
                                          dnpIntervalHours === 0
                                            ? Math.max(
                                                5,
                                                Math.min(
                                                  59,
                                                  Number(e.target.value) || 0,
                                                ),
                                              )
                                            : Math.max(
                                                0,
                                                Math.min(
                                                  59,
                                                  Number(e.target.value) || 0,
                                                ),
                                              );
                                        const nextMinutes =
                                          dnpIntervalHours * 60 + minutes;
                                        setDnpIntervalMinutes(nextMinutes);
                                        saveDnpIntervalMinutes(nextMinutes);
                                      }}
                                      style={{
                                        width: "70px",
                                        padding: "0.35rem 0.5rem",
                                        borderRadius: "6px",
                                        border: "1px solid var(--border-color)",
                                        background: "var(--surface)",
                                        color: "var(--text-primary)",
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>

                        <div
                          style={{
                            height: "1px",
                            background: "var(--border-color)",
                            margin: "0.75rem 0",
                          }}
                        />

                        {/* 3. Assigning Staff */}
                        <div style={{ marginBottom: "1rem" }}>
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              marginBottom: "0.5rem",
                            }}
                          >
                            Assigning Staff
                          </div>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              cursor: isAdmin ? "pointer" : "not-allowed",
                              fontSize: "0.85rem",
                              color: "var(--text-primary)",
                              marginBottom: "0.75rem",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={assignStaffEnabled}
                              disabled={
                                assignSettingsLoading ||
                                assignSettingsSaving.enabled ||
                                !isAdmin
                              }
                              onChange={(e) => {
                                saveAssignStaffEnabled(e.target.checked);
                              }}
                            />
                            Auto-assign qualified leads to staff
                          </label>

                          {assignStaffEnabled && (
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: "0.75rem",
                              }}
                            >
                              <div>
                                <label
                                  htmlFor="assign-staff-logic"
                                  style={{
                                    display: "block",
                                    fontSize: "0.8rem",
                                    color: "var(--text-secondary)",
                                    marginBottom: "0.35rem",
                                  }}
                                >
                                  Assign logic
                                </label>
                                <select
                                  id="assign-staff-logic"
                                  className="input-field"
                                  value={assignStaffLogic}
                                  disabled={
                                    assignSettingsLoading ||
                                    assignSettingsSaving.logic ||
                                    !isAdmin
                                  }
                                  onChange={(e) => {
                                    saveAssignStaffLogic(e.target.value);
                                  }}
                                  style={{
                                    padding: "0.35rem 0.5rem",
                                    borderRadius: "6px",
                                    fontSize: "0.85rem",
                                    minWidth: "160px",
                                    background: "var(--surface)",
                                    color: "var(--text-primary)",
                                  }}
                                >
                                  <option value="round_robin">
                                    Round robin
                                  </option>
                                  <option value="random">
                                    Randomly assign staff
                                  </option>
                                </select>
                              </div>

                              {assignStaffLogic === "round_robin" && (
                                <div>
                                  <label
                                    htmlFor="assign-staff-leads-per-user"
                                    style={{
                                      display: "block",
                                      fontSize: "0.8rem",
                                      color: "var(--text-secondary)",
                                      marginBottom: "0.35rem",
                                    }}
                                  >
                                    Leads per user before moving to next
                                  </label>
                                  <input
                                    id="assign-staff-leads-per-user"
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={assignStaffLeadsPerUser}
                                    disabled={
                                      assignSettingsLoading ||
                                      assignSettingsSaving.leadsPerUser ||
                                      !isAdmin
                                    }
                                    onChange={(e) => {
                                      setAssignStaffLeadsPerUser(
                                        Number(e.target.value),
                                      );
                                    }}
                                    onBlur={(e) => {
                                      saveAssignStaffLeadsPerUser(
                                        Number(e.target.value),
                                      );
                                    }}
                                    style={{
                                      width: "70px",
                                      padding: "0.35rem 0.5rem",
                                      borderRadius: "6px",
                                      border: "1px solid var(--border-color)",
                                      background: "var(--surface)",
                                      color: "var(--text-primary)",
                                    }}
                                  />
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        <div
                          style={{
                            height: "1px",
                            background: "var(--border-color)",
                            margin: "0.75rem 0",
                          }}
                        />

                        {/* 4. Qualified Status */}
                        <div>
                          <div
                            style={{
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              color: "var(--text-secondary)",
                              textTransform: "uppercase",
                              letterSpacing: "0.03em",
                              marginBottom: "0.5rem",
                            }}
                          >
                            Qualified Status
                          </div>
                          <label
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "0.5rem",
                              cursor: isAdmin ? "pointer" : "not-allowed",
                              fontSize: "0.85rem",
                              color: "var(--text-primary)",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={aiTranscriptEnabled}
                              disabled={aiTranscriptSaving || !isAdmin}
                              onChange={(e) => {
                                saveAiTranscriptEnabled(e.target.checked);
                              }}
                            />
                            Use AI to qualify using transcripts
                          </label>
                        </div>

                        {!isAdmin && (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: "var(--text-secondary)",
                              marginTop: "0.75rem",
                            }}
                          >
                            Only admins can change these settings.
                          </div>
                        )}
                      </div>
                    </>,
                    document.body,
                  )}
              </>
            )}
            {!isWellness && !isTravel && (
              <ColumnPicker
                tableKey="leads"
                onColumnsChange={setVisibleColumns}
              />
            )}
            {isAdmin && selectedLeads.length > 0 && (
              <>
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  {selectedLeads.length} lead
                  {selectedLeads.length === 1 ? "" : "s"} selected
                </span>
                <select
                  className="input-field"
                  value={bulkAgent}
                  onChange={(e) => setBulkAgent(e.target.value)}
                  style={{ width: "auto", minWidth: 150 }}
                >
                  <option value="">Unassign</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.email}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleBulkAssign}
                >
                  Assign
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedLeads([]);
                    setBulkAgent("");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--accent-color)",
                    cursor: "pointer",
                    fontSize: "0.85rem",
                  }}
                >
                  Clear
                </button>
              </>
            )}
          </div>
        </div>
        <TopScrollSync forceScrollbar>
          <table
            className={
              isTravel
                ? "leads-table leads-table--fit"
                : isGeneric
                  ? "leads-table leads-table--compact"
                  : "leads-table"
            }
            style={{
              width: "100%",
              borderCollapse: "collapse",
              textAlign: "left",
              minWidth: leadsTableMinWidth,
              tableLayout: isTravel ? "fixed" : "auto",
            }}
          >
            {isTravel && (
              <colgroup>
                {isAdmin && <col style={{ width: "2.5%" }} />}
                <col style={{ width: "10.5%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "8.5%" }} />
                <col style={{ width: "6.5%" }} />
                <col style={{ width: "8.5%" }} />
                <col style={{ width: "6.5%" }} />
                <col style={{ width: "7.5%" }} />
                <col style={{ width: "7.5%" }} />
                <col style={{ width: "5%" }} />
                <col style={{ width: "8%" }} />
              </colgroup>
            )}
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid var(--border-color)",
                  backgroundColor: "var(--table-header-bg)",
                }}
              >
                {isAdmin && (
                  <th style={{ padding: "1rem", width: "40px" }}>
                    <input
                      type="checkbox"
                      checked={
                        selectedLeads.length === filteredLeads.length &&
                        filteredLeads.length > 0
                      }
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer" }}
                    />
                  </th>
                )}
                <th
                  style={{
                    padding: "1rem",
                    color: "var(--text-secondary)",
                    fontWeight: "500",
                    fontSize: "0.875rem",
                  }}
                >
                  Name
                </th>
                {isColVisible("email") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Email
                  </th>
                )}
                {isColVisible("company") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    {isTravel ? "Category" : "Company"}
                  </th>
                )}
                {isColVisible("phone") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Phone
                  </th>
                )}
                {isColVisible("aiScore") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Lead Score
                  </th>
                )}
                {isColVisible("source") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Source
                  </th>
                )}
                {isGeneric && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                      minWidth: "180px",
                    }}
                  >
                    Callified Campaign
                  </th>
                )}
                {isGeneric && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                      minWidth: "140px",
                    }}
                  >
                    Call Status
                  </th>
                )}
                {isGeneric && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                      width: "110px",
                    }}
                  >
                    Callified AI call
                  </th>
                )}
                {isGeneric && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                      width: "100px",
                    }}
                  >
                    Callified Score
                  </th>
                )}
                {isTravel && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Sub-brand
                  </th>
                )}
                {isTravel && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Amount
                  </th>
                )}
                {customFieldDefs
                  .filter((f) => isColVisible(`cf_${f.fieldKey}`))
                  .map((f) => (
                    <th
                      key={f.id}
                      className="leads-custom-field-col"
                      style={{
                        padding: "1rem",
                        color: "var(--text-secondary)",
                        fontWeight: "500",
                        fontSize: "0.875rem",
                      }}
                    >
                      <span className="leads-custom-field-label">
                        {f.label}
                      </span>
                    </th>
                  ))}
                {isColVisible("assignedTo") && (
                  <th
                    className="leads-assigned-col"
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Assigned To
                  </th>
                )}
                {isColVisible("createdAt") && (
                  <th
                    style={{
                      padding: "1rem",
                      color: "var(--text-secondary)",
                      fontWeight: "500",
                      fontSize: "0.875rem",
                    }}
                  >
                    Created
                  </th>
                )}
                <th
                  style={{
                    padding: "1rem 0.5rem",
                    color: "var(--text-secondary)",
                    fontWeight: "500",
                    fontSize: "0.875rem",
                    whiteSpace: "nowrap",
                  }}
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={leadsColSpan}
                    style={{
                      padding: "2rem",
                      textAlign: "center",
                      color: "var(--text-secondary)",
                    }}
                  >
                    Loading leads...
                  </td>
                </tr>
              ) : filteredLeads.length === 0 ? (
                <tr>
                  <td
                    colSpan={leadsColSpan}
                    style={{
                      padding: "2rem",
                      textAlign: "center",
                      color: "var(--text-secondary)",
                    }}
                  >
                    No leads found
                  </td>
                </tr>
              ) : (
                paginatedLeads.map((lead) => (
                  <tr
                    key={lead.id}
                    style={{
                      borderBottom: "1px solid var(--border-color)",
                      cursor: "pointer",
                    }}
                    className="table-row-hover"
                    onClick={() => navigate(leadDetailPath(lead))}
                    title="Open lead detail"
                  >
                    {isAdmin && (
                      <td
                        style={{ padding: "1rem" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selectedLeads.includes(lead.id)}
                          onChange={() => toggleSelect(lead.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                    )}
                    <td style={{ padding: "1rem", fontWeight: "500" }}>
                      {lead.name}
                    </td>
                    {isColVisible("email") && (
                      <td
                        style={{
                          padding: "1rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {lead.email}
                      </td>
                    )}
                    {isColVisible("company") && (
                      <td
                        style={{
                          padding: "1rem",
                          color: "var(--text-secondary)",
                        }}
                      >
                        {lead.company || (
                          <span style={{ color: "var(--border-color)" }}>
                            -
                          </span>
                        )}
                      </td>
                    )}
                    {isColVisible("phone") && (
                      <td
                        style={{
                          padding: "1rem",
                          color: "var(--text-secondary)",
                          fontSize: "0.875rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lead.phone || (
                          <span style={{ color: "var(--border-color)" }}>
                            -
                          </span>
                        )}
                      </td>
                    )}
                    {isColVisible("aiScore") && (
                      <td style={{ padding: "1rem" }}>
                        <span
                          style={{
                            padding: "0.25rem 0.75rem",
                            borderRadius: "999px",
                            fontSize: "0.75rem",
                            fontWeight: "bold",
                            backgroundColor:
                              lead.aiScore > 75
                                ? "rgba(16, 185, 129, 0.1)"
                                : lead.aiScore > 40
                                  ? "rgba(245, 158, 11, 0.1)"
                                  : "rgba(239, 68, 68, 0.1)",
                            color:
                              lead.aiScore > 75
                                ? "var(--success-color)"
                                : lead.aiScore > 40
                                  ? "var(--warning-color)"
                                  : "#ef4444",
                          }}
                        >
                          {lead.aiScore}/100
                        </span>
                      </td>
                    )}
                    {isColVisible("source") && (
                      <td style={{ padding: "1rem" }}>
                        <span style={sourceBadgeStyle}>
                          {leadSourceLabel(lead)}
                        </span>
                      </td>
                    )}
                    {isGeneric && (
                      <td
                        style={{ padding: "1rem" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <select
                          className="input-field"
                          value={
                            lead.callifiedCampaignId
                              ? String(lead.callifiedCampaignId)
                              : ""
                          }
                          onChange={(e) =>
                            handleCampaignChange(lead, e.target.value)
                          }
                          disabled={!callifiedConfigured}
                          style={{
                            minWidth: "160px",
                            padding: "0.4rem 0.6rem",
                            fontSize: "0.8125rem",
                          }}
                          aria-label={`Assign Callified campaign for ${lead.name || "lead"}`}
                        >
                          <option value="">—</option>
                          {callifiedCampaigns.map((c) => (
                            <option key={c.id} value={String(c.id)}>
                              {c.name || `Campaign ${c.id}`}
                              {c.product_name ? ` — ${c.product_name}` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                    )}
                    {isGeneric && (
                      <td
                        style={{ padding: "1rem", whiteSpace: "nowrap" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const queueItem = callQueue.find(
                            (q) => q.lead.id === lead.id,
                          );
                          const isConnected =
                            queueItem &&
                            (queueItem.status === "calling" ||
                              queueItem.status === "waiting_for_completion");
                          if (isConnected) {
                            return (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  padding: "0.25rem 0.75rem",
                                  borderRadius: "999px",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  background: "rgba(16, 185, 129, 0.15)",
                                  color: "#10b981",
                                }}
                              >
                                <RefreshCw
                                  size={12}
                                  style={{
                                    animation: "spin 1s linear infinite",
                                  }}
                                />{" "}
                                Connected
                              </span>
                            );
                          }
                          if (classifyingLeads.has(lead.id)) {
                            return (
                              <span
                                style={{
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: "0.35rem",
                                  padding: "0.25rem 0.75rem",
                                  borderRadius: "999px",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  background: "var(--surface-hover)",
                                  color: "var(--text-secondary)",
                                }}
                              >
                                <RefreshCw
                                  size={12}
                                  style={{
                                    animation: "spin 1s linear infinite",
                                  }}
                                />{" "}
                                Classifying…
                              </span>
                            );
                          }
                          const meta = getCallStatusMeta(
                            lead.callifiedLeadStatus,
                          );
                          return (
                            <span
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.35rem",
                              }}
                            >
                              <select
                                className="input-field"
                                value={normalizeCallStatus(
                                  lead.callifiedLeadStatus,
                                )}
                                onChange={(e) =>
                                  handleLeadStatusChange(lead, e.target.value)
                                }
                                disabled={!callifiedConfigured}
                                style={{
                                  padding: "0.25rem 0.6rem",
                                  borderRadius: "999px",
                                  fontSize: "0.75rem",
                                  fontWeight: 600,
                                  border: "none",
                                  cursor: "pointer",
                                  minWidth: "90px",
                                  color: meta.color,
                                  backgroundColor: meta.bg,
                                }}
                                aria-label={`Call status for ${lead.name || "lead"}`}
                              >
                                {CALL_STATUS_OPTIONS.map((o) => (
                                  <option key={o.value} value={o.value}>
                                    {o.label}
                                  </option>
                                ))}
                              </select>
                              {lead.callifiedLeadStatus &&
                                normalizeCallStatus(
                                  lead.callifiedLeadStatus,
                                ) !== CALL_STATUS.YET_TO_CALL && (
                                  <span
                                    title={buildLeadStatusTooltip(lead, {
                                      maxRetries: dnpMaxRetries,
                                    })}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      justifyContent: "center",
                                      color: "var(--text-secondary)",
                                      cursor: "help",
                                      marginLeft: "0.25rem",
                                      flexShrink: 0,
                                    }}
                                  >
                                    <Info size={14} />
                                  </span>
                                )}
                            </span>
                          );
                        })()}
                      </td>
                    )}
                    {isGeneric && (
                      <td
                        style={{ padding: "1rem", whiteSpace: "nowrap" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => {
                            if (!callifiedConfigured) {
                              notify.info(
                                "Configure Callified in Settings → Integrations to make AI calls",
                              );
                              return;
                            }
                            handleSingleDial(lead, lead.callifiedCampaignId);
                          }}
                          title={
                            callifiedConfigured
                              ? `Call ${lead.name || "lead"} via AI`
                              : "Configure Callified settings"
                          }
                          style={{
                            ...actionIconBtn,
                            color: callifiedConfigured
                              ? "var(--success-color)"
                              : "var(--text-secondary)",
                            opacity: callifiedConfigured ? 1 : 0.6,
                            position: "relative",
                          }}
                        >
                          <Phone size={15} />
                          {(() => {
                            const count =
                              callifiedSummaries[lead.id]?.callCount || 0;
                            if (count <= 0) return null;
                            return (
                              <span
                                style={{
                                  position: "absolute",
                                  top: -6,
                                  right: -6,
                                  minWidth: "18px",
                                  height: "18px",
                                  padding: "0 4px",
                                  borderRadius: "999px",
                                  background: "var(--accent-color)",
                                  color: "#fff",
                                  fontSize: "0.65rem",
                                  fontWeight: 700,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  justifyContent: "center",
                                  border: "2px solid var(--bg-color)",
                                }}
                              >
                                {count > 99 ? "99+" : count}
                              </span>
                            );
                          })()}
                        </button>
                        <button
                          onClick={() => {
                            if (!callifiedConfigured) {
                              notify.info(
                                "Configure Callified in Settings → Integrations to view call details",
                              );
                              return;
                            }
                            setCallifiedDetailsLead(lead);
                          }}
                          title={
                            callifiedConfigured
                              ? `View Callified call details for ${lead.name || "lead"}`
                              : "Configure Callified settings"
                          }
                          style={{
                            ...actionIconBtn,
                            marginLeft: 6,
                            color: callifiedConfigured
                              ? "var(--accent-color)"
                              : "var(--text-secondary)",
                            opacity: callifiedConfigured ? 1 : 0.6,
                          }}
                        >
                          <FileText size={15} />
                        </button>
                      </td>
                    )}
                    {isGeneric && (
                      <td
                        style={{ padding: "1rem" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const score = callifiedSummaries[lead.id]?.lastScore;
                          if (score == null) {
                            return (
                              <span
                                style={{
                                  color: "var(--text-secondary)",
                                  fontSize: "0.875rem",
                                }}
                              >
                                —
                              </span>
                            );
                          }
                          const color =
                            score >= 4
                              ? "var(--success-color)"
                              : score >= 3
                                ? "var(--warning-color)"
                                : "#ef4444";
                          const bg =
                            score >= 4
                              ? "rgba(16, 185, 129, 0.1)"
                              : score >= 3
                                ? "rgba(245, 158, 11, 0.1)"
                                : "rgba(239, 68, 68, 0.1)";
                          return (
                            <span
                              style={{
                                padding: "0.25rem 0.75rem",
                                borderRadius: "999px",
                                fontSize: "0.75rem",
                                fontWeight: "bold",
                                background: bg,
                                color,
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.15rem",
                              }}
                            >
                              {Array.from({ length: 5 }).map((_, i) => (
                                <span
                                  key={i}
                                  style={{ opacity: i < score ? 1 : 0.3 }}
                                >
                                  ★
                                </span>
                              ))}
                              <span style={{ marginLeft: 4 }}>{score}/5</span>
                            </span>
                          );
                        })()}
                      </td>
                    )}
                    {isTravel && (
                      <td
                        style={{
                          padding: "1rem",
                          color: "var(--text-secondary)",
                          fontSize: "0.875rem",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {lead.subBrand ? (
                          subBrandShortLabel(lead.subBrand)
                        ) : (
                          <span style={{ color: "var(--border-color)" }}>
                            -
                          </span>
                        )}
                      </td>
                    )}
                    {isTravel &&
                      (() => {
                        // 1. Itinerary advancePaidAmount (highest fidelity  set by sync/webhook)
                        const bv = bookingValueByContact[lead.id];
                        if (bv && bv.value > 0) {
                          return (
                            <td
                              style={{
                                padding: "1rem",
                                fontWeight: 500,
                                fontSize: "0.875rem",
                              }}
                              title="Amount paid"
                            >
                              {bv.currency || "INR"}{" "}
                              {Number(bv.value).toLocaleString()}
                            </td>
                          );
                        }
                        // 2. TMC instalment paid totals keyed by parent email  covers leads
                        // whose parent contact has no itinerary row (common for school trips).
                        const tmcEntry = tmcPaidByEmail[lead.email];
                        if (tmcEntry && tmcEntry.paidTotal > 0) {
                          return (
                            <td
                              style={{
                                padding: "1rem",
                                fontWeight: 500,
                                fontSize: "0.875rem",
                              }}
                              title="Amount paid"
                            >
                              {tmcEntry.currency || "INR"}{" "}
                              {Number(tmcEntry.paidTotal).toLocaleString()}
                            </td>
                          );
                        }
                        const deals = dealsByContact[lead.id] || [];
                        const total = deals.reduce(
                          (s, d) => s + (Number(d.amount) || 0),
                          0,
                        );
                        const currency = deals[0]?.currency || "INR";
                        return (
                          <td
                            style={{
                              padding: "1rem",
                              fontWeight: 500,
                              fontSize: "0.875rem",
                            }}
                          >
                            {total > 0 ? (
                              `${currency} ${total.toLocaleString()}`
                            ) : (
                              <span style={{ color: "var(--text-secondary)" }}>
                                -
                              </span>
                            )}
                          </td>
                        );
                      })()}
                    {/* Generic-vertical-only Lead custom fields  shows every
                      defined field's value, or a dash for leads that predate
                      the field (backend fills the key with null). Each
                      field's column is independently toggleable via the
                      "Customize table" picker (same cf_ prefix as the header).
                      Reuse the same inline cell editor as Contacts so empty
                      custom values can be added directly in the table. */}
                    {customFieldDefs
                      .filter((f) => isColVisible(`cf_${f.fieldKey}`))
                      .map((f) => {
                        const raw = lead.customFields?.[f.fieldKey];
                        return (
                          <td
                            key={f.id}
                            className="leads-custom-field-col"
                            style={{
                              padding: "0.75rem 1rem",
                              color: "var(--text-secondary)",
                              fontSize: "0.875rem",
                            }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <InlineCellEditor
                              contactId={lead.id}
                              field={f}
                              value={raw}
                              onSaved={(newValue) => {
                                setLeads((prev) =>
                                  prev.map((l) =>
                                    l.id === lead.id
                                      ? {
                                          ...l,
                                          customFields: {
                                            ...(l.customFields || {}),
                                            [f.fieldKey]: newValue,
                                          },
                                        }
                                      : l,
                                  ),
                                );
                              }}
                            />
                          </td>
                        );
                      })}
                    {isColVisible("assignedTo") && (
                      <td
                        className="leads-assigned-col"
                        style={{ padding: "1rem" }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isAdmin ? (
                          <select
                            className="input-field"
                            value={lead.assignedToId || ""}
                            onChange={(e) =>
                              handleAssign(lead.id, e.target.value)
                            }
                            style={{
                              padding: "0.375rem 0.5rem",
                              fontSize: "0.8rem",
                              minWidth: "130px",
                              background: "var(--input-bg)",
                            }}
                            aria-label={`Assign ${lead.name || "lead"} to staff`}
                          >
                            <option value="">Unassigned</option>
                            {staff.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name || s.email}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span
                            style={{
                              fontSize: "0.875rem",
                              color: lead.assignedToId
                                ? "var(--text-primary)"
                                : "var(--text-secondary)",
                            }}
                          >
                            {lead.assignedTo?.name ||
                              lead.assignedTo?.email ||
                              "Unassigned"}
                          </span>
                        )}
                      </td>
                    )}
                    {isColVisible("createdAt") && (
                      <td
                        style={{
                          padding: "1rem",
                          color: "var(--text-secondary)",
                          fontSize: "0.875rem",
                        }}
                      >
                        {formatDate(lead.createdAt)}
                      </td>
                    )}
                    <td
                      style={{
                        padding: "0.75rem 0.5rem",
                        whiteSpace: "nowrap",
                        minWidth: "88px",
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => openEdit(lead)}
                        title="Edit lead"
                        style={actionIconBtn}
                      >
                        <Pencil size={15} />
                      </button>
                      <button
                        onClick={() => handleConvert(lead.id)}
                        title="Convert to Prospect"
                        style={{
                          ...actionIconBtn,
                          color: "var(--success-color)",
                          marginLeft: 6,
                        }}
                      >
                        <ArrowRightCircle size={15} />
                      </button>
                      <button
                        onClick={() => handleDelete(lead)}
                        title="Delete lead"
                        style={{
                          ...actionIconBtn,
                          color: "var(--danger-color, #f43f5e)",
                          marginLeft: 6,
                        }}
                      >
                        <Trash2 size={15} />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TopScrollSync>
        {!loading && filteredLeads.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "0.75rem",
              flexWrap: "wrap",
              padding: "0.75rem 7.5rem 0.75rem 1rem",
              borderTop: "1px solid var(--border-color)",
              background: "var(--surface-color)",
              position: "relative",
              zIndex: 2,
            }}
          >
            <span
              style={{
                color: "var(--text-secondary)",
                fontSize: "0.8125rem",
                whiteSpace: "nowrap",
              }}
            >
              Showing {pageStart}-{pageEnd} of {filteredLeads.length}
            </span>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexWrap: "wrap",
              }}
            >
              <label
                htmlFor="leads-page-size"
                style={{
                  color: "var(--text-secondary)",
                  fontSize: "0.8125rem",
                }}
              >
                Rows
              </label>
              <select
                id="leads-page-size"
                value={leadsPageSize}
                onChange={(e) => {
                  setLeadsPageSize(Number(e.target.value));
                  setLeadsPage(0);
                }}
                className="input-field"
                style={{
                  width: "auto",
                  minWidth: "4.5rem",
                  padding: "0.35rem 0.5rem",
                  fontSize: "0.8125rem",
                }}
                aria-label="Rows per page"
              >
                {LEADS_PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
              <button
                type="button"
                title="Previous page"
                aria-label="Previous page"
                onClick={() => setLeadsPage(currentLeadsPage - 1)}
                disabled={currentLeadsPage === 0}
                style={{
                  ...actionIconBtn,
                  opacity: currentLeadsPage === 0 ? 0.45 : 1,
                }}
              >
                <ChevronLeft size={16} />
              </button>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  goToLeadsPage();
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                <label
                  htmlFor="leads-page-number"
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.8125rem",
                  }}
                >
                  Page
                </label>
                <input
                  id="leads-page-number"
                  type="number"
                  min="1"
                  max={leadsPageCount}
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value)}
                  onBlur={goToLeadsPage}
                  style={{
                    width: "3.5rem",
                    padding: "0.35rem 0.4rem",
                    textAlign: "center",
                    border: "1px solid var(--border-color)",
                    borderRadius: 6,
                    background: "var(--input-bg)",
                    color: "var(--text-primary)",
                  }}
                  aria-label="Page number"
                />
                <span
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.8125rem",
                  }}
                >
                  of {leadsPageCount}
                </span>
              </form>
              <button
                type="button"
                title="Next page"
                aria-label="Next page"
                onClick={() => setLeadsPage(currentLeadsPage + 1)}
                disabled={currentLeadsPage >= leadsPageCount - 1}
                style={{
                  ...actionIconBtn,
                  opacity: currentLeadsPage >= leadsPageCount - 1 ? 0.45 : 1,
                }}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* #892  Create Lead drawer. Mounted only when `creating` is true.
            Close triggers: X button, ESC keypress (handled by the useEffect
            above), and clicking on the dark overlay outside the drawer body.
            The form fields + submit handler are unchanged from the previous
            inline form  only the trigger surface moved. */}
      {creating && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) closeCreate();
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Create Lead"
        >
          <div
            className="card"
            style={{
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              width: "100%",
              maxWidth: 480,
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
                Create Lead
              </h3>
              <button
                type="button"
                onClick={closeCreate}
                aria-label="Close"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                <X size={18} />
              </button>
            </div>
            {/* #557: noValidate so the JS handler in handleCreateLead runs the
                  client-side validation (length caps, control-char rejection,
                  HTML strip, email shape). Native HTML5 validation would block
                  submit without giving us a chance to surface the targeted toasts. */}
            <form
              onSubmit={handleCreateLead}
              noValidate
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.875rem",
              }}
            >
              <input
                type="text"
                placeholder="Full Name"
                required
                maxLength={191}
                className="input-field"
                value={newLead.name}
                onChange={(e) => handleChange("name", e.target.value)}
              />
              <input
                type="email"
                placeholder="Email Address"
                required={!isWellness}
                maxLength={191}
                className="input-field"
                value={newLead.email}
                onChange={(e) => handleChange("email", e.target.value)}
              />
              <input
                type="text"
                placeholder={
                  isTravel
                    ? "Category (e.g. School Trip, Umrah, Family Holiday)"
                    : "Company"
                }
                maxLength={191}
                className="input-field"
                value={newLead.company}
                onChange={(e) => handleChange("company", e.target.value)}
              />
              {!isTravel && (
                <input
                  type="text"
                  placeholder="Job Title"
                  maxLength={200}
                  className="input-field"
                  value={newLead.title}
                  onChange={(e) => handleChange("title", e.target.value)}
                />
              )}
              {/* Phone field — required for wellness, optional for generic and travel. */}
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <select
                  className="input-field"
                  value={newLead.countryCode}
                  onChange={(e) => handleChange("countryCode", e.target.value)}
                  style={{ width: "100px" }}
                >
                  {COUNTRY_CODES.map((cc) => (
                    <option key={cc.code} value={cc.code}>
                      {cc.code}
                    </option>
                  ))}
                </select>
                <input
                  type="tel"
                  placeholder={
                    isWellness
                      ? "Phone (10-digit mobile, e.g. 9876543210)"
                      : "Phone (optional)"
                  }
                  required={isWellness}
                  className="input-field"
                  value={newLead.phone}
                  onChange={(e) => handleChange("phone", e.target.value)}
                  style={{ flex: 1 }}
                />
              </div>
              <select
                className="input-field"
                name="source"
                value={newLead.source}
                onChange={(e) => handleChange("source", e.target.value)}
              >
                {isWellness
                  ? WELLNESS_SOURCE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))
                  : isTravel
                    ? TRAVEL_SOURCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))
                    : SOURCE_OPTIONS.map((src) => (
                        <option key={src} value={src}>
                          {src}
                        </option>
                      ))}
              </select>

              {/* #600  wellness extras: treatment of interest (dropdown of
                    catalog services + a free-text "Other" fallback if the
                    catalogue is empty), preferred clinic, preferred
                    practitioner. All three persist on Contact and feed
                    marketing-attribution + lead-routing downstream. */}
              {isWellness && (
                <>
                  {services.length > 0 ? (
                    <select
                      className="input-field"
                      name="treatmentOfInterest"
                      value={newLead.treatmentOfInterest}
                      onChange={(e) =>
                        handleChange("treatmentOfInterest", e.target.value)
                      }
                    >
                      <option value="">Treatment of interest (optional)</option>
                      {services.map((svc) => (
                        <option key={svc.id} value={svc.name || svc.title}>
                          {svc.name || svc.title}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      name="treatmentOfInterest"
                      placeholder="Treatment of interest (optional)"
                      maxLength={191}
                      className="input-field"
                      value={newLead.treatmentOfInterest}
                      onChange={(e) =>
                        handleChange("treatmentOfInterest", e.target.value)
                      }
                    />
                  )}
                  {locations.length > 0 && (
                    <select
                      className="input-field"
                      name="preferredLocationId"
                      value={newLead.preferredLocationId}
                      onChange={(e) =>
                        handleChange("preferredLocationId", e.target.value)
                      }
                    >
                      <option value="">Preferred clinic (optional)</option>
                      {locations.map((loc) => (
                        <option key={loc.id} value={loc.id}>
                          {loc.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {staff.filter(
                    (s) => (s.wellnessRole || "").toLowerCase() === "doctor",
                  ).length > 0 && (
                    <select
                      className="input-field"
                      name="preferredPractitionerId"
                      value={newLead.preferredPractitionerId}
                      onChange={(e) =>
                        handleChange("preferredPractitionerId", e.target.value)
                      }
                    >
                      <option value="">
                        Preferred practitioner (optional)
                      </option>
                      {staff
                        .filter(
                          (s) =>
                            (s.wellnessRole || "").toLowerCase() === "doctor",
                        )
                        .map((doc) => (
                          <option key={doc.id} value={doc.id}>
                            {doc.name || doc.email}
                          </option>
                        ))}
                    </select>
                  )}
                </>
              )}

              {renderCustomFieldInputs(
                newLead.customFields,
                handleCustomFieldChangeNew,
              )}

              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                  marginTop: "0.5rem",
                }}
              >
                <button
                  type="button"
                  onClick={closeCreate}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: 6,
                    border: "1px solid var(--border-color)",
                    background: "var(--surface-color)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                >
                  Add Lead
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            backdropFilter: "blur(4px)",
            WebkitBackdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: "1rem",
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Edit Lead"
        >
          <div
            className="card"
            style={{
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              width: "100%",
              maxWidth: 480,
              maxHeight: "90vh",
              overflowY: "auto",
              padding: "1.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: "1rem",
              }}
            >
              <h3 style={{ margin: 0, fontSize: "1.1rem", fontWeight: 600 }}>
                Edit Lead
              </h3>
              <button
                type="button"
                onClick={() => setEditing(null)}
                aria-label="Close"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                  padding: 4,
                }}
              >
                <X size={18} />
              </button>
            </div>
            <form
              onSubmit={submitEdit}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "0.875rem",
              }}
            >
              <input
                type="text"
                placeholder="Full Name"
                required
                className="input-field"
                value={editForm.name}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, name: e.target.value }))
                }
              />
              <input
                type="email"
                placeholder="Email Address"
                className="input-field"
                value={editForm.email}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, email: e.target.value }))
                }
              />
              <input
                type="text"
                placeholder="Company"
                className="input-field"
                value={editForm.company}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, company: e.target.value }))
                }
              />
              <input
                type="text"
                placeholder="Job Title"
                className="input-field"
                value={editForm.title}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, title: e.target.value }))
                }
              />
              <select
                className="input-field"
                value={editForm.source}
                onChange={(e) =>
                  setEditForm((prev) => ({ ...prev, source: e.target.value }))
                }
              >
                {isWellness
                  ? WELLNESS_SOURCE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))
                  : isTravel
                    ? TRAVEL_SOURCE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))
                    : SOURCE_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
              </select>
              {renderCustomFieldInputs(
                editForm.customFields,
                handleCustomFieldChangeEdit,
              )}
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                  marginTop: "0.5rem",
                }}
              >
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  style={{
                    padding: "0.5rem 1rem",
                    borderRadius: 6,
                    border: "1px solid var(--border-color)",
                    background: "var(--surface-color)",
                    color: "var(--text-secondary)",
                    cursor: "pointer",
                    fontSize: "0.875rem",
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={editSaving}
                  style={{ padding: "0.5rem 1rem", fontSize: "0.875rem" }}
                >
                  {editSaving ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {isGeneric && callifiedCallLead && (
        <CallifiedLeadCallDialog
          lead={callifiedCallLead}
          defaultCampaignId={
            callifiedCallLead.callifiedCampaignId
              ? String(callifiedCallLead.callifiedCampaignId)
              : ""
          }
          onClose={() => setCallifiedCallLead(null)}
          onCalled={fetchLeads}
        />
      )}

      {isGeneric && callifiedDetailsLead && (
        <CallifiedCallDetailsDrawer
          lead={callifiedDetailsLead}
          onClose={() => setCallifiedDetailsLead(null)}
        />
      )}

      {isGeneric && callStatusDrawerOpen && (
        <CallifiedCallStatusDrawer
          onClose={() => setCallStatusDrawerOpen(false)}
        />
      )}
    </div>
  );
};

const actionIconBtn = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 4,
  color: "var(--text-secondary)",
  display: "inline-flex",
  alignItems: "center",
};
const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 999,
  fontSize: 12,
  fontWeight: 500,
  background: "var(--surface-color)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-color)",
  cursor: "pointer",
};
const chipActiveStyle = {
  ...chipStyle,
  background: "var(--primary-color, var(--accent-color))",
  color: "var(--accent-text, #fff)",
  border: "1px solid var(--primary-color, var(--accent-color))",
};
const chipCountStyle = {
  fontSize: 11,
  fontWeight: 600,
  opacity: 0.8,
  marginLeft: 2,
};

export default Leads;
