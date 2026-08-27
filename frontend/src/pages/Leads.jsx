import { fetchApi } from "../utils/api";
import { useNotify } from "../utils/notify";
import { formatDateMedium as formatDate } from "../utils/date";
import {
  Fragment,
  useState,
  useEffect,
  useLayoutEffect,
  useContext,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useNavigate, useSearchParams } from "react-router-dom";
import ReturnToBanner from "../components/ReturnToBanner";
import {
  UserPlus,
  Search,
  ArrowRightCircle,
  Eye,
  Plus,
  X,
  Pencil,
  Trash2,
  RefreshCw,
  Phone,
  FileText,
  Filter,
  SlidersHorizontal,
  Info,
  Settings,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { AuthContext } from "../App";
import ColumnPicker from "../components/ColumnPicker";
import FilterPanel from "../components/FilterPanel";
import InlineCellEditor from "../components/InlineCellEditor";
import ScrollableSelect from "../components/ScrollableSelect";
import TopScrollSync from "../components/TopScrollSync";
import {
  SUB_BRAND_IDS,
  accessibleSubBrands,
  subBrandShortLabel,
} from "../utils/travelSubBrand";
import { useActiveSubBrand } from "../utils/subBrand";
import CallifiedLeadCallDialog from "../components/CallifiedLeadCallDialog";
import { useLeadCalling } from "../hooks/useLeadCalling";
import {
  LeadCallButton as WellnessLeadCallButton,
  LeadCallDialog as WellnessLeadCallDialog,
} from "../components/wellness/LeadCallAction";
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
const LEADS_COLUMN_LAYOUT_STORAGE_KEY = "globuscrm.leads.columnLayout.v1";
const LEADS_COLUMN_MIN_WIDTH = 72;
const LEADS_COLUMN_COLLAPSED_WIDTH = 52;
const LEADS_NAME_COLUMN_MIN_WIDTH = 220;
const LEADS_NAME_COLUMN_MAX_WIDTH = 380;
const LEADS_ACTIONS_COLUMN_WIDTH = 176;
const LEADS_HEADER_MENU_WIDTH = 300;
const LEADS_HEADER_MENU_SUBMENU_WIDTH = 320;
const LEADS_HEADER_MENU_GAP = 6;
const LEADS_DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "email",
  "company",
  "phone",
  "aiScore",
  "source",
  "tags",
  "assignedTo",
  "createdAt",
];
const LEADS_COLUMN_DEFAULT_WIDTHS = {
  select: 48,
  name: 240,
  email: 220,
  company: 190,
  phone: 150,
  aiScore: 118,
  source: 150,
  tags: 190,
  campaign: 190,
  callStatus: 160,
  callifiedAi: 122,
  callifiedScore: 128,
  subBrand: 130,
  amount: 130,
  assignedTo: 170,
  createdAt: 145,
  actions: LEADS_ACTIONS_COLUMN_WIDTH,
};

const inlineBuiltinCellStyle = {
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.35rem",
  minHeight: "1.35rem",
  maxWidth: "100%",
  padding: "0.15rem 0.3rem",
  borderRadius: 4,
};

const inlineBuiltinEmptyStyle = {
  color: "var(--accent-color)",
  fontSize: "0.8rem",
  whiteSpace: "nowrap",
};

const sourceBadgeStyle = {
  display: "inline-flex",
  alignItems: "center",
  padding: "0.25rem 0.65rem",
  borderRadius: "999px",
  fontSize: "0.75rem",
  fontWeight: 600,
  backgroundColor: "var(--source-badge-bg, rgba(139, 92, 246, 0.16))",
  color: "var(--source-badge-text, var(--text-primary))",
  border: "1px solid var(--border-color)",
};

const compactToolbarButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.3rem",
  fontSize: "0.8rem",
  lineHeight: 1.1,
  whiteSpace: "nowrap",
};

const compactToolbarSurfaceStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  flexWrap: "wrap",
  rowGap: "0.45rem",
  flex: "1 1 1020px",
  minWidth: 0,
  width: "100%",
  padding: "0.6rem 0.75rem",
  borderRadius: 16,
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)",
  boxShadow: "0 10px 24px rgba(15, 23, 42, 0.06)",
};

const compactToolbarDividerStyle = {
  width: 1,
  alignSelf: "stretch",
  background: "var(--border-color)",
  opacity: 0.8,
  margin: "0 0.1rem",
  flexShrink: 0,
};

const LEAD_TAG_LIMIT = 50;
const LEAD_TAG_MAX_LENGTH = 80;

