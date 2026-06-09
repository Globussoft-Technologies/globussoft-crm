// Unit tests for backend/lib/listProjection.js — #920 slice S3.
//
// Module under test: listProjection(modelName, fullShape) + the auxiliary
// exports (getProjections + isFullShape).
//
// Slice S42 extension — wellness PHI list-endpoint slim projections.
// Adds Patient / Visit / Prescription entries to KNOWN_MODELS + PII_FIELDS
// and pins their shape contract. The PII-absence assertions are the load-
// bearing HIPAA contract on this slice: a future contributor including
// e.g. `Patient.phone` in the slim shape (because "it's small") triggers
// these tests to red and forces a PRD-level conversation.
//
// What this pins
// --------------
// The helper consolidates the per-model summary projection lookup that
// 51 prior slices (commits f7790241 through 4c1743ae, #920 slices 1-51)
// have been hand-rolling per route. The contract this file pins:
//
// listProjection(modelName, fullShape):
//   - Returns `undefined` whenever `fullShape` is truthy, regardless of
//     `modelName`. The caller's `findMany` then defaults to full row shape.
//   - Returns `undefined` for unknown / misspelled model names (graceful
//     degradation to "full shape" rather than throwing — a route with a
//     typo'd model name still ships data, it just doesn't get the slim
//     payload). NOT silently passing the model name through to Prisma
//     prevents an attacker from poking unknown-model names hoping for an
//     error-disclosure side-channel.
//   - Returns `undefined` for non-string / empty-string model names.
//   - Returns an `Object.freeze`'d `select`-shape object for known models
//     when `fullShape` is falsy. Every projection includes `id: true`
//     (every adopting route needs the id key to wire row-click → detail).
//   - Returns IDENTITY-STABLE objects across calls (same input ⇒ same
//     reference). Adopting routes can cache the projection across
//     requests; downstream Prisma calls don't need defensive cloning.
//   - PURE — no I/O, no env-var reads, no clock. The same call pair
//     `(name, fullShape)` always returns the same value (test runs
//     don't depend on environment).
//
// Per-model projection contract (what fields are SAFE in summary):
//   - TmcTrip            — id + tripCode + destination + status + dates
//                          + createdAt. NO PII (no parent contact info, no
//                          microsite urls).
//   - TripParticipant    — id + tripId + fullName + consentCapturedAt +
//                          createdAt. **PII safeguard:** passportNumber,
//                          aadhaarLast4, aadhaarTokenId, parent*, and
//                          medicalNotes are explicitly EXCLUDED.
//   - Itinerary          — id + subBrand + contactId + destination + status
//                          + dates + totalAmount + currency + createdAt.
//                          shareToken (auth-bearing) + pricingJson (heavy)
//                          + pdfUrl + micrositeUrl are EXCLUDED.
//   - TravelQuote        — id + subBrand + contactId + status + totals +
//                          validUntil + createdAt.
//   - TravelInvoice      — id + subBrand + contactId + invoiceNum + status
//                          + docType + totals + dueDate + paidAt + createdAt.
//                          TCS fields are EXCLUDED (audit-trail, not picker
//                          data).
//   - TravelSupplier     — id + subBrand + name + supplierCategory +
//                          isActive + createdAt. **PII safeguard:** phone,
//                          email, contactPerson, gstin, addressLine, notes
//                          are EXCLUDED.
//   - RfuLeadProfile     — id + contactId + productTier + createdAt.
//                          **PII safeguard:** passportNumber + emergency*
//                          + medical + visa/frequent-flyer history JSON
//                          are EXCLUDED.
//   - MarketplaceLead    — id + provider + name + status + contactId +
//                          createdAt. **PII safeguard:** email, phone,
//                          company, message, product, city, rawPayload
//                          are EXCLUDED.
//
// isFullShape(query):
//   - Strict-equality on the literal "summary" — `?fields=summary` is the
//     ONLY value that opts into slim shape. Everything else (absent param,
//     `?fields=full`, `?fields=Summary`, `?fields=summary,extra`,
//     `?fields=summary ` with trailing whitespace, null/undefined query
//     objects) returns true (full shape). Mirrors the strict-equality
//     contract that the prior 51 slices' tests pin (e.g.
//     deal-insights.test.js's "non-exact ?fields values" describe).

