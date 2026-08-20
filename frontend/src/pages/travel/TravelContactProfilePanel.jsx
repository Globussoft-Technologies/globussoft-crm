import { useEffect, useState } from "react";
import { fetchApi, getAuthToken } from "../../utils/api";
import { useNotify } from "../../utils/notify";
import { AlertTriangle, Download, FileText, Plus, Save, Trash2, Upload } from "lucide-react";

function emptyProfile() {
  return {
    identity: {
      fullName: "",
      aka: "",
      dob: "",
      gender: "",
      nationality: "",
      address: "",
      city: "",
      state: "",
      postalCode: "",
      country: "",
      isdCode: "",
      phone: "",
      email: "",
      whatsappOptIn: false,
      languages: [],
    },
    passports: [],
    visas: [],
    travelHistory: [],
    preferences: {
      seat: "",
      mealCodes: [],
      cabin: "",
      airlinePreference: "",
      airlineAvoid: "",
      hotelClass: "",
      roomType: "",
      bedType: "",
      floor: "",
      dietary: "",
      mobility: "",
      allergies: "",
    },
    frequentFlyerPrograms: [],
    paymentReferences: {
      razorpayTokenRef: "",
      gstNumber: "",
      pan: "",
      tcsFlag: false,
      billingAddress: "",
    },
    emergencyContact: {
      name: "",
      relationship: "",
      phone: "",
      insuranceProvider: "",
      insuranceNumber: "",
    },
    familyLinks: [],
    consents: {
      whatsappOptIn: false,
      marketingOptIn: false,
      dpdpCapturedAt: "",
      dpdpSource: "",
    },
    segments: [],
    notes: "",
  };
}

function csvText(value) {
  return Array.isArray(value) ? value.join(", ") : "";
}

function csvArray(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function dateInput(value) {
  if (!value) return "";
  return String(value).slice(0, 10);
}

function Field({ label, children, span = 1 }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: span > 1 ? `span ${span}` : undefined }}>
      <span style={labelStyle}>{label}</span>
      {children}
    </label>
  );
}

