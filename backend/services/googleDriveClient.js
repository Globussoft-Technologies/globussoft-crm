// Google Drive integration — STUB MODE.
//
// Real OAuth + Drive folder creation wires in when Q1 Workspace
// admin creds land in backend/.env:
//   GOOGLE_WORKSPACE_CLIENT_ID
//   GOOGLE_WORKSPACE_CLIENT_SECRET
//   GOOGLE_WORKSPACE_REFRESH_TOKEN (long-lived; from one-time admin OAuth)
//   GOOGLE_DRIVE_PARENT_FOLDER_ID  (optional — where new trip folders nest)
// Until then, this stub returns deterministic synthetic folder ids /
// URLs so the confirmed-trip flow is exercisable end-to-end in dev +
// demo + CI without an external dependency.
//
// Contract this stub pins (REAL impl MUST honour):
//   driveEnabled() → boolean
//   createTripFolder({ tripCode, destination, departDate }) →
//     { folderId, folderUrl, folderName }
//     - folderId is opaque (real: Drive ID; stub: synthetic)
//     - folderUrl is browser-openable
//     - folderName follows the convention agreed with Yasin (Q1
//       packet — see PLACEHOLDER_NAMING_CONVENTION below)
//
// Naming convention (PLACEHOLDER until Q1 input pack lands):
//   "TMC Trip — {tripCode} — {destination} — {YYYY-MM departure}"
//   e.g. "TMC Trip — bali2026 — Bali, Indonesia — 2026-09"
//
// See PRD §4.8 for the confirmed-trip auto-create trigger semantics
// and TRAVEL_CRM_OPEN_QUESTIONS.md Q1 for the cred-handover blocker.

const crypto = require("crypto");

function driveEnabled() {
  return Boolean(
    process.env.GOOGLE_WORKSPACE_CLIENT_ID &&
    process.env.GOOGLE_WORKSPACE_CLIENT_SECRET &&
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN
  );
}

function buildFolderName({ tripCode, destination, departDate }) {
  const ym = (() => {
    if (!departDate) return "TBD";
    const d = departDate instanceof Date ? departDate : new Date(departDate);
    if (!Number.isFinite(d.getTime())) return "TBD";
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  })();
  // Spaces stay; em-dash for the human-readable separator per PRD
  // "naming convention from input pack" placeholder. Yasin's final
  // convention swaps this once Q1 lands.
  return `TMC Trip — ${tripCode} — ${destination || "TBD"} — ${ym}`;
}

async function createTripFolder({ tripCode, destination, departDate }) {
  if (!tripCode) {
    throw new Error("createTripFolder: tripCode required");
  }
  const folderName = buildFolderName({ tripCode, destination, departDate });
  // STUB: Google Drive folder.create API call. Real impl uses
  // googleapis library: drive.files.create({ requestBody: { name,
  // mimeType: 'application/vnd.google-apps.folder', parents: [Q1_PARENT] } }).
  // Pending Q1 Workspace creds.
  const folderId = `stub-folder-${crypto.createHash("sha256").update(String(tripCode)).digest("hex").slice(0, 24)}`;
  const folderUrl = `https://drive.google.com/drive/folders/${folderId}`;
  console.log(`[google-drive-stub] createTripFolder tripCode=${tripCode} → name="${folderName}" folderId=${folderId.slice(0, 20)}… (synthetic — pending Q1 Workspace creds)`);
  return { folderId, folderUrl, folderName };
}

module.exports = {
  driveEnabled,
  buildFolderName,
  createTripFolder,
};
