// Travel CRM — RFU Customer Profile (PRD §7).
//
// Lives at /travel/rfu/customers/:contactId. Reads from
//   GET  /api/contacts/:id                   — for name/email/phone
//   GET  /api/travel/rfu-profiles/by-contact/:contactId  — the RFU
//                                                          extension
// and lets advisors fill in the full RFU profile fields (passport,
// visa history, frequent-flyer, preferences, budget, emergency
// contact, medical notes, complaints, product tier) per PRD §4.5
// "RFU customer database — full profile."
//
// Phase 1: paint-by-numbers form. Visa history / frequent-flyer /
// past complaints are free-form JSON textareas; the Phase 1.5 visual
// builders for those will land per the same trajectory as the
// diagnostic Q-set + microsite editor flows.

import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  AlertCircle, AlertTriangle, ChevronLeft, Edit2, Globe, Save, User, X,
} from "lucide-react";
import { fetchApi } from "../../utils/api";
import { useNotify } from "../../utils/notify";

const PRODUCT_TIERS = [
  { value: "", label: "(not set)" },
  { value: "entry", label: "Entry" },
  { value: "primary", label: "Primary" },
  { value: "premium", label: "Premium" },
];

const blankProfile = {
  passportNumber: "",
  passportExpiry: "",
  visaHistoryJson: "",
  frequentFlyerJson: "",
  seatPref: "",
  mealPref: "",
  travelStyle: "",
  budgetMin: "",
  budgetMax: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  medicalNotes: "",
  specialAssistance: "",
  pastComplaintsJson: "",
  productTier: "",
};

function toDateInput(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (!Number.isFinite(dt.getTime())) return "";
  return dt.toISOString().slice(0, 10);
}