import { describe, test, expect } from 'vitest';
import listProjection, { getProjections, isFullShape } from '../../lib/listProjection.js';

const KNOWN_MODELS = [
  'TmcTrip',
  'TripParticipant',
  'Itinerary',
  'TravelQuote',
  'TravelInvoice',
  'TravelSupplier',
  'RfuLeadProfile',
  'MarketplaceLead',
  // S42 — wellness PHI slim projections (HIPAA / DPDP-Act-regulated).
  'Patient',
  'Visit',
  'Prescription',
];

// PII / sensitive fields per model — fields the slim projection MUST NOT
// include. Drives both the per-field-absence + the per-field-not-leaked
// assertions below. Sourced from prisma/schema.prisma for each model.
const PII_FIELDS = Object.freeze({
  TmcTrip: ['micrositeUrl', 'micrositeUuid', 'driveFolderId'],
  TripParticipant: [
    'passportNumber', 'passportExpiry', 'passportDocId',
    'passportExtractionJson', 'passportExtractedAt', 'passportVerifiedAt',
    'passportVerifiedById', 'passportRejectedAt',
    'aadhaarLast4', 'aadhaarTokenId',
    'parentName', 'parentPhone', 'parentEmail',
    'medicalNotes',
  ],
  Itinerary: ['shareToken', 'pricingJson', 'pdfUrl'],
  TravelQuote: [],
  TravelInvoice: [
    'tcsAmount', 'tcsRate', 'tcsExceedingAmount', 'tcsAppliedAt',
    'parentInvoiceId',
  ],
  TravelSupplier: [
    'contactPerson', 'phone', 'email', 'gstin', 'addressLine',
    'paymentTermsDays', 'creditLimit', 'creditCurrency', 'taxRegimeCode',
    'primaryContactRole', 'notes',
  ],
  RfuLeadProfile: [
    'passportNumber', 'passportExpiry',
    'visaHistoryJson', 'frequentFlyerJson',
    'seatPref', 'mealPref', 'travelStyle',
    'budgetMin', 'budgetMax',
    'emergencyContactName', 'emergencyContactPhone',
    'medicalNotes', 'specialAssistance', 'pastComplaintsJson',
  ],
  MarketplaceLead: [
    'email', 'phone', 'company', 'product', 'message', 'city',
    'rawPayload', 'externalLeadId',
  ],
  // S42 — wellness PHI (HIPAA / DPDP-Act-regulated). Every column dropped
  // here would constitute a "PHI disclosure" under PRD §11 if it leaked
  // through a list response — pinned absent.
  Patient: [
    'phone', 'normalizedPhone', 'email', 'dob', 'gender', 'bloodGroup',
    'allergies', 'notes', 'photoUrl', 'gst', 'tagsJson',
    'anniversary', 'walletBalance', 'taxType', 'instagramHandle',
    'contactId', 'userId',
  ],
  Visit: [
    'reason', 'notes', 'vitals', 'photosBefore', 'photosAfter',
    'amountCharged', 'videoRoom', 'videoCallUrl',
    'atHomeAddress', 'atHomeCity', 'atHomePincode',
    'travelTimeMinutes',
    'utmSource', 'utmMedium', 'utmCampaign', 'utmTerm', 'utmContent',
    'referrer',
  ],
  Prescription: [
    'drugs',          // load-bearing — the actual prescription contents
    'instructions',   // patient-specific dosage narrative
    'pdfUrl',         // signed URL with the same drug list once opened
  ],
});