function ArrayEditor({ title, rows, columns, onChange, addLabel, pageSize = null, page = 0, onPageChange = null, scrollHeight = null }) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const totalPages = pageSize ? Math.max(1, Math.ceil(normalizedRows.length / pageSize)) : 1;
  const safePage = Math.min(Math.max(page || 0, 0), totalPages - 1);
  const visibleRows = pageSize ? normalizedRows.slice(safePage * pageSize, safePage * pageSize + pageSize) : normalizedRows;

  const setCell = (index, key, value) => {
    onChange(normalizedRows.map((row, idx) => (idx === index ? { ...row, [key]: value } : row)));
  };

  const addRow = () => {
    const next = {};
    columns.forEach((col) => {
      next[col.key] = col.type === "checkbox" ? false : "";
    });
    onChange([...normalizedRows, next]);
  };

  const removeRow = (index) => {
    onChange(normalizedRows.filter((_, idx) => idx !== index));
  };

  return (
    <div style={subCard}>
      <div style={subHeader}>
        <h3 style={subTitle}>{title}</h3>
        <button type="button" style={secondaryBtn} onClick={addRow}><Plus size={14} /> {addLabel || "Add row"}</button>
      </div>
      {normalizedRows.length === 0 ? (
        <div style={empty}>No entries yet.</div>
      ) : (
        <>
          <div style={{ display: "grid", gap: 12, maxHeight: scrollHeight || undefined, overflowY: scrollHeight ? "auto" : "visible", paddingRight: scrollHeight ? 4 : 0 }}>
            {visibleRows.map((row, visibleIndex) => {
              const index = pageSize ? safePage * pageSize + visibleIndex : visibleIndex;
              return (
                <div key={index} style={arrayRow}>
                  <div style={grid3}>
                    {columns.map((col) => (
                      <Field key={`${index}-${col.key}`} label={col.label} span={col.span || 1}>
                        {col.type === "checkbox" ? (
                          <input type="checkbox" checked={Boolean(row?.[col.key])} onChange={(e) => setCell(index, col.key, e.target.checked)} />
                        ) : col.type === "textarea" ? (
                          <textarea value={row?.[col.key] || ""} rows={3} style={textarea} onChange={(e) => setCell(index, col.key, e.target.value)} />
                        ) : (
                          <input
                            type={col.type || "text"}
                            value={col.type === "date" ? dateInput(row?.[col.key]) : row?.[col.key] || ""}
                            style={input}
                            onChange={(e) => setCell(index, col.key, e.target.value)}
                          />
                        )}
                      </Field>
                    ))}
                  </div>
                  <div style={{ display: "flex", justifyContent: "flex-end" }}>
                    <button type="button" style={dangerBtn} onClick={() => removeRow(index)}><Trash2 size={14} /> Remove</button>
                  </div>
                </div>
              );
            })}
          </div>
          {pageSize && totalPages > 1 && onPageChange ? (
            <div style={pagerRow}>
              <button type="button" style={pageBtn} onClick={() => onPageChange(Math.max(0, safePage - 1))} disabled={safePage === 0}>Previous</button>
              <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>Page {safePage + 1} of {totalPages}</span>
              <button type="button" style={pageBtn} onClick={() => onPageChange(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1}>Next</button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function TravelContactProfilePanel({ contactId }) {
  const notify = useNotify();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [data, setData] = useState(null);
  const [profile, setProfile] = useState(emptyProfile());
  const [documents, setDocuments] = useState([]);
  const [uploadForm, setUploadForm] = useState({ label: "", category: "general", documentType: "", expiresAt: "" });
  const [files, setFiles] = useState([]);
  const [importFile, setImportFile] = useState(null);
  const [travelHistoryPage, setTravelHistoryPage] = useState(0);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetchApi(`/api/travel/contact-profiles/by-contact/${contactId}`);
      setData(res || null);
      setProfile({ ...emptyProfile(), ...(res?.profile || {}) });
      setDocuments(Array.isArray(res?.documents) ? res.documents : []);
    } catch (_e) {
      setData(null);
      setProfile(emptyProfile());
      setDocuments([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [contactId]);

  useEffect(() => {
    const total = Array.isArray(profile.travelHistory) ? profile.travelHistory.length : 0;
    const totalPages = Math.max(1, Math.ceil(total / 2));
    if (travelHistoryPage > totalPages - 1) {
      setTravelHistoryPage(Math.max(0, totalPages - 1));
    }
  }, [profile.travelHistory, travelHistoryPage]);

  const setIdentity = (key, value) => setProfile((prev) => ({ ...prev, identity: { ...(prev.identity || {}), [key]: value } }));
  const setPreferences = (key, value) => setProfile((prev) => ({ ...prev, preferences: { ...(prev.preferences || {}), [key]: value } }));
  const setPayment = (key, value) => setProfile((prev) => ({ ...prev, paymentReferences: { ...(prev.paymentReferences || {}), [key]: value } }));
  const setEmergency = (key, value) => setProfile((prev) => ({ ...prev, emergencyContact: { ...(prev.emergencyContact || {}), [key]: value } }));
  const setConsent = (key, value) => setProfile((prev) => ({ ...prev, consents: { ...(prev.consents || {}), [key]: value } }));

  const downloadTemplate = async (format) => {
    try {
      const token = getAuthToken();
      const response = await fetch('/api/travel/contact-profiles/template?format=' + format, {
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!response.ok) throw new Error('Failed to download template');
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = format === 'xlsx' ? 'travel-contact-profiles-template.xlsx' : 'travel-contact-profiles-template.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      notify.error(e?.message || 'Failed to download template');
    }
  };

  const importProfiles = async () => {
    if (!importFile) {
      notify.error('Choose a CSV or Excel file to import');
      return;
    }
    setImporting(true);
    try {
      const form = new FormData();
      form.append('file', importFile);
      const res = await fetchApi('/api/travel/contact-profiles/import', { method: 'POST', body: form });
      notify.success('Imported ' + (res?.imported || 0) + ' profile row(s)');
      setImportFile(null);
      await load();
    } catch (e) {
      notify.error(e?.body?.error || e?.message || 'Failed to import profile file');
    } finally {
      setImporting(false);
    }
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      const payload = {
        ...profile,
        identity: {
          ...(profile.identity || {}),
          languages: csvArray(profile.identity?.languages),
        },
        preferences: {
          ...(profile.preferences || {}),
          mealCodes: csvArray(profile.preferences?.mealCodes),
        },
        segments: csvArray(profile.segments),
      };
      const res = await fetchApi(`/api/travel/contact-profiles/by-contact/${contactId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      setData(res || null);
      setProfile({ ...emptyProfile(), ...(res?.profile || {}) });
      setDocuments(Array.isArray(res?.documents) ? res.documents : []);
      notify.success("Travel profile saved");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to save travel profile");
    } finally {
      setSaving(false);
    }
  };

  const uploadDocuments = async () => {
    if (!files.length) {
      notify.error("Choose at least one file");
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      files.forEach((file) => form.append("files", file));
      form.append("label", uploadForm.label);
      form.append("category", uploadForm.category);
      form.append("documentType", uploadForm.documentType);
      form.append("expiresAt", uploadForm.expiresAt);
      const res = await fetchApi(`/api/travel/contact-profiles/by-contact/${contactId}/documents`, { method: "POST", body: form });
      setDocuments((prev) => [...(Array.isArray(res?.documents) ? res.documents : []), ...prev]);
      setFiles([]);
      setUploadForm({ label: "", category: "general", documentType: "", expiresAt: "" });
      notify.success("Travel documents uploaded");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to upload documents");
    } finally {
      setUploading(false);
    }
  };

  const deleteDocument = async (documentId) => {
    try {
      await fetchApi(`/api/travel/contact-profiles/documents/${documentId}`, { method: "DELETE" });
      setDocuments((prev) => prev.filter((item) => item.id !== documentId));
      notify.success("Document removed");
    } catch (e) {
      notify.error(e?.body?.error || e?.message || "Failed to delete document");
    }
  };

  if (loading) {
    return <section style={section}><div style={card}>Loading travel profile...</div></section>;
  }

  return (
    <section style={section}>
      <div style={headerRow}>
        <div>
          <h2 style={title}>Travel Profile</h2>
          <p style={subtitle}>Travel-only traveller schema, documents, expiry watch, and import-ready fields.</p>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button type="button" style={linkBtn} onClick={() => downloadTemplate("csv")}><Download size={14} /> CSV template</button>
          <button type="button" style={linkBtn} onClick={() => downloadTemplate("xlsx")}><Download size={14} /> Excel template</button>
          <button type="button" style={primaryBtn} onClick={saveProfile} disabled={saving}><Save size={14} /> {saving ? "Saving..." : "Save profile"}</button>
        </div>
      </div>

      <div style={card}>
        <h3 style={subTitle}>Import master profile file</h3>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <input type="file" accept=".csv,.xlsx,.xls" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
          <button type="button" style={primaryBtn} onClick={importProfiles} disabled={importing}><Download size={14} /> {importing ? "Importing..." : "Import CSV/Excel"}</button>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{importFile ? importFile.name : "No import file selected"}</span>
        </div>
      </div>

      {(data?.alerts || []).length > 0 && (
        <div style={alertWrap}>
          {data.alerts.map((alert, index) => (
            <div key={`${alert.kind}-${index}`} style={alertCard}>
              <AlertTriangle size={14} />
              <span>{alert.label} {alert.milestone ? `(${alert.milestone})` : ""}</span>
            </div>
          ))}
        </div>
      )}

      <div style={card}>
        <div style={grid3}>
          <Field label="Full name as per passport"><input style={input} value={profile.identity?.fullName || ""} onChange={(e) => setIdentity("fullName", e.target.value)} /></Field>
          <Field label="AKA"><input style={input} value={profile.identity?.aka || ""} onChange={(e) => setIdentity("aka", e.target.value)} /></Field>
          <Field label="DOB"><input type="date" style={input} value={dateInput(profile.identity?.dob)} onChange={(e) => setIdentity("dob", e.target.value)} /></Field>
          <Field label="Gender"><input style={input} value={profile.identity?.gender || ""} onChange={(e) => setIdentity("gender", e.target.value)} /></Field>
          <Field label="Nationality"><input style={input} value={profile.identity?.nationality || ""} onChange={(e) => setIdentity("nationality", e.target.value)} /></Field>
          <Field label="Languages"><input style={input} value={csvText(profile.identity?.languages)} onChange={(e) => setIdentity("languages", e.target.value)} placeholder="English, Hindi" /></Field>
          <Field label="ISD code"><input style={input} value={profile.identity?.isdCode || ""} onChange={(e) => setIdentity("isdCode", e.target.value)} /></Field>
          <Field label="Phone"><input style={input} value={profile.identity?.phone || ""} onChange={(e) => setIdentity("phone", e.target.value)} /></Field>
          <Field label="Email"><input style={input} value={profile.identity?.email || ""} onChange={(e) => setIdentity("email", e.target.value)} /></Field>
          <Field label="Address" span={3}><textarea rows={3} style={textarea} value={profile.identity?.address || ""} onChange={(e) => setIdentity("address", e.target.value)} /></Field>
        </div>
        <div style={checkRow}>
          <label style={checkboxLabel}><input type="checkbox" checked={Boolean(profile.identity?.whatsappOptIn)} onChange={(e) => setIdentity("whatsappOptIn", e.target.checked)} /> WhatsApp opt-in</label>
        </div>
      </div>

      <ArrayEditor
        title="Passports"
        addLabel="Add passport"
        rows={Array.isArray(profile.passports) ? profile.passports : []}
        onChange={(rows) => setProfile((prev) => ({ ...prev, passports: rows }))}
        columns={[
          { key: "number", label: "Passport number" },
          { key: "issueDate", label: "Issue date", type: "date" },
          { key: "expiryDate", label: "Expiry date", type: "date" },
          { key: "placeOfIssue", label: "Place of issue" },
          { key: "uploadedScanLabel", label: "Uploaded scan label" },
          { key: "mrzParsed", label: "MRZ auto-parsed", type: "checkbox" },
          { key: "isPrimary", label: "Primary", type: "checkbox" },
          { key: "notes", label: "Notes", type: "textarea", span: 3 },
        ]}
      />

      <ArrayEditor
        title="Visas"
        addLabel="Add visa"
        rows={Array.isArray(profile.visas) ? profile.visas : []}
        onChange={(rows) => setProfile((prev) => ({ ...prev, visas: rows }))}
        columns={[
          { key: "country", label: "Country" },
          { key: "type", label: "Type" },
          { key: "issueDate", label: "Issue date", type: "date" },
          { key: "expiryDate", label: "Expiry date", type: "date" },
          { key: "entries", label: "Entries" },
          { key: "copies", label: "Copies", type: "number" },
        ]}
      />

      <ArrayEditor
        title="Travel history"
        addLabel="Add trip history"
        rows={Array.isArray(profile.travelHistory) ? profile.travelHistory : []}
        onChange={(rows) => setProfile((prev) => ({ ...prev, travelHistory: rows }))}
        pageSize={2}
        page={travelHistoryPage}
        onPageChange={setTravelHistoryPage}
        scrollHeight={500}
        columns={[
          { key: "country", label: "Country" },
          { key: "fromDate", label: "From", type: "date" },
          { key: "toDate", label: "To", type: "date" },
          { key: "note", label: "Notes", type: "textarea", span: 3 },
        ]}
      />

      <div style={card}>
        <h3 style={subTitle}>Travel preferences</h3>
        <div style={grid3}>
          <Field label="Seat"><input style={input} value={profile.preferences?.seat || ""} onChange={(e) => setPreferences("seat", e.target.value)} /></Field>
          <Field label="Meal codes"><input style={input} value={csvText(profile.preferences?.mealCodes)} onChange={(e) => setPreferences("mealCodes", e.target.value)} placeholder="VGML, HNML" /></Field>
          <Field label="Cabin"><input style={input} value={profile.preferences?.cabin || ""} onChange={(e) => setPreferences("cabin", e.target.value)} /></Field>
          <Field label="Preferred airline"><input style={input} value={profile.preferences?.airlinePreference || ""} onChange={(e) => setPreferences("airlinePreference", e.target.value)} /></Field>
          <Field label="Avoid airline"><input style={input} value={profile.preferences?.airlineAvoid || ""} onChange={(e) => setPreferences("airlineAvoid", e.target.value)} /></Field>
          <Field label="Hotel class"><input style={input} value={profile.preferences?.hotelClass || ""} onChange={(e) => setPreferences("hotelClass", e.target.value)} /></Field>
          <Field label="Room type"><input style={input} value={profile.preferences?.roomType || ""} onChange={(e) => setPreferences("roomType", e.target.value)} /></Field>
          <Field label="Bed type"><input style={input} value={profile.preferences?.bedType || ""} onChange={(e) => setPreferences("bedType", e.target.value)} /></Field>
          <Field label="Floor"><input style={input} value={profile.preferences?.floor || ""} onChange={(e) => setPreferences("floor", e.target.value)} /></Field>
          <Field label="Dietary" span={2}><input style={input} value={profile.preferences?.dietary || ""} onChange={(e) => setPreferences("dietary", e.target.value)} /></Field>
          <Field label="Mobility"><input style={input} value={profile.preferences?.mobility || ""} onChange={(e) => setPreferences("mobility", e.target.value)} /></Field>
          <Field label="Allergies" span={3}><textarea rows={2} style={textarea} value={profile.preferences?.allergies || ""} onChange={(e) => setPreferences("allergies", e.target.value)} /></Field>
        </div>
      </div>

      <ArrayEditor
        title="Frequent flyer / loyalty programs"
        addLabel="Add program"
        rows={Array.isArray(profile.frequentFlyerPrograms) ? profile.frequentFlyerPrograms : []}
        onChange={(rows) => setProfile((prev) => ({ ...prev, frequentFlyerPrograms: rows }))}
        columns={[
          { key: "programType", label: "Program type" },
          { key: "provider", label: "Provider" },
          { key: "number", label: "Account number" },
          { key: "tier", label: "Tier" },
          { key: "expiryDate", label: "Expiry date", type: "date" },
        ]}
      />

      <div style={card}>
        <h3 style={subTitle}>Payment, emergency, consent, segments</h3>
        <div style={grid3}>
          <Field label="Razorpay token ref"><input style={input} value={profile.paymentReferences?.razorpayTokenRef || ""} onChange={(e) => setPayment("razorpayTokenRef", e.target.value)} /></Field>
          <Field label="GST number"><input style={input} value={profile.paymentReferences?.gstNumber || ""} onChange={(e) => setPayment("gstNumber", e.target.value)} /></Field>
          <Field label="PAN"><input style={input} value={profile.paymentReferences?.pan || ""} onChange={(e) => setPayment("pan", e.target.value)} /></Field>
          <Field label="Billing address" span={3}><textarea rows={2} style={textarea} value={profile.paymentReferences?.billingAddress || ""} onChange={(e) => setPayment("billingAddress", e.target.value)} /></Field>
          <Field label="Emergency contact name"><input style={input} value={profile.emergencyContact?.name || ""} onChange={(e) => setEmergency("name", e.target.value)} /></Field>
          <Field label="Relationship"><input style={input} value={profile.emergencyContact?.relationship || ""} onChange={(e) => setEmergency("relationship", e.target.value)} /></Field>
          <Field label="Emergency phone"><input style={input} value={profile.emergencyContact?.phone || ""} onChange={(e) => setEmergency("phone", e.target.value)} /></Field>
          <Field label="Insurance provider"><input style={input} value={profile.emergencyContact?.insuranceProvider || ""} onChange={(e) => setEmergency("insuranceProvider", e.target.value)} /></Field>
          <Field label="Insurance number"><input style={input} value={profile.emergencyContact?.insuranceNumber || ""} onChange={(e) => setEmergency("insuranceNumber", e.target.value)} /></Field>
          <Field label="Segments" span={2}><input style={input} value={csvText(profile.segments)} onChange={(e) => setProfile((prev) => ({ ...prev, segments: e.target.value }))} placeholder="school, vip, past-umrah" /></Field>
        </div>
        <div style={checkRow}>
          <label style={checkboxLabel}><input type="checkbox" checked={Boolean(profile.paymentReferences?.tcsFlag)} onChange={(e) => setPayment("tcsFlag", e.target.checked)} /> TCS flag</label>
          <label style={checkboxLabel}><input type="checkbox" checked={Boolean(profile.consents?.whatsappOptIn)} onChange={(e) => setConsent("whatsappOptIn", e.target.checked)} /> Consent: WhatsApp</label>
          <label style={checkboxLabel}><input type="checkbox" checked={Boolean(profile.consents?.marketingOptIn)} onChange={(e) => setConsent("marketingOptIn", e.target.checked)} /> Consent: marketing</label>
        </div>
        <div style={grid3}>
          <Field label="DPDP captured at"><input type="datetime-local" style={input} value={(profile.consents?.dpdpCapturedAt || "").slice(0, 16)} onChange={(e) => setConsent("dpdpCapturedAt", e.target.value)} /></Field>
          <Field label="DPDP source" span={2}><input style={input} value={profile.consents?.dpdpSource || ""} onChange={(e) => setConsent("dpdpSource", e.target.value)} /></Field>
          <Field label="Notes" span={3}><textarea rows={4} style={textarea} value={profile.notes || ""} onChange={(e) => setProfile((prev) => ({ ...prev, notes: e.target.value }))} /></Field>
        </div>
      </div>

      <ArrayEditor
        title="Family / group linkage"
        addLabel="Add link"
        rows={Array.isArray(profile.familyLinks) ? profile.familyLinks : []}
        onChange={(rows) => setProfile((prev) => ({ ...prev, familyLinks: rows }))}
        columns={[
          { key: "linkedContactId", label: "Linked contact ID", type: "number" },
          { key: "name", label: "Name" },
          { key: "relationship", label: "Relationship" },
        ]}
      />

      <div style={card}>
        <h3 style={subTitle}>Travel documents</h3>
        <div style={grid3}>
          <Field label="Label"><input style={input} value={uploadForm.label} onChange={(e) => setUploadForm((prev) => ({ ...prev, label: e.target.value }))} /></Field>
          <Field label="Category"><input style={input} value={uploadForm.category} onChange={(e) => setUploadForm((prev) => ({ ...prev, category: e.target.value }))} placeholder="passport, visa, aadhaar, bank" /></Field>
          <Field label="Document type"><input style={input} value={uploadForm.documentType} onChange={(e) => setUploadForm((prev) => ({ ...prev, documentType: e.target.value }))} /></Field>
          <Field label="Expiry date"><input type="date" style={input} value={uploadForm.expiresAt} onChange={(e) => setUploadForm((prev) => ({ ...prev, expiresAt: e.target.value }))} /></Field>
          <Field label="Files" span={2}><input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files || []))} /></Field>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
          <span style={{ color: "var(--text-secondary)", fontSize: 13 }}>{files.length ? `${files.length} file(s) ready` : "No files selected"}</span>
          <button type="button" style={primaryBtn} onClick={uploadDocuments} disabled={uploading}><Upload size={14} /> {uploading ? "Uploading..." : "Upload documents"}</button>
        </div>
        <div style={{ display: "grid", gap: 10, marginTop: 16 }}>
          {documents.length === 0 ? (
            <div style={empty}>No travel documents uploaded yet.</div>
          ) : documents.map((doc) => (
            <div key={doc.id} style={docRow}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <FileText size={16} />
                <div>
                  <div style={{ fontWeight: 600 }}>{doc.label || doc.originalName}</div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>{doc.category || "general"}{doc.documentType ? ` � ${doc.documentType}` : ""}{doc.expiresAt ? ` � expires ${dateInput(doc.expiresAt)}` : ""}</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <a href={doc.fileUrl} target="_blank" rel="noreferrer" style={linkBtn}>Open</a>
                <button type="button" style={dangerBtn} onClick={() => deleteDocument(doc.id)}><Trash2 size={14} /> Remove</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {(data?.visaApplications || []).length > 0 && (
        <div style={card}>
          <h3 style={subTitle}>Existing visa applications</h3>
          <div style={{ display: "grid", gap: 8 }}>
            {data.visaApplications.map((item) => (
              <div key={item.id} style={docRow}>
                <div>
                  <strong>{item.destinationCountry || "Visa"}</strong> {item.applicationType ? `� ${item.applicationType}` : ""}
                  <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>Status: {item.status || "unknown"}{item.expiryDate ? ` � expiry ${dateInput(item.expiryDate)}` : ""}</div>
                </div>
                <a href={`/travel/visa/applications/${item.id}`} style={linkBtn}>Open</a>
              </div>
            ))}
          </div>
        </div>
      )}

      {data?.duplicateHints && (
        <div style={card}>
          <h3 style={subTitle}>Dedup watch</h3>
          <div style={{ display: "grid", gap: 8 }}>
            <div style={hintLine}>Passport matches: {(data.duplicateHints.byPassport || []).length}</div>
            <div style={hintLine}>Email + DOB matches: {(data.duplicateHints.byEmailDob || []).length}</div>
            <div style={hintLine}>Phone + name matches: {(data.duplicateHints.byPhoneName || []).length}</div>
          </div>
        </div>
      )}
    </section>
  );
}

const section = { marginBottom: 24 };
const card = { background: "var(--surface-color)", border: "1px solid var(--border-color)", borderRadius: 8, padding: 16, marginBottom: 16 };
const subCard = { ...card, padding: 14 };
const headerRow = { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap", marginBottom: 12 };
const title = { margin: 0, fontSize: 18 };
const subtitle = { margin: "4px 0 0", color: "var(--text-secondary)", fontSize: 13 };
const subHeader = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" };
const subTitle = { margin: 0, fontSize: 15 };
const grid3 = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 };
const input = { padding: "10px 12px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--surface-color)", color: "var(--text-primary)" };
const textarea = { ...input, minHeight: 74, resize: "vertical" };
const labelStyle = { fontSize: 12, color: "var(--text-secondary)", fontWeight: 600 };
const primaryBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--primary-color, var(--accent-color))", background: "var(--primary-color, var(--accent-color))", color: "#fff", cursor: "pointer", textDecoration: "none", fontWeight: 600 };
const secondaryBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--surface-color)", color: "var(--text-primary)", cursor: "pointer", fontWeight: 600 };
const pagerRow = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" };
const pageBtn = { ...secondaryBtn, padding: "8px 12px" };
const linkBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border-color)", background: "var(--surface-color)", color: "var(--primary-color, var(--accent-color))", textDecoration: "none", fontWeight: 600 };
const dangerBtn = { display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(168,50,63,0.25)", background: "rgba(168,50,63,0.08)", color: "#A8323F", cursor: "pointer", fontWeight: 600 };
const checkRow = { display: "flex", flexWrap: "wrap", gap: 14, marginTop: 12 };
const checkboxLabel = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 };
const alertWrap = { display: "grid", gap: 8, marginBottom: 16 };
const alertCard = { display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 6, border: "1px solid rgba(200,154,78,0.35)", background: "rgba(200,154,78,0.12)", color: "#7A5419" };
const empty = { padding: 16, textAlign: "center", color: "var(--text-secondary)" };
const arrayRow = { border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, background: "var(--subtle-bg)" };
const docRow = { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, border: "1px solid var(--border-color)", borderRadius: 8, padding: 12, flexWrap: "wrap" };
const hintLine = { fontSize: 13, color: "var(--text-primary)" };
