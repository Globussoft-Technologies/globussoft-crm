const express = require("express");
const fs = require("fs");
const path = require("path");
const router = express.Router();
const prisma = require("../lib/prisma");
const { verifyToken } = require("../middleware/auth");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { requirePermission } = require("../middleware/requirePermission");
const { writeAudit } = require("../lib/audit");
const {
  CONNECTOR_PATH,
  CONNECTOR_PROVIDER,
  createConnectorCredentials,
  disconnectConnector,
  getConnectorStatus,
  parseTallyResponse,
  sendTallyJob,
} = require("../lib/tallyConnectorBridge");

const guards = [verifyToken, requireTravelTenant];
const activePushes = new Set();
const connectorBinaryPath = path.resolve(
  process.env.TALLY_CONNECTOR_EXE_PATH
    || path.join(__dirname, "..", "..", "tally-connector", "dist", "TallyConnector.exe"),
);

function safeCredentials(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return { connectorId: parsed.connectorId || null, createdAt: parsed.createdAt || null };
  } catch (_) {
    return null;
  }
}

function connectorUrlFor(req) {
  const configuredUrl = String(process.env.TALLY_CONNECTOR_PUBLIC_URL || "").trim();
  if (configuredUrl) {
    try {
      const url = new URL(configuredUrl);
      if (url.protocol === "https:") url.protocol = "wss:";
      if (url.protocol === "http:") url.protocol = "ws:";
      if (!url.pathname || url.pathname === "/") url.pathname = CONNECTOR_PATH;
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch (_) {
      console.warn("[tally-connector] ignoring invalid TALLY_CONNECTOR_PUBLIC_URL");
    }
  }
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const wsProtocol = (forwarded || req.protocol) === "https" ? "wss" : "ws";
  return `${wsProtocol}://${forwardedHost || req.get("host")}${CONNECTOR_PATH}`;
}

function validXml(value) {
  const xml = String(value || "").trim();
  return /<ENVELOPE(?:\s|>)/i.test(xml) && /<\/ENVELOPE>\s*$/i.test(xml);
}

function validateImportXml(value, stage) {
  const xml = String(value || "").trim();
  if (!validXml(xml)) return { valid: false, reason: "Valid Tally ENVELOPE XML is required" };

  if (
    /<!DOCTYPE|<!ENTITY|<\?(?!xml\b)|<TDL(?:\s|>)|<EXPORTDATA(?:\s|>)|<FUNCTION(?:\s|>)/i.test(xml)
  ) {
    return { valid: false, reason: "Tally XML contains a prohibited declaration or operation" };
  }
  if (!/<TALLYREQUEST>\s*Import Data\s*<\/TALLYREQUEST>/i.test(xml) || !/<IMPORTDATA(?:\s|>)/i.test(xml)) {
    return { valid: false, reason: "Only Tally Import Data envelopes are allowed" };
  }
  if (/<(?:ISDELETED|ISCANCELLED|CANCELLED)>\s*Yes\s*<\//i.test(xml)) {
    return { valid: false, reason: "Delete and cancellation operations are not allowed" };
  }

  const objects = [...xml.matchAll(/<TALLYMESSAGE\b[^>]*>\s*<([A-Z][A-Z0-9_.-]*)\b([^>]*)>/gi)];
  const objectTypes = objects.map((match) => match[1].toUpperCase());
  if (objectTypes.length === 0) {
    return { valid: false, reason: "Tally XML does not contain any import objects" };
  }
  const actionTokens = [...xml.matchAll(/\bACTION\s*=/gi)];
  const allObjectsCreate = objects.every((match) => /\bACTION\s*=\s*["']Create["']/i.test(match[2]));
  if (!allObjectsCreate || actionTokens.length !== objects.length) {
    return { valid: false, reason: "Only explicit ACTION=Create operations are allowed" };
  }

  const expectedReport = stage === "masters" ? "All Masters" : "Vouchers";
  if (!new RegExp(`<REPORTNAME>\\s*${expectedReport}\\s*</REPORTNAME>`, "i").test(xml)) {
    return { valid: false, reason: `The ${stage} payload has an unexpected Tally report type` };
  }
  const allowedTypes = stage === "masters" ? new Set(["LEDGER", "VOUCHERTYPE", "COSTCENTRE"]) : new Set(["VOUCHER"]);
  if (objectTypes.some((type) => !allowedTypes.has(type))) {
    return { valid: false, reason: `The ${stage} payload contains an unsupported Tally object` };
  }

  return { valid: true, xml };
}

function previouslyExportedVoucherKeys(xml) {
  const keys = new Set();
  String(xml || "").replace(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi, (_match, attributes, body) => {
    const type = attributes.match(/\bVCHTYPE="([^"]*)"/i)?.[1]
      || body.match(/<VOUCHERTYPENAME\b[^>]*>([\s\S]*?)<\/VOUCHERTYPENAME>/i)?.[1]?.trim();
    const reference = body.match(/<REFERENCE\b[^>]*>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
    if (type && reference) keys.add(`${type}\u0000${reference}`);
    return _match;
  });
  return keys;
}

function liveVoucherPresence(xml) {
  const presence = new Map();
  String(xml || "").replace(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi, (_match, attributes, body) => {
    const type = attributes.match(/\bVCHTYPE="([^"]*)"/i)?.[1]
      || body.match(/<VOUCHERTYPENAME\b[^>]*>([\s\S]*?)<\/VOUCHERTYPENAME>/i)?.[1]?.trim();
    const reference = body.match(/<REFERENCE\b[^>]*>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
    const masterId = body.match(/<MASTERID\b[^>]*>\s*(\d+)\s*<\/MASTERID>/i)?.[1];
    if (type && reference && masterId) {
      const key = `${type}\u0000${reference}`;
      const ids = presence.get(key) || [];
      if (!ids.includes(masterId)) ids.push(masterId);
      presence.set(key, ids);
    }
    return _match;
  });
  return presence;
}

function voucherCostCentreNames(xml) {
  return new Set([...String(xml || "").matchAll(/<COSTCENTREALLOCATIONS\.LIST>[\s\S]*?<NAME>([\s\S]*?)<\/NAME>/gi)]
    .map((match) => match[1]?.trim())
    .filter(Boolean));
}

function voucherCount(xml) {
  return [...String(xml || "").matchAll(/<VOUCHER\b[^>]*>/gi)].length;
}

function xmlText(value) {
  return String(value || "").replace(/[&<>"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  })[character]);
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function buildVoucherPresenceRequest(companyName, voucherKeys) {
  const clauses = [...voucherKeys].map((key) => {
    const [type, reference] = String(key).split("\u0000");
    if (!type || !reference || !/^[\w .:/#()+-]{1,160}$/.test(type) || !/^[\w .:/#()+-]{1,240}$/.test(reference)) {
      throw Object.assign(new Error("A voucher reference cannot be safely reconciled with Tally"), { code: "TALLY_RECONCILIATION_INVALID" });
    }
    return `($VoucherTypeName = "${type}" AND $Reference = "${reference}")`;
  });
  if (!clauses.length) throw Object.assign(new Error("Voucher references are required for Tally reconciliation"), { code: "TALLY_RECONCILIATION_INVALID" });
  const formula = clauses.join(" OR ");
  return `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Globus Voucher Presence</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${xmlText(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="Globus Voucher Presence"><TYPE>Voucher</TYPE><FETCH>Date, VoucherTypeName, Reference, MasterID</FETCH><FILTER>Globus Voucher Reference Filter</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="Globus Voucher Reference Filter">${xmlText(formula)}</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
}

function companyNameFromImportXml(xml) {
  const value = String(xml || "").match(/<SVCURRENTCOMPANY>([\s\S]*?)<\/SVCURRENTCOMPANY>/i)?.[1]?.trim() || "";
  return decodeXmlText(value);
}

function receiptAllocation(message) {
  const voucher = message.match(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/i);
  if (!voucher || !/\bVCHTYPE="Receipt"/i.test(voucher[1])) return null;
  const reference = voucher[2].match(/<REFERENCE>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
  const allocation = voucher[2].match(/<BILLALLOCATIONS\.LIST>([\s\S]*?)<\/BILLALLOCATIONS\.LIST>/i)?.[1];
  const billReference = allocation?.match(/<NAME>([\s\S]*?)<\/NAME>/i)?.[1]?.trim();
  const rawAmount = allocation?.match(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/i)?.[1];
  const amount = Math.abs(Number(rawAmount || 0));
  return reference && billReference && amount > 0 ? { reference, billReference, amount } : null;
}

function legacyReceiptTotals(xml) {
  const totals = new Map();
  String(xml || "").replace(/<TALLYMESSAGE\b[^>]*>[\s\S]*?<\/TALLYMESSAGE>/gi, (message) => {
    const receipt = receiptAllocation(message);
    if (receipt && receipt.reference === `REC-${receipt.billReference}`) {
      totals.set(receipt.billReference, (totals.get(receipt.billReference) || 0) + receipt.amount);
    }
    return message;
  });
  return totals;
}

function purchasePaymentFingerprint(message) {
  const voucher = message.match(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/i);
  const type = voucher?.[1].match(/\bVCHTYPE="([^"]*)"/i)?.[1];
  if (!voucher || !/^(Purchase|Payment|Journal)$/i.test(type || "")) return null;
  const normalizedBody = voucher[2]
    .replace(/<VOUCHERNUMBER>[\s\S]*?<\/VOUCHERNUMBER>/gi, "")
    .replace(/<REFERENCE>[\s\S]*?<\/REFERENCE>/gi, "")
    .replace(/(<BILLALLOCATIONS\.LIST>[\s\S]*?<NAME>)[\s\S]*?(<\/NAME>)/gi, "$1$2")
    .replace(/\s+/g, "")
    .toLowerCase();
  return `${String(type).toLowerCase()}\u0000${normalizedBody}`;
}

function legacyPurchasePaymentEntries(xml) {
  const entries = [];
  String(xml || "").replace(/<TALLYMESSAGE\b[^>]*>[\s\S]*?<\/TALLYMESSAGE>/gi, (message) => {
    const voucher = message.match(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/i);
    const type = voucher?.[1].match(/\bVCHTYPE="([^"]*)"/i)?.[1];
    const reference = voucher?.[2].match(/<REFERENCE>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
    const fingerprint = purchasePaymentFingerprint(message);
    if (type && fingerprint && (/^Journal$/i.test(type) || /^TRV-\d{4}$/i.test(reference || ""))) {
      entries.push({ key: `${type}\u0000${reference}`, fingerprint });
    }
    return message;
  });
  return entries;
}

function omitPreviouslyExportedVouchers(xml, exportedKeys, legacyCoverage, legacyFingerprints) {
  let skipped = 0;
  let included = 0;
  const partialLegacyMatches = [];
  const filteredXml = String(xml || "").replace(/<TALLYMESSAGE\b[^>]*>[\s\S]*?<\/TALLYMESSAGE>/gi, (message) => {
    const voucher = message.match(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/i);
    if (!voucher) return message;
    const type = voucher[1].match(/\bVCHTYPE="([^"]*)"/i)?.[1];
    const reference = voucher[2].match(/<REFERENCE>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
    if (type && reference && exportedKeys.has(`${type}\u0000${reference}`)) {
      skipped += 1;
      return "";
    }
    const receipt = receiptAllocation(message);
    const legacyRemaining = receipt ? Number(legacyCoverage.get(receipt.billReference) || 0) : 0;
    if (receipt && legacyRemaining > 0.005) {
      if (legacyRemaining + 0.005 >= receipt.amount) {
        legacyCoverage.set(receipt.billReference, legacyRemaining - receipt.amount);
        skipped += 1;
        return "";
      }
      partialLegacyMatches.push(receipt.billReference);
      return message;
    }
    const fingerprint = purchasePaymentFingerprint(message);
    const legacyCount = fingerprint ? Number(legacyFingerprints.get(fingerprint) || 0) : 0;
    if (fingerprint && legacyCount > 0) {
      legacyFingerprints.set(fingerprint, legacyCount - 1);
      skipped += 1;
      return "";
    }
    included += 1;
    return message;
  });
  return { xml: filteredXml, skipped, included, partialLegacyMatches };
}

function retainOnlyLiveVoucherHistory(exportedKeys, legacyCoverage, legacyFingerprints, legacyFingerprintKeys, liveVoucherKeys) {
  for (const key of [...exportedKeys]) {
    if (!liveVoucherKeys.has(key)) exportedKeys.delete(key);
  }
  for (const billReference of [...legacyCoverage.keys()]) {
    if (!liveVoucherKeys.has(`Receipt\u0000REC-${billReference}`)) legacyCoverage.delete(billReference);
  }
  for (const [fingerprint, keys] of legacyFingerprintKeys) {
    const liveCount = keys.filter((key) => liveVoucherKeys.has(key)).length;
    if (liveCount) legacyFingerprints.set(fingerprint, liveCount);
    else legacyFingerprints.delete(fingerprint);
  }
}

function shouldOfferExistingVoucherUpdate(existingCurrentKeys, filteredVouchers) {
  return existingCurrentKeys.size > 0 && filteredVouchers.included === 0;
}

function syncLogRequestPayload(stageName, stageXml, fullVouchersXml) {
  return stageName === "vouchers" ? fullVouchersXml : stageXml;
}

function markLiveVouchersForAlter(xml, presence) {
  let altered = 0;
  const transformed = String(xml || "").replace(/<VOUCHER\b([^>]*)>([\s\S]*?)<\/VOUCHER>/gi, (fullMatch, attributes, body) => {
    const type = attributes.match(/\bVCHTYPE="([^"]*)"/i)?.[1]
      || body.match(/<VOUCHERTYPENAME\b[^>]*>([\s\S]*?)<\/VOUCHERTYPENAME>/i)?.[1]?.trim();
    const reference = body.match(/<REFERENCE\b[^>]*>([\s\S]*?)<\/REFERENCE>/i)?.[1]?.trim();
    const ids = presence.get(`${type}\u0000${reference}`) || [];
    if (!ids.length) return fullMatch;
    if (ids.length !== 1) {
      throw Object.assign(new Error(`Multiple Tally vouchers already use reference ${reference}. Remove the duplicate before updating.`), { code: "TALLY_AMBIGUOUS_VOUCHER" });
    }
    altered += 1;
    const cleanAttributes = attributes
      .replace(/\s+(?:TAGNAME|TAGVALUE|ACTION)\s*=\s*["'][^"']*["']/gi, "")
      .trimEnd();
    return `<VOUCHER${cleanAttributes} TAGNAME="Master ID" TAGVALUE="${ids[0]}" ACTION="Alter">${body}</VOUCHER>`;
  });
  return { xml: transformed, altered };
}

function costCentreCodesFromMastersXml(xml) {
  return [...String(xml || "").matchAll(/<COSTCENTRE\b[^>]*\bNAME\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1].trim())
    .filter((code) => /^[A-Z0-9-]{1,80}$/i.test(code));
}

async function updateCostCentreSyncStatus(tenantId, mastersXml, syncStatus) {
  const codes = [...new Set(costCentreCodesFromMastersXml(mastersXml))];
  if (!codes.length || !prisma.travelTallyCostCentre?.updateMany) return;
  await prisma.travelTallyCostCentre.updateMany({
    where: { tenantId, code: { in: codes } },
    data: { syncStatus },
  });
}

router.get("/status", ...guards, requirePermission("tally", "read"), async (req, res) => {
  try {
    const integration = await prisma.integration.findUnique({
      where: { tenantId_provider: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER } },
      select: { settings: true, isActive: true },
    });
    const credentials = integration?.isActive ? safeCredentials(integration.settings) : null;
    res.json({
      configured: Boolean(credentials),
      credentials,
      connectorUrl: connectorUrlFor(req),
      ...getConnectorStatus(req.travelTenant.id),
    });
  } catch (error) {
    console.error("[tally-connector] status failed:", error.message);
    res.status(500).json({ error: "Failed to load Tally connector status", code: "TALLY_CONNECTOR_STATUS_ERROR" });
  }
});

router.post("/credentials", ...guards, requirePermission("tally", "update"), async (req, res) => {
  try {
    const generated = createConnectorCredentials();
    await prisma.integration.upsert({
      where: { tenantId_provider: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER } },
      create: { tenantId: req.travelTenant.id, provider: CONNECTOR_PROVIDER, token: generated.stored.tokenHash, settings: JSON.stringify({ connectorId: generated.stored.connectorId, createdAt: generated.stored.createdAt }), isActive: true },
      update: { token: generated.stored.tokenHash, settings: JSON.stringify({ connectorId: generated.stored.connectorId, createdAt: generated.stored.createdAt }), isActive: true },
    });
    disconnectConnector(req.travelTenant.id);
    await writeAudit("TravelTally", "ROTATE_CONNECTOR_TOKEN", 0, req.user.userId, req.travelTenant.id, { connectorId: generated.stored.connectorId }).catch((error) => {
      console.warn("[tally-connector] credential audit failed:", error.message);
    });
    res.status(201).json({
      customerId: req.travelTenant.id,
      connectorId: generated.stored.connectorId,
      token: generated.token,
      connectorUrl: connectorUrlFor(req),
      message: "Save this token now. It is only returned once.",
    });
  } catch (error) {
    console.error("[tally-connector] credential generation failed:", error.message);
    res.status(500).json({ error: "Failed to generate connector credentials", code: "TALLY_CONNECTOR_CREDENTIAL_ERROR" });
  }
});

router.get("/binary", ...guards, requirePermission("tally", "read"), (req, res) => {
  if (!fs.existsSync(connectorBinaryPath)) {
    return res.status(503).json({
      error: "The Tally connector package is not available on this server.",
      code: "TALLY_CONNECTOR_BINARY_UNAVAILABLE",
    });
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.download(connectorBinaryPath, "TallyConnector.exe", (error) => {
    if (error && !res.headersSent) {
      console.error("[tally-connector] binary download failed:", error.message);
      res.status(500).json({
        error: "Failed to download the Tally connector.",
        code: "TALLY_CONNECTOR_BINARY_DOWNLOAD_ERROR",
      });
    }
  });
});

router.post("/push", ...guards, requirePermission("tally", "export"), async (req, res) => {
  const mastersXml = String(req.body?.mastersXml || "").trim();
  const vouchersXml = String(req.body?.vouchersXml || "").trim();
  const forceRepush = req.body?.forceRepush === true;
  const updateExisting = req.body?.updateExisting === true;
  if (!validXml(vouchersXml) || (mastersXml && !validXml(mastersXml))) {
    return res.status(400).json({ error: "Valid Tally ENVELOPE XML is required", code: "INVALID_TALLY_XML" });
  }
  const vouchersValidation = validateImportXml(vouchersXml, "vouchers");
  const mastersValidation = mastersXml ? validateImportXml(mastersXml, "masters") : { valid: true };
  if (!vouchersValidation.valid || !mastersValidation.valid) {
    const validation = !vouchersValidation.valid ? vouchersValidation : mastersValidation;
    return res.status(400).json({ error: validation.reason, code: "UNSAFE_TALLY_XML" });
  }
  if (!getConnectorStatus(req.travelTenant.id).online) {
    return res.status(503).json({ error: "Tally connector is offline. Start it on the Tally computer and try again.", code: "TALLY_CONNECTOR_OFFLINE" });
  }

  if (activePushes.has(req.travelTenant.id)) {
    return res.status(409).json({ error: "Another direct Tally push is already running for this account", code: "TALLY_PUSH_IN_PROGRESS" });
  }
  activePushes.add(req.travelTenant.id);
  try {
    const currentVoucherKeys = previouslyExportedVoucherKeys(vouchersXml);
    const voucherReferences = [...new Set([...currentVoucherKeys].map((key) => key.split("\u0000")[1]))];
    const voucherCostCentres = [...voucherCostCentreNames(vouchersXml)];
    const historyMatchers = [
      ...voucherReferences.map((reference) => ({ requestPayload: { contains: `<REFERENCE>${reference}</REFERENCE>` } })),
      ...voucherCostCentres.map((costCentre) => ({ requestPayload: { contains: `<NAME>${costCentre}</NAME>` } })),
    ];
    const priorVoucherLogs = [];
    for (let offset = 0; offset < historyMatchers.length; offset += 50) {
      const chunk = historyMatchers.slice(offset, offset + 50);
      const matchingLogs = await prisma.travelTallySyncLog.findMany({
        where: {
          tenantId: req.travelTenant.id,
          sourceType: "DIRECT_EXPORT",
          voucherType: "VOUCHERS",
          status: { in: ["SYNCED", "FAILED"] },
          OR: chunk,
        },
        select: { id: true, requestPayload: true, responsePayload: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      priorVoucherLogs.push(...matchingLogs);
    }
    const uniquePriorLogs = [...new Map(priorVoucherLogs.map((entry) => [entry.id, entry])).values()]
      .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    const exportedKeys = new Set();
    const legacyCoverage = new Map();
    const legacyFingerprints = new Map();
    const legacyFingerprintKeys = new Map();
    const seenLegacyReceipts = new Set();
    const seenLegacyPurchasePayments = new Set();
    let tallyPresence = new Map();
    for (const entry of uniquePriorLogs) {
      const tally = entry.status === "FAILED" ? parseTallyResponse(entry.responsePayload) : null;
      const wasImported = entry.status === "SYNCED" || Number(tally?.created || 0) > 0 || Number(tally?.altered || 0) > 0;
      if (!wasImported) continue;
      for (const key of previouslyExportedVoucherKeys(entry.requestPayload)) exportedKeys.add(key);
      for (const [billReference, amount] of legacyReceiptTotals(entry.requestPayload)) {
        const legacyKey = `Receipt\u0000REC-${billReference}`;
        if (seenLegacyReceipts.has(legacyKey)) continue;
        seenLegacyReceipts.add(legacyKey);
        legacyCoverage.set(billReference, amount);
      }
      for (const legacyEntry of legacyPurchasePaymentEntries(entry.requestPayload)) {
        if (seenLegacyPurchasePayments.has(legacyEntry.key)) continue;
        seenLegacyPurchasePayments.add(legacyEntry.key);
        legacyFingerprints.set(legacyEntry.fingerprint, (legacyFingerprints.get(legacyEntry.fingerprint) || 0) + 1);
        const keys = legacyFingerprintKeys.get(legacyEntry.fingerprint) || [];
        keys.push(legacyEntry.key);
        legacyFingerprintKeys.set(legacyEntry.fingerprint, keys);
      }
    }
    if (!forceRepush && (exportedKeys.size || seenLegacyReceipts.size || seenLegacyPurchasePayments.size)) {
      const lookupKeys = new Set([
        ...exportedKeys,
        ...seenLegacyReceipts,
        ...seenLegacyPurchasePayments,
      ]);
      let liveVoucherKeys;
      try {
        const lookupXml = buildVoucherPresenceRequest(companyNameFromImportXml(vouchersXml), lookupKeys);
        const lookupResult = await sendTallyJob(req.travelTenant.id, lookupXml, { jobType: "EXPORT_VOUCHER_PRESENCE" });
        const reportedKeys = previouslyExportedVoucherKeys(lookupResult.responseXml);
        tallyPresence = liveVoucherPresence(lookupResult.responseXml);
        const keysWithoutMasterId = [...reportedKeys].filter((key) => !tallyPresence.has(key));
        if (keysWithoutMasterId.length) {
          throw Object.assign(new Error("Tally did not return Master IDs for existing vouchers"), { code: "TALLY_RECONCILIATION_INVALID" });
        }
        liveVoucherKeys = reportedKeys;
      } catch (error) {
        await writeAudit("TravelTally", "DIRECT_PUSH_RECONCILIATION_FAILED", 0, req.user.userId, req.travelTenant.id, { code: error.code || "TALLY_RECONCILIATION_FAILED" }).catch(() => {});
        return res.status(error.code === "TALLY_CONNECTOR_TIMEOUT" ? 504 : 502).json({
          error: "Could not verify existing vouchers in Tally. Nothing was pushed, preventing accidental duplicates.",
          code: "TALLY_RECONCILIATION_FAILED",
        });
      }

      retainOnlyLiveVoucherHistory(exportedKeys, legacyCoverage, legacyFingerprints, legacyFingerprintKeys, liveVoucherKeys);
    }
    const filteredVouchers = omitPreviouslyExportedVouchers(vouchersXml, exportedKeys, legacyCoverage, legacyFingerprints);
    const existingCurrentKeys = new Set([...currentVoucherKeys].filter((key) => tallyPresence.has(key)));
    // If a trip has old and new vouchers together, skip the old vouchers and
    // import the new ones. Offer an update only when every voucher exists.
    if (shouldOfferExistingVoucherUpdate(existingCurrentKeys, filteredVouchers) && !forceRepush && !updateExisting) {
      return res.status(409).json({
        error: `${existingCurrentKeys.size} voucher(s) still exist in Tally. Update them, re-upload all as new vouchers, or cancel.`,
        code: "TALLY_EXISTING_VOUCHERS_FOUND",
        existingVouchers: existingCurrentKeys.size,
        missingOrNewVouchers: voucherCount(vouchersXml) - existingCurrentKeys.size,
      });
    }
    let vouchersToPush;
    try {
      vouchersToPush = forceRepush
        ? { xml: vouchersXml, included: voucherCount(vouchersXml), skipped: 0, partialLegacyMatches: [] }
        : updateExisting
          ? { ...markLiveVouchersForAlter(vouchersXml, tallyPresence), included: voucherCount(vouchersXml), skipped: 0, partialLegacyMatches: [] }
          : filteredVouchers;
    } catch (error) {
      return res.status(409).json({ error: error.message, code: error.code || "TALLY_RECONCILIATION_FAILED" });
    }
    if (vouchersToPush.partialLegacyMatches.length) {
      return res.status(409).json({
        error: "An earlier combined receipt only partly matches the current payment records. No vouchers were sent; reconcile this invoice's receipts before retrying.",
        code: "TALLY_LEGACY_RECEIPT_PARTIAL_MATCH",
      });
    }
    if (!vouchersToPush.included && vouchersToPush.skipped > 0) {
      return res.status(409).json({
        error: `No new vouchers are available. ${vouchersToPush.skipped} voucher(s) were already pushed. Pushing them again may create duplicates in Tally.`,
        code: "TALLY_NO_NEW_VOUCHERS",
        skippedVouchers: vouchersToPush.skipped,
      });
    }
    const stages = [
      ...(mastersXml ? [{ name: "masters", xml: mastersXml }] : []),
      ...(vouchersToPush.included ? [{ name: "vouchers", xml: vouchersToPush.xml }] : []),
    ];
    const results = [];
    for (const stage of stages) {
      try {
        const result = await sendTallyJob(req.travelTenant.id, stage.xml, { jobType: stage.name === "masters" ? "IMPORT_MASTERS" : "IMPORT_VOUCHERS" });
        const tally = result.tally || parseTallyResponse(result.responseXml);
        if (!tally.success) {
          throw Object.assign(new Error(tally.lineError || `Tally reported ${tally.errors + tally.exceptions} error(s)`), { code: "TALLY_IMPORT_FAILED", responseXml: result.responseXml, tally });
        }
        results.push({ stage: stage.name, status: "success", tally });
        await prisma.travelTallySyncLog.create({
          data: { tenantId: req.travelTenant.id, sourceType: "DIRECT_EXPORT", sourceId: 0, voucherType: stage.name.toUpperCase(), status: "SYNCED", triggeredByUserId: req.user.userId, requestPayload: syncLogRequestPayload(stage.name, stage.xml, vouchersXml), responsePayload: result.responseXml },
        });
        if (stage.name === "masters") {
          await updateCostCentreSyncStatus(req.travelTenant.id, stage.xml, "SYNCED").catch((error) => {
            console.warn("[tally-connector] cost-centre sync status update failed:", error.message);
          });
        }
      } catch (error) {
        const tally = error.tally || parseTallyResponse(error.responseXml);
        if (stage.name === "masters") {
          await updateCostCentreSyncStatus(req.travelTenant.id, stage.xml, "FAILED").catch(() => {});
        }
        await prisma.travelTallySyncLog.create({
          data: { tenantId: req.travelTenant.id, sourceType: "DIRECT_EXPORT", sourceId: 0, voucherType: stage.name.toUpperCase(), status: "FAILED", triggeredByUserId: req.user.userId, requestPayload: syncLogRequestPayload(stage.name, stage.xml, vouchersXml), responsePayload: error.responseXml || null },
        }).catch(() => {});
        await writeAudit("TravelTally", "DIRECT_PUSH_FAILED", 0, req.user.userId, req.travelTenant.id, { stage: stage.name, code: error.code || "TALLY_IMPORT_FAILED" }).catch(() => {});
        return res.status(error.code === "TALLY_CONNECTOR_TIMEOUT" ? 504 : 502).json({ error: error.message || "Tally import failed", code: error.code || "TALLY_IMPORT_FAILED", stage: stage.name, tally });
      }
    }
    await writeAudit("TravelTally", "DIRECT_PUSH_SUCCESS", 0, req.user.userId, req.travelTenant.id, { stages: results.map((result) => result.stage) }).catch(() => {});
    return res.json({ success: true, results, skippedVouchers: vouchersToPush.skipped });
  } finally {
    activePushes.delete(req.travelTenant.id);
  }
});

router.__testHooks = {
  buildVoucherPresenceRequest,
  liveVoucherPresence,
  markLiveVouchersForAlter,
  legacyPurchasePaymentEntries,
  omitPreviouslyExportedVouchers,
  previouslyExportedVoucherKeys,
  retainOnlyLiveVoucherHistory,
  shouldOfferExistingVoucherUpdate,
  syncLogRequestPayload,
};

module.exports = router;