describe('listProjection(modelName, fullShape)', () => {
  describe('fullShape=true short-circuit', () => {
    test('returns undefined for every known model when fullShape=true', () => {
      for (const model of KNOWN_MODELS) {
        expect(listProjection(model, true)).toBeUndefined();
      }
    });

    test('returns undefined for unknown model when fullShape=true', () => {
      expect(listProjection('NonexistentModel', true)).toBeUndefined();
    });

    test('returns undefined for null/undefined model when fullShape=true', () => {
      expect(listProjection(null, true)).toBeUndefined();
      expect(listProjection(undefined, true)).toBeUndefined();
    });

    test('treats any truthy value as fullShape=true (1, "yes", {})', () => {
      // The flag is documented as "boolean (or any truthy value)" — pin the
      // permissive contract so a caller passing `!isSummary` (a non-boolean
      // in some JS contexts) still gets full shape.
      expect(listProjection('TmcTrip', 1)).toBeUndefined();
      expect(listProjection('TmcTrip', 'yes')).toBeUndefined();
      expect(listProjection('TmcTrip', {})).toBeUndefined();
      expect(listProjection('TmcTrip', [])).toBeUndefined();
    });
  });

  describe('fullShape=false / falsy — returns slim projection for known models', () => {
    test('returns a projection object for every known model', () => {
      for (const model of KNOWN_MODELS) {
        const projection = listProjection(model, false);
        expect(projection).toBeDefined();
        expect(typeof projection).toBe('object');
        expect(projection).not.toBeNull();
      }
    });

    test('every projection includes `id: true`', () => {
      for (const model of KNOWN_MODELS) {
        const projection = listProjection(model, false);
        expect(projection).toHaveProperty('id', true);
      }
    });

    test('every projection value is `true` (Prisma `select` shape contract)', () => {
      // Prisma `select` keys map to `true` (include) or `false` (exclude) or
      // a nested-select object. Our slim shape only uses `true` (the keys
      // we WANT) — we never spell out `false` for excluded keys; absence
      // is the exclusion signal.
      for (const model of KNOWN_MODELS) {
        const projection = listProjection(model, false);
        for (const [, v] of Object.entries(projection)) {
          // Allow `true` only (the helper never ships `false` exclusions —
          // we let absence carry the exclusion signal so the SQL `SELECT`
          // stays narrow rather than spelling out exclusions).
          expect(v).toBe(true);
        }
      }
    });

    test('treats any falsy value as fullShape=false (false, null, undefined, 0, "", NaN)', () => {
      for (const falsy of [false, null, undefined, 0, '', NaN]) {
        expect(listProjection('TmcTrip', falsy)).toBeDefined();
      }
    });

    test('returns IDENTITY-STABLE projections across calls (same reference)', () => {
      // Adopting routes may cache the projection across requests. Pin
      // identity-stability so we don't accidentally return a fresh object
      // per call (which would defeat downstream caching + complicate test
      // mocks that compare with `toHaveBeenCalledWith(expect.objectContaining(...))`).
      const a = listProjection('TmcTrip', false);
      const b = listProjection('TmcTrip', false);
      expect(a).toBe(b);
    });

    test('projection objects are FROZEN (defensive — caller can never mutate)', () => {
      // Mutating the projection would corrupt every subsequent request's
      // payload. Freeze at module load.
      const projection = listProjection('TmcTrip', false);
      expect(Object.isFrozen(projection)).toBe(true);
      expect(() => { projection.id = false; }).toThrowError(TypeError);
    });
  });

  describe('unknown model name — graceful degradation', () => {
    test('returns undefined for an unknown model name (no throw)', () => {
      expect(() => listProjection('Nonexistent', false)).not.toThrow();
      expect(listProjection('Nonexistent', false)).toBeUndefined();
    });

    test('case-sensitive lookup — "tmcTrip" lower-case is unknown', () => {
      // PROJECTIONS uses the Prisma model name exactly (PascalCase). The
      // helper does NOT canonicalise. Misspellings degrade to full shape.
      expect(listProjection('tmcTrip', false)).toBeUndefined();
      expect(listProjection('TMCTRIP', false)).toBeUndefined();
    });

    test('returns undefined for non-string modelName (null, undefined, 0, [])', () => {
      expect(listProjection(null, false)).toBeUndefined();
      expect(listProjection(undefined, false)).toBeUndefined();
      expect(listProjection(0, false)).toBeUndefined();
      expect(listProjection([], false)).toBeUndefined();
      expect(listProjection({}, false)).toBeUndefined();
    });

    test('returns undefined for empty string', () => {
      expect(listProjection('', false)).toBeUndefined();
    });
  });

  describe('per-model PII / sensitive-field absence (FR-3.5 contract)', () => {
    // The load-bearing contract of #920: PII fields documented as
    // sensitive must NOT appear in the slim summary projection. If a
    // future contributor adds a sensitive field to a projection
    // (e.g. "let's just include phone, it's small"), these tests fail
    // and force a PRD-level conversation.
    for (const model of KNOWN_MODELS) {
      test(`${model} — PII fields are EXCLUDED from slim projection`, () => {
        const projection = listProjection(model, false);
        for (const piiField of PII_FIELDS[model]) {
          expect(projection).not.toHaveProperty(piiField);
        }
      });
    }
  });

  describe('per-model summary shape pinning', () => {
    test('TmcTrip slim shape = {id, tripCode, destination, status, departDate, returnDate, createdAt}', () => {
      const p = listProjection('TmcTrip', false);
      expect(p).toEqual({
        id: true,
        tripCode: true,
        destination: true,
        status: true,
        departDate: true,
        returnDate: true,
        createdAt: true,
      });
    });

    test('TripParticipant slim shape — fullName only (passport/aadhaar/parent/medical EXCLUDED)', () => {
      const p = listProjection('TripParticipant', false);
      expect(p).toEqual({
        id: true,
        tripId: true,
        fullName: true,
        consentCapturedAt: true,
        createdAt: true,
      });
      // Cross-check the PII safeguard one more time — these are the
      // load-bearing exclusions for the entire #920 close. If any of
      // these leak the slice is invalid.
      expect(p).not.toHaveProperty('passportNumber');
      expect(p).not.toHaveProperty('aadhaarLast4');
      expect(p).not.toHaveProperty('parentPhone');
      expect(p).not.toHaveProperty('parentEmail');
      expect(p).not.toHaveProperty('medicalNotes');
    });

    test('Itinerary slim shape — shareToken + pricingJson + pdfUrl EXCLUDED', () => {
      const p = listProjection('Itinerary', false);
      expect(p).toMatchObject({
        id: true,
        subBrand: true,
        contactId: true,
        destination: true,
        status: true,
        startDate: true,
        endDate: true,
        totalAmount: true,
        currency: true,
        createdAt: true,
      });
      expect(p).not.toHaveProperty('shareToken');     // auth-bearing — MUST not leak
      expect(p).not.toHaveProperty('pricingJson');    // heavy + sensitive
      expect(p).not.toHaveProperty('pdfUrl');         // signed URL (auth-bearing on some providers)
    });

    test('TravelQuote slim shape', () => {
      const p = listProjection('TravelQuote', false);
      expect(p).toEqual({
        id: true,
        subBrand: true,
        contactId: true,
        status: true,
        totalAmount: true,
        currency: true,
        validUntil: true,
        createdAt: true,
      });
    });

    test('TravelInvoice slim shape — TCS fields EXCLUDED', () => {
      const p = listProjection('TravelInvoice', false);
      expect(p).toMatchObject({
        id: true,
        subBrand: true,
        contactId: true,
        invoiceNum: true,
        status: true,
        docType: true,
        totalAmount: true,
        currency: true,
        dueDate: true,
        paidAt: true,
        createdAt: true,
      });
      // TCS columns are audit-trail data, not picker-relevant — EXCLUDED.
      expect(p).not.toHaveProperty('tcsAmount');
      expect(p).not.toHaveProperty('tcsRate');
      expect(p).not.toHaveProperty('tcsAppliedAt');
    });

    test('TravelSupplier slim shape — supplier PII EXCLUDED', () => {
      const p = listProjection('TravelSupplier', false);
      expect(p).toEqual({
        id: true,
        subBrand: true,
        name: true,
        supplierCategory: true,
        isActive: true,
        createdAt: true,
      });
      expect(p).not.toHaveProperty('phone');
      expect(p).not.toHaveProperty('email');
      expect(p).not.toHaveProperty('contactPerson');
      expect(p).not.toHaveProperty('gstin');
      expect(p).not.toHaveProperty('addressLine');
    });

    test('RfuLeadProfile slim shape — passport + emergency-contact + medical EXCLUDED', () => {
      const p = listProjection('RfuLeadProfile', false);
      expect(p).toEqual({
        id: true,
        contactId: true,
        productTier: true,
        createdAt: true,
      });
      expect(p).not.toHaveProperty('passportNumber');
      expect(p).not.toHaveProperty('emergencyContactName');
      expect(p).not.toHaveProperty('emergencyContactPhone');
      expect(p).not.toHaveProperty('medicalNotes');
      expect(p).not.toHaveProperty('visaHistoryJson');
    });

    test('MarketplaceLead slim shape — email/phone/company/message/rawPayload EXCLUDED', () => {
      const p = listProjection('MarketplaceLead', false);
      expect(p).toEqual({
        id: true,
        provider: true,
        name: true,
        status: true,
        contactId: true,
        createdAt: true,
      });
      expect(p).not.toHaveProperty('email');
      expect(p).not.toHaveProperty('phone');
      expect(p).not.toHaveProperty('company');
      expect(p).not.toHaveProperty('message');
      expect(p).not.toHaveProperty('rawPayload');
      expect(p).not.toHaveProperty('product');
      expect(p).not.toHaveProperty('city');
    });

    // ── S42 wellness PHI projections ──────────────────────────────────
    test('Patient slim shape — phone/email/dob/allergies/notes EXCLUDED (HIPAA-load-bearing)', () => {
      const p = listProjection('Patient', false);
      expect(p).toEqual({
        id: true,
        name: true,         // operator headline (masking still applied
                            // route-side for low-trust viewers).
        locationId: true,
        source: true,
        createdAt: true,
      });
      // Every PHI column on the Patient schema MUST be absent. These
      // assertions are the load-bearing privacy contract for S42 — if
      // they break, the slice is invalid.
      expect(p).not.toHaveProperty('phone');
      expect(p).not.toHaveProperty('normalizedPhone');
      expect(p).not.toHaveProperty('email');
      expect(p).not.toHaveProperty('dob');
      expect(p).not.toHaveProperty('gender');
      expect(p).not.toHaveProperty('bloodGroup');
      expect(p).not.toHaveProperty('allergies');
      expect(p).not.toHaveProperty('notes');
      expect(p).not.toHaveProperty('photoUrl');
      expect(p).not.toHaveProperty('gst');
      expect(p).not.toHaveProperty('tagsJson');
      expect(p).not.toHaveProperty('anniversary');
      expect(p).not.toHaveProperty('walletBalance');
      expect(p).not.toHaveProperty('taxType');
      expect(p).not.toHaveProperty('instagramHandle');
    });

    test('Visit slim shape — clinical narrative + vitals + photos + home-address EXCLUDED', () => {
      const p = listProjection('Visit', false);
      expect(p).toEqual({
        id: true,
        patientId: true,    // FK only — patient PHI follows separate fetch
        visitDate: true,
        status: true,
        doctorId: true,
        serviceId: true,
        locationId: true,
        bookingType: true,  // CLINIC_VISIT | IN_HOME | VIDEO | PHONE
        createdAt: true,
      });
      // Clinical PHI columns — MUST NOT leak.
      expect(p).not.toHaveProperty('reason');
      expect(p).not.toHaveProperty('notes');
      expect(p).not.toHaveProperty('vitals');
      expect(p).not.toHaveProperty('photosBefore');
      expect(p).not.toHaveProperty('photosAfter');
      // Financial-PHI columns.
      expect(p).not.toHaveProperty('amountCharged');
      // Telehealth-session identifiers (auth-bearing).
      expect(p).not.toHaveProperty('videoRoom');
      expect(p).not.toHaveProperty('videoCallUrl');
      // Patient home-address PHI.
      expect(p).not.toHaveProperty('atHomeAddress');
      expect(p).not.toHaveProperty('atHomeCity');
      expect(p).not.toHaveProperty('atHomePincode');
    });

    test('Prescription slim shape — drugs + instructions + pdfUrl EXCLUDED (medico-legal load-bearing)', () => {
      const p = listProjection('Prescription', false);
      expect(p).toEqual({
        id: true,
        patientId: true,
        visitId: true,
        doctorId: true,
        createdAt: true,
      });
      // The Rx contents — load-bearing drop for HIPAA compliance.
      // Shipping `drugs` in a list response is what makes the bare-list
      // call a regulated PHI read.
      expect(p).not.toHaveProperty('drugs');
      expect(p).not.toHaveProperty('instructions');
      expect(p).not.toHaveProperty('pdfUrl');
    });
  });
});