export default function RfuCustomerProfile() {
  const { contactId } = useParams();
  const notify = useNotify();
  const navigate = useNavigate();
  const cid = parseInt(contactId, 10);

  const [contact, setContact] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(blankProfile);
  // PRD §4.5 — when the backend rejects with 409 DUPLICATE_PASSPORT,
  // surface the merge-or-edit choice in a modal instead of a toast.
  // `null` = closed; otherwise `{ existingContactId, existingProfileId,
  // attemptedPassport }`.
  const [dupModal, setDupModal] = useState(null);

  const load = () => {
    setLoading(true);
    Promise.all([
      fetchApi(`/api/contacts/${cid}`).catch(() => null),
      fetchApi(`/api/travel/rfu-profiles/by-contact/${cid}`).catch((e) => {
        if (e?.status === 404) return null; // no profile yet — show "Create" CTA
        throw e;
      }),
    ])
      .then(([c, p]) => {
        setContact(c);
        setProfile(p);
        if (p) {
          setForm({
            passportNumber: p.passportNumber || "",
            passportExpiry: toDateInput(p.passportExpiry),
            visaHistoryJson: p.visaHistoryJson || "",
            frequentFlyerJson: p.frequentFlyerJson || "",
            seatPref: p.seatPref || "",
            mealPref: p.mealPref || "",
            travelStyle: p.travelStyle || "",
            budgetMin: p.budgetMin != null ? String(p.budgetMin) : "",
            budgetMax: p.budgetMax != null ? String(p.budgetMax) : "",
            emergencyContactName: p.emergencyContactName || "",
            emergencyContactPhone: p.emergencyContactPhone || "",
            medicalNotes: p.medicalNotes || "",
            specialAssistance: p.specialAssistance || "",
            pastComplaintsJson: p.pastComplaintsJson || "",
            productTier: p.productTier || "",
          });
        }
      })
      .catch((e) => notify.error(e?.body?.error || "Failed to load profile"))
      .finally(() => setLoading(false));
  };
  useEffect(load, [cid]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    // Validate JSON-shaped textareas client-side so users don't get a
    // misleading 500 from the server. Empty strings are fine.
    for (const k of ["visaHistoryJson", "frequentFlyerJson", "pastComplaintsJson"]) {
      if (form[k] && form[k].trim()) {
        try { JSON.parse(form[k]); }
        catch { notify.error(`${k} is not valid JSON`); return; }
      }
    }
    const body = {
      passportNumber: form.passportNumber || null,
      passportExpiry: form.passportExpiry || null,
      visaHistoryJson: form.visaHistoryJson || null,
      frequentFlyerJson: form.frequentFlyerJson || null,
      seatPref: form.seatPref || null,
      mealPref: form.mealPref || null,
      travelStyle: form.travelStyle || null,
      budgetMin: form.budgetMin === "" ? null : Number(form.budgetMin),
      budgetMax: form.budgetMax === "" ? null : Number(form.budgetMax),
      emergencyContactName: form.emergencyContactName || null,
      emergencyContactPhone: form.emergencyContactPhone || null,
      medicalNotes: form.medicalNotes || null,
      specialAssistance: form.specialAssistance || null,
      pastComplaintsJson: form.pastComplaintsJson || null,
      productTier: form.productTier || null,
    };
    setSaving(true);
    try {
      if (profile) {
        await fetchApi(`/api/travel/rfu-profiles/${profile.id}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        notify.success("Profile updated");
      } else {
        await fetchApi("/api/travel/rfu-profiles", {
          method: "POST",
          body: JSON.stringify({ contactId: cid, ...body }),
        });
        notify.success("Profile created");
      }
      setEditing(false);
      load();
    } catch (e) {
      // PRD §4.5 — passport-key collision: a different contact in this
      // tenant already owns the passport the operator typed. Show the
      // merge-or-edit modal rather than a toast so the operator can
      // navigate to the other contact's profile (one-click).
      if (e?.status === 409 && e?.body?.code === "DUPLICATE_PASSPORT") {
        setDupModal({
          existingContactId: e.body.existingContactId,
          existingProfileId: e.body.existingProfileId,
          attemptedPassport: form.passportNumber,
        });
      } else {
        notify.error(e?.body?.error || "Failed to save profile");
      }
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div style={{ padding: 24 }}>Loading&hellip;</div>;
  if (!Number.isFinite(cid)) {
    return (
      <div style={{ padding: 24 }}>
        <Link to="/travel/leads" style={backLink}><ChevronLeft size={16} /> Back to leads</Link>
        <p style={{ color: "var(--text-secondary)" }}>Invalid contact id in URL.</p>
      </div>
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
      <Link to="/travel/leads" style={backLink}>
        <ChevronLeft size={16} aria-hidden /> Back to leads
      </Link>

      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, margin: "8px 0 16px" }}>
        <div>
          <h1 style={{ display: "flex", alignItems: "center", gap: 10, margin: 0 }}>
            <Globe size={28} aria-hidden /> RFU Customer Profile
          </h1>
          <div style={{ color: "var(--text-secondary)", marginTop: 4 }}>
            <User size={14} aria-hidden style={{ verticalAlign: -2, marginRight: 6 }} />
            {contact?.name || `Contact #${cid}`}
            {contact?.email && <span> &middot; {contact.email}</span>}
            {contact?.phone && <span> &middot; {contact.phone}</span>}
          </div>
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} style={primaryBtn}>
            <Edit2 size={14} /> {profile ? "Edit profile" : "Create profile"}
          </button>
        )}
      </header>

      {!profile && !editing && (
        <div style={emptyBox} role="status">
          <AlertCircle size={18} aria-hidden style={{ color: "var(--warning-color)" }} />
          <span>No RFU profile yet for this contact. Click <strong>Create profile</strong> to add the full RFU detail per PRD §4.5.</span>
        </div>
      )}

      {editing ? (
        <FormView form={form} setForm={setForm} onSave={save} onCancel={() => { setEditing(false); load(); }} saving={saving} />
      ) : profile ? (
        <ReadView profile={profile} />
      ) : null}

      {dupModal && (
        <DuplicatePassportModal
          existingContactId={dupModal.existingContactId}
          existingProfileId={dupModal.existingProfileId}
          attemptedPassport={dupModal.attemptedPassport}
          onGoToContact={() => {
            setDupModal(null);
            navigate(`/travel/rfu/customers/${dupModal.existingContactId}`);
          }}
          onClose={() => setDupModal(null)}
        />
      )}
    </div>
  );
}

// ─── Duplicate-passport modal (PRD §4.5 Phase 2 dedup) ───────────────
//
// Surfaced when POST /rfu-profiles or PATCH /rfu-profiles/:id returns
// 409 DUPLICATE_PASSPORT. Lets the operator either jump to the other
// contact (preferred — preserves the pilgrim's single history line)
// or dismiss and edit the passport to the correct value.

function DuplicatePassportModal({
  existingContactId,
  attemptedPassport,
  onGoToContact,
  onClose,
}) {
  const [otherContact, setOtherContact] = useState(null);
  useEffect(() => {
    if (!existingContactId) return;
    fetchApi(`/api/contacts/${existingContactId}`)
      .then(setOtherContact)
      .catch(() => { /* fall back to id-only display */ });
  }, [existingContactId]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dup-passport-modal-title"
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: 16,
      }}
    >
      <div style={{
        background: "var(--surface-color)", color: "var(--text-primary)",
        borderRadius: 12, padding: 24, maxWidth: 480, width: "100%",
        border: "1px solid var(--border-color)",
        boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
      }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <AlertTriangle size={22} aria-hidden style={{ color: "var(--warning-color)" }} />
          <h2 id="dup-passport-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Passport already on file
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: "auto", background: "transparent", border: "none",
              cursor: "pointer", color: "var(--text-secondary)",
            }}
          >
            <X size={18} />
          </button>
        </header>
        <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>
          Passport <strong>{attemptedPassport}</strong> is already linked to{" "}
          {otherContact ? (
            <>
              <strong>{otherContact.name}</strong>
              {otherContact.email && <> ({otherContact.email})</>}
            </>
          ) : (
            <strong>contact #{existingContactId}</strong>
          )}
          . A passport must belong to one pilgrim — please open that contact and update their record, or correct the passport number here.
        </p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
              background: "var(--surface-color)", color: "var(--text-primary)",
              border: "1px solid var(--border-color)", cursor: "pointer",
            }}
          >
            Edit passport
          </button>
          <button
            type="button"
            onClick={onGoToContact}
            style={{
              padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
              background: "var(--primary-color, var(--accent-color))", color: "#fff",
              border: "none", cursor: "pointer",
            }}
          >
            Open that contact
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Read view ──────────────────────────────────────────────────────

