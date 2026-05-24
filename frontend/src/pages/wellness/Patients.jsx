import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Plus, Users, Phone, Mail, Pencil, Download, Tag } from "lucide-react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { SEARCH_DEBOUNCE_MS } from "../../utils/timing";
import { formatDate } from "../../utils/date";

export default function Patients() {
  const notify = useNotify();
  const formRef = useRef(null);
  const [patients, setPatients] = useState([]);
  const [total, setTotal] = useState(0);
  // #829 — track 403 from /api/wellness/patients so the empty-state copy
  // honestly says "Access restricted" instead of the misleading "No patients
  // match." that pre-fix made permission-blocked users think their tenant
  // was simply empty.
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [q, setQ] = useState("");
  // #820 Part 1 — client-side pagination. Demo has 51 patients today; rendering
  // them all as one continuous table is acceptable for that scale but breaks
  // down once tenants accumulate hundreds. 25 per page matches the "Standard
  // pagination (25 / 50 / 100 per page)" expectation in the issue. Server-side
  // pagination is a deliberate follow-up (tracked in the #820 follow-up issue).
  const [page, setPage] = useState(1);
  const PER_PAGE = 25;
  // #331-bug fix: form-create flag added so handleCreate can request a refresh
  // without re-introducing a stale-state read. The previous direct `load()`
  // call inside handleCreate re-fetched with whatever `q` the closure had
  // captured when the form was rendered, which raced against the debounced
  // search effect.
  const [reloadTick, setReloadTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  // #931 + #816 Patients slice — CSV export. Backend at
  // /api/wellness/patients.csv (phiReadGate; accepts ?q & ?locationId
  // matching the current view). fetch+blob trick because plain <a href>
  // can't set the Authorization header.
  const [csvBusy, setCsvBusy] = useState(false);
  // #931 — bulk-select + bulk-tag-add. Selected patient ids live in a Set so
  // toggle / clear is O(1). Modal stays open when the request errors so the
  // user can correct the tags input and retry without re-selecting rows.
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [tagModalOpen, setTagModalOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [locations, setLocations] = useState([]);
  // #205: dob added so the form can capture it; gender already exists. Phone
  // is now required (Indian mobile shape); email is optional but validated
  // shape-wise when present.
  const [form, setForm] = useState({
    name: "",
    phone: "",
    email: "",
    dob: "",
    gender: "",
    source: "walk-in",
    locationId: "",
    // #792 — anniversary + GST. Anniversary feeds marketing automations
    // (anniversary-day campaigns); GST is required on the invoice surface
    // for B2B / corporate-account patients.
    anniversary: "",
    gst: "",
  });

  // #331: search box dropped the first character of a fresh query.
  //
  // Root cause: two interacting issues.
  //  1. On mount, the debounced fetch effect ran with q=''. Under React 18
  //     StrictMode (and dev double-invoke) this scheduled a no-op
  //     "fetch all patients" request that completed AFTER the user's first
  //     keystroke fetch. The second response overwrote the filtered list,
  //     re-rendered the table as "No patients found" because the
  //     subsequent typed-query fetch had already updated `loading=false`
  //     and `patients=[]` was the most recent server reply for an
  //     in-flight cancelled request whose stale resolution still landed.
  //  2. The `load` closure captured `q` at definition time. By the time
  //     the timer fired, `q` could be one keystroke behind the input
  //     value because re-renders re-create `load`, but the timer ID being
  //     cleaned up was the one captured by the OUTER useEffect — fine
  //     for cancellation, but the bound `load` that did get called still
  //     used the latest q. The actual cause was (1) — the racing empty
  //     fetch — but to be safe we also (a) read `q` via a ref so the
  //     timer body always sees the current value, (b) tag each fetch
  //     with a request id and ignore stale responses, and (c) skip the
  //     no-op empty-string fetch on initial mount.
  const qRef = useRef(q);
  useEffect(() => {
    qRef.current = q;
  }, [q]);
  const reqIdRef = useRef(0);
  const didMountRef = useRef(false);

  const load = (currentQ) => {
    const myReqId = ++reqIdRef.current;
    setLoading(true);
    const url = currentQ
      ? `/api/wellness/patients?q=${encodeURIComponent(currentQ)}`
      : "/api/wellness/patients";
    fetchApi(url)
      .then((d) => {
        // Drop stale responses — a slow empty-query fetch must not stomp
        // on a fresher typed-query fetch.
        if (myReqId !== reqIdRef.current) return;
        setPatients(d.patients);
        setTotal(d.total);
        setPermissionDenied(false);
      })
      .catch((err) => {
        if (myReqId !== reqIdRef.current) return;
        setPatients([]);
        setTotal(0);
        // #829 — distinguish 403 (caller's role lacks PHI access) from
        // genuine empty / network failure so the empty-state row can show
        // honest copy. fetchApi already toasts the 403 string.
        setPermissionDenied(err?.status === 403);
      })
      .finally(() => {
        if (myReqId !== reqIdRef.current) return;
        setLoading(false);
      });
  };

  // #931 + #816 Patients slice — Export the current view (honors the active
  // search query `q`) as CSV. Mirrors the Services.jsx / Memberships.jsx /
  // BookingPages.jsx CSV pattern from commits 41d15f8 / 5069871 / 962d82a.
  // Endpoint applies phiReadGate so a USER without PHI access will receive
  // 403; we surface that via notify (no need to also flip permissionDenied
  // since the table state isn't affected).
  const exportCsv = async () => {
    setCsvBusy(true);
    try {
      const token = getAuthToken();
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await fetch(`/api/wellness/patients.csv${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `patients-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      notify.success(`Exported ${total.toLocaleString()} patient${total === 1 ? '' : 's'}.`);
    } catch (e) {
      notify.error(e.message || 'CSV export failed.');
    } finally {
      setCsvBusy(false);
    }
  };

  // #931 — bulk-select helpers. `toggleSelect` flips an individual row;
  // `toggleSelectAllVisible` selects every patient on the current page if
  // any are unselected, otherwise clears the whole selection. We deliberately
  // operate on the CURRENT PAGE only — selecting all rows across pages would
  // be a surprising side-effect since the user can't see what they're tagging.
  const toggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleSelectAllVisible = (visibleList) => {
    setSelectedIds((prev) => {
      const allSelected = visibleList.length > 0 && visibleList.every((p) => prev.has(p.id));
      if (allSelected) {
        const next = new Set(prev);
        for (const p of visibleList) next.delete(p.id);
        return next;
      }
      const next = new Set(prev);
      for (const p of visibleList) next.add(p.id);
      return next;
    });
  };

  // #931 — submit the bulk-tag-add modal. Parses the comma-separated tag
  // input, trims + lowercases + dedupes client-side (server also re-dedupes
  // defensively). On success: clear modal state, clear selection, refresh
  // list. On error: modal stays open so the user can correct the tag string.
  const submitBulkTags = async () => {
    const raw = tagInput || "";
    const parsed = raw
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const deduped = Array.from(new Set(parsed));
    if (deduped.length === 0) {
      notify.error("Enter at least one tag (comma-separated).");
      return;
    }
    if (deduped.length > 20) {
      notify.error("Cannot add more than 20 tags in a single request.");
      return;
    }
    const patientIds = Array.from(selectedIds);
    if (patientIds.length === 0) {
      notify.error("No patients selected.");
      return;
    }
    setTagBusy(true);
    try {
      const res = await fetchApi("/api/wellness/patients/bulk-tags", {
        method: "PATCH",
        body: JSON.stringify({ patientIds, addTags: deduped }),
      });
      const updatedCount = res?.updated ?? patientIds.length;
      notify.success(
        `Added ${deduped.length} tag${deduped.length === 1 ? "" : "s"} to ${updatedCount} patient${updatedCount === 1 ? "" : "s"}.`,
      );
      setTagInput("");
      setTagModalOpen(false);
      setSelectedIds(new Set());
      setReloadTick((t) => t + 1);
    } catch (e) {
      notify.error(e?.message || "Failed to add tags.");
      // Modal stays open intentionally so the user can retry.
    } finally {
      setTagBusy(false);
    }
  };

  useEffect(() => {
    // First mount: do exactly one immediate load with empty q so the table
    // populates, but don't go through the debounced path that races with
    // the user's first keystroke.
    if (!didMountRef.current) {
      didMountRef.current = true;
      load("");
      return;
    }
    // #548: standardised on SEARCH_DEBOUNCE_MS (300ms) — was 250ms; pen-test
    // flagged drift between Patients (250) and Omnibar (300). One source of
    // truth in utils/timing.js.
    const t = setTimeout(() => load(qRef.current), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q, reloadTick]);

  useEffect(() => {
    fetchApi("/api/wellness/locations")
      .then(setLocations)
      .catch(() => setLocations([]));
  }, []);

  useEffect(() => {
    if (showAdd && formRef.current) {
      formRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [showAdd]);

  // #820 Part 1 — reset to page 1 whenever the active filter changes, otherwise
  // the user can be stranded on page 3 of a result set that only has 1 page
  // after they tighten the search.
  useEffect(() => {
    setPage(1);
    // #931 — clear bulk-selection when the filter changes; previously-selected
    // ids may no longer be visible, and silently bulk-tagging hidden rows
    // would violate "what you see is what you tag" expectations.
    setSelectedIds(new Set());
  }, [q]);

  // #820 Part 1 — compute the visible slice. `totalPages` falls back to 1 so
  // the "Page 1 of 1" indicator still renders when the list is empty.
  const totalPages = Math.max(1, Math.ceil(patients.length / PER_PAGE));
  const startIdx = (page - 1) * PER_PAGE;
  const visiblePatients = patients.slice(startIdx, startIdx + PER_PAGE);

  // #108: phone may be optional, but if present must look like a real phone number
  // (10–15 digits after stripping +, -, spaces, parens). Pre-fix the form accepted
  // arbitrary text like "abc123notaphone".
  // #205: phone is now required and must look like an Indian mobile (10-digit
  // starting 6-9, optional +91 prefix). Existing isValidPhone kept for
  // legacy callers; #205 uses the stricter check below at submit time.
  const isValidPhone = (p) => {
    if (!p || !p.trim()) return true; // optional
    const digits = p.replace(/\D/g, "");
    return digits.length >= 10 && digits.length <= 15;
  };
  const INDIAN_MOBILE_RE = /^(\+91)?[6-9]\d{9}$/;
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // #595 — visual canonicalisation on blur. Returns the input as E.164
  // (`+919876543210`) when it parses as a valid Indian mobile; otherwise
  // returns the input unchanged so the user can see and correct what they
  // typed. Backend also runs toE164() so the stored value is canonical
  // even if the user submits before blurring.
  const toE164OnBlur = (raw) => {
    if (!raw) return raw;
    const cleaned = String(raw).replace(/[\s\-()]/g, "");
    if (cleaned.startsWith("+91") && /^\+91[6-9]\d{9}$/.test(cleaned)) return cleaned;
    if (/^91[6-9]\d{9}$/.test(cleaned)) return "+" + cleaned;
    if (/^[6-9]\d{9}$/.test(cleaned)) return "+91" + cleaned;
    return raw;
  };

  const startEdit = (patient) => {
    setForm({
      name: patient.name || "",
      phone: patient.phone || "",
      email: patient.email || "",
      dob: patient.dob ? String(patient.dob).slice(0, 10) : "",
      gender: patient.gender || "",
      source: patient.source || "walk-in",
      locationId: patient.locationId || "",
      // #792 — anniversary stored as ISO string in API, sliced to YYYY-MM-DD
      // for the native date-picker input. GST already stored uppercase.
      anniversary: patient.anniversary ? String(patient.anniversary).slice(0, 10) : "",
      gst: patient.gst || "",
    });
    setEditingId(patient.id);
    setShowAdd(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // #337: reject whitespace-only names. The HTML `required` attribute on
    // the input only checks `value.length >= 1`, so "   " sails through.
    // Trim before any other validation so we also normalise the saved name.
    const trimmedName = (form.name || "").trim();
    if (trimmedName.length < 1) {
      notify.error("Name is required");
      return;
    }
    // #205: phone required + Indian mobile shape. Strip spaces / dashes /
    // parens before testing so common formatting (+91 98765-43210) passes.
    const phoneRaw = (form.phone || "").trim();
    const phoneClean = phoneRaw.replace(/[\s\-()]/g, "");
    if (!phoneClean) {
      notify.error("Phone is required");
      return;
    }
    if (!INDIAN_MOBILE_RE.test(phoneClean)) {
      notify.error(
        "Enter a valid Indian mobile number (10 digits, starting 6-9; +91 prefix optional).",
      );
      return;
    }
    // #205: email optional, but if filled must look like an email.
    const emailRaw = (form.email || "").trim();
    if (emailRaw && !EMAIL_RE.test(emailRaw)) {
      notify.error("Enter a valid email address (e.g. patient@example.com).");
      return;
    }
    try {
      const payload = {
        ...form,
        name: trimmedName,
        locationId: form.locationId ? parseInt(form.locationId) : null,
      };
      await fetchApi("/api/wellness/patients", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      notify.success(`Patient "${trimmedName}" added`);
      setForm({
        name: "",
        phone: "",
        email: "",
        dob: "",
        gender: "",
        source: "walk-in",
        locationId: locations[0]?.id || "",
        anniversary: "",
        gst: "",
      });
      setShowAdd(false);
      // #331: bump reloadTick instead of calling load() directly so the
      // debounced effect handles the refresh consistently and reads the
      // latest q via the ref.
      setReloadTick((t) => t + 1);
    } catch (_err) {
      /* fetchApi already toasted */
    }
  };

  return (
    <div style={{ padding: "2rem", animation: "fadeIn 0.5s ease-out" }}>
      <header
        style={{
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: "1rem",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1
            style={{
              fontFamily: "var(--font-family)",
              fontSize: "1.75rem",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <Users size={24} /> Patients
          </h1>
          <p style={{ color: "var(--text-secondary)", marginTop: "0.25rem" }}>
            {total.toLocaleString()} total
          </p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* #931 — bulk-tag-add CTA. Visible only when ≥1 row is selected so
              it doesn't compete with the New-patient + Export CSV buttons in
              the default chrome. Opens the comma-separated-tags modal which
              POSTs to /api/wellness/patients/bulk-tags. */}
          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setTagModalOpen(true)}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: 'var(--primary-color, var(--accent-color))', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer' }}
            >
              <Tag size={16} /> Add tags to {selectedIds.size} selected
            </button>
          )}
          {/* #931 + #816 Patients slice — CSV export honors the current search
              filter. Hidden when there's nothing to export OR when the role
              already saw the access-restricted state (avoids tempting the user
              to try an export that will just toast 403). */}
          {!permissionDenied && (
            <button
              type="button"
              onClick={exportCsv}
              disabled={csvBusy || total === 0}
              title={q ? `Download ${total} matching patient${total === 1 ? '' : 's'} as CSV` : `Download all ${total} patients as CSV`}
              style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.5rem 0.9rem', background: 'transparent', color: 'var(--text-primary)', border: '1px solid var(--border-color)', borderRadius: 8, cursor: csvBusy || total === 0 ? 'not-allowed' : 'pointer', opacity: csvBusy || total === 0 ? 0.6 : 1 }}
            >
              <Download size={16} /> Export CSV
            </button>
          )}
          <button
            onClick={() => {
              setShowAdd(!showAdd);
              if (showAdd) {
                setEditingId(null);
                setForm({
                  name: "",
                  phone: "",
                email: "",
                dob: "",
                gender: "",
                source: "walk-in",
                locationId: locations[0]?.id || "",
                anniversary: "",
                gst: "",
              });
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.3rem",
            padding: "0.5rem 1rem",
            background: "var(--accent-color)",
            color: "#fff",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
            <Plus size={16} /> {showAdd ? "Cancel" : "New patient"}
          </button>
        </div>
      </header>

      {showAdd && (
        <form
          ref={formRef}
          onSubmit={handleSubmit}
          className="glass"
          style={{
            padding: "1rem",
            marginBottom: "1rem",
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "0.75rem",
            alignItems: "end",
          }}
        >
          <input
            placeholder="Name *"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={inputStyle}
          />
          {/* #205: phone required (Indian mobile). Add inputMode + pattern so
              mobile keyboards default numeric and HTML5 native validation
              catches the obvious cases. JS-side check still runs on submit. */}
          {/* #595: onBlur canonicalises the visible value to E.164 so the
              user sees the form actually being saved (`+919876543210`) and
              spots a typo before submit. */}
          <input
            placeholder="Phone *"
            required
            type="tel"
            inputMode="tel"
            pattern="\+?[0-9]{10,15}"
            title="Indian mobile: 10 digits, starting 6-9 (auto-prefixed with +91 on blur)"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            onBlur={(e) => setForm({ ...form, phone: toE164OnBlur(e.target.value) })}
            style={inputStyle}
          />
          <input
            placeholder="Email"
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            style={inputStyle}
          />
          {/* #205: DOB optional. Type=date so the browser shows a real picker. */}
          <input
            placeholder="Date of birth"
            type="date"
            value={form.dob}
            onChange={(e) => setForm({ ...form, dob: e.target.value })}
            style={inputStyle}
          />
          <select
            value={form.gender}
            onChange={(e) => setForm({ ...form, gender: e.target.value })}
            style={inputStyle}
          >
            <option value="">Gender (optional)</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
            <option value="Other">Other</option>
          </select>
          {/* #317: option `value` is the canonical lowercase / kebab-case
              enum that matches the DB. Display labels stay human-readable.
              Pre-fix, mixed casing between this form ("Referral") and what
              the backend stored ("referral") meant the source filter dropdown
              showed two distinct entries for the same logical source and
              filtered patients incorrectly. Keeping a single source of truth
              here prevents the divergence from re-emerging. */}
          <select
            value={form.source}
            onChange={(e) => setForm({ ...form, source: e.target.value })}
            style={inputStyle}
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
          {locations.length > 1 && (
            <select
              value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}
              style={inputStyle}
            >
              <option value="">Select clinic</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          {/* #792 — anniversary feeds anniversary-day marketing
              automations. Optional (patient may be unmarried). */}
          <input
            placeholder="Anniversary"
            type="date"
            value={form.anniversary}
            onChange={(e) => setForm({ ...form, anniversary: e.target.value })}
            style={inputStyle}
            aria-label="Anniversary"
          />
          {/* #792 — GSTIN for B2B / corporate-account invoicing. 15-char
              alphanumeric. Optional. */}
          <input
            placeholder="GSTIN (15 chars)"
            type="text"
            maxLength={15}
            value={form.gst}
            onChange={(e) =>
              setForm({ ...form, gst: e.target.value.toUpperCase() })
            }
            style={inputStyle}
            aria-label="GSTIN"
          />
          <button
            type="submit"
            style={{
              padding: "0.55rem 1rem",
              background: "var(--success-color)",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {editingId ? "Save Changes" : "Save"}
          </button>
        </form>
      )}

      <div
        className="glass"
        style={{
          padding: "0.75rem 1rem",
          marginBottom: "1rem",
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        <Search size={16} color="var(--text-secondary)" />
        <input
          placeholder="Search by name, phone, or email…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "var(--text-primary)",
            fontSize: "0.9rem",
          }}
        />
      </div>

      {loading && <div>Loading…</div>}

      {!loading && (
        <div className="glass" style={{ padding: 0, overflow: "hidden" }}>
          {/* #229: table-layout: fixed prevents a single very long patient name
              from blowing the column widths and pushing later columns offscreen.
              Combined with the ellipsis style on the name cell. */}
          <table
            className="stable-table"
            style={{
              borderCollapse: "collapse",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                {/* #931 — bulk-select. Header checkbox selects/clears all
                    currently-visible (current page) patients; per-row
                    checkboxes toggle individual selection. */}
                <th style={{ ...thStyle, width: "4%", textAlign: "center" }}>
                  <input
                    type="checkbox"
                    aria-label="Select all visible patients"
                    checked={
                      visiblePatients.length > 0 &&
                      visiblePatients.every((p) => selectedIds.has(p.id))
                    }
                    onChange={() => toggleSelectAllVisible(visiblePatients)}
                  />
                </th>
                <th style={{ ...thStyle, width: "18%" }}>Name</th>
                <th style={{ ...thStyle, width: "13%" }}>Phone</th>
                <th style={{ ...thStyle, width: "18%" }}>Email</th>
                <th style={{ ...thStyle, width: "8%" }}>Gender</th>
                <th style={{ ...thStyle, width: "12%" }}>Source</th>
                <th style={{ ...thStyle, width: "13%" }}>Added</th>
                <th style={{ ...thStyle, width: "9%", textAlign: "center" }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {visiblePatients.map((p) => (
                <tr
                  key={p.id}
                  style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                >
                  {/* #931 — per-row bulk-select checkbox. */}
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${p.name}`}
                      checked={selectedIds.has(p.id)}
                      onChange={() => toggleSelect(p.id)}
                    />
                  </td>
                  <td style={nameTdStyle} title={p.name}>
                    <Link
                      to={`/wellness/patients/${p.id}`}
                      style={{
                        color: "var(--accent-color)",
                        textDecoration: "none",
                        fontWeight: 500,
                      }}
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td style={tdStyle}>
                    {p.phone && (
                      <span>
                        <Phone size={12} style={{ verticalAlign: "middle" }} />{" "}
                        {p.phone}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>
                    {p.email && (
                      <span>
                        <Mail size={12} style={{ verticalAlign: "middle" }} />{" "}
                        {p.email}
                      </span>
                    )}
                  </td>
                  <td style={tdStyle}>{p.gender || "—"}</td>
                  <td style={tdStyle}>{p.source || "—"}</td>
                  <td style={tdStyle}>
                    {formatDate(p.createdAt)}
                  </td>
                  <td style={{ ...tdStyle, textAlign: "center" }}>
                    <button
                      onClick={() => startEdit(p)}
                      title="Edit patient"
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--accent-color)",
                        cursor: "pointer",
                        padding: "0.25rem",
                        display: "inline-flex",
                        alignItems: "center",
                      }}
                    >
                      <Pencil size={16} />
                    </button>
                  </td>
                </tr>
              ))}
              {patients.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    style={{
                      ...tdStyle,
                      textAlign: "center",
                      color: permissionDenied ? "var(--warning-color, #f59e0b)" : "var(--text-secondary)",
                      padding: permissionDenied ? "2rem 1rem" : undefined,
                    }}
                  >
                    {/* #829 — honest empty-state when the API returned 403.
                        Pre-fix the same "No patients match." copy rendered for
                        both real-empty and permission-blocked, so a Demo User
                        viewing a populated clinic saw a phantom empty list. */}
                    {permissionDenied ? (
                      <>
                        <strong>Access restricted.</strong>
                        <div style={{ fontSize: "0.85rem", marginTop: "0.5rem", color: "var(--text-secondary)" }}>
                          Your role does not have permission to view patient records. Patient data is hidden — not absent. Ask an Admin to grant clinical access if you need it.
                        </div>
                      </>
                    ) : (
                      "No patients match."
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {/* #820 Part 1 — pagination footer. Hidden when there's nothing to
              paginate (0 patients) so the empty state stays uncluttered. */}
          {patients.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "0.75rem 1rem",
                borderTop: "1px solid rgba(255,255,255,0.06)",
                color: "var(--text-secondary)",
                fontSize: "0.85rem",
              }}
            >
              <span>
                Showing {startIdx + 1}-
                {Math.min(startIdx + PER_PAGE, patients.length)} of{" "}
                {patients.length}
              </span>
              <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  style={{
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: page <= 1 ? "var(--text-secondary)" : "var(--text-primary)",
                    padding: "0.35rem 0.75rem",
                    borderRadius: 6,
                    cursor: page <= 1 ? "not-allowed" : "pointer",
                    opacity: page <= 1 ? 0.5 : 1,
                  }}
                >
                  Previous
                </button>
                <span style={{ color: "var(--text-primary)" }}>
                  Page {page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  style={{
                    background: "transparent",
                    border: "1px solid rgba(255,255,255,0.1)",
                    color: page >= totalPages ? "var(--text-secondary)" : "var(--text-primary)",
                    padding: "0.35rem 0.75rem",
                    borderRadius: 6,
                    cursor: page >= totalPages ? "not-allowed" : "pointer",
                    opacity: page >= totalPages ? 0.5 : 1,
                  }}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* #931 — bulk-tag-add modal. Comma-separated tag input; Apply fires
          PATCH /api/wellness/patients/bulk-tags. On success: modal closes,
          selection clears, list refreshes. On error: modal stays open. */}
      {tagModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bulk-tag-modal-title"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={(e) => {
            // Click on backdrop closes (unless mid-request).
            if (e.target === e.currentTarget && !tagBusy) {
              setTagModalOpen(false);
            }
          }}
        >
          <div
            className="glass"
            style={{
              padding: '1.5rem',
              borderRadius: 12,
              minWidth: 360,
              maxWidth: 480,
              background: 'var(--bg-primary, #1a1a2e)',
              border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
            }}
          >
            <h3 id="bulk-tag-modal-title" style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.1rem', fontWeight: 600 }}>
              Add tags to {selectedIds.size} patient{selectedIds.size === 1 ? '' : 's'}
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
              Enter tags separated by commas. Tags are stored lowercased and deduped against existing tags.
            </p>
            <input
              type="text"
              aria-label="Tags (comma-separated)"
              placeholder="vip, dermatology, follow-up"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              disabled={tagBusy}
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                type="button"
                onClick={() => {
                  if (tagBusy) return;
                  setTagModalOpen(false);
                  setTagInput("");
                }}
                disabled={tagBusy}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'transparent',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-color, rgba(255,255,255,0.1))',
                  borderRadius: 8,
                  cursor: tagBusy ? 'not-allowed' : 'pointer',
                  opacity: tagBusy ? 0.6 : 1,
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitBulkTags}
                disabled={tagBusy || tagInput.trim().length === 0}
                style={{
                  padding: '0.5rem 1rem',
                  background: 'var(--primary-color, var(--accent-color))',
                  color: '#fff',
                  border: 'none',
                  borderRadius: 8,
                  cursor: (tagBusy || tagInput.trim().length === 0) ? 'not-allowed' : 'pointer',
                  opacity: (tagBusy || tagInput.trim().length === 0) ? 0.6 : 1,
                }}
              >
                {tagBusy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const thStyle = {
  textAlign: "left",
  padding: "0.75rem 1rem",
  fontSize: "0.75rem",
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  fontSize: "0.9rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
// #229: name cell ellipses long names so they don't blow out the table layout.
const nameTdStyle = { ...tdStyle, maxWidth: 220 };
const inputStyle = {
  padding: "0.55rem 0.75rem",
  background: "rgba(255,255,255,0.05)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  color: "var(--text-primary)",
  fontSize: "0.9rem",
  outline: "none",
};
