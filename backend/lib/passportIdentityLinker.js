const prisma = require("./prisma");
const MAX_CANDIDATES = 8;

function normalizePhone(value) {
  if (!value || typeof value !== "string") return null;
  const digits = value.replace(/[^0-9]/g, "");
  if (digits.length === 10) return `91${digits}`;
  return digits || null;
}

function normalizePassportNumber(value) {
  if (!value || typeof value !== "string") return null;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return normalized || null;
}

function normalizeName(value) {
  if (!value || typeof value !== "string") return null;
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || null;
}

function normalizeDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function extractionFullName(extraction = {}) {
  const parts = [extraction.givenNames, extraction.surname].filter(Boolean);
  return normalizeName(parts.length ? parts.join(" ") : extraction.fullName);
}

function compactContact(contact) {
  if (!contact) return null;
  return {
    id: contact.id,
    name: contact.name || null,
    email: contact.email || null,
    phone: contact.phone || null,
    subBrand: contact.subBrand || null,
  };
}

function candidateKey(candidate) {
  return `${candidate.sourceType}:${candidate.sourceId}`;
}

function addCandidate(out, seen, candidate) {
  if (!candidate || out.length >= MAX_CANDIDATES) return;
  const key = candidateKey(candidate);
  if (seen.has(key)) return;
  seen.add(key);
  out.push(candidate);
}

function parseEnvelope(json) {
  try {
    return json ? JSON.parse(json) : null;
  } catch (_) {
    return null;
  }
}

function buildSourceCandidate({ sourceType, row, matchedBy, strength, contact = null }) {
  return {
    sourceType,
    sourceId: row.id,
    matchedBy,
    strength,
    fullName: row.fullName || contact?.name || null,
    passportNumber: row.passportNumber || null,
    passportExpiry: row.passportExpiry || null,
    verifiedAt: row.passportVerifiedAt || null,
    subBrand: row.subBrand || contact?.subBrand || null,
    contact: compactContact(contact),
  };
}

function compactConfidenceEnvelope(envelope = {}) {
  return JSON.stringify({
    provider: envelope.provider || null,
    confidence: envelope.confidence ?? null,
    mrzFound: envelope.mrzFound ?? null,
    vizFound: envelope.vizFound ?? null,
    checks: envelope.checks || null,
  });
}

function dateOrNull(value) {
  const normalized = normalizeDate(value);
  return normalized ? new Date(`${normalized}T00:00:00.000Z`) : null;
}

async function persistPassportIdentity({
  tenantId,
  contactId = null,
  sourceType,
  sourceId,
  extraction = {},
  fullName,
  phone,
  verifiedAt,
  verifiedById,
  envelope = {},
} = {}) {
  if (!tenantId || !sourceType || !Number.isFinite(Number(sourceId)) || !prisma.passportIdentity) return null;

  const normalizedPassportNumber = normalizePassportNumber(extraction.passportNumber);
  const resolvedFullName = fullName || [extraction.givenNames, extraction.surname].filter(Boolean).join(" ") || null;
  const normalizedFullName = normalizeName(resolvedFullName);
  const data = {
    tenantId,
    contactId: contactId || null,
    normalizedPassportNumber,
    passportNumber: extraction.passportNumber || null,
    fullName: resolvedFullName,
    normalizedFullName,
    dateOfBirth: dateOrNull(extraction.dateOfBirth),
    phoneNormalized: normalizePhone(phone || ""),
    nationality: extraction.nationality || null,
    passportExpiry: dateOrNull(extraction.dateOfExpiry || extraction.passportExpiry),
    confidenceJson: compactConfidenceEnvelope(envelope),
    sourceType,
    sourceId: Number(sourceId),
    verifiedAt: verifiedAt || new Date(),
    verifiedById: verifiedById || null,
  };

  if (!normalizedPassportNumber && !normalizedFullName && !data.dateOfBirth) return null;

  const existing = normalizedPassportNumber
    ? await prisma.passportIdentity.findFirst({ where: { tenantId, normalizedPassportNumber } })
    : null;

  if (existing) {
    return prisma.passportIdentity.update({
      where: { id: existing.id },
      data: {
        contactId: existing.contactId || data.contactId,
        passportNumber: data.passportNumber || existing.passportNumber,
        fullName: data.fullName || existing.fullName,
        normalizedFullName: data.normalizedFullName || existing.normalizedFullName,
        dateOfBirth: data.dateOfBirth || existing.dateOfBirth,
        phoneNormalized: data.phoneNormalized || existing.phoneNormalized,
        nationality: data.nationality || existing.nationality,
        passportExpiry: data.passportExpiry || existing.passportExpiry,
        confidenceJson: data.confidenceJson,
        verifiedAt: data.verifiedAt,
        verifiedById: data.verifiedById,
      },
    });
  }

  return prisma.passportIdentity.create({ data });
}