function normalizeLeadTags(raw) {
  if (!raw) return [];
  let values = raw;
  if (typeof raw === "string") {
    try {
      values = JSON.parse(raw);
    } catch (_e) {
      values = raw.split(",");
    }
  }
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const tags = [];
  for (const value of values) {
    const tag = String(value || "").trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function cleanLeadTagInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  return stripDangerousTags(text).value.slice(0, LEAD_TAG_MAX_LENGTH);
}

function removeLeadTagFromList(rawTags, tagKey) {
  const currentTags = normalizeLeadTags(rawTags);
  const nextTags = currentTags.filter(
    (tag) => tag.toLowerCase() !== tagKey,
  );
  return nextTags.length === currentTags.length ? null : nextTags;
}

function LeadTagsCell({ lead, options, onSave, onDeleteTag }) {
  const tags = normalizeLeadTags(lead.tags);
  const [open, setOpen] = useState(false);
  const [draftTags, setDraftTags] = useState(tags);
  const [panel, setPanel] = useState(options.length > 0 ? "search" : "create");
  const [searchQuery, setSearchQuery] = useState("");
  const [newTagInput, setNewTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingTag, setDeletingTag] = useState("");
  const [hovered, setHovered] = useState(false);
  const [popoverStyle, setPopoverStyle] = useState(null);
  const [popoverReady, setPopoverReady] = useState(false);
  const triggerRef = useRef(null);
  const optionKeySet = useMemo(
    () => new Set(options.map((tag) => tag.toLowerCase())),
    [options],
  );

  useEffect(() => {
    if (!open) {
      setDraftTags(normalizeLeadTags(lead.tags));
      setPanel(options.length > 0 ? "search" : "create");
      setSearchQuery("");
      setNewTagInput("");
      setDeletingTag("");
      setPopoverReady(false);
      setPopoverStyle(null);
    }
  }, [open, lead.tags, options.length]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 360;
      const maxLeft = Math.max(8, window.innerWidth - width - 8);
      setPopoverStyle({
        top: Math.max(8, rect.bottom + 6),
        left: Math.min(Math.max(8, rect.left), maxLeft),
        width,
      });
      setPopoverReady(true);
    };
    setPopoverReady(false);
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const addDraftTag = (raw) => {
    const tag = cleanLeadTagInput(raw);
    if (!tag) return;
    setDraftTags((prev) => {
      if (prev.length >= LEAD_TAG_LIMIT) return prev;
      const exists = prev.some(
        (current) => current.toLowerCase() === tag.toLowerCase(),
      );
      if (exists) return prev;
      return [...prev, tag];
    });
  };

  const removeDraftTag = (tag) => {
    setDraftTags((prev) => prev.filter((current) => current !== tag));
  };

  const applyExistingTag = (tag) => {
    addDraftTag(tag);
    setSearchQuery("");
  };

  const createNewTag = () => {
    addDraftTag(newTagInput);
    setNewTagInput("");
  };

  const deleteSavedTag = async (tag) => {
    const normalizedTag = cleanLeadTagInput(tag);
    if (!normalizedTag || !onDeleteTag) return false;
    const tagKey = normalizedTag.toLowerCase();
    if (deletingTag === tagKey) return false;
    setDeletingTag(tagKey);
    try {
      const deleted = await onDeleteTag(lead, normalizedTag);
      if (deleted) {
        setDraftTags((prev) =>
          prev.filter((current) => current.toLowerCase() !== tagKey),
        );
      }
      return deleted;
    } finally {
      setDeletingTag("");
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      await onSave(lead, "tags", draftTags);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setDraftTags(tags);
    setSearchQuery("");
    setNewTagInput("");
    setPanel(options.length > 0 ? "search" : "create");
    setOpen(false);
  };

  const trimmedSearch = searchQuery.trim();
  const optionRows = options.filter((tag) => {
    if (!tag) return false;
    if (!trimmedSearch) return true;
    return tag.toLowerCase().includes(trimmedSearch.toLowerCase());
  });
  const trimmedNewTag = newTagInput.trim();
  const exactNewTagMatch =
    trimmedNewTag &&
    options.some((tag) => tag.toLowerCase() === trimmedNewTag.toLowerCase());

  return (
    <div
      ref={triggerRef}
      className="lead-tags-cell"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen(true);
      }}
    >
      <div className="lead-tags-display" title={tags.join(", ") || "Add tags"}>
        {tags.length === 0 ? (
          <span style={inlineBuiltinEmptyStyle}>+ Click to add</span>
        ) : (
          <>
            {tags.map((tag) => (
              <span key={tag} className="lead-tag-chip">
                {tag}
              </span>
            ))}
          </>
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={`Edit Tags for ${lead.name || "lead"}`}
        title="Edit Tags"
        style={{
          ...actionIconBtn,
          flexShrink: 0,
          padding: 2,
          opacity: hovered ? 0.85 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transition: "opacity 0.15s ease",
        }}
      >
        <Pencil size={12} />
      </button>
      {open &&
        createPortal(
          <>
            <div
              style={{ position: "fixed", inset: 0, zIndex: 80 }}
              onMouseDown={(e) => {
                e.stopPropagation();
                cancel();
              }}
            />
            <div
              role="dialog"
              aria-label={`Edit Tags for ${lead.name || "lead"}`}
              className="card lead-tags-popover"
              style={{
                position: "fixed",
                top: popoverStyle?.top || 0,
                left: popoverStyle?.left || 0,
                width: popoverStyle?.width || 360,
                zIndex: 81,
                visibility: popoverReady ? "visible" : "hidden",
                transition: "none",
                transform: "none",
                animation: "none",
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            >
              <div
                className="lead-tags-mode-switch"
                role="group"
                aria-label="Tag options"
              >
                <button
                  type="button"
                  className={`lead-tags-mode-button${panel === "search" ? " lead-tags-mode-button--active" : ""}`}
                  aria-pressed={panel === "search"}
                  onClick={() => setPanel("search")}
                >
                  <Search size={13} />
                  Search existing
                </button>
                <button
                  type="button"
                  className={`lead-tags-mode-button${panel === "create" ? " lead-tags-mode-button--active" : ""}`}
                  aria-pressed={panel === "create"}
                  onClick={() => setPanel("create")}
                >
                  <Plus size={13} />
                  Add new
                </button>
              </div>
              {draftTags.length > 0 && (
                <div
                  className="lead-tags-draft-list"
                  aria-label="Selected tags"
                >
                  {draftTags.map((tag) => (
                    <span key={tag} className="lead-tag-chip lead-tag-chip--selected">
                      <span className="lead-tag-chip__label">{tag}</span>
                      <button
                        type="button"
                        onClick={() => removeDraftTag(tag)}
                        aria-label={`Remove ${tag} from this lead`}
                        className="lead-tag-chip-action lead-tag-chip-action--remove"
                      >
                        <X size={12} />
                      </button>
                      {optionKeySet.has(tag.toLowerCase()) && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteSavedTag(tag);
                          }}
                          aria-label={`Delete saved tag ${tag}`}
                          title={`Delete saved tag ${tag}`}
                          className="lead-tag-chip-action lead-tag-chip-action--delete"
                          disabled={saving || deletingTag === tag.toLowerCase()}
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {panel === "search" ? (
                <>
                  <label
                    className="lead-tags-label"
                    htmlFor={`lead-tags-search-${lead.id}`}
                  >
                    Search saved tags
                  </label>
                  <div className="lead-tags-search-row">
                    <input
                      id={`lead-tags-search-${lead.id}`}
                      className="input-field"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Search saved tags"
                      autoFocus
                      onKeyDown={(e) => {
                        if (e.key !== "Enter") return;
                        e.preventDefault();
                        if (optionRows.length > 0) {
                          applyExistingTag(optionRows[0]);
                        }
                      }}
                    />
                  </div>
                  <div
                    className="lead-tags-search-list"
                    aria-label="Available tags"
                  >
                    {options.length === 0 ? (
                      <span className="lead-tags-search-empty">
                        No saved tags yet. Switch to Add new to create the first one.
                      </span>
                    ) : optionRows.length === 0 ? (
                      trimmedSearch ? (
                        <div className="lead-tags-search-empty">
                          <span>No matching saved tags.</span>
                          <button
                            type="button"
                            className="lead-tags-inline-link"
                            onClick={() => {
                              setPanel("create");
                              setNewTagInput(trimmedSearch);
                            }}
                          >
                            Create &quot;{trimmedSearch}&quot;
                          </button>
                        </div>
                      ) : (
                        <span className="lead-tags-search-empty">
                          All saved tags on this lead are already selected.
                        </span>
                      )
                    ) : (
                      optionRows.map((tag) => {
                        const tagKey = tag.toLowerCase();
                        const deletingThisTag = deletingTag === tagKey;
                        return (
                          <div key={tag} className="lead-tags-option-row">
                            <button
                              type="button"
                              className="lead-tags-option"
                              onClick={() => applyExistingTag(tag)}
                            >
                              {tag}
                            </button>
                            <button
                              type="button"
                              className="lead-tags-option-delete"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                deleteSavedTag(tag);
                              }}
                              aria-label={`Delete saved tag ${tag}`}
                              title={`Delete saved tag ${tag}`}
                              disabled={saving || deletingThisTag}
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                  <div className="lead-tags-create-tip">
                    Search saved tags and click one to apply it.
                  </div>
                </>
              ) : (
                <>
                  <label
                    className="lead-tags-label"
                    htmlFor={`lead-tags-new-${lead.id}`}
                  >
                    Add a new tag
                  </label>
                  <form
                    className="lead-tags-input-row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      createNewTag();
                    }}
                  >
                    <input
                      id={`lead-tags-new-${lead.id}`}
                      className="input-field"
                      value={newTagInput}
                      onChange={(e) => setNewTagInput(e.target.value)}
                      placeholder="Type a new tag"
                      maxLength={LEAD_TAG_MAX_LENGTH}
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="lead-tags-add-button"
                      aria-label="Add new tag"
                    >
                      <Plus size={14} />
                    </button>
                  </form>
                  <div className="lead-tags-create-tip">
                    Add a new tag here, then click Save to apply it to this lead.
                  </div>
                  {trimmedNewTag && exactNewTagMatch && (
                    <div className="lead-tags-search-empty">
                      That tag already exists in saved tags. Use Search existing if you want to apply it from the catalog.
                    </div>
                  )}
                </>
              )}
              <div className="lead-tags-popover-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={cancel}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={save}
                  disabled={saving}
                >
                  Save
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}

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

function BuiltInInlineCellEditor({
  lead,
  field,
  label,
  value,
  type = "text",
  options = [],
  onSave,
  required = false,
  renderValue = null,
  editOnDisplayClick = true,
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  const save = async (nextValue = draft) => {
    const normalized =
      type === "select" ? nextValue : String(nextValue || "").trim();
    if (required && !normalized) return;
    if (normalized === (value ?? "")) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      await onSave(lead, field, normalized);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    const isEmpty = value === null || value === undefined || value === "";
    return (
      <span
        className="inline-cell-editor-display"
        onClick={editOnDisplayClick ? () => setEditing(true) : undefined}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={editOnDisplayClick ? `Click to edit ${label}` : undefined}
        style={{
          ...inlineBuiltinCellStyle,
          cursor: editOnDisplayClick ? inlineBuiltinCellStyle.cursor : "default",
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: isEmpty ? "var(--accent-color)" : "inherit",
          }}
        >
          {isEmpty ? (
            <span style={inlineBuiltinEmptyStyle}>+ Add {label}</span>
          ) : renderValue ? (
            renderValue(value)
          ) : (
            String(value)
          )}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setEditing(true);
          }}
          aria-label={`Edit ${label} for ${lead.name || "lead"}`}
          title={`Edit ${label}`}
          style={{
            ...actionIconBtn,
            flexShrink: 0,
            padding: 2,
            opacity: hovered ? 0.85 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 0.15s ease",
          }}
        >
          <Pencil size={12} />
        </button>
      </span>
    );
  }

  if (type === "select") {
    return (
      <select
        ref={inputRef}
        className="input-field"
        value={draft}
        disabled={saving}
        onChange={(e) => save(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setEditing(false);
        }}
        aria-label={`Edit ${label} for ${lead.name || "lead"}`}
        style={{
          width: "100%",
          minWidth: 120,
          padding: "0.35rem 0.45rem",
          fontSize: "0.8125rem",
        }}
      >
        <option value="">Select</option>
        {options.map((opt) => (
          <option key={opt.value || opt} value={opt.value || opt}>
            {opt.label || opt}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      ref={inputRef}
      className="input-field"
      type={type}
      value={draft}
      disabled={saving}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => save()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      aria-label={`Edit ${label} for ${lead.name || "lead"}`}
      style={{
        width: "100%",
        minWidth: 120,
        padding: "0.35rem 0.45rem",
        fontSize: "0.8125rem",
      }}
    />
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
  const { activeSubBrand } = useActiveSubBrand();
  // Callified AI calling is only available in the generic CRM vertical.
  const isGeneric = !isWellness && !isTravel;
  // ADMINs always get the full assignment UI. Travel non-admins can also
  // reassign the leads they own, but only to non-admin staff targets.
  const isAdmin = auth?.user?.role === "ADMIN";
  const [leads, setLeads] = useState([]);
  const [leadTagCatalog, setLeadTagCatalog] = useState([]);
  const [staff, setStaff] = useState([]);
  const [services, setServices] = useState([]);
  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [leadsPage, setLeadsPage] = useState(0);
  const [leadsPageSize, setLeadsPageSize] = useState(25);
  const [pageInput, setPageInput] = useState("1");
  const [selectedLeads, setSelectedLeads] = useState([]);
  const [columnLayout, setColumnLayout] = useState(() => {
    try {
      const saved = window.localStorage.getItem(
        LEADS_COLUMN_LAYOUT_STORAGE_KEY,
      );
      const parsed = saved ? JSON.parse(saved) : null;
      return {
        widths:
          parsed?.widths && typeof parsed.widths === "object"
            ? parsed.widths
            : {},
        collapsed:
          parsed?.collapsed && typeof parsed.collapsed === "object"
            ? parsed.collapsed
            : {},
      };
    } catch (_err) {
      return { widths: {}, collapsed: {} };
    }
  });
  const resizeStateRef = useRef(null);
  const leadsFrozenTableRef = useRef(null);
  const leadsScrollableTableRef = useRef(null);
  const [bulkAgent, setBulkAgent] = useState("");
  const [, setBulkCampaignId] = useState("");
  const [bulkCampaignDropdownOpen, setBulkCampaignDropdownOpen] =
    useState(false);
  const [bulkCampaignSaving, setBulkCampaignSaving] = useState(false);
  const [leadBulkActionsOpen, setLeadBulkActionsOpen] = useState(false);
  // Wellness Callified calling — the AI / Manual chooser used by Appointments
  // and Patients. Distinct from the generic-vertical flow below, which has its
  // own dialog, auto-campaign rules and lead-status sync; the hook returns
  // disabled on every non-wellness tenant so the two never both appear.
  const wellnessCall = useLeadCalling();

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
  const [subBrandFilter, setSubBrandFilter] = useState(
    isTravel ? activeSubBrand || "" : "",
  );
  const [stageFilter, setStageFilter] = useState("");

  useEffect(() => {
    if (isTravel) setSubBrandFilter(activeSubBrand || "");
  }, [activeSubBrand, isTravel]);
  const [previewLead, setPreviewLead] = useState(null);
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
  const [leadColumnCatalog, setLeadColumnCatalog] = useState([]);
  const [sortConfig, setSortConfig] = useState({ key: null, direction: null });
  const [headerMenuState, setHeaderMenuState] = useState(null);
  const [headerMenuSubmenu, setHeaderMenuSubmenu] = useState(null);
  const [headerMenuSearch, setHeaderMenuSearch] = useState("");
  const [headerFilterRequest, setHeaderFilterRequest] = useState(null);
  const [renameFieldState, setRenameFieldState] = useState(null);

  // Drill-down entry from the Lead Reports cluster: a report row links here
  // with the filter it represents, e.g.
  //   /leads?callStatus=qualified&returnTo=%2Flead-reports&returnLabel=Lead+Funnel
  // Seeding the existing filter state (rather than adding a parallel filter
  // path) means the dropdowns visibly reflect what's applied and the user can
  // widen or clear it from the normal controls.
  const [drillParams] = useSearchParams();
  useEffect(() => {
    const callStatus = drillParams.get("callStatus");
    const source = drillParams.get("source");
    const assignee = drillParams.get("assignee");
    if (callStatus) setLeadStatusFilter(normalizeCallStatus(callStatus));
    if (source) setSourceFilter(source);
    if (assignee) setAssigneeFilter(assignee);
    // Read once per URL — re-running on every render would fight the user's
    // own changes to the dropdowns.
  }, [drillParams]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        LEADS_COLUMN_LAYOUT_STORAGE_KEY,
        JSON.stringify(columnLayout),
      );
    } catch (_err) {
      // Layout persistence is a convenience; table interaction should still work.
    }
  }, [columnLayout]);
  useEffect(() => {
    if (!isGeneric) {
      setLeadColumnCatalog([]);
      return undefined;
    }
    let cancelled = false;
    fetchApi("/api/table-column-prefs/leads", { silent: true })
      .then((data) => {
        if (cancelled) return;
        setLeadColumnCatalog(Array.isArray(data?.availableColumns) ? data.availableColumns : []);
        if (Array.isArray(data?.visible)) {
          setVisibleColumns(data.visible);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLeadColumnCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isGeneric]);
  useEffect(
    () => () => {
      if (!resizeStateRef.current) return;
      window.removeEventListener("mousemove", resizeStateRef.current.onMove);
      window.removeEventListener("mouseup", resizeStateRef.current.onUp);
    },
    [],
  );
  const getColumnDefaultWidth = (key) =>
    LEADS_COLUMN_DEFAULT_WIDTHS[key] || (key.startsWith("cf_") ? 150 : 140);
  const getColumnWidth = (key) =>
    columnLayout.collapsed?.[key]
      ? LEADS_COLUMN_COLLAPSED_WIDTH
      : key === "actions"
        ? Math.max(
            Number(columnLayout.widths?.[key]) || getColumnDefaultWidth(key),
            LEADS_ACTIONS_COLUMN_WIDTH,
          )
        : key === "name"
          ? Math.max(
              LEADS_NAME_COLUMN_MIN_WIDTH,
              Math.min(
                Number(columnLayout.widths?.[key]) || getColumnDefaultWidth(key),
                LEADS_NAME_COLUMN_MAX_WIDTH,
              ),
            )
          : Number(columnLayout.widths?.[key]) || getColumnDefaultWidth(key);
  const setColumnWidth = (key, width) => {
    const minWidth =
      key === "actions"
        ? LEADS_ACTIONS_COLUMN_WIDTH
        : key === "name"
          ? LEADS_NAME_COLUMN_MIN_WIDTH
          : LEADS_COLUMN_MIN_WIDTH;
    const maxWidth = key === "name" ? LEADS_NAME_COLUMN_MAX_WIDTH : Number.POSITIVE_INFINITY;
    const nextWidth = Math.max(minWidth, Math.min(Math.round(width), maxWidth));
    setColumnLayout((prev) => ({
      widths: { ...(prev.widths || {}), [key]: nextWidth },
      collapsed: { ...(prev.collapsed || {}), [key]: false },
    }));
  };
  const startColumnResize = (key, event) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = getColumnWidth(key);
    const onMove = (moveEvent) => {
      setColumnWidth(key, startWidth + moveEvent.clientX - startX);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      resizeStateRef.current = null;
    };
    resizeStateRef.current = { onMove, onUp };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
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

  const loadLeadTagCatalog = useCallback(async () => {
    try {
      const data = await fetchApi("/api/contacts/filter-values/tags?status=Lead");
      const rows = Array.isArray(data?.values)
        ? data.values
        : Array.isArray(data)
          ? data
          : [];
      const seen = new Set();
      const tags = [];
      for (const row of rows) {
        const tag = cleanLeadTagInput(row?.label || row?.value || row);
        if (!tag) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        tags.push(tag);
      }
      tags.sort((a, b) => a.localeCompare(b));
      setLeadTagCatalog(tags);
    } catch {
      setLeadTagCatalog([]);
    }
  }, []);

  const fetchStaff = async () => {
    try {
      const data = await fetchApi("/api/staff");
      setStaff(Array.isArray(data) ? data : []);
    } catch {
      setStaff([]);
    }
  };

  const staffBrandSuffix = (member) => {
    if (!isTravel) return "";
    const brands = accessibleSubBrands(member).map(subBrandShortLabel);
    return brands.length ? ` (${brands.join(", ")})` : "";
  };

  const staffOptionLabel = (member) =>
    `${member.name || member.email}${staffBrandSuffix(member)}`;

  const assignableStaff = (lead) => {
    let rows = staff;
    if (isTravel && !isAdmin) {
      rows = rows.filter((s) => s.role !== "ADMIN");
    }
    if (!isTravel || !lead?.subBrand) return rows;
    return rows.filter(
      (s) =>
        accessibleSubBrands(s).includes(lead.subBrand) ||
        String(s.id) === String(lead.assignedToId),
    );
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
    loadLeadTagCatalog();
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

  const handleBulkDelete = async () => {
    if (selectedLeads.length === 0) return;

    const ok = await notify.confirm({
      title: "Delete selected leads?",
      message: `Delete ${selectedLeads.length} selected lead${selectedLeads.length === 1 ? "" : "s"}? This can't be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return;

    setLeadBulkActionsOpen(false);
    try {
      const res = await fetchApi("/api/contacts/bulk-delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contactIds: selectedLeads }),
      });
      const deletedCount = Number.isFinite(Number(res?.deleted))
        ? Number(res.deleted)
        : selectedLeads.length;
      notify.success(`Deleted ${deletedCount} lead${deletedCount === 1 ? "" : "s"}`);
      setSelectedLeads([]);
      setBulkAgent("");
      setBulkCampaignDropdownOpen(false);
      fetchLeads({ background: true });
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete leads");
    }
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
  const hasActiveLeadFilters = Boolean(
    searchTerm.trim() ||
    sourceFilter ||
    subBrandFilter ||
    stageFilter ||
    campaignFilter ||
    leadStatusFilter ||
    assigneeFilter ||
    advancedFilters.length > 0,
  );

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

  const handleLeadBulkActionsToggle = () => {
    if (leadBulkActionsOpen) {
      setLeadBulkActionsOpen(false);
      return;
    }
    if (selectedLeads.length === 0) {
      setSelectedLeads(filteredLeads.map((lead) => lead.id));
    }
    setLeadBulkActionsOpen(true);
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
  const customFieldByKey = useMemo(
    () => new Map(customFieldDefs.map((field) => [`cf_${field.fieldKey}`, field])),
    [customFieldDefs],
  );
  const leadColumnKeySet = useMemo(
    () => new Set(leadColumnCatalog.map((column) => column.key)),
    [leadColumnCatalog],
  );
  const preferredVisibleColumns = useMemo(
    () =>
      Array.isArray(visibleColumns)
        ? visibleColumns
        : [
            ...LEADS_DEFAULT_VISIBLE_COLUMNS,
            ...customFieldDefs.map((field) => `cf_${field.fieldKey}`),
          ],
    [customFieldDefs, visibleColumns],
  );
  const leadUserColumnDefs = preferredVisibleColumns
    .filter((key) => key !== "name")
    .filter(
      (key) =>
        key === "email" ||
        key === "company" ||
        key === "phone" ||
        key === "aiScore" ||
        key === "source" ||
        key === "tags" ||
        key === "assignedTo" ||
        key === "createdAt" ||
        customFieldByKey.has(key),
    )
    .map((key) => {
      if (key === "email") return { key, label: "Email" };
      if (key === "company")
        return { key, label: isTravel ? "Category" : "Company" };
      if (key === "phone") return { key, label: "Phone" };
      if (key === "aiScore") return { key, label: "Lead Score" };
      if (key === "source") return { key, label: "Source" };
      if (key === "tags") return { key, label: "Tags" };
      if (key === "assignedTo") return { key, label: "Assigned To" };
      if (key === "createdAt") return { key, label: "Created" };
      const field = customFieldByKey.get(key);
      return {
        key,
        label: field?.label || key,
        customField: true,
        field,
      };
    });
  const leadFixedExtraColumnDefs = [
    ...(isGeneric
      ? [
          { key: "campaign", label: "Callified Campaign" },
          { key: "callStatus", label: "Call Status" },
          { key: "callifiedAi", label: "Callified AI call" },
          { key: "callifiedScore", label: "Callified Score" },
        ]
      : []),
    ...(isTravel
      ? [
          { key: "subBrand", label: "Sub-brand" },
          { key: "amount", label: "Amount" },
      ]
      : []),
  ];
  const getCustomFieldFilterKind = (fieldType) => {
    if (fieldType === "date") return "date";
    if (fieldType === "number") return "number";
    if (fieldType === "checkbox") return "boolean";
    return "text";
  };
  const getHeaderFilterConfig = (column) => {
    if (!column) return null;
    if (column.customField && column.field) {
      return {
        fieldKey: `custom_${column.field.id}`,
        label: column.label,
        kind: getCustomFieldFilterKind(column.field.fieldType),
      };
    }
    switch (column.key) {
      case "name":
        return { fieldKey: "name", label: "Name", kind: "text" };
      case "email":
        return { fieldKey: "email", label: "Email", kind: "text" };
      case "company":
        return { fieldKey: "company", label: isTravel ? "Category" : "Company", kind: "text" };
      case "phone":
        return { fieldKey: "phone", label: "Phone", kind: "text" };
      case "source":
        return { fieldKey: "source", label: "Source", kind: "text" };
      case "campaign":
        return { fieldKey: "callifiedCampaignId", label: "Callified Campaign", kind: "id" };
      case "callStatus":
        return { fieldKey: "callifiedLeadStatus", label: "Call Status", kind: "text" };
      case "tags":
        return { fieldKey: "tags", label: "Tags", kind: "text" };
      case "aiScore":
        return { fieldKey: "aiScore", label: "Lead Score", kind: "number" };
      case "assignedTo":
        return { fieldKey: "assignedToId", label: "Assigned To", kind: "id" };
      case "createdAt":
        return { fieldKey: "createdAt", label: "Created", kind: "date" };
      case "subBrand":
        return { fieldKey: "subBrand", label: "Sub-brand", kind: "text" };
      default:
        return null;
    }
  };
  const closeHeaderMenu = useCallback(() => {
    setHeaderMenuState(null);
    setHeaderMenuSubmenu(null);
    setHeaderMenuSearch("");
  }, []);
  useEffect(() => {
    if (!headerMenuState) return undefined;
    const dismiss = () => closeHeaderMenu();
    const onKey = (event) => {
      if (event.key === "Escape") {
        closeHeaderMenu();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss);
    };
  }, [closeHeaderMenu, headerMenuState]);
  const openHeaderMenu = (column, event) => {
    if (!column || column.key === "select" || column.key === "actions") return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHeaderMenuState({
      key: column.key,
      label: column.label,
      customField: Boolean(column.customField),
      field: column.field || null,
      fixedExtra: leadFixedExtraColumnDefs.some((item) => item.key === column.key),
      locked: column.key === "name",
      rect: {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
    });
    setHeaderMenuSubmenu(null);
    setHeaderMenuSearch("");
  };
  const openHeaderFilter = (column) => {
    const config = getHeaderFilterConfig(column);
    if (!config) return;
    setHeaderFilterRequest(config);
    closeHeaderMenu();
  };
  const openColumnPickerFromMenu = () => {
    window.dispatchEvent(
      new CustomEvent("globuscrm:open-table-column-picker", {
        detail: { tableKey: "leads" },
      }),
    );
    closeHeaderMenu();
  };
  const currentVisibleLeadColumns = useMemo(
    () => preferredVisibleColumns.filter((key) => key !== "name"),
    [preferredVisibleColumns],
  );
  const resolveAllowedVisibleColumns = useCallback(
    (nextVisible) => {
      const allowedKeys = leadColumnKeySet.size
        ? leadColumnKeySet
        : new Set(["name", ...preferredVisibleColumns]);
      const cleanVisible = [];
      const seen = new Set();
      for (const rawKey of Array.isArray(nextVisible) ? nextVisible : []) {
        const key = String(rawKey);
        if (seen.has(key) || !allowedKeys.has(key)) continue;
        seen.add(key);
        cleanVisible.push(key);
      }
      if (!cleanVisible.includes("name")) {
        cleanVisible.unshift("name");
      }
      return cleanVisible;
    },
    [leadColumnKeySet, preferredVisibleColumns],
  );
  const persistVisibleColumns = useCallback(
    async (nextVisible) => {
      if (!isGeneric) return nextVisible;
      const cleanVisible = resolveAllowedVisibleColumns(nextVisible);
      const data = await fetchApi("/api/table-column-prefs/leads", {
        method: "PUT",
        body: JSON.stringify({ visible: cleanVisible }),
      });
      const saved = Array.isArray(data?.visible) ? data.visible : cleanVisible;
      setVisibleColumns(saved);
      return saved;
    },
    [isGeneric, resolveAllowedVisibleColumns],
  );
  const collapseColumn = (columnKey) => {
    setColumnLayout((prev) => ({
      widths: { ...(prev.widths || {}) },
      collapsed: {
        ...(prev.collapsed || {}),
        [columnKey]: !prev.collapsed?.[columnKey],
      },
    }));
  };
  const addColumnAdjacent = async (targetKey, side, selectedKey) => {
    if (!isGeneric || !targetKey || !selectedKey || selectedKey === "name") return;
    const base =
      targetKey === "name"
        ? ["name", ...currentVisibleLeadColumns]
        : [...currentVisibleLeadColumns];
    const targetIndex = base.indexOf(targetKey);
    if (targetIndex < 0) return;
    const next = base.filter((key) => key !== selectedKey);
    const insertAt = side === "left" ? targetIndex : targetIndex + 1;
    next.splice(Math.max(0, Math.min(next.length, insertAt)), 0, selectedKey);
    try {
      await persistVisibleColumns(next);
      closeHeaderMenu();
      setHeaderMenuSubmenu(null);
    } catch (err) {
      notify.error(err?.message || "Failed to update column order");
    }
  };
  const removeColumnFromTable = async (columnKey) => {
    if (!isGeneric || columnKey === "name") return;
    const next = currentVisibleLeadColumns.filter((key) => key !== columnKey);
    try {
      await persistVisibleColumns(next);
      if (sortConfig.key === columnKey) {
        setSortConfig({ key: null, direction: null });
      }
      closeHeaderMenu();
      setHeaderMenuSubmenu(null);
    } catch (err) {
      notify.error(err?.message || "Failed to update column order");
    }
  };
  const renameCustomField = async () => {
    if (!renameFieldState?.id || !renameFieldState?.fieldKey) return;
    const trimmed = String(renameFieldState?.label || "").trim();
    if (!trimmed) {
      notify.error("Label is required");
      return;
    }
    try {
      await fetchApi(`/api/lead-custom-fields/${renameFieldState.id}`, {
        method: "PUT",
        body: JSON.stringify({ label: trimmed }),
      });
      setCustomFieldDefs((prev) =>
        prev.map((field) =>
          field.id === renameFieldState.id
            ? { ...field, label: trimmed }
            : field,
        ),
      );
      setLeadColumnCatalog((prev) =>
        prev.map((column) =>
          column.key === `cf_${renameFieldState.fieldKey}`
            ? { ...column, label: trimmed }
            : column,
        ),
      );
      setRenameFieldState(null);
      closeHeaderMenu();
      await fetchLeads({ background: true });
    } catch (err) {
      notify.error(err?.message || "Failed to rename field");
    }
  };
  const getLeadSortValue = useCallback(
    (lead, key) => {
      if (!lead) return "";
      if (key && key.startsWith("cf_")) {
        const customField = customFieldByKey.get(key);
        return customField ? lead.customFields?.[customField.fieldKey] ?? "" : "";
      }
      switch (key) {
        case "name":
          return lead.name || "";
        case "email":
          return lead.email || "";
        case "company":
          return lead.company || "";
        case "phone":
          return lead.phone || "";
        case "aiScore":
          return Number(lead.aiScore ?? 0);
        case "source":
          return lead.source || "";
        case "tags":
          return normalizeLeadTags(lead.tags).join(", ");
        case "assignedTo":
          return lead.assignedTo?.name || lead.assignedTo?.email || "";
        case "createdAt":
          return lead.createdAt ? new Date(lead.createdAt).getTime() : 0;
        case "campaign": {
          const campaign = callifiedCampaigns.find(
            (c) => String(c.id) === String(lead.callifiedCampaignId),
          );
          return campaign?.name || "";
        }
        case "callStatus":
          return getCallStatusMeta(normalizeCallStatus(lead.callifiedLeadStatus)).label || "";
        case "callifiedAi":
          return Number(callifiedSummaries[lead.id]?.callCount || 0);
        case "callifiedScore":
          return Number(callifiedSummaries[lead.id]?.lastScore ?? -1);
        case "subBrand":
          return lead.subBrand || "";
        case "amount": {
          const bv = bookingValueByContact[lead.id];
          if (bv && Number(bv.value) > 0) return Number(bv.value);
          const tmcEntry = tmcPaidByEmail[lead.email];
          if (tmcEntry && Number(tmcEntry.paidTotal) > 0) {
            return Number(tmcEntry.paidTotal);
          }
          const deals = dealsByContact[lead.id] || [];
          return deals.reduce((sum, deal) => sum + (Number(deal.amount) || 0), 0);
        }
        default:
          return lead[key] ?? "";
      }
    },
    [
      bookingValueByContact,
      callifiedCampaigns,
      callifiedSummaries,
      customFieldByKey,
      dealsByContact,
      tmcPaidByEmail,
    ],
  );
  const openRenameField = () => {
    if (!headerMenuState?.customField || !headerMenuState.field) return;
    const field = headerMenuState.field;
    setRenameFieldState({
      id: field.id,
      fieldKey: field.fieldKey,
      label: headerMenuState.label || field.label || "",
    });
  };
  const renderHeaderMenuTrigger = (column) => {
    if (!column || column.key === "select" || column.key === "actions") return null;
    const isActive = headerMenuState?.key === column.key;
    return (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openHeaderMenu(column, event);
        }}
        aria-haspopup="menu"
        aria-expanded={isActive}
        aria-label={`Open ${column.label} column menu`}
        title={`Open ${column.label} column menu`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 24,
          height: 24,
          flexShrink: 0,
          padding: 0,
          borderRadius: 6,
          border: "1px solid var(--border-color)",
          background: isActive ? "var(--surface-hover)" : "var(--surface-color)",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <ChevronDown size={12} />
      </button>
    );
  };
  const tableColumnDefs = [
    { key: "name", label: "Name" },
    ...leadUserColumnDefs,
    ...leadFixedExtraColumnDefs,
    { key: "actions", label: "Actions", locked: true },
  ];
  const leadsFrozenColumnDefs = tableColumnDefs.filter(
    (column) => column.key === "name",
  );
  const leadsScrollableColumnDefs = tableColumnDefs.filter(
    (column) => column.key !== "name",
  );
  const leadsFrozenTableWidth = leadsFrozenColumnDefs.reduce(
    (sum, column) => sum + getColumnWidth(column.key),
    0,
  );
  const leadsScrollableTableWidth = leadsScrollableColumnDefs.reduce(
    (sum, column) => sum + getColumnWidth(column.key),
    0,
  );
  const leadsScrollableTableBaseWidth = leadsScrollableColumnDefs.reduce(
    (sum, column) => sum + getColumnDefaultWidth(column.key),
    0,
  );
  // Keep the scroll pane wide enough to preserve the scroll position when a
  // column is shrunk. Without this floor, dragging a column left can make
  // the pane contract and hide the neighbor to the left until the
  // width is restored.
  const leadsScrollableTableMinWidth = `${Math.max(
    leadsScrollableTableWidth,
    leadsScrollableTableBaseWidth,
  )}px`;
  const leadsFrozenTableWidthPx = `${leadsFrozenTableWidth}px`;
  const leadsTableClassName = isTravel
    ? "leads-table leads-table--fit"
    : isGeneric
      ? "leads-table leads-table--compact"
      : "leads-table";
  // Every vertical uses the split-table layout. Row-height sync is required
  // so the frozen Name pane stays aligned with the scrollable columns.
  const leadsRowSyncEnabled = true;
  const syncTablePairHeight = useCallback((leftRow, rightRow) => {
    if (!leftRow || !rightRow) return;
    const height = Math.max(
      Math.ceil(leftRow.getBoundingClientRect().height),
      Math.ceil(rightRow.getBoundingClientRect().height),
    );
    const nextHeight = `${height}px`;
    if (leftRow.style.height !== nextHeight) {
      leftRow.style.height = nextHeight;
    }
    if (rightRow.style.height !== nextHeight) {
      rightRow.style.height = nextHeight;
    }
  }, []);
  const syncSplitTableRowHeights = useCallback(() => {
    if (!leadsRowSyncEnabled) return;
    const frozenTable = leadsFrozenTableRef.current;
    const scrollableTable = leadsScrollableTableRef.current;
    if (!frozenTable || !scrollableTable) return;

    const frozenHeaderRow = frozenTable.querySelector("thead tr");
    const scrollHeaderRow = scrollableTable.querySelector("thead tr");
    const frozenRows = Array.from(frozenTable.querySelectorAll("tbody tr"));
    const scrollRows = Array.from(scrollableTable.querySelectorAll("tbody tr"));
    if (
      frozenRows.length === 0 ||
      frozenRows.length !== scrollRows.length ||
      !frozenHeaderRow ||
      !scrollHeaderRow
    ) {
      return;
    }

    syncTablePairHeight(frozenHeaderRow, scrollHeaderRow);
    frozenRows.forEach((frozenRow, index) => {
      const scrollRow = scrollRows[index];
      if (!scrollRow) return;
      syncTablePairHeight(frozenRow, scrollRow);
    });
  }, [leadsRowSyncEnabled, syncTablePairHeight]);
  const genericHeaderSyncEnabled = isGeneric;
  const genericHeaderSyncSignature = genericHeaderSyncEnabled
    ? tableColumnDefs.map((column) => `${column.key}:${column.label}`).join("::")
    : "";
  const syncGenericHeaderHeight = useCallback(() => {
    if (!genericHeaderSyncEnabled) return;
    const frozenTable = leadsFrozenTableRef.current;
    const scrollableTable = leadsScrollableTableRef.current;
    if (!frozenTable || !scrollableTable) return;

    const frozenHeaderRow = frozenTable.querySelector("thead tr");
    const scrollHeaderRow = scrollableTable.querySelector("thead tr");
    syncTablePairHeight(frozenHeaderRow, scrollHeaderRow);
  }, [genericHeaderSyncEnabled, syncTablePairHeight]);

  const leadDetailPath = (lead) => {
    if (isTravel) return `/travel/leads/${lead.id}`;
    return `/contacts/${lead.id}`;
  };

  const leadTagOptions = Array.from(
    new Set([
      ...leadTagCatalog,
      ...leads.flatMap((lead) => normalizeLeadTags(lead.tags)),
    ]),
  ).sort((a, b) => a.localeCompare(b));

  const updateLeadInlineValue = async (lead, field, rawValue) => {
    let value = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (field === "tags") {
      value = normalizeLeadTags(rawValue);
      if (value.length > LEAD_TAG_LIMIT) {
        notify.error(`A lead can have at most ${LEAD_TAG_LIMIT} tags`);
        throw new Error("Too many tags");
      }
      for (const tag of value) {
        if (CONTROL_CHAR_RE.test(tag)) {
          notify.error("Tags contain invalid control characters");
          throw new Error("Invalid tags");
        }
        if (stripDangerousTags(tag).stripped) {
          notify.error("HTML markup is not allowed in tags");
          throw new Error("HTML markup is not allowed");
        }
        if (tag.length > LEAD_TAG_MAX_LENGTH) {
          notify.error(
            `Each tag must be ${LEAD_TAG_MAX_LENGTH} characters or less`,
          );
          throw new Error("Tag too long");
        }
      }
    }
    if (field === "name" && !value) {
      notify.error("Name is required");
      throw new Error("Name is required");
    }
    if (typeof value === "string" && CONTROL_CHAR_RE.test(value)) {
      notify.error(`${field} contains invalid control characters`);
      throw new Error("Invalid control characters");
    }
    const limit = FIELD_LIMITS[field];
    if (limit && String(value || "").length > limit) {
      notify.error(`${field} is too long. Maximum ${limit} characters.`);
      throw new Error("Field too long");
    }
    if (field === "email" && value && !EMAIL_RE.test(value)) {
      notify.error("Enter a valid email address");
      throw new Error("Invalid email");
    }
    if (typeof value === "string") {
      const stripped = stripDangerousTags(value);
      if (stripped.stripped) {
        notify.error("HTML markup is not allowed in inline edits");
        throw new Error("HTML markup is not allowed");
      }
    }

    await fetchApi(`/api/contacts/${lead.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    setLeads((prev) =>
      prev.map((row) =>
        row.id === lead.id ? { ...row, [field]: value } : row,
      ),
    );
    setPreviewLead((current) =>
      current?.id === lead.id ? { ...current, [field]: value } : current,
    );
    if (field === "tags" && Array.isArray(value)) {
      setLeadTagCatalog((prev) => {
        const seen = new Set(prev.map((tag) => tag.toLowerCase()));
        const next = [...prev];
        for (const tag of value) {
          if (seen.has(tag.toLowerCase())) continue;
          seen.add(tag.toLowerCase());
          next.push(tag);
        }
        next.sort((a, b) => a.localeCompare(b));
        return next;
      });
    }
    notify.success("Lead updated");
  };

  const handleDeleteLeadTag = async (lead, rawTag) => {
    const tag = cleanLeadTagInput(rawTag);
    if (!tag) return false;
    const ok = await notify.confirm({
      title: "Delete saved tag?",
      message: `Delete "${tag}" from every lead in this pipeline? This removes the saved tag from all matching leads and cannot be undone.`,
      confirmText: "Delete",
      cancelText: "Cancel",
      destructive: true,
    });
    if (!ok) return false;

    try {
      const result = await fetchApi("/api/contacts/tags", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, status: "Lead" }),
      });
      const tagKey = tag.toLowerCase();
      setLeadTagCatalog((prev) =>
        prev.filter((current) => current.toLowerCase() !== tagKey),
      );
      setLeads((prev) =>
        prev.map((row) => {
          const nextTags = removeLeadTagFromList(row.tags, tagKey);
          return nextTags ? { ...row, tags: nextTags } : row;
        }),
      );
      setPreviewLead((current) => {
        if (!current) return current;
        const nextTags = removeLeadTagFromList(current.tags, tagKey);
        return nextTags ? { ...current, tags: nextTags } : current;
      });
      notify.success(
        `Deleted "${tag}" from ${result?.updatedContacts ?? 0} lead${(result?.updatedContacts ?? 0) === 1 ? "" : "s"}`,
      );
      return true;
    } catch (err) {
      notify.error(err?.body?.error || err?.message || "Failed to delete tag");
      return false;
    }
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
      normalizeLeadTags(lead.tags).join(" "),
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
  const sortedLeads = useMemo(() => {
    if (!sortConfig.key || !sortConfig.direction) return filteredLeads;
    const direction = sortConfig.direction === "desc" ? -1 : 1;
    const collator = new Intl.Collator(undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return [...filteredLeads].sort((a, b) => {
      const aValue = getLeadSortValue(a, sortConfig.key);
      const bValue = getLeadSortValue(b, sortConfig.key);
      const aNull = aValue === null || aValue === undefined || aValue === "";
      const bNull = bValue === null || bValue === undefined || bValue === "";
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      if (typeof aValue === "number" && typeof bValue === "number") {
        return (aValue - bValue) * direction;
      }
      return collator.compare(String(aValue), String(bValue)) * direction;
    });
  }, [
    filteredLeads,
    getLeadSortValue,
    sortConfig.direction,
    sortConfig.key,
  ]);

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

  const qualifiedAssignmentLeadKey = filteredLeads
    .map((l) => `${l.id}:${l.callifiedLeadStatus}:${l.assignedToId}`)
    .join(",");

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
  }, [isGeneric, staff.length, qualifiedAssignmentLeadKey]);

  const leadsPageCount = Math.max(
    1,
    Math.ceil(sortedLeads.length / leadsPageSize),
  );
  const currentLeadsPage = Math.min(leadsPage, leadsPageCount - 1);
  const pageStart =
    sortedLeads.length === 0 ? 0 : currentLeadsPage * leadsPageSize + 1;
  const pageEnd =
    sortedLeads.length === 0
      ? 0
      : Math.min(
          sortedLeads.length,
          currentLeadsPage * leadsPageSize + leadsPageSize,
        );
  const paginatedLeads = sortedLeads.slice(
    currentLeadsPage * leadsPageSize,
    currentLeadsPage * leadsPageSize + leadsPageSize,
  );
  const leadsRowSyncSignature = leadsRowSyncEnabled
    ? paginatedLeads
        .map((lead) =>
          [
            lead.id,
            lead.name,
            lead.email,
            lead.company,
            lead.phone,
            lead.source,
            Array.isArray(lead.tags) ? lead.tags.join(",") : String(lead.tags || ""),
            lead.assignedToId ?? "",
            lead.createdAt ?? "",
            lead.subBrand ?? "",
            lead.aiScore ?? "",
            lead.status ?? "",
            lead.callifiedLeadStatus ?? "",
            lead.callifiedCampaignId ?? "",
          ].join("|"),
        )
        .concat(
          isGeneric
            ? `::${genericHeaderSyncSignature}::${JSON.stringify(columnLayout)}`
            : "",
        )
    : "";

  useLayoutEffect(() => {
    if (!leadsRowSyncEnabled) return undefined;
    const frozenTable = leadsFrozenTableRef.current;
    const scrollableTable = leadsScrollableTableRef.current;
    if (!frozenTable || !scrollableTable) return undefined;
    syncSplitTableRowHeights();
    return () => {
      frozenTable?.querySelectorAll("thead tr, tbody tr").forEach((row) => {
        row.style.height = "";
      });
      scrollableTable
        ?.querySelectorAll("thead tr, tbody tr")
        .forEach((row) => {
          row.style.height = "";
      });
    };
  }, [leadsRowSyncEnabled, leadsRowSyncSignature, syncSplitTableRowHeights]);

  useLayoutEffect(() => {
    if (!genericHeaderSyncEnabled) return undefined;
    const frozenTable = leadsFrozenTableRef.current;
    const scrollableTable = leadsScrollableTableRef.current;
    if (!frozenTable || !scrollableTable) return undefined;
    syncGenericHeaderHeight();
    return () => {
      frozenTable?.querySelectorAll("thead tr").forEach((row) => {
        row.style.height = "";
      });
      scrollableTable?.querySelectorAll("thead tr").forEach((row) => {
        row.style.height = "";
      });
    };
  }, [
    genericHeaderSyncEnabled,
    genericHeaderSyncSignature,
    syncGenericHeaderHeight,
  ]);

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
  const getHeaderCellStyle = (key, extra = {}) => ({
    padding: "1rem",
    color: "var(--text-secondary)",
    fontWeight: "500",
    fontSize: "0.875rem",
    verticalAlign: "middle",
    overflow: "hidden",
    position: "relative",
    ...extra,
  });
  const getBodyCellStyle = (key, extra = {}) => ({
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    padding: "1rem",
    ...extra,
  });
  const renderColumnHeaderCell = (
    key,
    label,
    extra = {},
    cellProps = {},
    controls = null,
    leadingControls = null,
  ) => {
    const locked = key === "select" || key === "actions";
    const { key: headerKey, ...restCellProps } = cellProps;
    return (
      <th
        key={headerKey}
        {...restCellProps}
        style={getHeaderCellStyle(key, extra)}
        aria-label={`${label} column`}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-start",
            gap: "0.4rem",
            minWidth: 0,
          }}
        >
          {leadingControls}
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "normal",
            lineHeight: 1.2,
          }}
          >
            {label}
          </span>
          {controls && (
            <span style={{ display: "inline-flex", flexShrink: 0 }}>{controls}</span>
          )}
        </div>
        {!locked && (
          <span
            role="separator"
            aria-label={`Resize ${label} column`}
            aria-orientation="vertical"
            title={`Drag to resize ${label}`}
            onMouseDown={(e) => startColumnResize(key, e)}
            style={{
              position: "absolute",
              top: 0,
              right: 0,
              width: 8,
              height: "100%",
              cursor: "col-resize",
              touchAction: "none",
              borderRight: "2px solid transparent",
            }}
          />
        )}
      </th>
    );
  };
  const renderBuiltInLeadCell = ({
    lead,
    field,
    label,
    value,
    type,
    options,
    extraStyle = {},
    renderValue,
    required = false,
  }) => (
    <td
      style={getBodyCellStyle(field, extraStyle)}
      onClick={(e) => e.stopPropagation()}
    >
      <BuiltInInlineCellEditor
        lead={lead}
        field={field}
        label={label}
        value={value}
        type={type}
        options={options}
        onSave={updateLeadInlineValue}
        renderValue={renderValue}
      required={required}
    />
  </td>
  );
  const renderLeadUserHeaderCell = (column) => {
    if (!column) return null;
    return renderColumnHeaderCell(
      column.key,
      column.label,
      { paddingRight: "2rem" },
      column.customField
        ? {
            key: column.field?.id || column.key,
            className: "leads-custom-field-col",
          }
        : {},
      renderHeaderMenuTrigger(column),
    );
  };
  const renderLeadUserBodyCell = (lead, column) => {
    if (column.customField) {
      const field = column.field;
      const raw = lead.customFields?.[field.fieldKey];
      return (
        <td
          key={field.id}
          className="leads-custom-field-col"
          style={getBodyCellStyle(`cf_${field.fieldKey}`, {
            color: "var(--text-secondary)",
            fontSize: "0.875rem",
          })}
          onClick={(e) => e.stopPropagation()}
        >
          <InlineCellEditor
            contactId={lead.id}
            field={field}
            value={raw}
            onSaved={(newValue) => {
              setLeads((prev) =>
                prev.map((l) =>
                  l.id === lead.id
                    ? {
                        ...l,
                        customFields: {
                          ...(l.customFields || {}),
                          [field.fieldKey]: newValue,
                        },
                      }
                    : l,
                ),
              );
            }}
          />
        </td>
      );
    }
    switch (column.key) {
      case "email":
        return renderBuiltInLeadCell({
          lead,
          field: "email",
          label: "Email",
          value: lead.email,
          type: "email",
          extraStyle: { color: "var(--text-secondary)" },
        });
      case "company":
        return renderBuiltInLeadCell({
          lead,
          field: "company",
          label: isTravel ? "Category" : "Company",
          value: lead.company,
          extraStyle: { color: "var(--text-secondary)" },
        });
      case "phone":
        return renderBuiltInLeadCell({
          lead,
          field: "phone",
          label: "Phone",
          value: lead.phone,
          type: "tel",
          extraStyle: {
            color: "var(--text-secondary)",
            fontSize: "0.875rem",
          },
        });
      case "aiScore":
        return (
          <td style={getBodyCellStyle("aiScore")}>
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
        );
      case "source":
        return renderBuiltInLeadCell({
          lead,
          field: "source",
          label: "Source",
          value: leadSourceLabel(lead),
          type: "select",
          options: sourceFilterOptions,
          renderValue: (displayValue) => (
            <span style={sourceBadgeStyle}>{displayValue}</span>
          ),
        });
      case "tags":
        return (
          <td
            style={getBodyCellStyle("tags", { overflow: "visible" })}
            onClick={(e) => e.stopPropagation()}
          >
            <LeadTagsCell
              lead={lead}
              options={leadTagOptions}
              onSave={updateLeadInlineValue}
              onDeleteTag={handleDeleteLeadTag}
            />
          </td>
        );
      case "assignedTo":
        return (
          <td
            className="leads-assigned-col"
            style={getBodyCellStyle("assignedTo")}
            onClick={(e) => e.stopPropagation()}
          >
            {isAdmin || isTravel ? (
              <select
                className="input-field"
                value={lead.assignedToId || ""}
                onChange={(e) => handleAssign(lead.id, e.target.value)}
                style={{
                  padding: "0.375rem 0.5rem",
                  fontSize: "0.8rem",
                  minWidth: "130px",
                  background: "var(--input-bg)",
                }}
                aria-label={`Assign ${lead.name || "lead"} to staff`}
              >
                <option value="">Unassigned</option>
                {assignableStaff(lead).map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffOptionLabel(s)}
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
        );
      case "createdAt":
        return (
          <td
            style={getBodyCellStyle("createdAt", {
              color: "var(--text-secondary)",
              fontSize: "0.875rem",
            })}
          >
            {formatDate(lead.createdAt)}
          </td>
        );
      default:
        return null;
    }
  };
  const previewLeadCurrent = previewLead
    ? leads.find((lead) => lead.id === previewLead.id) || previewLead
    : null;
  const previewCampaign =
    previewLeadCurrent &&
    callifiedCampaigns.find(
      (c) => String(c.id) === String(previewLeadCurrent.callifiedCampaignId),
    );
  const previewStatus = previewLeadCurrent
    ? getCallStatusMeta(previewLeadCurrent.callifiedLeadStatus)
    : null;
  const headerMenuRect = headerMenuState?.rect || null;
  const headerMenuOpenUp = Boolean(
    headerMenuRect &&
      window.innerHeight - headerMenuRect.bottom - 12 < 260 &&
      headerMenuRect.top > 260,
  );
  const headerMenuTop = headerMenuRect
    ? Math.max(12, headerMenuRect.bottom + LEADS_HEADER_MENU_GAP)
    : 0;
  const headerMenuBottom = headerMenuRect
    ? Math.max(12, window.innerHeight - headerMenuRect.top + LEADS_HEADER_MENU_GAP)
    : 0;
  const headerMenuLeft = headerMenuRect
    ? Math.max(
        12,
        Math.min(
          window.innerWidth - LEADS_HEADER_MENU_WIDTH - 12,
          headerMenuRect.left,
        ),
      )
    : 0;
  const headerMenuMaxHeight = headerMenuRect
    ? Math.max(
        220,
        Math.min(
          headerMenuOpenUp
            ? headerMenuRect.top - 12
            : window.innerHeight - headerMenuRect.bottom - 12,
          420,
        ),
      )
    : 0;
  const headerSubmenuLeft = headerMenuRect
    ? Math.max(
        12,
        Math.min(
          window.innerWidth - LEADS_HEADER_MENU_SUBMENU_WIDTH - 12,
          headerMenuLeft + LEADS_HEADER_MENU_WIDTH + LEADS_HEADER_MENU_GAP,
        ),
      )
    : 0;
  const headerSubmenuOpenLeft =
    headerMenuRect &&
    headerMenuLeft +
      LEADS_HEADER_MENU_WIDTH +
      LEADS_HEADER_MENU_SUBMENU_WIDTH +
      (LEADS_HEADER_MENU_GAP * 2) >
      window.innerWidth;
  const headerSubmenuFallbackLeft = headerMenuRect
    ? Math.max(
        12,
        headerMenuLeft - LEADS_HEADER_MENU_SUBMENU_WIDTH - LEADS_HEADER_MENU_GAP,
      )
    : 0;
  const headerSubmenuActualLeft = headerSubmenuOpenLeft
    ? headerSubmenuFallbackLeft
    : headerSubmenuLeft;
  const headerSubmenuMaxHeight = headerMenuRect ? headerMenuMaxHeight : 0;

  return (
    <div style={{ padding: "2rem", animation: "fadeIn 0.3s ease" }}>
      {/* Renders only when this page was opened as a drill-down from a report. */}
      <ReturnToBanner />
      <header
        style={{
          marginBottom: "1rem",
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
      </header>
      <div
        style={{
          ...compactToolbarSurfaceStyle,
          marginBottom: "1rem",
          justifyContent: "flex-start",
        }}
      >
          <button
            type="button"
            className="btn-secondary"
            onClick={refreshAll}
            style={{
              ...compactToolbarButtonStyle,
            }}
          >
            <RefreshCw size={14} /> Refresh
          </button>

          {(isGeneric || isWellness) && (
            <CsvImportExportToolbar
              entity="contacts"
              label="Leads"
              formats={["csv", "xlsx"]}
              compact
              endpoints={{
                export: "/api/csv/contacts/export.csv",
                template: "/api/csv/contacts/template.csv",
                meta: "/api/csv/contacts",
                import: "/api/csv/contacts/import.csv",
              }}
            />
          )}

          <span aria-hidden="true" style={compactToolbarDividerStyle} />

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
                  aria-haspopup="menu"
                  aria-expanded={autoCampaignRulesOpen}
                  style={{
                    ...compactToolbarButtonStyle,
                    minWidth: "160px",
                    padding: "0.42rem 0.7rem",
                    cursor: "pointer",
                    position: "relative",
                  }}
                  aria-label="Auto-assign Callified Campaigns rules"
                  title="Configure rules to automatically assign Callified campaigns to new leads"
                >
                  <Settings size={14} />
                  <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.05 }}>
                    <span>Auto-assign</span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>Callified Campaigns</span>
                  </span>
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
                  aria-haspopup="menu"
                  aria-expanded={campaignDropdownOpen}
                  style={{
                    ...compactToolbarButtonStyle,
                    minWidth: "175px",
                    padding: "0.42rem 0.7rem",
                    cursor: "pointer",
                  }}
                >
                  <Filter size={14} />
                  {selectedCampaignIds.length === 0
                    ? "Select campaigns to dial"
                    : `${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? "" : "s"} selected`}
                  {campaignDropdownOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
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
                  ...compactToolbarButtonStyle,
                  padding: "0.42rem 0.7rem",
                }}
              >
                {callQueueActive ? (
                  <>
                    <RefreshCw
                      size={14}
                      style={{ animation: "spin 1s linear infinite" }}
                    />{" "}
                    Dialling...
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
                  ...compactToolbarButtonStyle,
                  padding: "0.42rem 0.7rem",
                }}
              >
                <Phone size={14} /> Call Status
              </button>
            </>
          )}

          <span aria-hidden="true" style={compactToolbarDividerStyle} />

          <div style={{ position: "relative" }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleLeadBulkActionsToggle}
                aria-haspopup="menu"
                aria-expanded={leadBulkActionsOpen}
                style={{
                  ...compactToolbarButtonStyle,
                  padding: "0.42rem 0.7rem",
                }}
              >
              <SlidersHorizontal size={14} />
              Bulk actions
              {leadBulkActionsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {selectedLeads.length > 0 && (
                <span
                  style={{
                    minWidth: 18,
                    height: 18,
                    padding: "0 5px",
                    borderRadius: 999,
                    background: "var(--accent-color)",
                    color: "#fff",
                    fontSize: "0.7rem",
                    fontWeight: 600,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {selectedLeads.length}
                </span>
              )}
            </button>
            {leadBulkActionsOpen && (
              <>
                <div
                  style={{
                    position: "fixed",
                    inset: 0,
                    zIndex: 1088,
                    background: "transparent",
                  }}
                  onClick={() => setLeadBulkActionsOpen(false)}
                />
                <div
                  role="menu"
                  aria-label="Bulk actions"
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    left: 0,
                    right: "auto",
                    zIndex: 1089,
                    width: "min(420px, 92vw)",
                    padding: "0.85rem",
                    background: "var(--bg-color)",
                    border: "1px solid var(--border-color)",
                    borderRadius: 12,
                    boxShadow: "0 12px 32px rgba(0,0,0,0.2)",
                    display: "grid",
                    gap: "0.75rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.5rem",
                    }}
                  >
                    <strong
                      style={{
                        fontSize: "0.9rem",
                        color: "var(--text-primary)",
                      }}
                    >
                      Bulk actions
                    </strong>
                    <span
                      style={{
                        fontSize: "0.78rem",
                        color: "var(--text-secondary)",
                      }}
                    >
                      {selectedLeads.length} selected
                    </span>
                  </div>
                  {selectedLeads.length === 0 ? (
                    <div
                      style={{
                        fontSize: "0.85rem",
                        color: "var(--text-secondary)",
                        lineHeight: 1.5,
                      }}
                    >
                      Select one or more leads to use bulk actions.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "grid",
                        gap: "0.65rem",
                      }}
                    >
                      {isGeneric && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setLeadBulkActionsOpen(false);
                            handleDialSelectedLeads();
                          }}
                          disabled={callQueueActive}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "0.35rem",
                            fontSize: "0.85rem",
                          }}
                        >
                          <Phone size={14} /> Dial selected
                        </button>
                      )}
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "0.5rem",
                          flexWrap: "wrap",
                        }}
                      >
                        <select
                          className="input-field"
                          value={bulkAgent}
                          onChange={(e) => setBulkAgent(e.target.value)}
                          style={{
                            flex: 1,
                            minWidth: 180,
                            padding: "0.5rem",
                          }}
                          aria-label="Bulk assign staff"
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
                          onClick={() => {
                            setLeadBulkActionsOpen(false);
                            handleBulkAssign();
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "0.35rem",
                            fontSize: "0.85rem",
                          }}
                        >
                          Assign to staff
                        </button>
                      </div>
                      {isGeneric && callifiedConfigured && (
                        <button
                          type="button"
                          className="btn-secondary"
                          onClick={() => {
                            setLeadBulkActionsOpen(false);
                            setBulkCampaignDropdownOpen(true);
                          }}
                          disabled={bulkCampaignSaving}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: "0.35rem",
                            fontSize: "0.85rem",
                          }}
                          >
                          <Filter size={14} /> Assign campaign
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn-danger"
                        onClick={() => {
                          handleBulkDelete();
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "0.35rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        <Trash2 size={14} /> Delete selected leads
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setSelectedLeads([]);
                          setBulkAgent("");
                          setBulkCampaignDropdownOpen(false);
                          setLeadBulkActionsOpen(false);
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                          gap: "0.35rem",
                          fontSize: "0.85rem",
                        }}
                      >
                        Clear selection
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

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
                padding: "0.42rem 0.7rem",
              }}
            >
              {callQueueActive ? (
                <>
                  <RefreshCw
                    size={14}
                    style={{ animation: "spin 1s linear infinite" }}
                  />{" "}
                  Dialling...
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
                  padding: "0.42rem 0.7rem",
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
              marginLeft: "auto",
            }}
          >
            <Plus size={16} /> Create Lead
          </button>
        </div>

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
        style={{ overflow: "hidden" }}
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.65rem",
              flexWrap: "wrap",
              minWidth: 0,
              flex: "1 1 520px",
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

            <FilterPanel
              fieldsUrl="/api/contacts/filter-fields?status=Lead"
              valuesUrl={(field) => `/api/contacts/filter-values/${field}?status=Lead`}
              filters={advancedFilters}
              onChange={setAdvancedFilters}
              triggerLabel="Filter by"
              triggerIcon={
                <span style={{ display: "inline-flex", alignItems: "center", gap: "0.15rem" }}>
                  <Filter size={14} />
                  <ChevronDown size={12} />
                </span>
              }
              showSelectedFilters={false}
              showCountBadge
              compactTrigger
              buttonTitle="Filter leads"
              buttonAriaLabel="Filter by"
              buttonStyle={{
                ...compactToolbarButtonStyle,
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
            {hasActiveLeadFilters && (
              <button
                type="button"
                className="btn-secondary"
                onClick={resetFilters}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                }}
              >
                <RefreshCw size={13} /> Reset filters
              </button>
            )}
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
        <div className="leads-split-table">
          <div
            className="leads-table-frozen-pane"
            style={{ width: leadsFrozenTableWidthPx }}
          >
            <div className="leads-table-frozen-spacer" />
            <table
              ref={leadsFrozenTableRef}
              className={`${leadsTableClassName} leads-table--frozen`}
              style={{
                width: leadsFrozenTableWidthPx,
                borderCollapse: "separate",
                borderSpacing: 0,
                textAlign: "left",
                minWidth: leadsFrozenTableWidthPx,
                tableLayout: "fixed",
              }}
            >
              <colgroup>
                {leadsFrozenColumnDefs.map((column) => (
                  <col
                    key={column.key}
                    style={{ width: `${getColumnWidth(column.key)}px` }}
                  />
                ))}
              </colgroup>
              <thead>
                <tr
                  style={{
                    backgroundColor: "var(--table-header-bg)",
                  }}
                >
                  {renderColumnHeaderCell(
                    "name",
                    "Name",
                    { paddingRight: "2rem" },
                    {},
                    renderHeaderMenuTrigger({ key: "name", label: "Name" }),
                    isAdmin ? (
                      <input
                        type="checkbox"
                        checked={
                          selectedLeads.length === filteredLeads.length &&
                          filteredLeads.length > 0
                        }
                        onChange={toggleSelectAll}
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Select all leads"
                        style={{
                          cursor: "pointer",
                          flexShrink: 0,
                          margin: 0,
                        }}
                      />
                    ) : null,
                  )}
                </tr>
              </thead>
              <tbody>
                {loading || filteredLeads.length === 0 ? (
                  <tr>
                    <td
                      style={getBodyCellStyle("name", { fontWeight: "500" })}
                    />
                  </tr>
                ) : (
                  paginatedLeads.map((lead) => (
                    <tr
                      key={lead.id}
                      style={{
                        cursor: "pointer",
                      }}
                      className="table-row-hover"
                      onClick={() => navigate(leadDetailPath(lead))}
                      title="Open lead detail"
                    >
                      <td
                        style={getBodyCellStyle("name", { fontWeight: "500" })}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "0.5rem",
                            minWidth: 0,
                          }}
                        >
                          {isAdmin && (
                            <input
                              type="checkbox"
                              checked={selectedLeads.includes(lead.id)}
                              onChange={() => toggleSelect(lead.id)}
                              onClick={(e) => e.stopPropagation()}
                              aria-label={`Select ${lead.name || "lead"}`}
                              style={{
                                cursor: "pointer",
                                flexShrink: 0,
                                margin: 0,
                              }}
                            />
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <BuiltInInlineCellEditor
                              lead={lead}
                              field="name"
                              label="Name"
                              value={lead.name}
                              onSave={updateLeadInlineValue}
                              required
                              editOnDisplayClick={false}
                              renderValue={(name) => (
                                <a
                                  href={leadDetailPath(lead)}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    navigate(leadDetailPath(lead));
                                  }}
                                  title={`Open profile for ${lead.name || "lead"}`}
                                  style={{
                                    minWidth: 0,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                    color: "var(--accent-color)",
                                    fontWeight: 700,
                                    textDecoration: "none",
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.textDecoration = "underline";
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.textDecoration = "none";
                                  }}
                                >
                                  {name || "Unnamed lead"}
                                </a>
                              )}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="leads-table-scroll-pane">
            <TopScrollSync
              forceScrollbar
              scrollWidth={leadsScrollableTableMinWidth}
              stickyTop
              stickyTopOffset={0}
              hideBottomScrollbar
            >
              <table
                ref={leadsScrollableTableRef}
                className={`${leadsTableClassName} leads-table--scrollable`}
                style={{
                  width: "100%",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                  textAlign: "left",
                  minWidth: leadsScrollableTableMinWidth,
                  tableLayout: "fixed",
                }}
              >
                <colgroup>
                  {leadsScrollableColumnDefs.map((column) => (
                    <col
                      key={column.key}
                      style={{ width: `${getColumnWidth(column.key)}px` }}
                    />
                  ))}
                </colgroup>
                <thead>
                  <tr
                    style={{
                      backgroundColor: "var(--table-header-bg)",
                    }}
                  >
                    {leadUserColumnDefs.map((column) => (
                      <Fragment key={column.key}>
                        {renderLeadUserHeaderCell(column)}
                      </Fragment>
                    ))}
                    {isGeneric &&
                      renderColumnHeaderCell(
                        "campaign",
                        "Callified Campaign",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({
                          key: "campaign",
                          label: "Callified Campaign",
                        }),
                      )}
                    {isGeneric &&
                      renderColumnHeaderCell(
                        "callStatus",
                        "Call Status",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({
                          key: "callStatus",
                          label: "Call Status",
                        }),
                      )}
                    {isGeneric &&
                      renderColumnHeaderCell(
                        "callifiedAi",
                        "Callified AI call",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({
                          key: "callifiedAi",
                          label: "Callified AI call",
                        }),
                      )}
                    {isGeneric &&
                      renderColumnHeaderCell(
                        "callifiedScore",
                        "Callified Score",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({
                          key: "callifiedScore",
                          label: "Callified Score",
                        }),
                      )}
                    {isTravel &&
                      renderColumnHeaderCell(
                        "subBrand",
                        "Sub-brand",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({
                          key: "subBrand",
                          label: "Sub-brand",
                        }),
                      )}
                    {isTravel &&
                      renderColumnHeaderCell(
                        "amount",
                        "Amount",
                        { paddingRight: "2rem" },
                        {},
                        renderHeaderMenuTrigger({ key: "amount", label: "Amount" }),
                      )}
                    {renderColumnHeaderCell("actions", "Actions", {
                      padding: "1rem 0.5rem",
                      whiteSpace: "nowrap",
                    })}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td
                        colSpan={leadsScrollableColumnDefs.length}
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
                        colSpan={leadsScrollableColumnDefs.length}
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
                          cursor: "pointer",
                        }}
                        className="table-row-hover"
                        onClick={() => navigate(leadDetailPath(lead))}
                        title="Open lead detail"
                      >
                        {leadUserColumnDefs.map((column) => (
                          <Fragment key={column.key}>
                            {renderLeadUserBodyCell(lead, column)}
                          </Fragment>
                        ))}
                        {isGeneric && (
                          <td
                            style={getBodyCellStyle("campaign")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ScrollableSelect
                              value={
                                lead.callifiedCampaignId
                                  ? String(lead.callifiedCampaignId)
                                  : ""
                              }
                              onChange={(campaignId) =>
                                handleCampaignChange(lead, campaignId)
                              }
                              disabled={!callifiedConfigured}
                              width={160}
                              maxVisibleRows={5}
                              ariaLabel={`Assign Callified campaign for ${lead.name || "lead"}`}
                              placeholder="—"
                              options={[
                                { value: "", label: "—" },
                                ...callifiedCampaigns.map((c) => ({
                                  value: String(c.id),
                                  label: `${c.name || `Campaign ${c.id}`}${c.product_name ? ` — ${c.product_name}` : ""}`,
                                })),
                              ]}
                            />
                          </td>
                        )}
                        {isGeneric && (
                          <td
                            style={getBodyCellStyle("callStatus")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(() => {
                              const queueItem = callQueue.find(
                                (q) => q.lead.id === lead.id,
                              );
                              const isConnected =
                                queueItem &&
                                (queueItem.status === "calling" ||
                                  queueItem.status ===
                                    "waiting_for_completion");
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
                                      handleLeadStatusChange(
                                        lead,
                                        e.target.value,
                                      )
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
                            style={getBodyCellStyle("callifiedAi")}
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
                                handleSingleDial(
                                  lead,
                                  lead.callifiedCampaignId,
                                );
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
                            style={getBodyCellStyle("callifiedScore")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {(() => {
                              const score =
                                callifiedSummaries[lead.id]?.lastScore;
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
                                  <span style={{ marginLeft: 4 }}>
                                    {score}/5
                                  </span>
                                </span>
                              );
                            })()}
                          </td>
                        )}
                        {isTravel && (
                          <td
                            style={getBodyCellStyle("subBrand", {
                              color: "var(--text-secondary)",
                              fontSize: "0.875rem",
                            })}
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
                                  style={getBodyCellStyle("amount", {
                                    fontWeight: 500,
                                    fontSize: "0.875rem",
                                  })}
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
                                  style={getBodyCellStyle("amount", {
                                    fontWeight: 500,
                                    fontSize: "0.875rem",
                                  })}
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
                                style={getBodyCellStyle("amount", {
                                  fontWeight: 500,
                                  fontSize: "0.875rem",
                                })}
                              >
                                {total > 0 ? (
                                  `${currency} ${total.toLocaleString()}`
                                ) : (
                                  <span
                                    style={{ color: "var(--text-secondary)" }}
                                  >
                                    -
                                  </span>
                                )}
                              </td>
                            );
                          })()}
                        <td
                          style={getBodyCellStyle("actions", {
                            padding: "0.75rem 0.5rem",
                            minWidth: `${LEADS_ACTIONS_COLUMN_WIDTH}px`,
                            overflow: "visible",
                            textOverflow: "clip",
                          })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {wellnessCall.enabled && (
                            <WellnessLeadCallButton
                              lead={lead}
                              onCall={() => wellnessCall.open(lead)}
                            />
                          )}
                          <button
                            onClick={() => setPreviewLead(lead)}
                            title="Preview lead"
                            aria-label={`Preview ${lead.name || "lead"}`}
                            style={actionIconBtn}
                          >
                            <Eye size={15} />
                          </button>
                          <button
                            onClick={() => openEdit(lead)}
                            title="Edit lead"
                            style={{ ...actionIconBtn, marginLeft: 6 }}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            onClick={() => handleConvert(lead.id)}
                            title="Convert to Prospect"
                            aria-label={`Convert ${lead.name || "lead"} to Prospect`}
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
          </div>
        </div>
        <WellnessLeadCallDialog
          lead={wellnessCall.target}
          onClose={wellnessCall.close}
        />
        {headerMenuState &&
          headerMenuRect &&
          createPortal(
            <>
              <div
                style={{
                  position: "fixed",
                  inset: 0,
                  zIndex: 1094,
                  background: "transparent",
                }}
                onMouseDown={closeHeaderMenu}
              />
              <div
                role="menu"
                aria-label={`${headerMenuState.label} column menu`}
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                  position: "fixed",
                  left: headerMenuLeft,
                  top: headerMenuOpenUp ? undefined : headerMenuTop,
                  bottom: headerMenuOpenUp ? headerMenuBottom : undefined,
                  width: LEADS_HEADER_MENU_WIDTH,
                  maxHeight: headerMenuMaxHeight,
                  overflowY: "auto",
                  zIndex: 1095,
                  background: "var(--bg-color)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 12,
                  boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
                  padding: "0.35rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "0.5rem",
                    padding: "0.25rem 0.4rem 0.45rem",
                    borderBottom: "1px solid var(--border-color)",
                    marginBottom: "0.25rem",
                  }}
                >
                  <strong
                    style={{
                      fontSize: "0.85rem",
                      color: "var(--text-primary)",
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {headerMenuState.label}
                  </strong>
                  <button
                    type="button"
                    onClick={closeHeaderMenu}
                    aria-label="Close column menu"
                    style={{
                      ...actionIconBtn,
                      width: 26,
                      height: 26,
                      padding: 0,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <X size={14} />
                  </button>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSortConfig({ key: headerMenuState.key, direction: "asc" });
                    closeHeaderMenu();
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    padding: "0.55rem 0.45rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    borderRadius: 8,
                    fontSize: "0.88rem",
                    textAlign: "left",
                  }}
                  className="table-row-hover"
                >
                  <ChevronUp size={15} />
                  <span>Sort ascending A to Z</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSortConfig({ key: headerMenuState.key, direction: "desc" });
                    closeHeaderMenu();
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    padding: "0.55rem 0.45rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    cursor: "pointer",
                    borderRadius: 8,
                    fontSize: "0.88rem",
                    textAlign: "left",
                  }}
                  className="table-row-hover"
                >
                  <ChevronDown size={15} />
                  <span>Sort descending Z to A</span>
                </button>
                {isGeneric && !headerMenuState.fixedExtra && (
                  <>
                    <button
                      type="button"
                      onClick={() => setHeaderMenuSubmenu({ side: "right" })}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.55rem",
                        padding: "0.55rem 0.45rem",
                        border: "none",
                        background: "transparent",
                        color: "var(--text-primary)",
                        cursor: "pointer",
                        borderRadius: 8,
                        fontSize: "0.88rem",
                        textAlign: "left",
                      }}
                      className="table-row-hover"
                    >
                      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}>
                        <Plus size={15} />
                        <span>Add column to the right</span>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                    {headerMenuState.key !== "name" && (
                      <button
                        type="button"
                        onClick={() => setHeaderMenuSubmenu({ side: "left" })}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "0.55rem",
                          padding: "0.55rem 0.45rem",
                          border: "none",
                          background: "transparent",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          borderRadius: 8,
                          fontSize: "0.88rem",
                          textAlign: "left",
                        }}
                        className="table-row-hover"
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}>
                          <Plus size={15} />
                          <span>Add column to the left</span>
                        </span>
                        <ChevronLeft size={14} />
                      </button>
                    )}
                    {headerMenuState.key !== "name" && (
                      <button
                        type="button"
                        onClick={() => {
                          collapseColumn(headerMenuState.key);
                          closeHeaderMenu();
                        }}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.55rem",
                          padding: "0.55rem 0.45rem",
                          border: "none",
                          background: "transparent",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          borderRadius: 8,
                          fontSize: "0.88rem",
                          textAlign: "left",
                        }}
                        className="table-row-hover"
                      >
                        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.55rem" }}>
                          <ChevronLeft size={15} />
                          <span>
                            {columnLayout.collapsed?.[headerMenuState.key]
                              ? "Expand column"
                              : "Collapse column"}
                          </span>
                        </span>
                      </button>
                    )}
                    {headerMenuState.key !== "name" && (
                      <button
                        type="button"
                        onClick={() => removeColumnFromTable(headerMenuState.key)}
                        style={{
                          width: "100%",
                          display: "flex",
                          alignItems: "center",
                          gap: "0.55rem",
                          padding: "0.55rem 0.45rem",
                          border: "none",
                          background: "transparent",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          borderRadius: 8,
                          fontSize: "0.88rem",
                          textAlign: "left",
                        }}
                        className="table-row-hover"
                      >
                        <X size={15} />
                        <span>Remove column</span>
                      </button>
                    )}
                  </>
                )}
                {isGeneric && (
                  <button
                    type="button"
                    onClick={openColumnPickerFromMenu}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.55rem",
                      padding: "0.55rem 0.45rem",
                      border: "none",
                      background: "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      borderRadius: 8,
                      fontSize: "0.88rem",
                      textAlign: "left",
                    }}
                    className="table-row-hover"
                  >
                    <SlidersHorizontal size={15} />
                    <span>Edit all columns</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    if (!headerMenuState.customField) return;
                    openRenameField();
                    closeHeaderMenu();
                  }}
                  disabled={!headerMenuState.customField}
                  title={
                    headerMenuState.customField
                      ? "Rename field"
                      : "Available for custom fields only"
                  }
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.55rem",
                    padding: "0.55rem 0.45rem",
                    border: "none",
                    background: "transparent",
                    color: "var(--text-primary)",
                    cursor: headerMenuState.customField ? "pointer" : "not-allowed",
                    borderRadius: 8,
                    fontSize: "0.88rem",
                    textAlign: "left",
                    opacity: headerMenuState.customField ? 1 : 0.45,
                  }}
                  className="table-row-hover"
                >
                  <Pencil size={15} />
                  <span>Rename field</span>
                </button>
                {getHeaderFilterConfig(headerMenuState) && (
                  <button
                    type="button"
                    onClick={() => openHeaderFilter(headerMenuState)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: "0.55rem",
                      padding: "0.55rem 0.45rem",
                      border: "none",
                      background: "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      borderRadius: 8,
                      fontSize: "0.88rem",
                      textAlign: "left",
                    }}
                    className="table-row-hover"
                  >
                    <Filter size={15} />
                    <span>Add as filter</span>
                  </button>
                )}
                {headerMenuSubmenu && isGeneric && !headerMenuState.fixedExtra && (
                  <div
                    role="menu"
                    aria-label={`${headerMenuState.label} add column submenu`}
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{
                      position: "fixed",
                      left: headerSubmenuActualLeft,
                      top: headerMenuOpenUp ? undefined : headerMenuTop,
                      bottom: headerMenuOpenUp ? headerMenuBottom : undefined,
                      width: LEADS_HEADER_MENU_SUBMENU_WIDTH,
                      maxHeight: headerSubmenuMaxHeight,
                      overflowY: "auto",
                      zIndex: 1096,
                      background: "var(--bg-color)",
                      border: "1px solid var(--border-color)",
                      borderRadius: 12,
                      boxShadow: "0 12px 32px rgba(0,0,0,0.25)",
                      padding: "0.35rem",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "0.5rem",
                        padding: "0.25rem 0.4rem 0.45rem",
                        borderBottom: "1px solid var(--border-color)",
                        marginBottom: "0.25rem",
                      }}
                    >
                      <strong
                        style={{
                          fontSize: "0.85rem",
                          color: "var(--text-primary)",
                        }}
                      >
                        Select field
                      </strong>
                      <button
                        type="button"
                        onClick={openColumnPickerFromMenu}
                        style={{
                          background: "transparent",
                          border: "none",
                          color: "var(--accent-color)",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                        }}
                      >
                        Edit all columns
                      </button>
                    </div>
                    <div style={{ padding: "0.4rem 0.45rem 0.35rem" }}>
                      <div style={{ position: "relative" }}>
                        <Search
                          size={14}
                          style={{
                            position: "absolute",
                            left: "0.6rem",
                            top: "50%",
                            transform: "translateY(-50%)",
                            color: "var(--text-secondary)",
                          }}
                        />
                        <input
                          value={headerMenuSearch}
                          onChange={(e) => setHeaderMenuSearch(e.target.value)}
                          placeholder="Search fields..."
                          aria-label="Search column fields"
                          className="input-field"
                          style={{
                            padding: "0.4rem 0.6rem 0.4rem 1.9rem",
                            fontSize: "0.85rem",
                          }}
                        />
                      </div>
                    </div>
                    <div style={{ overflowY: "auto", maxHeight: "280px" }}>
                      {(leadColumnCatalog.length === 0 ? [] : leadColumnCatalog)
                        .filter((column) => column.key !== "name")
                        .filter((column) => column.key !== headerMenuState.key)
                        .filter((column) => {
                          const term = headerMenuSearch.trim().toLowerCase();
                          if (!term) return true;
                          return (
                            column.label.toLowerCase().includes(term) ||
                            column.key.toLowerCase().includes(term)
                          );
                        })
                        .map((column) => (
                          <button
                            type="button"
                            key={column.key}
                            onClick={() =>
                              addColumnAdjacent(
                                headerMenuState.key,
                                headerMenuSubmenu.side,
                                column.key,
                              )
                            }
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              gap: "0.5rem",
                              padding: "0.5rem 0.45rem",
                              border: "none",
                              background: "transparent",
                              color: "var(--text-primary)",
                              cursor: "pointer",
                              borderRadius: 8,
                              fontSize: "0.88rem",
                              textAlign: "left",
                            }}
                            className="table-row-hover"
                          >
                            <span
                              style={{
                                minWidth: 0,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {column.label}
                            </span>
                            {currentVisibleLeadColumns.includes(column.key) && (
                              <span
                                style={{
                                  fontSize: "0.72rem",
                                  color: "var(--text-secondary)",
                                  flexShrink: 0,
                                }}
                              >
                                Visible
                              </span>
                            )}
                          </button>
                        ))}
                      {leadColumnCatalog.length === 0 && (
                        <div
                          style={{
                            padding: "0.75rem 0.45rem",
                            color: "var(--text-secondary)",
                            fontSize: "0.85rem",
                          }}
                        >
                          Loading fields...
                        </div>
                      )}
                      {leadColumnCatalog.length > 0 &&
                        leadColumnCatalog
                          .filter((column) => column.key !== "name")
                          .filter((column) => column.key !== headerMenuState.key)
                          .filter((column) => {
                            const term = headerMenuSearch.trim().toLowerCase();
                            if (!term) return true;
                            return (
                              column.label.toLowerCase().includes(term) ||
                              column.key.toLowerCase().includes(term)
                            );
                          }).length === 0 && (
                          <div
                            style={{
                              padding: "0.75rem 0.45rem",
                              color: "var(--text-secondary)",
                              fontSize: "0.85rem",
                            }}
                          >
                            No matching fields.
                          </div>
                        )}
                    </div>
                  </div>
                )}
              </div>
            </>,
            document.body,
          )}
        {headerFilterRequest && (
          <FilterPanel
            fieldsUrl="/api/contacts/filter-fields?status=Lead"
            valuesUrl={(field) => `/api/contacts/filter-values/${field}?status=Lead`}
            filters={advancedFilters}
            onChange={setAdvancedFilters}
            fieldKey={headerFilterRequest.fieldKey}
            fieldLabel={headerFilterRequest.label}
            fieldKind={headerFilterRequest.kind}
            autoOpen
            hideTrigger
            showSelectedFilters={false}
            showCountBadge={false}
            onClose={() => setHeaderFilterRequest(null)}
          />
        )}
        {renameFieldState && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Rename ${renameFieldState.label || "field"}`}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                setRenameFieldState(null);
              }
            }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1097,
              background: "rgba(0,0,0,0.25)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1rem",
            }}
          >
            <div
              className="card"
              onMouseDown={(e) => e.stopPropagation()}
              style={{
                width: "min(420px, 100%)",
                background: "var(--bg-color)",
                borderRadius: 12,
                boxShadow: "0 16px 36px rgba(0,0,0,0.3)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "0.75rem",
                  padding: "1rem 1rem 0.75rem",
                  borderBottom: "1px solid var(--border-color)",
                }}
              >
                <strong style={{ fontSize: "0.95rem" }}>Rename field</strong>
                <button
                  type="button"
                  onClick={() => setRenameFieldState(null)}
                  aria-label="Close rename dialog"
                  style={actionIconBtn}
                >
                  <X size={14} />
                </button>
              </div>
              <div style={{ padding: "1rem" }}>
                <label
                  htmlFor="rename-field-label"
                  style={{
                    display: "block",
                    marginBottom: "0.4rem",
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  Field label
                </label>
                <input
                  id="rename-field-label"
                  className="input-field"
                  value={renameFieldState.label}
                  onChange={(e) =>
                    setRenameFieldState((prev) => ({
                      ...(prev || {}),
                      label: e.target.value,
                    }))
                  }
                  style={{ width: "100%" }}
                />
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: "0.5rem",
                  padding: "0 1rem 1rem",
                }}
              >
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setRenameFieldState(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={renameCustomField}
                  disabled={!renameFieldState.label.trim()}
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}
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

      {previewLeadCurrent && (
        <div
          onClick={(e) => {
            if (e.target === e.currentTarget) setPreviewLead(null);
          }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            justifyContent: "flex-end",
            zIndex: 1000,
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Lead preview"
        >
          <aside
            className="card"
            style={{
              width: "min(520px, 100vw)",
              height: "100vh",
              overflowY: "auto",
              borderRadius: 0,
              background: "var(--bg-color)",
              color: "var(--text-primary)",
              padding: "1.25rem",
              boxShadow: "-18px 0 40px rgba(15, 23, 42, 0.28)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.78rem",
                  }}
                >
                  Lead preview
                </div>
                <h2 style={{ margin: "0.2rem 0 0", fontSize: "1.25rem" }}>
                  {previewLeadCurrent.name || "Unnamed lead"}
                </h2>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  {previewLeadCurrent.title ||
                    previewLeadCurrent.company ||
                    "No title or company yet"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewLead(null)}
                aria-label="Close lead preview"
                style={actionIconBtn}
              >
                <X size={16} />
              </button>
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
                gap: "0.75rem",
                marginTop: "1rem",
              }}
            >
              <div className="card" style={{ padding: "0.85rem" }}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.72rem",
                  }}
                >
                  Score
                </div>
                <strong>{previewLeadCurrent.aiScore ?? 0}/100</strong>
              </div>
              <div className="card" style={{ padding: "0.85rem" }}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.72rem",
                  }}
                >
                  Source
                </div>
                <strong>{leadSourceLabel(previewLeadCurrent)}</strong>
              </div>
              <div className="card" style={{ padding: "0.85rem" }}>
                <div
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: "0.72rem",
                  }}
                >
                  Assigned
                </div>
                <strong>
                  {previewLeadCurrent.assignedTo?.name ||
                    previewLeadCurrent.assignedTo?.email ||
                    "Unassigned"}
                </strong>
              </div>
            </div>

            {isGeneric && (
              <div
                style={{
                  marginTop: "1rem",
                  padding: "0.85rem",
                  border: "1px solid var(--border-color)",
                  borderRadius: 8,
                  background: "var(--surface-color)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: "0.75rem",
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "0.8rem",
                    }}
                  >
                    Call status
                  </span>
                  <span
                    style={{
                      padding: "0.2rem 0.65rem",
                      borderRadius: "999px",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      background: previewStatus?.bg,
                      color: previewStatus?.color,
                    }}
                  >
                    {previewStatus?.label || "New"}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: "0.6rem",
                    color: "var(--text-secondary)",
                    fontSize: "0.85rem",
                  }}
                >
                  Campaign: {previewCampaign?.name || "Not assigned"}
                </div>
              </div>
            )}

            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                flexWrap: "wrap",
                marginTop: "1rem",
              }}
            >
              <button
                type="button"
                className="btn-secondary"
                onClick={() => navigate(leadDetailPath(previewLeadCurrent))}
              >
                Open full detail
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  openEdit(previewLeadCurrent);
                  setPreviewLead(null);
                }}
              >
                Edit lead
              </button>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => handleConvert(previewLeadCurrent.id)}
              >
                Convert to Prospect
              </button>
            </div>

            <section style={{ marginTop: "1.25rem" }}>
              <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>
                Contact information
              </h3>
              {[
                ["Email", previewLeadCurrent.email],
                ["Phone", previewLeadCurrent.phone],
                [isTravel ? "Category" : "Company", previewLeadCurrent.company],
                ["Title", previewLeadCurrent.title],
                ["Created", formatDate(previewLeadCurrent.createdAt)],
              ].map(([label, value]) => (
                <div
                  key={label}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "120px minmax(0, 1fr)",
                    gap: "0.75rem",
                    padding: "0.6rem 0",
                    borderBottom: "1px solid var(--border-color)",
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-secondary)",
                      fontSize: "0.82rem",
                    }}
                  >
                    {label}
                  </span>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    {value || (
                      <span style={{ color: "var(--text-secondary)" }}>
                        Not set
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </section>

            {customFieldDefs.length > 0 && (
              <section style={{ marginTop: "1.25rem" }}>
                <h3 style={{ margin: "0 0 0.75rem", fontSize: "0.95rem" }}>
                  Custom fields
                </h3>
                {customFieldDefs.map((field) => {
                  const value =
                    previewLeadCurrent.customFields?.[field.fieldKey];
                  const display = Array.isArray(value)
                    ? value.join(", ")
                    : value;
                  return (
                    <div
                      key={field.id}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "120px minmax(0, 1fr)",
                        gap: "0.75rem",
                        padding: "0.6rem 0",
                        borderBottom: "1px solid var(--border-color)",
                      }}
                    >
                      <span
                        style={{
                          color: "var(--text-secondary)",
                          fontSize: "0.82rem",
                        }}
                      >
                        {field.label}
                      </span>
                      <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                        {display || (
                          <span style={{ color: "var(--text-secondary)" }}>
                            Not set
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </section>
            )}
          </aside>
        </div>
      )}

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
            background: "var(--catalogue-modal-backdrop)",
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
            background: "var(--catalogue-modal-backdrop)",
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

export default Leads;
