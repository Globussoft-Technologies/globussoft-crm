import { useState } from "react";
import {
  Phone,
  UserPlus,
  Mail as MailIcon,
  Calendar as CalendarIcon,
  AtSign,
  Globe,
  FileText,
} from "lucide-react";
import { fetchApi } from "../../../utils/api";
import { useNotify } from "../../../utils/notify";
import ModalShell from "./ModalShell";
import { iconBtnSmall, primaryTealBtn, modalInputStyle } from "./styles";

// ── Create-customer modal ──────────────────────────────────────────
export default function PatientCreateModal({ locations, onClose, onCreated, editPatient = null }) {
  const notify = useNotify();
  const isEdit = !!editPatient;
  const INDIAN_MOBILE_RE = /^(\+91)?[6-9]\d{9}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const toE164OnBlur = (raw) => {
    if (!raw) return raw;
    const cleaned = String(raw).replace(/[\s\-()]/g, "");
    if (cleaned.startsWith("+91") && /^\+91[6-9]\d{9}$/.test(cleaned)) return cleaned;
    if (/^91[6-9]\d{9}$/.test(cleaned)) return "+" + cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return "+91" + cleaned;
    return raw;
  };

  // Date fields come back from the API as ISO strings; <input type="date">
  // needs YYYY-MM-DD. Strip the time half.
  const toDateInput = (val) => {
    if (!val) return "";
    if (typeof val === "string") return val.slice(0, 10);
    try { return new Date(val).toISOString().slice(0, 10); } catch { return ""; }
  };

  // S97 — structured intake. Persist firstName + lastName explicitly so
  // the patient row's structured-name columns (S62) start populating from
  // the create flow. Legacy `name` column stays the canonical full-name
  // surface (it backs the search index, SMS templates, and prescriptions)
  // and is derived on save from `${firstName} ${lastName}`.trim().
  //
  // Edit-mode prefill: when the row already has firstName/lastName, use
  // them as-is. When the row is legacy (firstName + lastName both null)
  // we best-effort split the existing `name`: everything before the last
  // whitespace run goes to firstName, the final word becomes lastName.
  // Single-word names land entirely in firstName with lastName empty —
  // this is the right shape for cultures with single legal names.
  const splitLegacyName = (full) => {
    const s = String(full || "").trim();
    if (!s) return { firstName: "", lastName: "" };
    const parts = s.split(/\s+/);
    if (parts.length === 1) return { firstName: parts[0], lastName: "" };
    return {
      firstName: parts.slice(0, -1).join(" "),
      lastName: parts[parts.length - 1],
    };
  };
  const [form, setForm] = useState(() => {
    if (editPatient) {
      const hasStructured = editPatient.firstName || editPatient.lastName;
      const split = hasStructured
        ? { firstName: editPatient.firstName || "", lastName: editPatient.lastName || "" }
        : splitLegacyName(editPatient.name);
      return {
        firstName: split.firstName,
        lastName: split.lastName,
        // Legacy `name` is retained for back-compat reads (some callers may
        // pre-fill it) but is auto-derived on render + submit.
        name: editPatient.name || "",
        phone: editPatient.phone || "",
        email: editPatient.email || "",
        gender: editPatient.gender || "",
        taxType: editPatient.taxType || "",
        source: editPatient.source || "walk-in",
        instagramHandle: editPatient.instagramHandle || "",
        dob: toDateInput(editPatient.dob),
        anniversary: toDateInput(editPatient.anniversary),
        notes: editPatient.notes || "",
        locationId: editPatient.locationId || locations[0]?.id || "",
      };
    }
    return {
      firstName: "",
      lastName: "",
      name: "",
      phone: "",
      email: "",
      gender: "",
      taxType: "",
      source: "walk-in",
      instagramHandle: "",
      dob: "",
      anniversary: "",
      notes: "",
      locationId: locations[0]?.id || "",
    };
  });
  // Computed full name preview — derived from the structured fields. This
  // is what we POST as `name` so the canonical legacy column stays
  // populated even for backends that don't yet persist firstName/lastName.
  const derivedName = [form.firstName, form.lastName]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join(" ");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    // S97 — validation moved from `name` to `firstName`. lastName is
    // optional (single-name cultures, mononyms, etc.). The canonical
    // `name` column is derived from the two structured fields on save.
    const trimmedFirstName = (form.firstName || "").trim();
    const trimmedLastName = (form.lastName || "").trim();
    if (trimmedFirstName.length < 1) { notify.error("First name is required"); return; }
    const trimmedName = [trimmedFirstName, trimmedLastName].filter(Boolean).join(" ");
    const phoneClean = (form.phone || "").trim().replace(/[\s\-()]/g, "");
    if (!phoneClean) { notify.error("Phone is required"); return; }
    if (!INDIAN_MOBILE_RE.test(phoneClean)) {
      notify.error("Enter a valid Indian mobile (10 digits, starting 6-9; +91 optional).");
      return;
    }
    const emailRaw = (form.email || "").trim();
    if (emailRaw && !EMAIL_RE.test(emailRaw)) {
      notify.error("Enter a valid email address (e.g. customer@example.com).");
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        // S97 — send all three so the backend can persist whichever it
        // recognises today. POST /patients currently only persists
        // `name`; the structured fields are forward-compat — they'll
        // start populating Patient.firstName / Patient.lastName once the
        // route handler whitelists them (paired follow-up slice).
        name: trimmedName,
        firstName: trimmedFirstName,
        lastName: trimmedLastName || null,
        phone: form.phone,
        email: emailRaw || null,
        gender: form.gender || null,
        taxType: form.taxType || null,
        source: form.source || null,
        instagramHandle: form.instagramHandle ? form.instagramHandle.trim().replace(/^@/, "") : null,
        dob: form.dob || null,
        anniversary: form.anniversary || null,
        notes: form.notes || null,
        locationId: form.locationId ? parseInt(form.locationId) : null,
      };
      if (isEdit) {
        await fetchApi(`/api/wellness/patients/${editPatient.id}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        notify.success(`Customer "${trimmedName}" updated`);
      } else {
        await fetchApi("/api/wellness/patients", { method: "POST", body: JSON.stringify(payload) });
        notify.success(`Customer "${trimmedName}" added`);
      }
      onCreated();
    } catch (_err) { /* toast fired by fetchApi */ }
    finally { setSubmitting(false); }
  };

  return (
    <ModalShell
      title={isEdit ? "Edit customer" : "Create customer"}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" onClick={onClose} style={iconBtnSmall}>Cancel</button>
          <button
            type="submit"
            form="patient-create-form"
            disabled={submitting}
            style={{ ...primaryTealBtn, padding: "0.55rem 1.25rem", opacity: submitting ? 0.6 : 1 }}
          >
            {submitting
              ? (isEdit ? "Saving…" : "Adding…")
              : (isEdit ? "Save changes" : "Add customer")}
          </button>
        </>
      }
    >
      <form id="patient-create-form" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
        <FormField label="Phone number" required icon={<Phone size={14} />}>
          <input
            type="tel"
            inputMode="tel"
            required
            value={form.phone}
            placeholder="+91 9876543210"
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            onBlur={(e) => setForm({ ...form, phone: toE164OnBlur(e.target.value) })}
            style={modalInputStyle}
          />
        </FormField>
        {/* S97 — structured intake: firstName (required) + lastName
            (optional, for mononym / single-legal-name cultures). The
            canonical `name` column is rendered as a read-only derived
            preview below so the operator sees the exact string that will
            be saved + searched on. */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: "1rem" }}>
          <FormField label="First name" required icon={<UserPlus size={14} />}>
            <input
              required
              value={form.firstName}
              placeholder="John"
              aria-label="First name"
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
          <FormField label="Last name">
            <input
              value={form.lastName}
              placeholder="Doe"
              aria-label="Last name"
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
        </div>
        <FormField label="Full name (auto)">
          <input
            readOnly
            tabIndex={-1}
            aria-label="Full name preview"
            data-testid="patient-name-preview"
            value={derivedName}
            placeholder="Will be derived from First + Last"
            style={{
              ...modalInputStyle,
              background: "var(--subtle-bg, rgba(0,0,0,0.04))",
              color: "var(--text-secondary)",
              cursor: "not-allowed",
            }}
          />
        </FormField>
        <FormField label="Gender">
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {[
              { value: "M", label: "Male" },
              { value: "F", label: "Female" },
              { value: "Other", label: "Other" },
            ].map((g) => (
              <button
                key={g.value}
                type="button"
                onClick={() => setForm({ ...form, gender: g.value })}
                aria-pressed={form.gender === g.value}
                style={{
                  flex: "1 1 90px",
                  padding: "0.7rem 0.5rem",
                  borderRadius: 10,
                  border: `1px solid ${form.gender === g.value ? "var(--primary-color, var(--accent-color))" : "var(--border-color, rgba(0,0,0,0.12))"}`,
                  background: form.gender === g.value ? "var(--primary-color, var(--accent-color))" : "var(--subtle-bg, rgba(0,0,0,0.02))",
                  color: form.gender === g.value ? "#fff" : "var(--text-primary)",
                  cursor: "pointer",
                  fontWeight: 500,
                  fontSize: "0.9rem",
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        </FormField>
        <FormField label="Email" icon={<MailIcon size={14} />}>
          <input
            type="email"
            value={form.email}
            placeholder="customer@example.com"
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Tax type">
          <div style={{ display: "flex", gap: "1rem", paddingTop: 4 }}>
            {[
              { value: "individual", label: "Individual" },
              { value: "business", label: "Business" },
            ].map((t) => (
              <label key={t.value} style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", cursor: "pointer", fontSize: "0.9rem" }}>
                <input
                  type="radio"
                  name="taxType"
                  value={t.value}
                  checked={form.taxType === t.value}
                  onChange={() => setForm({ ...form, taxType: t.value })}
                />
                {t.label}
              </label>
            ))}
          </div>
        </FormField>
        <FormField label="Instagram handle" icon={<AtSign size={14} />}>
          <input
            value={form.instagramHandle}
            placeholder="@yourhandle"
            onChange={(e) => setForm({ ...form, instagramHandle: e.target.value })}
            style={modalInputStyle}
          />
        </FormField>
        <FormField label="Lead source" icon={<Globe size={14} />}>
          <select
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            style={modalInputStyle}
          >
            <option value="walk-in">Walk-in</option>
            <option value="referral">Referral</option>
            <option value="website-form">Website form</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="instagram">Instagram</option>
            <option value="meta-ad">Meta ad</option>
            <option value="google-ad">Google ad</option>
            <option value="indiamart">IndiaMART</option>
          </select>
        </FormField>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))", gap: "1rem" }}>
          <FormField label="Date of birth" icon={<CalendarIcon size={14} />}>
            <input
              type="date"
              value={form.dob}
              onChange={(e) => setForm({ ...form, dob: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
          <FormField label="Date of anniversary" icon={<CalendarIcon size={14} />}>
            <input
              type="date"
              value={form.anniversary}
              onChange={(e) => setForm({ ...form, anniversary: e.target.value })}
              style={modalInputStyle}
            />
          </FormField>
        </div>
        {locations.length > 1 && (
          <FormField label="Clinic">
            <select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
              style={modalInputStyle}
            >
              <option value="">Select clinic</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </FormField>
        )}
        <FormField label="Notes" icon={<FileText size={14} />}>
          <textarea
            value={form.notes}
            placeholder="Add any context, allergies, preferences…"
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            style={{ ...modalInputStyle, minHeight: 80, resize: "vertical", fontFamily: "inherit" }}
          />
        </FormField>
      </form>
    </ModalShell>
  );
}

function FormField({ label, required, icon, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.8rem", color: "var(--text-secondary)", fontWeight: 500 }}>
        {required && <span style={{ color: "#e57373" }}>*</span>}
        {icon}
        {label}
      </span>
      {children}
    </label>
  );
}