async function findPassportIdentityCandidates({
  tenantId,
  sourceType,
  sourceId,
  extraction,
  fullName,
  phone,
} = {}) {
  if (!tenantId) return [];

  const passportNumber = normalizePassportNumber(extraction?.passportNumber);
  const targetName = normalizeName(fullName) || extractionFullName(extraction);
  const targetDob = normalizeDate(extraction?.dateOfBirth);
  const targetPhone = normalizePhone(phone || "");
  const out = [];
  const seen = new Set();

  if (passportNumber) {
    if (prisma.passportIdentity) {
      const identityRows = await prisma.passportIdentity.findMany({
        where: { tenantId, normalizedPassportNumber: passportNumber },
        include: { contact: { select: { id: true, name: true, email: true, phone: true, subBrand: true } } },
        orderBy: { verifiedAt: "desc" },
        take: MAX_CANDIDATES,
      });
      for (const row of identityRows) {
        addCandidate(out, seen, {
          sourceType: "passportIdentity",
          sourceId: row.id,
          matchedBy: "passport",
          strength: "exact",
          fullName: row.fullName || row.contact?.name || null,
          passportNumber: row.passportNumber || null,
          passportExpiry: row.passportExpiry || null,
          verifiedAt: row.verifiedAt || null,
          subBrand: row.contact?.subBrand || null,
          contact: compactContact(row.contact),
        });
      }
    }
    const [customerRows, tripRows, rfuRows] = await Promise.all([
      prisma.customerTraveller.findMany({
        where: {
          tenantId,
          passportNumber,
          passportVerifiedAt: { not: null },
          ...(sourceType === "customer" && sourceId ? { NOT: { id: sourceId } } : {}),
        },
        orderBy: { passportVerifiedAt: "desc" },
        take: MAX_CANDIDATES,
      }),
      prisma.tripParticipant.findMany({
        where: {
          passportNumber,
          passportVerifiedAt: { not: null },
          trip: { tenantId },
          ...(sourceType === "trip" && sourceId ? { NOT: { id: sourceId } } : {}),
        },
        include: { trip: { select: { id: true, tripCode: true, destination: true } } },
        orderBy: { passportVerifiedAt: "desc" },
        take: MAX_CANDIDATES,
      }),
      prisma.rfuLeadProfile.findMany({
        where: { tenantId, passportNumber },
        include: { contact: { select: { id: true, name: true, email: true, phone: true, subBrand: true, deletedAt: true } } },
        orderBy: { id: "asc" },
        take: MAX_CANDIDATES,
      }),
    ]);

    for (const row of customerRows) {
      addCandidate(out, seen, buildSourceCandidate({ sourceType: "customerTraveller", row, matchedBy: "passport", strength: "exact" }));
    }
    for (const row of tripRows) {
      addCandidate(out, seen, {
        ...buildSourceCandidate({ sourceType: "tripParticipant", row, matchedBy: "passport", strength: "exact" }),
        trip: row.trip || null,
      });
    }
    for (const row of rfuRows) {
      if (row.contact?.deletedAt) continue;
      addCandidate(out, seen, {
        sourceType: "rfuLeadProfile",
        sourceId: row.id,
        matchedBy: "passport",
        strength: "exact",
        fullName: row.contact?.name || null,
        passportNumber: row.passportNumber || null,
        passportExpiry: row.passportExpiry || null,
        verifiedAt: null,
        subBrand: row.contact?.subBrand || "rfu",
        contact: compactContact(row.contact),
      });
    }
  }

  if (out.length || !targetName || !targetDob || !targetPhone) return out;

  // Existing schema has DOB only inside extraction JSON, so this fallback is a
  // bounded scan of recently verified customer travellers. It compares compact
  // text fields only; no document/image bytes are read or returned.
  const recentCustomerRows = await prisma.customerTraveller.findMany({
    where: {
      tenantId,
      passportVerifiedAt: { not: null },
      passportExtractionJson: { not: null },
      ...(sourceType === "customer" && sourceId ? { NOT: { id: sourceId } } : {}),
    },
    orderBy: { passportVerifiedAt: "desc" },
    take: 200,
  });

  for (const row of recentCustomerRows) {
    const envelope = parseEnvelope(row.passportExtractionJson);
    const ex = envelope?.extraction || {};
    const rowName = normalizeName(row.fullName) || extractionFullName(ex);
    const rowDob = normalizeDate(ex.dateOfBirth);
    const rowPhone = normalizePhone(row.phone || "");
    if (rowName === targetName && rowDob === targetDob && rowPhone === targetPhone) {
      addCandidate(out, seen, buildSourceCandidate({ sourceType: "customerTraveller", row, matchedBy: "name_dob_phone", strength: "strong" }));
    }
  }

  return out;
}

module.exports = {
  findPassportIdentityCandidates,
  persistPassportIdentity,
  normalizePassportNumber,
  normalizeName,
  normalizeDate,
};
