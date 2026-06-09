// Passport OCR integration client — STUB MODE.
//
// STUB: Passport OCR vendor decision PC-1 (docs/PRD_PASSPORT_OCR.md §5.1)
// is pending Yasin's call: Google Document AI vs Azure Form Recognizer vs
// hybrid vs Indian alternative. The schema (TripParticipant passport cols +
// the new passportExtractionJson / passportVerifiedAt / passportVerifiedById /
// passportRejectedAt / passportExtractedAt additions in C2) + the
// fieldEncryption infra are already shipped — what's missing is the vendor
// client + the operator UI. This module is the STUB-mode skeleton so the
// upload route + verification queue UI can land + go green on CI / demo
// ahead of the vendor decision.
//
// Real-mode swap (post PC-1 + cred drop): single file. Replace the canned
// return inside extractPassport() with the vendor's HTTP call; the
// contract — { extraction, confidence, provider, extractedAt } — stays
// unchanged. Downstream consumers (upload route, verification queue UI,
// audit log call sites) keep working without diff.
//
// Mirror clients for the swap-when-cred pattern:
//   - backend/services/digilockerClient.js (commit 1babe1b — original)
//   - backend/services/ratehawkClient.js   (commit 2852b82 — same pattern)
//   - backend/services/adsGptClient.js     (commit 9f35040 — same pattern)
//
// Stub-mode enablement: by default the stub returns canned values so the
// operator queue + upload flow are exercisable end-to-end. To exercise the
// "vendor not configured" failure path (e.g. for the AC-6 audit test),
// set PASSPORT_OCR_DISABLED=1 in the environment, OR call extractPassport
// without a tenantId.
//
// Cred chase: docs/PRD_PASSPORT_OCR.md §5.2 (after PC-1 vendor decision):
//   - Google DocAI: GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_DOCAI_PROJECT_ID
//                   + GOOGLE_DOCAI_PASSPORT_PROCESSOR_ID + GOOGLE_DOCAI_LOCATION
//   - Azure FR:     AZURE_FORM_RECOGNIZER_ENDPOINT + AZURE_FORM_RECOGNIZER_KEY
//   - Hybrid:       both bundles

const INTEGRATION = 'passport-ocr';

/**
 * Returns true if the OCR vendor is enabled for the given tenant.
 *
 * In STUB mode this is the inverse of the PASSPORT_OCR_DISABLED env-var
 * (default: enabled — so the demo + CI flows have the canned extraction
 * available). In REAL mode (post PC-1), this should also check a
 * per-tenant feature flag (TenantSetting.passportOcrEnabled) so individual
 * tenants can opt-in / opt-out independently of the vendor cred drop.
 *
 * The cred-blocked failure path the spec exercises is the "not enabled"
 * branch — extractPassport throws `PASSPORT_OCR_NOT_YET_ENABLED` so the
 * upload route can surface a graceful "feature pending" error.
 */
function isEnabledForTenant(tenantId) {
  if (!tenantId) return false;
  if (process.env.PASSPORT_OCR_DISABLED === '1') return false;
  return true;
}

/**
 * Extract passport fields from an uploaded image.
 *
 * STUB: returns a canned extraction envelope matching the contract
 * PRD_PASSPORT_OCR §3 (FR-2) + the per-field confidence shape
 * described in §3.5. When PC-1 lands + the cred drop is in place,
 * swap the canned body for the vendor's HTTP call; the returned
 * envelope shape stays the same so the upload route + audit hooks
 * + verification UI keep working.
 *
 * Input options:
 *   - tenantId        (required)
 *   - imageDataUrl    (optional — data: URL form, used when the upload
 *                     came through the frontend as base64)
 *   - fileBuffer      (optional — Node Buffer, used by the route after
 *                     multer.diskStorage / memoryStorage)
 *   - fileName        (optional — original filename, used for logging
 *                     and the audit trail)
 *
 * Returns: { extraction, confidence, provider, extractedAt }
 *   - extraction.passportNumber   — 8-char alphanumeric (M1234567)
 *   - extraction.surname          — uppercase
 *   - extraction.givenNames       — uppercase
 *   - extraction.dateOfBirth      — ISO YYYY-MM-DD
 *   - extraction.sex              — single char M/F/X
 *   - extraction.nationality      — ISO 3-letter (IND/USA/GBR/...)
 *   - extraction.placeOfBirth     — uppercase
 *   - extraction.placeOfIssue     — uppercase
 *   - extraction.dateOfIssue      — ISO YYYY-MM-DD
 *   - extraction.dateOfExpiry     — ISO YYYY-MM-DD
 *   - extraction.mrz              — raw MRZ line-pair (2 lines, 44 chars each)
 *   - confidence                  — overall scalar [0, 1]
 *   - provider                    — short token (stub-mode-v1 today)
 *   - extractedAt                 — ISO timestamp
 */
async function extractPassport({ tenantId, imageDataUrl, fileBuffer, fileName } = {}) {
  if (!isEnabledForTenant(tenantId)) {
    const err = new Error('Passport OCR vendor not yet enabled for this tenant. Awaiting PC-1 vendor decision + cred drop (docs/PRD_PASSPORT_OCR.md §5).');
    err.code = 'PASSPORT_OCR_NOT_YET_ENABLED';
    throw err;
  }

  const imgSummary = imageDataUrl
    ? `dataUrl[${String(imageDataUrl).length} chars]`
    : fileBuffer
      ? `buffer[${fileBuffer.length || 0} bytes]`
      : 'no-image';
  console.log(`[passportOcrClient STUB] extractPassport: tenantId=${tenantId} fileName=${fileName || '<unnamed>'} ${imgSummary}`);

  // STUB return — canned extraction. Real-mode swap point.
  // The MRZ line is the canonical Indian passport (sample) MRZ format
  // matching ICAO 9303 — 2 lines of 44 chars each. The visible-zone
  // fields (surname / given names / DOB / etc.) match the MRZ for
  // consistency so the operator UI's "MRZ vs VIZ mismatch" check
  // (PRD §2.4) returns clean on stub data.
  return {
    extraction: {
      passportNumber: 'M1234567',
      surname: 'DOE',
      givenNames: 'JOHN',
      dateOfBirth: '1990-01-15',
      sex: 'M',
      nationality: 'IND',
      placeOfBirth: 'MUMBAI',
      placeOfIssue: 'DELHI',
      dateOfIssue: '2020-05-10',
      dateOfExpiry: '2030-05-09',
      mrz: 'P<INDDOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<\nM12345674IND9001154M3005099<<<<<<<<<<<<<<<06',
    },
    confidence: 0.95,
    provider: 'stub-mode-v1',
    extractedAt: new Date().toISOString(),
  };
}

module.exports = { extractPassport, isEnabledForTenant, INTEGRATION };