function ReadView({ profile }) {
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
      <Card title="Identity & travel docs">
        <KV label="Passport number" value={profile.passportNumber} />
        <KV label="Passport expiry" value={profile.passportExpiry ? new Date(profile.passportExpiry).toLocaleDateString() : null} />
        <KV label="Product tier" value={profile.productTier} badge />
      </Card>
      <Card title="Preferences">
        <KV label="Seat preference" value={profile.seatPref} />
        <KV label="Meal preference" value={profile.mealPref} />
        <KV label="Travel style" value={profile.travelStyle} />
      </Card>
      <Card title="Budget">
        <KV label="Min" value={profile.budgetMin != null ? `₹${Number(profile.budgetMin).toLocaleString("en-IN")}` : null} />
        <KV label="Max" value={profile.budgetMax != null ? `₹${Number(profile.budgetMax).toLocaleString("en-IN")}` : null} />
      </Card>
      <Card title="Emergency contact">
        <KV label="Name" value={profile.emergencyContactName} />
        <KV label="Phone" value={profile.emergencyContactPhone} />
      </Card>
      <Card title="Medical + special assistance" wide>
        <KV label="Medical notes" value={profile.medicalNotes} multiline />
        <KV label="Special assistance" value={profile.specialAssistance} multiline />
      </Card>
      <Card title="Visa history (JSON)" wide>
        <Pre value={profile.visaHistoryJson} placeholder="No visa history captured yet." />
      </Card>
      <Card title="Frequent-flyer (JSON)" wide>
        <Pre value={profile.frequentFlyerJson} placeholder="No frequent-flyer numbers captured." />
      </Card>
      <Card title="Past complaints (JSON)" wide>
        <Pre value={profile.pastComplaintsJson} placeholder="No past complaints logged." />
      </Card>
    </div>
  );
}

function KV({ label, value, badge, multiline }) {
  return (
    <div style={kvRow}>
      <span style={kvLabel}>{label}</span>
      {value
        ? badge
          ? <span style={brandBadge}>{value}</span>
          : <span style={{ whiteSpace: multiline ? "pre-wrap" : "normal" }}>{value}</span>
        : <span style={{ color: "var(--text-secondary)" }}>—</span>}
    </div>
  );
}

function Pre({ value, placeholder }) {
  if (!value) return <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{placeholder}</div>;
  // Pretty-print if parseable JSON; otherwise display raw.
  let printed = value;
  try { printed = JSON.stringify(JSON.parse(value), null, 2); } catch { /* keep raw */ }
  return (
    <pre style={{
      margin: 0, padding: 12, borderRadius: 6, fontSize: 12,
      background: "var(--bg-color)", color: "var(--text-primary)",
      maxHeight: 240, overflow: "auto",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    }}>{printed}</pre>
  );
}

// ─── Edit form ──────────────────────────────────────────────────────

