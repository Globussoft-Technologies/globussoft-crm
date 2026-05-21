// Generic contacts — duplicate-contact modal.
//
// Surfaced when POST /api/contacts returns 409 DUPLICATE_CONTACT
// (PRD §4.5 dedup preflight; the same shape the RFU passport-collision
// modal first shipped in commit 106b7dc). Backend payload:
//   {
//     code: "DUPLICATE_CONTACT",
//     matchedBy: "email" | "phone" | "both",
//     existingContactId,
//     contact: { id, name, email, phone, company, status, subBrand }
//   }
//
// The modal offers three deliberate paths so the operator picks the right
// one rather than getting a flat toast error:
//   1. Open existing — Link to /contacts/:id (preserves single history line).
//   2. Edit details — close the modal, leave the create form open to correct.
//   3. Create anyway — re-POST with ?force=true (rare "different person, same
//      email/phone" case; e.g. a household sharing an email).
//
// Presentational only: parent owns the state (`dupModal` + `creatingContact`).

import { AlertTriangle, X } from "lucide-react";
import { Link } from "react-router-dom";

export default function DuplicateContactModal({
  existingContactId,
  matchedBy,
  contact,
  creating,
  onEditDetails,
  onCreateAnyway,
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dup-contact-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
    >
      <div
        style={{
          background: "var(--surface-color)",
          color: "var(--text-primary)",
          borderRadius: 12,
          padding: 24,
          maxWidth: 520,
          width: "100%",
          border: "1px solid var(--border-color)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <AlertTriangle
            size={22}
            aria-hidden
            style={{ color: "var(--warning-color, #c89a4e)" }}
          />
          <h2 id="dup-contact-modal-title" style={{ margin: 0, fontSize: 18 }}>
            Possible duplicate contact
          </h2>
          <button
            type="button"
            onClick={onEditDetails}
            aria-label="Close"
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <p style={{ margin: "0 0 12px", fontSize: 14, lineHeight: 1.5 }}>
          A contact with this {labelForMatchedBy(matchedBy)} already exists in your
          CRM. Pick one of the three paths below — the wrong choice creates either
          a split history (Create anyway) or a stale lead (Edit details on the wrong record).
        </p>

        {contact && (
          <div
            style={{
              background: "var(--subtle-bg, rgba(0,0,0,0.04))",
              padding: 12,
              borderRadius: 8,
              marginBottom: 16,
              border: "1px solid var(--border-color)",
              fontSize: 13,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {contact.name || `Contact #${existingContactId}`}
            </div>
            {contact.email && <div>{contact.email}</div>}
            {contact.phone && <div>{contact.phone}</div>}
            {contact.company && <div>{contact.company}</div>}
            {contact.status && (
              <div
                style={{
                  marginTop: 6,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  color: "var(--text-secondary)",
                }}
              >
                Status: {contact.status}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onEditDetails}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              background: "var(--surface-color)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              cursor: "pointer",
            }}
          >
            Edit details
          </button>
          <button
            type="button"
            onClick={onCreateAnyway}
            disabled={creating}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              background: "var(--surface-color)",
              color: "var(--text-primary)",
              border: "1px solid var(--border-color)",
              cursor: creating ? "not-allowed" : "pointer",
              opacity: creating ? 0.5 : 1,
            }}
          >
            {creating ? "Creating…" : "Create anyway"}
          </button>
          <Link
            to={`/contacts/${existingContactId}`}
            style={{
              padding: "8px 14px",
              borderRadius: 6,
              fontWeight: 600,
              fontSize: 13,
              background: "var(--primary-color, var(--accent-color))",
              color: "#fff",
              textDecoration: "none",
              display: "inline-block",
            }}
          >
            Open existing
          </Link>
        </div>
      </div>
    </div>
  );
}

function labelForMatchedBy(matchedBy) {
  if (matchedBy === "email") return "email address";
  if (matchedBy === "phone") return "phone number";
  if (matchedBy === "both") return "email and phone number";
  return "email or phone number";
}