describe('getProjections()', () => {
  test('returns the per-model projection map', () => {
    const map = getProjections();
    expect(typeof map).toBe('object');
    for (const model of KNOWN_MODELS) {
      expect(map).toHaveProperty(model);
    }
  });

  test('the returned map is FROZEN (caller cannot mutate the registry)', () => {
    const map = getProjections();
    expect(Object.isFrozen(map)).toBe(true);
    expect(() => { map.NewModel = { id: true }; }).toThrowError(TypeError);
  });

  test('every nested projection is also FROZEN', () => {
    const map = getProjections();
    for (const model of KNOWN_MODELS) {
      expect(Object.isFrozen(map[model])).toBe(true);
    }
  });
});

describe('isFullShape(query)', () => {
  test('?fields=summary → false (slim path)', () => {
    expect(isFullShape({ fields: 'summary' })).toBe(false);
  });

  test('absent fields key → true (full shape — backward compat default)', () => {
    expect(isFullShape({})).toBe(true);
    expect(isFullShape({ other: 'x' })).toBe(true);
  });

  test('?fields=full → true (explicit full opt-out)', () => {
    expect(isFullShape({ fields: 'full' })).toBe(true);
  });

  test('non-exact summary values → true (full shape — strict equality)', () => {
    // Mirrors the prior 51 slices' "non-exact ?fields values keep legacy
    // envelope" contract — only the literal lowercase "summary" string opts
    // into slim.
    expect(isFullShape({ fields: 'Summary' })).toBe(true);
    expect(isFullShape({ fields: 'SUMMARY' })).toBe(true);
    expect(isFullShape({ fields: 'summary,extra' })).toBe(true);
    expect(isFullShape({ fields: 'summary ' })).toBe(true);
    expect(isFullShape({ fields: ' summary' })).toBe(true);
    expect(isFullShape({ fields: '' })).toBe(true);
  });

  test('null/undefined fields key → true (full shape)', () => {
    expect(isFullShape({ fields: null })).toBe(true);
    expect(isFullShape({ fields: undefined })).toBe(true);
  });

  test('null/undefined query object → true (defensive — no throw)', () => {
    expect(isFullShape(null)).toBe(true);
    expect(isFullShape(undefined)).toBe(true);
    expect(isFullShape('not-an-object')).toBe(true);
    expect(isFullShape(42)).toBe(true);
  });

  test('pure — identical input twice returns same value', () => {
    expect(isFullShape({ fields: 'summary' })).toBe(isFullShape({ fields: 'summary' }));
    expect(isFullShape({})).toBe(isFullShape({}));
  });

  test('integrates with listProjection — round-trip slim path', () => {
    // The canonical use site:
    //   const isSummary = req.query.fields === 'summary';
    //   const select = listProjection(model, !isSummary);
    // — but a route adopting the helper can write the same logic as:
    //   const select = listProjection(model, isFullShape(req.query));
    // The two forms must be equivalent on `?fields=summary`.
    const req = { query: { fields: 'summary' } };
    const fullShape = isFullShape(req.query);
    const select = listProjection('TmcTrip', fullShape);
    expect(fullShape).toBe(false);
    expect(select).toBeDefined();
    expect(select).toHaveProperty('id', true);
  });

  test('integrates with listProjection — round-trip full path', () => {
    const req = { query: {} };
    const fullShape = isFullShape(req.query);
    const select = listProjection('TmcTrip', fullShape);
    expect(fullShape).toBe(true);
    expect(select).toBeUndefined();
  });
});
