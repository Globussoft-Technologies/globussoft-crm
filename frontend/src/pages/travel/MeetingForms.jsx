import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Copy, GripVertical, ImagePlus, KeyRound, Plus, RefreshCw, Save, Search, Settings2, Trash2, X } from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const GOOGLE_FONTS = [
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Nunito", "Raleway",
  "DM Sans", "Manrope", "Outfit", "Work Sans", "Source Sans 3", "Noto Sans", "Ubuntu",
  "Merriweather", "Playfair Display", "Lora", "PT Serif", "Noto Serif", "Libre Baskerville",
  "Roboto Slab", "Bebas Neue", "Oswald", "Barlow", "Rubik", "Mulish", "Quicksand",
];
const FALLBACK_TIMEZONES = [
  "Asia/Kolkata", "Asia/Dubai", "Asia/Dhaka", "Asia/Bangkok", "Asia/Singapore", "Asia/Hong_Kong", "Asia/Tokyo",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Moscow",
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles", "America/Toronto",
  "Australia/Sydney", "Pacific/Auckland", "UTC",
];
const TIMEZONES = ["Asia/Kolkata", ...new Set(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : FALLBACK_TIMEZONES)]
  .filter((timezone, index, values) => values.indexOf(timezone) === index);
const DEFAULT_WEEKLY = Object.fromEntries(DAYS.map((day) => [day, ["saturday", "sunday"].includes(day) ? [] : [{ start: "10:00", end: "17:00" }]]));
const DEFAULT_FIELDS = [
  { key: "contactName", label: "Full Name", type: "text", required: true, enabled: true, order: 1 },
  { key: "designation", label: "Designation", type: "text", required: true, enabled: true, order: 2 },
  { key: "institution", label: "School / Institution", type: "text", required: true, enabled: true, order: 3 },
  { key: "city", label: "City", type: "text", required: true, enabled: true, order: 4 },
  { key: "contactEmail", label: "Work Email", type: "email", required: true, enabled: true, order: 5 },
  { key: "contactPhone", label: "Phone / WhatsApp", type: "tel", required: true, enabled: true, order: 6 },
];
const DEFAULT_EMAIL = `Hi {{name}},

Thank you for scheduling a conversation with The Modern Classroom.

Your conversation is confirmed.

DATE: {{date}}
TIME: {{time}}
FORMAT: {{duration}}-minute Zoom conversation

{{meeting_url}}

We look forward to speaking with you.

The Modern Classroom`;

const EMAIL_VARIABLES = [
  { token: "{{name}}", label: "Recipient name", example: "Asha Sharma" },
  { token: "{{institution}}", label: "School / Institution", example: "Chennai Public School", description: "Uses the School / Institution entered by the visitor in the booking form." },
  { token: "{{date}}", label: "Meeting date", example: "Friday, 2 October 2026" },
  { token: "{{time}}", label: "Meeting time", example: "10:00 AM" },
  { token: "{{timezone}}", label: "Timezone", example: "Asia/Kolkata" },
  { token: "{{duration}}", label: "Duration", example: "30" },
  { token: "{{meeting_url}}", label: "Meeting link", example: "https://zoom.us/j/123456789", description: "Shows the meeting URL as a clickable link." },
  { token: "{{meeting_button}}", label: "Meeting button", example: "Join Meeting", description: "Shows a button that opens the meeting URL." },
];

function emptyDraft(hostId = "") {
  return {
    name: "Talk to a TMC Experiential Learning Expert",
    slug: "talk-to-an-expert",
    hostUserId: hostId,
    durationMins: 30,
    timezone: "Asia/Kolkata",
    slotIntervalMins: 30,
    bufferBeforeMins: 0,
    bufferAfterMins: 0,
    minimumNoticeMins: 120,
    bookingHorizonDays: 60,
    maxBookingsPerDay: "",
    allowedStartDate: "",
    allowedEndDate: "",
    weeklyHours: DEFAULT_WEEKLY,
    dateOverrides: {},
    blackoutDates: [],
    fields: DEFAULT_FIELDS,
    calendarProvider: "google",
    createZoom: true,
    embedFontFamily: "Inter",
    emailSubject: "Your Conversation with TMC is Confirmed",
    emailBody: DEFAULT_EMAIL,
    emailLogoUrl: null,
    confirmationMessage: "Your conversation with a TMC Experiential Learning Expert has been scheduled.",
    isActive: false,
  };
}

function newFormDraft(forms, hostId = "") {
  const existingSlugs = new Set((forms || []).map((form) => String(form.slug || "").toLowerCase()));
  let sequence = 1;
  let slug = "talk-to-an-expert";
  while (existingSlugs.has(slug)) {
    sequence += 1;
    slug = `talk-to-an-expert-${sequence}`;
  }
  const draft = emptyDraft(hostId);
  return sequence === 1 ? draft : { ...draft, name: `${draft.name} ${sequence}`, slug };
}

function toDraft(form) {
  return {
    ...emptyDraft(),
    ...form,
    calendarProvider: "google",
    hostUserId: String(form.hostUserId || ""),
    allowedStartDate: form.allowedStartDate ? String(form.allowedStartDate).slice(0, 10) : "",
    allowedEndDate: form.allowedEndDate ? String(form.allowedEndDate).slice(0, 10) : "",
    maxBookingsPerDay: form.maxBookingsPerDay ?? "",
  };
}

const box = { background: "var(--surface-color, #fff)", color: "var(--text-primary, inherit)", border: "1px solid var(--border-color, #dde6ee)", borderRadius: 12, padding: 18 };
const input = { width: "100%", padding: "9px 10px", border: "1px solid var(--border-color, #d8e1e8)", borderRadius: 7, background: "var(--input-bg, #fff)", color: "inherit" };
const label = { display: "grid", gap: 5, fontSize: 12, fontWeight: 700 };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 12 };
const primary = { border: 0, borderRadius: 7, padding: "10px 14px", background: "var(--primary-color, var(--accent-color))", color: "#fff", fontWeight: 800, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 7 };

function HelpTip({ text }) {
  return <span className="meeting-help-tip" tabIndex="0" aria-label={text} data-tooltip={text}><CircleHelp size={14} /></span>;
}

function FieldTitle({ children, help }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>{children}<HelpTip text={help} /></span>;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function todayKeyInTimezone(timezone) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
  } catch {
    return dateKey(new Date());
  }
}

function formatBookingWhen(value, timezone) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    timeZone: timezone || "Asia/Kolkata",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function MultiDatePicker({ value = [], onChange }) {
  const initial = value[0] ? new Date(`${value[0]}T12:00:00`) : new Date();
  const [month, setMonth] = useState(() => new Date(initial.getFullYear(), initial.getMonth(), 1));
  const selected = new Set(value);
  const firstWeekday = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cells = [...Array(firstWeekday).fill(null), ...Array.from({ length: daysInMonth }, (_unused, index) => index + 1)];

  function toggle(day) {
    const key = dateKey(new Date(month.getFullYear(), month.getMonth(), day));
    onChange(selected.has(key) ? value.filter((item) => item !== key) : [...value, key].sort());
  }

  function moveMonth(offset) {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  }

  return <div className="meeting-blackout-picker" style={{ border: "1px solid var(--border-color, #d8e1e8)", borderRadius: 9, padding: 12, background: "var(--input-bg, #fff)" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 10 }}>
      <button type="button" aria-label="Previous blackout month" title="Previous month" onClick={() => moveMonth(-1)} className="meeting-calendar-nav"><ChevronLeft size={17} /></button>
      <strong aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</strong>
      <button type="button" aria-label="Next blackout month" title="Next month" onClick={() => moveMonth(1)} className="meeting-calendar-nav"><ChevronRight size={17} /></button>
    </div>
    <div className="meeting-calendar-grid" style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(30px, 1fr))", gap: 5, textAlign: "center" }}>
      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => <span key={day} style={{ color: "var(--text-secondary)", fontSize: 10, fontWeight: 800 }}>{day}</span>)}
      {cells.map((day, index) => day === null ? <span key={`blank-${index}`} /> : (() => {
        const key = dateKey(new Date(month.getFullYear(), month.getMonth(), day));
        const active = selected.has(key);
        return <button key={key} type="button" aria-label={`${active ? "Remove" : "Add"} blackout date ${key}`} aria-pressed={active} title={`${active ? "Remove" : "Block"} ${key}`} onClick={() => toggle(day)} className="meeting-calendar-day" style={{ border: active ? 0 : "1px solid var(--border-color, #d8e1e8)", borderRadius: 7, minHeight: 34, background: active ? "var(--primary-color, var(--accent-color))" : "transparent", color: active ? "#fff" : "inherit", fontWeight: active ? 800 : 500, cursor: "pointer" }}>{day}</button>;
      })())}
    </div>
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
      {value.length === 0 && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>No blackout dates selected.</span>}
      {value.map((key) => <span key={key} className="meeting-date-chip">{key}<button type="button" title={`Remove ${key}`} aria-label={`Remove blackout date ${key}`} onClick={() => onChange(value.filter((item) => item !== key))}><X size={13} /></button></span>)}
    </div>
  </div>;
}

function GoogleFontPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const filtered = GOOGLE_FONTS.filter((font) => font.toLowerCase().includes(search.trim().toLowerCase()));

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    return () => document.removeEventListener("mousedown", closeOutside);
  }, [open]);

  function toggle() {
    setOpen((current) => {
      const next = !current;
      if (next) {
        setSearch("");
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
      return next;
    });
  }

  return <div ref={rootRef} style={{ position: "relative", width: "100%" }}>
    <button type="button" aria-label="Embed Google Font" aria-haspopup="listbox" aria-expanded={open} onClick={toggle} style={{ ...input, minHeight: 40, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, cursor: "pointer", textAlign: "left" }}>
      <span>{value || "Inter"}</span><ChevronDown size={17} style={{ flex: "0 0 auto", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
    </button>
    {open && <div role="listbox" aria-label="Google Fonts" style={{ position: "absolute", zIndex: 50, top: "calc(100% + 6px)", left: 0, width: "100%", minWidth: 280, padding: 8, border: "1px solid var(--border-color, #d8e1e8)", borderRadius: 9, background: "var(--popover-bg, var(--surface-color, #fff))", color: "var(--text-primary, inherit)", boxShadow: "0 14px 34px rgba(15,23,42,.18)" }}>
      <div style={{ position: "relative", marginBottom: 7 }}><Search size={16} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)" }} /><input ref={searchRef} aria-label="Search Google Fonts" style={{ ...input, paddingLeft: 34 }} value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }} placeholder="Search fonts…" autoComplete="off" /></div>
      <div style={{ maxHeight: 230, overflowY: "auto", display: "grid", gap: 3 }}>
        {filtered.map((font) => <button key={font} type="button" role="option" aria-selected={font === value} onClick={() => { onChange(font); setOpen(false); }} style={{ border: 0, borderRadius: 6, padding: "9px 10px", background: font === value ? "var(--hover-bg, #edf8fd)" : "transparent", color: "inherit", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", textAlign: "left" }}><span>{font}</span>{font === value && <Check size={16} />}</button>)}
        {filtered.length === 0 && <div style={{ padding: 12, textAlign: "center", color: "var(--text-secondary)", fontSize: 12 }}>No matching Google Font</div>}
      </div>
    </div>}
  </div>;
}

export default function MeetingForms() {
  const notify = useNotify();
  const [forms, setForms] = useState([]);
  const [hosts, setHosts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [draft, setDraft] = useState(emptyDraft());
  const [bookings, setBookings] = useState([]);
  const [tab, setTab] = useState("settings");
  const [saving, setSaving] = useState(false);
  const [zoomConfig, setZoomConfig] = useState({ configured: false, status: "NOT_CONFIGURED", zoomHostUserId: "me" });
  const [emailProviderStatus, setEmailProviderStatus] = useState(null);
  const [zoomDraft, setZoomDraft] = useState({ accountId: "", clientId: "", clientSecret: "", zoomHostUserId: "me" });
  const [savingZoom, setSavingZoom] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnectingZoom, setDisconnectingZoom] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [removingLogo, setRemovingLogo] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingForm, setDeletingForm] = useState(false);
  const logoInputRef = useRef(null);
  const emailBodyRef = useRef(null);

  const origin = typeof window === "undefined" ? "https://crm.globusdemos.com" : window.location.origin;
  const selected = useMemo(() => forms.find((form) => form.id === selectedId) || null, [forms, selectedId]);

  const load = useCallback(async () => {
    try {
      const [formRows, hostRows, zoomStatus, emailStatus] = await Promise.all([
        fetchApi("/api/travel/meeting-forms"),
        fetchApi("/api/travel/meeting-forms/hosts"),
        fetchApi("/api/travel/meeting-forms/zoom-config"),
        fetchApi("/api/travel/email-provider").catch(() => null),
      ]);
      setForms(Array.isArray(formRows) ? formRows : []);
      setHosts(Array.isArray(hostRows) ? hostRows : []);
      setZoomConfig(zoomStatus || { configured: false, status: "NOT_CONFIGURED", zoomHostUserId: "me" });
      setEmailProviderStatus(emailStatus);
      setZoomDraft((current) => ({ ...current, zoomHostUserId: zoomStatus?.zoomHostUserId || "me" }));
      if (formRows?.[0]) {
        setSelectedId(formRows[0].id);
        setDraft(toDraft(formRows[0]));
        setIsCreating(false);
      } else {
        setSelectedId(null);
        setDraft(newFormDraft([], hostRows?.[0]?.id ? String(hostRows[0].id) : ""));
        setIsCreating(true);
      }
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Failed to load meeting forms");
    }
  }, [notify]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!selectedId) { setBookings([]); return; }
    fetchApi(`/api/travel/meeting-forms/${selectedId}/bookings`).then((rows) => setBookings(Array.isArray(rows) ? rows : [])).catch(() => setBookings([]));
  }, [selectedId]);

  async function refreshAll() {
    setRefreshing(true);
    try {
      const [formRowsValue, hostRowsValue, zoomStatus, emailStatus] = await Promise.all([
        fetchApi("/api/travel/meeting-forms"),
        fetchApi("/api/travel/meeting-forms/hosts"),
        fetchApi("/api/travel/meeting-forms/zoom-config"),
        fetchApi("/api/travel/email-provider").catch(() => null),
      ]);
      const formRows = Array.isArray(formRowsValue) ? formRowsValue : [];
      const hostRows = Array.isArray(hostRowsValue) ? hostRowsValue : [];
      const activeForm = isCreating ? null : formRows.find((form) => form.id === selectedId) || formRows[0] || null;
      const bookingRows = activeForm
        ? await fetchApi(`/api/travel/meeting-forms/${activeForm.id}/bookings`)
        : [];

      setForms(formRows);
      setHosts(hostRows);
      setZoomConfig(zoomStatus || { configured: false, status: "NOT_CONFIGURED", zoomHostUserId: "me" });
      setEmailProviderStatus(emailStatus);
      setZoomDraft((current) => ({ ...current, zoomHostUserId: zoomStatus?.zoomHostUserId || "me" }));
      if (isCreating) {
        setDraft((current) => ({ ...current, hostUserId: current.hostUserId || (hostRows[0]?.id ? String(hostRows[0].id) : "") }));
        setBookings([]);
      } else {
        setSelectedId(activeForm?.id || null);
        setDraft(activeForm ? toDraft(activeForm) : newFormDraft(formRows, hostRows[0]?.id ? String(hostRows[0].id) : ""));
        setIsCreating(!activeForm);
        setBookings(Array.isArray(bookingRows) ? bookingRows : []);
      }
      setRefreshVersion((version) => version + 1);
      notify.success("Meeting Form refreshed");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Failed to refresh Meeting Form");
    } finally {
      setRefreshing(false);
    }
  }

  function selectForm(form) {
    setShowDeleteConfirm(false); setSelectedId(form.id); setIsCreating(false); setDraft(toDraft(form)); setTab("settings");
  }

  function newForm() {
    setShowDeleteConfirm(false); setSelectedId(null); setIsCreating(true); setDraft(newFormDraft(forms, hosts[0]?.id ? String(hosts[0].id) : "")); setBookings([]); setTab("settings");
  }

  function setValue(key, value) { setDraft((current) => ({ ...current, [key]: value })); }

  function insertEmailVariable(token) {
    if (!EMAIL_VARIABLES.some((variable) => variable.token === token)) return;
    const control = emailBodyRef.current;
    const currentBody = String(draft.emailBody || "");
    const start = control?.selectionStart ?? currentBody.length;
    const end = control?.selectionEnd ?? start;
    const before = currentBody.slice(0, start);
    const after = currentBody.slice(end);
    const prefix = before && !/[\s\n]$/.test(before) ? " " : "";
    const suffix = after && !/^[\s\n.,!?)]/.test(after) ? " " : "";
    const nextBody = `${before}${prefix}${token}${suffix}${after}`;
    const nextCursor = start + prefix.length + token.length + suffix.length;
    setValue("emailBody", nextBody);
    window.setTimeout(() => {
      emailBodyRef.current?.focus();
      emailBodyRef.current?.setSelectionRange(nextCursor, nextCursor);
    }, 0);
  }

  function dropEmailVariable(event) {
    event.preventDefault();
    insertEmailVariable(event.dataTransfer.getData("application/x-meeting-email-variable") || event.dataTransfer.getData("text/plain"));
  }

  function updateWindow(day, index, key, value) {
    setDraft((current) => {
      const windows = [...(current.weeklyHours[day] || [])];
      windows[index] = { ...windows[index], [key]: value };
      return { ...current, weeklyHours: { ...current.weeklyHours, [day]: windows } };
    });
  }

  function addWindow(day) {
    setDraft((current) => ({ ...current, weeklyHours: { ...current.weeklyHours, [day]: [...(current.weeklyHours[day] || []), { start: "09:00", end: "17:00" }] } }));
  }

  function removeWindow(day, index) {
    setDraft((current) => ({ ...current, weeklyHours: { ...current.weeklyHours, [day]: (current.weeklyHours[day] || []).filter((_row, i) => i !== index) } }));
  }

  function addField() {
    const order = (draft.fields || []).length + 1;
    setValue("fields", [...(draft.fields || []), { key: `custom_${Date.now()}`, label: "Custom field", type: "text", required: false, enabled: true, order, placeholder: "", options: [] }]);
  }

  function updateField(index, changes) {
    setValue("fields", draft.fields.map((field, fieldIndex) => fieldIndex === index ? { ...field, ...changes } : field));
  }

  function changeFieldType(index, type) {
    const field = draft.fields[index];
    updateField(index, {
      type,
      options: type === "select" ? (field.options?.length ? field.options : ["Option 1", "Option 2"]) : [],
      placeholder: type === "select" ? "" : field.placeholder || "",
    });
  }

  function addFieldOption(index) {
    const field = draft.fields[index];
    updateField(index, { options: [...(field.options || []), `Option ${(field.options || []).length + 1}`] });
  }

  function updateFieldOption(fieldIndex, optionIndex, value) {
    const options = [...(draft.fields[fieldIndex].options || [])];
    options[optionIndex] = value;
    updateField(fieldIndex, { options });
  }

  function removeFieldOption(fieldIndex, optionIndex) {
    updateField(fieldIndex, { options: (draft.fields[fieldIndex].options || []).filter((_option, index) => index !== optionIndex) });
  }

  function fieldConfigurationError() {
    const seenKeys = new Set();
    for (const field of draft.fields || []) {
      if (!String(field.label || "").trim()) return "Every form field needs a label.";
      if (!field.key || seenKeys.has(field.key)) return "Every form field needs a unique key.";
      seenKeys.add(field.key);
      if (field.enabled !== false && field.type === "select") {
        const options = (field.options || []).map((option) => String(option).trim()).filter(Boolean);
        if (!options.length) return `Add at least one option to “${field.label}”.`;
        if (new Set(options.map((option) => option.toLowerCase())).size !== options.length) return `Remove duplicate options from “${field.label}”.`;
      }
    }
    return "";
  }

  function dateLimitError() {
    if (draft.allowedStartDate && draft.allowedEndDate && draft.allowedEndDate < draft.allowedStartDate) {
      return "End date cannot be earlier than start date.";
    }
    if (draft.allowedEndDate && draft.allowedEndDate < todayKeyInTimezone(draft.timezone)) {
      return "End date cannot be earlier than today.";
    }
    return "";
  }

  async function save() {
    const dateError = dateLimitError();
    if (dateError) {
      setTab("settings");
      notify.error(dateError);
      return;
    }
    if (!draft.hostUserId) {
      setTab("settings");
      notify.error("Select a staff host for this Meeting Form.");
      return;
    }
    const fieldError = fieldConfigurationError();
    if (fieldError) {
      setTab("fields");
      notify.error(fieldError);
      return;
    }
    setSaving(true);
    const creating = !selectedId;
    try {
      const body = { ...draft, hostUserId: Number(draft.hostUserId), maxBookingsPerDay: draft.maxBookingsPerDay === "" ? null : Number(draft.maxBookingsPerDay) };
      const response = await fetchApi(selectedId ? `/api/travel/meeting-forms/${selectedId}` : "/api/travel/meeting-forms", { method: selectedId ? "PUT" : "POST", body: JSON.stringify(body) });
      setSelectedId(response.id); setIsCreating(false); setDraft(toDraft(response));
      setForms((rows) => rows.some((row) => row.id === response.id)
        ? rows.map((row) => row.id === response.id ? { ...row, ...response } : row)
        : [...rows, response]);
      notify.success(creating ? "Meeting form created" : "Meeting form updated");
      try {
        const rows = await fetchApi("/api/travel/meeting-forms");
        if (Array.isArray(rows)) setForms(rows);
      } catch {
        notify.error("The Meeting Form was saved, but the form list could not be refreshed.");
      }
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Failed to save meeting form");
    } finally { setSaving(false); }
  }

  async function deleteMeetingForm() {
    if (!selectedId || !selected) return;
    setDeletingForm(true);
    try {
      await fetchApi(`/api/travel/meeting-forms/${selectedId}`, { method: "DELETE" });
      const remaining = forms.filter((form) => form.id !== selectedId);
      setForms(remaining);
      setShowDeleteConfirm(false);
      setBookings([]);
      if (remaining[0]) {
        setSelectedId(remaining[0].id);
        setDraft(toDraft(remaining[0]));
        setIsCreating(false);
      } else {
        setSelectedId(null);
        setDraft(newFormDraft([], hosts[0]?.id ? String(hosts[0].id) : ""));
        setIsCreating(true);
      }
      setTab("settings");
      notify.success("Meeting Form deleted");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Failed to delete Meeting Form");
    } finally {
      setDeletingForm(false);
    }
  }

  async function resendConfirmation(bookingId) {
    try {
      const result = await fetchApi(`/api/travel/meeting-forms/${selectedId}/bookings/${bookingId}/resend-confirmation`, { method: "POST" });
      setBookings((rows) => rows.map((row) => row.id === bookingId ? { ...row, emailStatus: "SENT", emailChannel: result.channel || "unified_inbox" } : row));
      notify.success("Branded confirmation email sent");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Confirmation email could not be sent");
    }
  }

  function applySavedForm(form) {
    // Uploading a logo persists immediately, but must not discard other edits
    // the operator has typed into the still-unsaved settings form.
    setDraft((current) => ({ ...current, emailLogoUrl: form.emailLogoUrl || null }));
    setForms((rows) => rows.map((row) => row.id === form.id ? { ...row, ...form } : row));
  }

  async function uploadEmailLogo(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!selectedId) {
      notify.error("Create the Meeting Form before uploading its email logo");
      return;
    }
    setUploadingLogo(true);
    try {
      const body = new FormData();
      body.append("logo", file);
      const form = await fetchApi(`/api/travel/meeting-forms/${selectedId}/email-logo`, { method: "POST", body });
      applySavedForm(form);
      notify.success("Confirmation email logo uploaded");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Email logo could not be uploaded");
    } finally {
      setUploadingLogo(false);
    }
  }

  async function removeEmailLogo() {
    if (!selectedId || !draft.emailLogoUrl) return;
    setRemovingLogo(true);
    try {
      const form = await fetchApi(`/api/travel/meeting-forms/${selectedId}/email-logo`, { method: "DELETE" });
      applySavedForm(form);
      notify.success("Confirmation email logo removed");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Email logo could not be removed");
    } finally {
      setRemovingLogo(false);
    }
  }

  async function connectZoom() {
    setSavingZoom(true);
    try {
      const status = await fetchApi("/api/travel/meeting-forms/zoom-config", { method: "PUT", body: JSON.stringify(zoomDraft) });
      setZoomConfig(status);
      setZoomDraft({ accountId: "", clientId: "", clientSecret: "", zoomHostUserId: status.zoomHostUserId || "me" });
      notify.success("Zoom credentials verified and connected for this Travel CRM tenant");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Zoom connection failed");
    } finally {
      setSavingZoom(false);
    }
  }

  async function disconnectZoom() {
    setDisconnectingZoom(true);
    try {
      const status = await fetchApi("/api/travel/meeting-forms/zoom-config/disconnect", { method: "POST" });
      setZoomConfig(status);
      setShowDisconnectConfirm(false);
      notify.success("Zoom disconnected");
    } catch (error) {
      notify.error(error?.body?.error || error.message || "Zoom could not be disconnected");
    } finally {
      setDisconnectingZoom(false);
    }
  }

  async function copy(value, message) {
    try { await navigator.clipboard.writeText(value); notify.success(message); } catch { notify.error("Clipboard access was blocked"); }
  }

  const publicKey = selected?.publicKey || draft.publicKey;
  const embedFont = draft.embedFontFamily || selected?.embedFontFamily || "Inter";
  const embedUrl = publicKey ? `${origin}/embed/meeting-form.html?form=${encodeURIComponent(publicKey)}&font=${encodeURIComponent(embedFont)}` : "";
  const embedCode = embedUrl ? `<iframe src="${embedUrl}" title="Schedule a TMC conversation" style="width:100%;min-height:760px;border:0" loading="lazy"></iframe>` : "";
  const apiBase = publicKey ? `${origin}/api/travel/meeting-forms/public/${publicKey}` : "";
  const settingsDateError = dateLimitError();
  const minimumEndDate = [todayKeyInTimezone(draft.timezone), draft.allowedStartDate].filter(Boolean).sort().at(-1);

  return (
    <div className="meeting-forms-page" style={{ padding: "1.25rem", maxWidth: 1500, margin: "0 auto", "--card-bg": "var(--surface-color)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 18 }}>
        <div><h1 style={{ margin: 0, display: "flex", gap: 9, alignItems: "center" }}><CalendarClock /> Meeting Forms</h1><p style={{ margin: "5px 0 0", color: "var(--text-secondary)" }}>Configure TMC scheduling once, then use the embed or the same APIs in any website UI.</p></div>
        <div style={{ display: "flex", gap: 9, flexWrap: "wrap" }}>
          <button type="button" title="Reload forms, hosts, Zoom status, email delivery status, bookings and the iframe preview" onClick={refreshAll} disabled={refreshing} style={{ ...primary, background: "#475569" }}><RefreshCw className={refreshing ? "meeting-refresh-spin" : ""} size={17} /> {refreshing ? "Refreshing…" : "Refresh"}</button>
          <button type="button" title={isCreating ? "A new Meeting Form is already being configured" : "Create a new configurable Meeting Form"} onClick={newForm} disabled={isCreating} style={{ ...primary, opacity: isCreating ? .6 : 1 }}><Plus size={17} /> New Meeting Form</button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(220px, 300px) minmax(0, 1fr)", gap: 16, alignItems: "start" }} className="meeting-forms-layout">
        <aside style={{ ...box, padding: 10 }}>
          {forms.length === 0 && <p style={{ padding: 10, color: "var(--text-secondary)" }}>No meeting forms yet.</p>}
          {isCreating && <div aria-current="page" style={{ width: "100%", textAlign: "left", border: "1px dashed var(--primary-color, var(--accent-color))", borderRadius: 8, padding: 12, marginBottom: 6, color: "inherit", background: "var(--hover-bg, #edf8fd)" }}><strong>New Meeting Form</strong><small style={{ display: "block", marginTop: 4, color: "var(--text-secondary)" }}>Unsaved · complete the settings and create</small></div>}
          {forms.map((form) => <div key={form.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", alignItems: "center", gap: 6, borderRadius: 8, padding: "4px 6px 4px 4px", marginBottom: 6, background: selectedId === form.id ? "var(--hover-bg, #edf8fd)" : "transparent" }}>
            <button type="button" onClick={() => selectForm(form)} style={{ minWidth: 0, width: "100%", textAlign: "left", border: 0, borderRadius: 7, padding: 8, cursor: "pointer", color: "inherit", background: "transparent" }}><strong>{form.name}</strong><small style={{ display: "block", marginTop: 4, color: "var(--text-secondary)" }}>{form.isActive ? "Active" : "Draft"} · {form._count?.bookings || 0} bookings</small></button>
            <button type="button" aria-label={`Delete ${form.name}`} title={`Delete ${form.name}`} onClick={() => { selectForm(form); setShowDeleteConfirm(true); }} style={{ display: "grid", placeItems: "center", width: 32, height: 32, padding: 0, border: "1px solid color-mix(in srgb, var(--danger-color, #dc2626) 45%, var(--border-color))", borderRadius: 7, color: "var(--danger-color, #dc2626)", background: "var(--input-bg, var(--surface-color))", cursor: "pointer" }}><Trash2 size={16} /></button>
          </div>)}
        </aside>

        <main style={{ minWidth: 0 }}>
          {isCreating && <div role="status" style={{ marginBottom: 12, padding: "11px 14px", border: "1px solid color-mix(in srgb, var(--primary-color, var(--accent-color)) 45%, transparent)", borderRadius: 9, background: "var(--hover-bg, #edf8fd)", fontSize: 13 }}><strong>Creating a new Meeting Form.</strong> Configure its settings, schedule and fields, then select <strong>Create Meeting Form</strong>.</div>}
          <div className="meeting-form-toolbar" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>{[['settings','Settings'],['schedule','Schedule'],['fields','Fields'],['integration','Embed & API'],['bookings','Bookings'],['zoom','Zoom Setup']].map(([key,text]) => {
              const unavailableUntilSaved = isCreating && ['integration', 'bookings'].includes(key);
              return <button key={key} title={unavailableUntilSaved ? `Create this Meeting Form before opening ${text}` : `Open ${text}`} type="button" disabled={unavailableUntilSaved} onClick={() => setTab(key)} style={{ ...primary, color: tab === key ? "#fff" : "inherit", background: tab === key ? "var(--primary-color, var(--accent-color))" : "var(--surface-color, #fff)", border: "1px solid var(--border-color, #dde6ee)", opacity: unavailableUntilSaved ? .55 : 1 }}>{text}</button>;
            })}</div>
            <div className="meeting-form-actions" style={{ display: "flex", flex: "1 0 100%", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <label title="Create a Zoom link automatically for every confirmed booking" className="meeting-toolbar-toggle"><input type="checkbox" checked={draft.createZoom} onChange={(e) => setValue("createZoom", e.target.checked)} /> <span>Create Zoom meeting</span></label>
              <label title="Make this Meeting Form available through its embed and public APIs" className="meeting-toolbar-toggle"><input type="checkbox" checked={draft.isActive} onChange={(e) => setValue("isActive", e.target.checked)} /> <span>Active/published</span></label>
              <button type="button" title="Save every change made across Settings, Schedule and Fields" onClick={save} disabled={saving} style={{ ...primary, marginLeft: "auto" }}><Save size={17} /> {saving ? "Saving…" : selectedId ? "Save Changes" : "Create Meeting Form"}</button>
            </div>
          </div>

          {tab === "settings" && <section className="meeting-form-surface" style={box}>
            <h2 style={{ marginTop: 0 }}><Settings2 size={19} /> {isCreating ? "New Meeting Form settings" : "Form settings"}</h2>
            <div style={grid}>
              <label style={label}><FieldTitle help="The title used to identify this Meeting Form inside the CRM.">Form name</FieldTitle><input style={input} value={draft.name} onChange={(e) => setValue("name", e.target.value)} /></label>
              <label style={label}><FieldTitle help="A unique URL-friendly identifier for this Meeting Form.">Slug</FieldTitle><input style={input} value={draft.slug} onChange={(e) => setValue("slug", e.target.value)} /></label>
              <label style={label}><FieldTitle help="The staff member whose connected calendar owns the appointment.">Host</FieldTitle><select style={input} value={draft.hostUserId} onChange={(e) => setValue("hostUserId", e.target.value)}><option value="">Select host</option>{hosts.map((host) => <option key={host.id} value={host.id}>{host.name} — {host.email}</option>)}</select></label>
              <label style={label}><FieldTitle help="The timezone used to calculate and display all booking slots. Asia/Kolkata is the default.">Timezone</FieldTitle><select aria-label="Timezone" style={input} value={draft.timezone || "Asia/Kolkata"} onChange={(e) => setValue("timezone", e.target.value)}>{draft.timezone && !TIMEZONES.includes(draft.timezone) && <option value={draft.timezone}>{draft.timezone}</option>}{TIMEZONES.map((timezone) => <option key={timezone} value={timezone}>{timezone === "Asia/Kolkata" ? "Asia/Kolkata — India" : timezone.replaceAll("_", " ")}</option>)}</select></label>
              <label style={label}><FieldTitle help="How far in advance someone must book. Slots inside this period are unavailable.">Minimum notice (minutes)</FieldTitle><input style={input} type="number" min="0" value={draft.minimumNoticeMins} onChange={(e) => setValue("minimumNoticeMins", Number(e.target.value))} /></label>
              <label style={label}><FieldTitle help="How many days into the future visitors can schedule.">Booking horizon (days)</FieldTitle><input style={input} type="number" min="1" value={draft.bookingHorizonDays} onChange={(e) => setValue("bookingHorizonDays", Number(e.target.value))} /></label>
              <label style={label}><FieldTitle help="Optional daily booking cap. Leave empty for no limit.">Maximum bookings/day</FieldTitle><input style={input} type="number" min="1" value={draft.maxBookingsPerDay} onChange={(e) => setValue("maxBookingsPerDay", e.target.value)} placeholder="No limit" /></label>
              <label style={label}><FieldTitle help="Optional first date on which bookings may be accepted.">Start date (optional)</FieldTitle><input aria-label="Start date (optional)" style={input} type="date" max={draft.allowedEndDate || undefined} value={draft.allowedStartDate} onChange={(e) => setValue("allowedStartDate", e.target.value)} /></label>
              <label style={label}><FieldTitle help="Optional final date on which bookings may be accepted. It cannot be before today or the start date.">End date (optional)</FieldTitle><input aria-label="End date (optional)" aria-invalid={Boolean(settingsDateError)} aria-describedby={settingsDateError ? "meeting-date-limit-error" : undefined} style={{ ...input, borderColor: settingsDateError ? "#dc2626" : undefined }} type="date" min={minimumEndDate} value={draft.allowedEndDate} onChange={(e) => setValue("allowedEndDate", e.target.value)} />{settingsDateError && <small id="meeting-date-limit-error" role="alert" style={{ color: "#b91c1c", fontWeight: 700 }}>{settingsDateError}</small>}</label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(180px,.7fr) minmax(260px,1.3fr)", gap: 18, alignItems: "center", padding: 14, marginTop: 14, border: "1px solid var(--border-color, #e5e7eb)", borderRadius: 9, background: "var(--hover-bg, #f8fafc)" }} className="meeting-font-setting">
              <div><strong style={{ display: "block", fontSize: 13 }}>Embed typography</strong><small style={{ display: "block", marginTop: 4, color: "var(--text-secondary)", lineHeight: 1.45 }}>Choose a Google Font for the hosted iframe only. API-built website UIs keep their own styling.</small></div>
              <label style={label}><FieldTitle help="Loaded from Google Fonts and applied to every element in the hosted iframe.">Google Font</FieldTitle><GoogleFontPicker value={draft.embedFontFamily || "Inter"} onChange={(font) => setValue("embedFontFamily", font)} /></label>
            </div>
            <div style={{ marginTop: 14 }}>
              <label style={label}><FieldTitle help="Click one or more exact calendar dates to prevent bookings on those days. Blackout dates do not repeat automatically in later months.">Blackout dates</FieldTitle><MultiDatePicker value={draft.blackoutDates || []} onChange={(dates) => setValue("blackoutDates", dates)} /></label>
              <small style={{ display: "block", marginTop: 7, color: "var(--text-secondary)" }}>Website access is managed once for the tenant under CRM Settings → Embed Allowlist.</small>
            </div>
            <label style={{ ...label, marginTop: 14 }}><FieldTitle help="Subject for the separate confirmation sent through the connected Unified Inbox.">Confirmation email subject</FieldTitle><input style={input} value={draft.emailSubject} onChange={(e) => setValue("emailSubject", e.target.value)} /></label>
            <div className="meeting-email-settings" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(240px,300px)", gap: 14, alignItems: "start", marginTop: 14 }}>
              <div style={{ display: "grid", gap: 8, minWidth: 0 }}>
                <FieldTitle help="Drag or click a field below to place it in the email. The CRM replaces it with the booking's real value when sending.">Confirmation email body</FieldTitle>
                <div className="meeting-email-variable-builder" aria-label="Email fields" style={{ padding: 11, border: "1px solid var(--border-color, #d8e1e8)", borderRadius: 9, background: "var(--hover-bg, #f8fafc)" }}>
                  <strong style={{ display: "block", fontSize: 12 }}>Add booking details</strong>
                  <small style={{ display: "block", margin: "3px 0 9px", color: "var(--text-secondary)", lineHeight: 1.4 }}>Drag a field into the email, or click it to insert it at the cursor. You can continue editing the text normally.</small>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                    {EMAIL_VARIABLES.map((variable) => <button key={variable.token} type="button" draggable="true" className="meeting-email-variable" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "7px 9px", border: "1px solid var(--border-color, #cbd5e1)", borderRadius: 7, background: "var(--surface-color, #fff)", color: "inherit", fontSize: 12, fontWeight: 700, cursor: "grab" }} title={`${variable.description ? `${variable.description} ` : ""}Example: ${variable.example}`} aria-label={`Insert ${variable.label}`} onDragStart={(event) => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData("application/x-meeting-email-variable", variable.token); event.dataTransfer.setData("text/plain", variable.token); }} onClick={() => insertEmailVariable(variable.token)}><GripVertical size={14} aria-hidden="true" /><Plus size={13} aria-hidden="true" /> {variable.label}</button>)}
                  </div>
                  <small style={{ display: "block", marginTop: 9, color: "var(--text-secondary)", lineHeight: 1.4 }}><strong>School / Institution</strong> is the value entered by the visitor in that field on the booking form.</small>
                </div>
                <textarea ref={emailBodyRef} aria-label="Confirmation email body" style={{ ...input, minHeight: 230, resize: "vertical" }} value={draft.emailBody} onChange={(e) => setValue("emailBody", e.target.value)} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={dropEmailVariable} />
                <small style={{ color: "var(--text-secondary)", fontWeight: 400 }}>The field chips are converted automatically when the email is sent—recipients never see the curly-bracket codes.</small>
              </div>
              <div style={{ display: "grid", alignContent: "start", gap: 10 }}>
                <div style={{ display: "grid", alignContent: "start", gap: 10, padding: 14, border: "1px solid var(--border-color, #d8e1e8)", borderRadius: 9, background: "var(--hover-bg, #f8fafc)" }}>
                  <div><FieldTitle help="PNG, JPEG or WebP, up to 2 MB. It appears after the configured text in the separate confirmation email.">Email footer logo</FieldTitle><small style={{ display: "block", marginTop: 5, color: "var(--text-secondary)", lineHeight: 1.45 }}>Shown at the bottom of the confirmation email. Recommended: a transparent logo under 180 px wide.</small></div>
                  {draft.emailLogoUrl ? <div style={{ display: "grid", placeItems: "center", minHeight: 100, padding: 12, borderRadius: 8, background: "#fff", border: "1px solid var(--border-color, #e5e7eb)" }}><img src={draft.emailLogoUrl} alt="Current email footer logo" style={{ display: "block", maxWidth: 180, maxHeight: 72, objectFit: "contain" }} /></div> : <div style={{ display: "grid", placeItems: "center", minHeight: 100, padding: 12, borderRadius: 8, border: "1px dashed var(--border-color, #cbd5e1)", color: "var(--text-secondary)", fontSize: 12 }}>No logo uploaded</div>}
                  <input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadEmailLogo} style={{ display: "none" }} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" disabled={uploadingLogo || !selectedId} title={selectedId ? "Upload or replace the footer logo" : "Create the Meeting Form first"} style={{ ...primary, padding: "8px 11px" }} onClick={() => logoInputRef.current?.click()}><ImagePlus size={16} /> {uploadingLogo ? "Uploading…" : draft.emailLogoUrl ? "Replace logo" : "Upload logo"}</button>
                    {draft.emailLogoUrl && <button type="button" disabled={removingLogo} title="Remove the footer logo" style={{ ...primary, padding: "8px 11px", background: "#b91c1c" }} onClick={removeEmailLogo}><Trash2 size={16} /> {removingLogo ? "Removing…" : "Remove"}</button>}
                  </div>
                </div>
                <div role="status" aria-label="Email delivery provider" style={{ padding: 12, border: `1px solid ${emailProviderStatus?.configured ? "color-mix(in srgb, var(--success-color) 45%, var(--border-color))" : "var(--border-color, #d8e1e8)"}`, borderRadius: 9, background: emailProviderStatus?.configured ? "color-mix(in srgb, var(--success-color) 12%, var(--surface-color))" : "var(--hover-bg, var(--subtle-bg))", color: "var(--text-primary, inherit)", fontSize: 12, lineHeight: 1.45 }}>
                  <strong style={{ display: "block", marginBottom: 3 }}>Email delivery</strong>
                  {emailProviderStatus === null
                    ? "Email delivery configuration unavailable"
                    : emailProviderStatus.configured
                      ? "Using customer-managed SendGrid email"
                      : "Using CRM-managed SendGrid email"}
                </div>
              </div>
            </div>
            <p style={{ margin: "10px 0 0", color: "var(--text-secondary)", fontSize: 12, lineHeight: 1.5 }}><strong>What recipients see:</strong> the confirmation email follows the subject, body, spacing and logo above. The host appointment is still created in Google Calendar, but Google’s separate fixed-layout invitation email is suppressed. Recipient inboxes do not need to be synced with the CRM; the host’s connected Gmail account or the configured SendGrid account sends to any real, deliverable email address. Previously sent Google invitations are not changed retroactively.</p>
          </section>}

          {tab === "schedule" && <section style={box}>
            <h2 style={{ marginTop: 0 }}>Availability and date overrides</h2>
            <div style={{ ...grid, padding: 14, marginBottom: 18, borderRadius: 9, background: "var(--hover-bg, #f5f7fa)", border: "1px solid var(--border-color, #e5e7eb)" }}>
              <label style={label}><FieldTitle help="Controls the length of the Zoom meeting and calendar appointment.">Appointment duration (minutes)</FieldTitle><input aria-label="Appointment duration (minutes)" style={input} type="number" min="5" max="480" step="5" value={draft.durationMins} onChange={(e) => setValue("durationMins", Number(e.target.value))} /><small style={{ color: "var(--text-secondary)", fontWeight: 400 }}>How long each Zoom meeting lasts.</small></label>
              <label style={label}><FieldTitle help="Controls how frequently selectable start times appear.">Time between offered slot starts (minutes)</FieldTitle><input aria-label="Time between offered slot starts (minutes)" style={input} type="number" min="5" max="480" step="5" value={draft.slotIntervalMins} onChange={(e) => setValue("slotIntervalMins", Number(e.target.value))} /><small style={{ color: "var(--text-secondary)", fontWeight: 400 }}>Example: 30 creates 10:00, 10:30, 11:00. Use buffers below for setup or recovery time.</small></label>
            </div>
            <div style={{ display: "grid", gap: 12 }}>{DAYS.map((day) => {
              const windows = draft.weeklyHours?.[day] || [];
              const closed = windows.length === 0;
              return <div key={day} className="meeting-schedule-day" style={{ display: "grid", gridTemplateColumns: "120px minmax(0,1fr)", gap: 10, alignItems: closed ? "center" : "start" }}>
                <strong style={{ textTransform: "capitalize", paddingTop: closed ? 0 : 9 }}>{day}</strong>
                <div style={{ display: "grid", gap: 7 }}>
                  {windows.map((row, index) => <div key={`${day}-${index}`} className="meeting-time-window" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr) auto", gap: 8 }}><input aria-label={`${day} start ${index + 1}`} style={input} type="time" value={row.start} onChange={(e) => updateWindow(day, index, "start", e.target.value)} /><input aria-label={`${day} end ${index + 1}`} style={input} type="time" value={row.end} onChange={(e) => updateWindow(day, index, "end", e.target.value)} /><button type="button" style={{ ...primary, padding: "7px 10px", background: "#64748b" }} onClick={() => removeWindow(day, index)}>Remove</button></div>)}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 32 }}><button type="button" title={`Add another availability period for ${day}`} aria-label={`${day} add time window`} style={{ ...primary, padding: "7px 10px", width: "max-content", background: "#475569" }} onClick={() => addWindow(day)}>+ Add time window</button>{closed && <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>Closed</span>}</div>
                </div>
              </div>;
            })}</div>
            <div style={{ ...grid, marginTop: 16 }}><label style={label}><FieldTitle help="Preparation time reserved immediately before every confirmed appointment.">Buffer before (minutes)</FieldTitle><input style={input} type="number" min="0" value={draft.bufferBeforeMins} onChange={(e) => setValue("bufferBeforeMins", Number(e.target.value))} /></label><label style={label}><FieldTitle help="Follow-up or recovery time reserved immediately after every confirmed appointment.">Buffer after (minutes)</FieldTitle><input style={input} type="number" min="0" value={draft.bufferAfterMins} onChange={(e) => setValue("bufferAfterMins", Number(e.target.value))} /></label></div>
            <label style={{ ...label, marginTop: 16 }}><FieldTitle help="Advanced per-date rules for closing a date or replacing its normal working hours.">Date-specific overrides (JSON)</FieldTitle><textarea style={{ ...input, minHeight: 170, fontFamily: "monospace" }} value={JSON.stringify(draft.dateOverrides || {}, null, 2)} onChange={(e) => { try { setValue("dateOverrides", JSON.parse(e.target.value)); } catch { /* keep last valid value */ } }} /></label>
            <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>Example: {`{"2026-10-02":{"closed":true},"2026-10-03":{"windows":[{"start":"11:00","end":"15:00"}]}}`}</p>
          </section>}

          {tab === "fields" && <section style={box}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}><h2 style={{ marginTop: 0 }}>Form fields</h2><button type="button" style={{ ...primary, background: "#475569" }} onClick={addField}>+ Add field</button></div>
            <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>Choose the field type to apply validation in both the hosted form and public booking API. Name and city fields accept international letters; designation and institution reject URLs or malformed values; phone numbers require 7 to 15 digits; email and Select values are checked before booking.</p>
            {(draft.fields || []).map((field, index) => <div key={field.key} className="meeting-field-card" style={{ padding: "14px 0", borderBottom: "1px solid var(--border-color, #e5e7eb)" }}>
              <div className="meeting-field-row" style={{ display: "grid", gridTemplateColumns: "minmax(180px,1fr) 130px minmax(180px,1fr) auto auto auto", gap: 10, alignItems: "center" }}>
                <label style={label}><FieldTitle help="The question or label visitors see in the booking form.">Field label</FieldTitle><input aria-label={`${field.key} label`} style={input} value={field.label} maxLength={100} onChange={(e) => updateField(index, { label: e.target.value })} /></label>
                <label style={label}><FieldTitle help="Controls the input UI and server-side validation applied to this answer.">Field type</FieldTitle><select aria-label={`${field.key} type`} style={input} value={field.type} onChange={(e) => changeFieldType(index, e.target.value)}><option value="text">Text</option><option value="email">Email</option><option value="tel">Phone</option><option value="textarea">Long text</option><option value="select">Select</option></select></label>
                {field.type === "select" ? <span style={{ color: "var(--text-secondary)", fontSize: 12, alignSelf: "end", paddingBottom: 10 }}>Manage choices below</span> : <label style={label}><FieldTitle help="Optional example text shown before the visitor enters a value.">Placeholder</FieldTitle><input aria-label={`${field.key} placeholder`} style={input} value={field.placeholder || ""} maxLength={150} onChange={(e) => updateField(index, { placeholder: e.target.value })} /></label>}
                <label style={{ alignSelf: "end", paddingBottom: 9 }}><input type="checkbox" checked={field.enabled !== false} onChange={(e) => updateField(index, { enabled: e.target.checked })} /> Enabled</label>
                <label style={{ alignSelf: "end", paddingBottom: 9 }}><input type="checkbox" checked={field.required === true} disabled={field.enabled === false} onChange={(e) => updateField(index, { required: e.target.checked })} /> Required</label>
                {field.key.startsWith("custom_") ? <button type="button" style={{ ...primary, padding: "7px 10px", background: "#b91c1c", alignSelf: "end" }} onClick={() => setValue("fields", draft.fields.filter((_item, i) => i !== index))}>Remove field</button> : <span />}
              </div>
              {field.type === "select" && <div className="meeting-option-editor" style={{ marginTop: 12, marginLeft: 0, padding: 12, borderRadius: 9, background: "var(--hover-bg, #f5f7fa)", border: "1px solid var(--border-color, #e5e7eb)" }}>
                <strong style={{ display: "block", marginBottom: 8 }}>Select options</strong>
                <div style={{ display: "grid", gap: 8 }}>{(field.options || []).map((option, optionIndex) => <div key={`${field.key}-option-${optionIndex}`} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8 }}><input aria-label={`${field.label} option ${optionIndex + 1}`} style={input} value={option} maxLength={100} placeholder={`Option ${optionIndex + 1}`} onChange={(e) => updateFieldOption(index, optionIndex, e.target.value)} /><button type="button" aria-label={`Remove ${field.label} option ${optionIndex + 1}`} style={{ ...primary, padding: "7px 10px", background: "#64748b" }} onClick={() => removeFieldOption(index, optionIndex)}>Remove</button></div>)}</div>
                <button type="button" style={{ ...primary, marginTop: 9, padding: "7px 10px", background: "#475569" }} onClick={() => addFieldOption(index)}>+ Add option</button>
                {(field.options || []).length === 0 && <p style={{ margin: "8px 0 0", color: "#b91c1c", fontSize: 12 }}>Add at least one option before saving this enabled field.</p>}
              </div>}
            </div>)}
          </section>}

          {tab === "zoom" && <section style={box}>
            <h2 style={{ marginTop: 0 }}><KeyRound size={19} /> Zoom Server-to-Server OAuth</h2>
            <p style={{ color: "var(--text-secondary)" }}>Connect this Travel CRM tenant’s own Zoom account. Credentials are verified with Zoom, saved for this tenant, and never returned to the browser.</p>
            <div style={{ padding: 12, border: `1px solid ${zoomConfig.configured ? "color-mix(in srgb, var(--success-color) 45%, var(--border-color))" : "var(--border-color)"}`, borderRadius: 8, marginBottom: 16, background: zoomConfig.configured ? "color-mix(in srgb, var(--success-color) 12%, var(--surface-color))" : "var(--hover-bg, var(--subtle-bg))", color: "var(--text-primary, inherit)" }}>
              <strong>{zoomConfig.configured ? "Connected" : "Not connected"}</strong>
              {zoomConfig.configured && <span> · Account {zoomConfig.accountId} · Client {zoomConfig.clientId} · Host {zoomConfig.zoomHostUserId}</span>}
              {zoomConfig.verifiedAt && <small style={{ display: "block", marginTop: 4 }}>Verified {new Date(zoomConfig.verifiedAt).toLocaleString()}</small>}
            </div>
            <div style={grid}>
              <label style={label}><FieldTitle help="The Account ID from the client's Zoom Server-to-Server OAuth app.">Zoom Account ID</FieldTitle><input style={input} value={zoomDraft.accountId} onChange={(e) => setZoomDraft((current) => ({ ...current, accountId: e.target.value }))} autoComplete="off" placeholder={zoomConfig.accountId || "Account ID"} /></label>
              <label style={label}><FieldTitle help="The Client ID from the client's Zoom Server-to-Server OAuth app.">Zoom Client ID</FieldTitle><input style={input} value={zoomDraft.clientId} onChange={(e) => setZoomDraft((current) => ({ ...current, clientId: e.target.value }))} autoComplete="off" placeholder={zoomConfig.clientId || "Client ID"} /></label>
              <label style={label}><FieldTitle help="The private Client Secret. It is never returned to the browser after saving.">Zoom Client Secret</FieldTitle><input style={input} type="password" value={zoomDraft.clientSecret} onChange={(e) => setZoomDraft((current) => ({ ...current, clientSecret: e.target.value }))} autoComplete="new-password" placeholder={zoomConfig.clientSecretConfigured ? "Enter a new secret to reconnect" : "Client Secret"} /></label>
              <label style={label}><FieldTitle help="Use me for the Zoom app owner or enter another licensed Zoom user email.">Zoom host user</FieldTitle><input style={input} value={zoomDraft.zoomHostUserId} onChange={(e) => setZoomDraft((current) => ({ ...current, zoomHostUserId: e.target.value }))} placeholder="me or host@email.com" /></label>
            </div>
            <p style={{ color: "var(--text-secondary)", fontSize: 12 }}>Required Zoom granular scopes: <code>meeting:write:meeting:admin</code> and <code>meeting:delete:meeting:admin</code>. Use <code>me</code> to create meetings under the Server-to-Server app owner, or enter a Zoom account user email.</p>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", position: "relative" }}><button type="button" disabled={savingZoom} style={primary} onClick={connectZoom}>{savingZoom ? "Verifying…" : zoomConfig.configured ? "Verify & Replace Connection" : "Verify & Connect Zoom"}</button>{zoomConfig.configured && <button type="button" style={{ ...primary, background: "#b91c1c" }} onClick={() => setShowDisconnectConfirm(true)}>Disconnect</button>}{showDisconnectConfirm && <div role="dialog" aria-modal="false" aria-labelledby="zoom-disconnect-title" style={{ position: "absolute", zIndex: 30, top: "calc(100% + 10px)", right: 0, width: "min(390px, calc(100vw - 3rem))", padding: 16, borderRadius: 10, background: "var(--surface-color, #fff)", border: "1px solid var(--border-color, #d8e1e8)", boxShadow: "0 12px 35px rgba(15,23,42,.22)", color: "var(--text-primary)" }}><strong id="zoom-disconnect-title" style={{ display: "block", marginBottom: 7 }}>Disconnect Zoom?</strong><p style={{ margin: "0 0 14px", color: "var(--text-secondary)", lineHeight: 1.5 }}>This permanently removes this tenant’s saved Zoom credentials. Published Meeting Forms must be disabled first.</p><div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button type="button" disabled={disconnectingZoom} style={{ ...primary, background: "var(--card-bg, #fff)", color: "inherit", border: "1px solid var(--border-color, #d8e1e8)" }} onClick={() => setShowDisconnectConfirm(false)}>Keep Connected</button><button type="button" disabled={disconnectingZoom} style={{ ...primary, background: "#b91c1c" }} onClick={disconnectZoom}>{disconnectingZoom ? "Disconnecting…" : "Disconnect Zoom"}</button></div></div>}</div>
          </section>}

          {tab === "integration" && <section style={box}>
            <h2 style={{ marginTop: 0 }}>Embed and API integration</h2>
            {!publicKey ? <p>Save this meeting form to generate integration details.</p> : <>
              <label style={label}><FieldTitle help="Open this hosted booking form directly or use it as the iframe source.">Embed URL</FieldTitle><div style={{ display: "flex", gap: 8 }}><input readOnly style={input} value={embedUrl} /><button title="Copy the hosted Meeting Form URL" style={primary} onClick={() => copy(embedUrl, "Embed URL copied")}><Copy size={16} /></button></div></label>
              <label style={{ ...label, marginTop: 14 }}><FieldTitle help="Paste this complete iframe tag into the client's website.">Iframe code</FieldTitle><textarea readOnly style={{ ...input, minHeight: 90, fontFamily: "monospace" }} value={embedCode} /><button title="Copy the complete iframe HTML" style={{ ...primary, width: "max-content" }} onClick={() => copy(embedCode, "Iframe code copied")}><Copy size={16} /> Copy embed</button></label>
              <h3>API endpoints</h3><pre style={{ whiteSpace: "pre-wrap", padding: 14, borderRadius: 8, background: "var(--hover-bg, #f5f7fa)" }}>{`GET  ${apiBase}\nGET  ${apiBase}/availability?start=YYYY-MM-DD&days=31\nPOST ${apiBase}/validate-slot\nPOST ${apiBase}/book\nGET  ${apiBase}/bookings/{confirmationToken}`}</pre>
              <p style={{ color: "var(--text-secondary)" }}>No API key is required. Use these generated URLs directly. Browser access follows the tenant-wide CRM Embed Allowlist; duplicate booking protection is handled automatically.</p>
              <div style={{ marginTop: 18 }}><iframe key={`${embedUrl}-${refreshVersion}`} title="Meeting form preview" src={embedUrl} style={{ width: "100%", minHeight: 760, border: "1px solid var(--border-color, #ddd)", borderRadius: 10 }} /></div>
            </>}
          </section>}

          {tab === "bookings" && <section style={box}>
            <h2 style={{ marginTop: 0 }}>Bookings</h2>
            <table className="meeting-bookings-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: 13 }}>
              <colgroup><col style={{ width: "20%" }} /><col style={{ width: "21%" }} /><col style={{ width: "19%" }} /><col style={{ width: "11%" }} /><col style={{ width: "14%" }} /><col style={{ width: "15%" }} /></colgroup>
              <thead><tr>{["Contact","Institution","When","Status","Meeting","Confirmation email"].map((h) => <th key={h} style={{ textAlign: "left", padding: "9px 8px", borderBottom: "1px solid var(--border-color)", fontSize: 12 }}>{h}</th>)}</tr></thead>
              <tbody>{bookings.map((booking) => <tr key={booking.id}>
                <td data-label="Contact" style={{ padding: "10px 8px", overflowWrap: "anywhere" }}><strong style={{ fontWeight: 600 }}>{booking.contactName}</strong><small style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-secondary)" }}>{booking.contactEmail}</small></td>
                <td data-label="Institution" style={{ padding: "10px 8px", overflowWrap: "anywhere" }}>{booking.institution || "—"}</td>
                <td data-label="When" style={{ padding: "10px 8px", lineHeight: 1.35 }}>{formatBookingWhen(booking.scheduledAt, booking.timezone || draft.timezone)}</td>
                <td data-label="Status" style={{ padding: "10px 8px", overflowWrap: "anywhere" }}>{booking.status}</td>
                <td data-label="Meeting" style={{ padding: "10px 8px" }}>{booking.meetingUrl ? <a href={booking.meetingUrl} target="_blank" rel="noopener noreferrer" title={`Open ${booking.contactName}'s Zoom meeting`} style={{ ...primary, padding: "6px 8px", fontSize: 12, textDecoration: "none", width: "max-content", whiteSpace: "nowrap" }}>Go to Meeting</a> : <span style={{ color: "var(--text-secondary)" }}>Unavailable</span>}</td>
                <td data-label="Confirmation email" style={{ padding: "10px 8px" }}><div className="meeting-email-status" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 7 }}><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{booking.emailStatus}</span>{booking.status === "CONFIRMED" && booking.emailStatus !== "SENT" && <button type="button" style={{ ...primary, padding: "5px 7px", fontSize: 11, flex: "0 0 auto" }} onClick={() => resendConfirmation(booking.id)}>Resend</button>}</div></td>
              </tr>)}</tbody>
            </table>
          </section>}

        </main>
      </div>
      {showDeleteConfirm && selected && <div className="meeting-delete-overlay" role="presentation" style={{ position: "fixed", zIndex: 1000, inset: 0, display: "grid", placeItems: "center", padding: 20, background: "rgba(15,23,42,.48)" }} onMouseDown={(event) => { if (event.target === event.currentTarget) setShowDeleteConfirm(false); }}>
        <div role="dialog" aria-modal="true" aria-labelledby="meeting-delete-title" style={{ ...box, width: "min(92vw, 470px)", padding: 22, boxShadow: "0 24px 70px rgba(15,23,42,.28)" }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
            <div>
              <h2 id="meeting-delete-title" style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}><Trash2 size={20} /> {selected._count?.bookings > 0 ? "Meeting Form cannot be deleted" : "Delete Meeting Form?"}</h2>
              {selected._count?.bookings > 0
                ? <p style={{ margin: "12px 0 0", color: "var(--text-secondary)", lineHeight: 1.55 }}>“{selected.name}” has {selected._count.bookings} booking{selected._count.bookings === 1 ? "" : "s"}. Its booking history is protected. Turn off <strong>Active/published</strong> and save the form to stop accepting new bookings.</p>
                : <p style={{ margin: "12px 0 0", color: "var(--text-secondary)", lineHeight: 1.55 }}>This permanently deletes “{selected.name}”. Its public embed and API URLs will stop working, and its uploaded email footer logo will be removed.</p>}
            </div>
            <button type="button" aria-label="Close delete Meeting Form dialog" onClick={() => setShowDeleteConfirm(false)} style={{ border: 0, background: "transparent", color: "inherit", cursor: "pointer", padding: 2 }}><X size={20} /></button>
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 9, marginTop: 20 }}>
            <button type="button" onClick={() => setShowDeleteConfirm(false)} style={{ ...primary, color: "inherit", background: "var(--card-bg, #fff)", border: "1px solid var(--border-color, #d8e1e8)" }}>{selected._count?.bookings > 0 ? "Close" : "Cancel"}</button>
            {(selected._count?.bookings || 0) === 0 && <button type="button" aria-label="Confirm delete Meeting Form" onClick={deleteMeetingForm} disabled={deletingForm} style={{ ...primary, background: "#b91c1c" }}><Trash2 size={16} /> {deletingForm ? "Deleting…" : "Delete Meeting Form"}</button>}
          </div>
        </div>
      </div>}
      <style>{`@keyframes meeting-refresh-spin{to{transform:rotate(360deg)}}.meeting-refresh-spin{animation:meeting-refresh-spin .75s linear infinite}.meeting-toolbar-toggle{display:inline-flex;align-items:center;gap:8px;padding:8px 11px;border:1px solid var(--border-color,#d8e1e8);border-radius:8px;background:var(--card-bg,#fff);font-size:13px;font-weight:800;white-space:nowrap;cursor:pointer;box-shadow:0 1px 2px rgba(15,23,42,.05)}.meeting-toolbar-toggle:hover{background:var(--hover-bg,#eef2f7);border-color:var(--primary-color,var(--accent-color))}.meeting-toolbar-toggle input{width:17px;height:17px;margin:0;accent-color:var(--primary-color,var(--accent-color));cursor:pointer}.meeting-help-tip{position:relative;display:inline-flex;align-items:center;color:var(--text-secondary);cursor:help;outline:none}.meeting-help-tip:after{content:attr(data-tooltip);position:absolute;z-index:100;left:50%;bottom:calc(100% + 8px);transform:translateX(-50%) translateY(3px);width:max-content;max-width:260px;padding:8px 10px;border-radius:7px;background:#111827;color:#fff;font-size:11px;font-weight:500;line-height:1.4;white-space:normal;box-shadow:0 8px 24px rgba(15,23,42,.2);opacity:0;visibility:hidden;pointer-events:none;transition:.15s}.meeting-help-tip:hover:after,.meeting-help-tip:focus:after{opacity:1;visibility:visible;transform:translateX(-50%) translateY(0)}.meeting-calendar-nav{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border:1px solid var(--border-color,#d8e1e8);border-radius:7px;background:transparent;color:inherit;cursor:pointer}.meeting-calendar-day:hover,.meeting-calendar-nav:hover{background:var(--hover-bg,#eef2f7)!important;color:inherit!important}.meeting-calendar-day[aria-pressed=true]:hover{background:var(--primary-color,var(--accent-color))!important;color:#fff!important}.meeting-date-chip{display:inline-flex;align-items:center;gap:5px;padding:5px 7px 5px 9px;border-radius:999px;background:var(--hover-bg,#eef2f7);font-size:11px}.meeting-date-chip button{display:inline-flex;border:0;background:transparent;color:inherit;padding:1px;cursor:pointer}.meeting-bookings-table tbody tr:not(:last-child){border-bottom:1px solid var(--border-color,#e5e7eb)}@media(max-width:1050px){.meeting-bookings-table,.meeting-bookings-table tbody{display:block}.meeting-bookings-table colgroup,.meeting-bookings-table thead{display:none}.meeting-bookings-table tbody{display:grid;gap:12px}.meeting-bookings-table tbody tr{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;padding:10px;border:1px solid var(--border-color,#d8e1e8)!important;border-radius:9px;background:var(--card-bg,#fff)}.meeting-bookings-table tbody td{display:grid;grid-template-columns:115px minmax(0,1fr);align-items:center;gap:8px;padding:7px 5px!important;min-width:0}.meeting-bookings-table tbody td:before{content:attr(data-label);font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:var(--text-secondary)}.meeting-email-status{justify-content:flex-start!important}}@media(max-width:800px){.meeting-forms-layout,.meeting-field-row,.meeting-font-setting,.meeting-email-settings{grid-template-columns:1fr!important}.meeting-schedule-day{grid-template-columns:1fr!important}.meeting-schedule-day>strong{padding-top:0!important}.meeting-time-window{grid-template-columns:1fr 1fr!important}.meeting-time-window>button{grid-column:1/-1;justify-self:start}.meeting-help-tip:after{left:0;transform:translateY(3px)}.meeting-help-tip:hover:after,.meeting-help-tip:focus:after{transform:translateY(0)}}@media(max-width:620px){.meeting-bookings-table tbody tr{grid-template-columns:1fr}.meeting-bookings-table tbody td{grid-template-columns:105px minmax(0,1fr)}}`}</style>
    </div>
  );
}