function FormView({ form, setForm, onSave, onCancel, saving }) {
  const set = (k, v) => setForm({ ...form, [k]: v });
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <Card title="Identity & travel docs">
        <Field label="Passport number">
          <input value={form.passportNumber} onChange={(e) => set("passportNumber", e.target.value)} style={input} />
        </Field>
        <Field label="Passport expiry">
          <input type="date" value={form.passportExpiry} onChange={(e) => set("passportExpiry", e.target.value)} style={input} />
        </Field>
        <Field label="Product tier">
          <select value={form.productTier} onChange={(e) => set("productTier", e.target.value)} style={input}>
            {PRODUCT_TIERS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </Field>
      </Card>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))" }}>
        <Card title="Preferences">
          <Field label="Seat preference"><input value={form.seatPref} onChange={(e) => set("seatPref", e.target.value)} style={input} placeholder="window | aisle | exit-row" /></Field>
          <Field label="Meal preference"><input value={form.mealPref} onChange={(e) => set("mealPref", e.target.value)} style={input} placeholder="veg | halal | gluten-free" /></Field>
          <Field label="Travel style"><input value={form.travelStyle} onChange={(e) => set("travelStyle", e.target.value)} style={input} placeholder="luxury | comfort | budget" /></Field>
        </Card>
        <Card title="Budget">
          <Field label="Min (₹)"><input type="number" min="0" value={form.budgetMin} onChange={(e) => set("budgetMin", e.target.value)} style={input} /></Field>
          <Field label="Max (₹)"><input type="number" min="0" value={form.budgetMax} onChange={(e) => set("budgetMax", e.target.value)} style={input} /></Field>
        </Card>
        <Card title="Emergency contact">
          <Field label="Name"><input value={form.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} style={input} /></Field>
          <Field label="Phone"><input value={form.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} style={input} placeholder="+91…" /></Field>
        </Card>
      </div>

      <Card title="Medical + special assistance">
        <Field label="Medical notes"><textarea value={form.medicalNotes} onChange={(e) => set("medicalNotes", e.target.value)} style={textarea} rows={3} /></Field>
        <Field label="Special assistance"><textarea value={form.specialAssistance} onChange={(e) => set("specialAssistance", e.target.value)} style={textarea} rows={3} /></Field>
      </Card>

      <Card title="JSON fields (paste / edit raw)">
        <Field label="Visa history JSON"><textarea value={form.visaHistoryJson} onChange={(e) => set("visaHistoryJson", e.target.value)} style={textareaMono} rows={4} placeholder='[{"country":"AE","date":"2024-03","outcome":"granted"}]' /></Field>
        <Field label="Frequent-flyer JSON"><textarea value={form.frequentFlyerJson} onChange={(e) => set("frequentFlyerJson", e.target.value)} style={textareaMono} rows={3} placeholder='[{"airline":"6E","number":"123456","tier":"silver"}]' /></Field>
        <Field label="Past complaints JSON"><textarea value={form.pastComplaintsJson} onChange={(e) => set("pastComplaintsJson", e.target.value)} style={textareaMono} rows={3} placeholder='[{"date":"2025-02","topic":"hotel","status":"resolved"}]' /></Field>
      </Card>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={onCancel} style={secondaryBtn}>
          <X size={14} /> Cancel
        </button>
        <button type="button" onClick={onSave} disabled={saving} style={saving ? primaryBtnDisabled : primaryBtn}>
          <Save size={14} /> {saving ? "Saving…" : "Save profile"}
        </button>
      </div>
    </div>
  );
}

function Card({ title, children, wide }) {
  return (
    <section style={{ ...card, gridColumn: wide ? "1 / -1" : undefined }}>
      <h2 style={cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ display: "block", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4, fontWeight: 600 }}>
        {label}
      </label>
      {children}
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────

const backLink = {
  display: "inline-flex", alignItems: "center", gap: 4,
  fontSize: 13, color: "var(--text-secondary)", textDecoration: "none",
  padding: "4px 8px", borderRadius: 4,
};
const card = {
  background: "var(--surface-color)",
  borderRadius: 12,
  padding: 16,
  border: "1px solid var(--border-color)",
};
const cardTitle = { margin: "0 0 12px", fontSize: 15 };
const emptyBox = {
  marginTop: 16, padding: 16, borderRadius: 12,
  background: "var(--subtle-bg)", border: "1px solid var(--border-color)",
  display: "flex", alignItems: "center", gap: 10,
  color: "var(--text-secondary)", fontSize: 14,
};
const kvRow = {
  display: "flex", justifyContent: "space-between", gap: 8,
  padding: "6px 0", borderTop: "1px solid var(--border-light)",
  fontSize: 13,
};
const kvLabel = { color: "var(--text-secondary)", fontWeight: 500 };
const brandBadge = {
  padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600,
  background: "var(--subtle-bg-3)", color: "var(--primary-color)",
  textTransform: "uppercase", letterSpacing: 0.5,
};
const input = {
  padding: "8px 10px", borderRadius: 6, width: "100%", boxSizing: "border-box",
  border: "1px solid var(--border-color)",
  background: "var(--bg-color)", color: "var(--text-primary)", fontSize: 13,
};
const textarea = { ...input, resize: "vertical" };
const textareaMono = {
  ...textarea,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12,
};
const primaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--primary-color)", color: "#fff",
  border: "none", cursor: "pointer",
};
const primaryBtnDisabled = { ...primaryBtn, opacity: 0.5, cursor: "not-allowed" };
const secondaryBtn = {
  display: "inline-flex", alignItems: "center", gap: 6,
  padding: "8px 14px", borderRadius: 6, fontWeight: 600, fontSize: 13,
  background: "var(--surface-color)", color: "var(--text-primary)",
  border: "1px solid var(--border-color)", cursor: "pointer",
};
