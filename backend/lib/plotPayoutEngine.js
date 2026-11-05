// Pure paise-accurate calculation helpers for deposit distribution.
// Nothing in this module reads Prisma or the network, which keeps the money
// rules independently testable and makes previews deterministic.

const BP_DENOMINATOR = 10_000n;

function toPaise(value, field = "amountPaise") {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
    return BigInt(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  throw new Error(`${field} must be a non-negative integer`);
}

function rupeesToPaise(value, field = "amount") {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${field} must be a valid amount`);
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error(`${field} must be a valid rupee amount`);
  const [whole, fraction = ""] = raw.split(".");
  return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}

function basisPointsAmount(amountPaise, rateBp) {
  const amount = toPaise(amountPaise);
  const rate = BigInt(Number(rateBp || 0));
  if (rate < 0n) throw new Error("rateBp cannot be negative");
  // Half-up is predictable for financial previews and keeps the remainder
  // reconciliation in the same unit.
  return (amount * rate + BP_DENOMINATOR / 2n) / BP_DENOMINATOR;
}

function sumPaise(rows) {
  return rows.reduce((sum, row) => sum + toPaise(row.amountPaise ?? row.grossPaise ?? row.netPaise ?? row), 0n);
}

function allocateByBasis(totalPaise, rows, basisKey = "ownershipBp") {
  const total = toPaise(totalPaise, "totalPaise");
  if (!rows.length) return [];
  const basisTotal = rows.reduce((sum, row) => sum + BigInt(Number(row[basisKey] || 0)), 0n);
  if (basisTotal <= 0n) throw new Error(`${basisKey} must total more than zero`);
  let allocated = 0n;
  return rows.map((row, index) => {
    const basis = BigInt(Number(row[basisKey] || 0));
    let amount = (total * basis) / basisTotal;
    if (index === rows.length - 1) amount = total - allocated;
    allocated += amount;
    return { ...row, amountPaise: amount };
  });
}

function normalizeRule(rule, fallback = {}) {
  return {
    ruleType: String(rule?.ruleType || fallback.ruleType || "PCT_LIST").toUpperCase(),
    rateBp: Number(rule?.rateBp ?? fallback.rateBp ?? 0),
    flatPaise: toPaise(rule?.flatPaise ?? fallback.flatPaise ?? 0, "flatPaise"),
  };
}

function ruleAmount(rule, values) {
  const normalized = normalizeRule(rule);
  if (!Number.isInteger(normalized.rateBp) || normalized.rateBp < 0) throw new Error("rateBp must be a non-negative integer");
  switch (normalized.ruleType) {
    case "PCT_BASE": return basisPointsAmount(values.basePricePaise, normalized.rateBp);
    case "PCT_LIST": return basisPointsAmount(values.listPricePaise, normalized.rateBp);
    case "PCT_FINAL": return basisPointsAmount(values.finalPricePaise, normalized.rateBp);
    case "FLAT": return normalized.flatPaise;
    default: throw new Error(`Unsupported commission rule: ${normalized.ruleType}`);
  }
}

function computeEntitlements(input) {
  const basePricePaise = toPaise(input.basePricePaise, "basePricePaise");
  const listPricePaise = toPaise(input.listPricePaise, "listPricePaise");
  const finalPricePaise = toPaise(input.finalPricePaise, "finalPricePaise");
  if (basePricePaise <= 0n || listPricePaise <= 0n || finalPricePaise <= 0n) throw new Error("Prices must be greater than zero");
  if (finalPricePaise < listPricePaise) throw new Error("Final price cannot be below list price");

  const owners = (input.owners || []).map((owner) => ({
    partnerId: Number(owner.partnerId),
    ownershipBp: Number(owner.ownershipBp),
    askedPricePaise: toPaise(owner.askedPricePaise, "askedPricePaise"),
    partyType: "OWNER",
    kind: "OWNER_SHARE",
  }));
  if (!owners.length) throw new Error("At least one owner is required");
  if (owners.some((owner) => !Number.isInteger(owner.partnerId) || owner.partnerId <= 0)) throw new Error("Each owner must have a valid partnerId");
  if (owners.some((owner) => !Number.isInteger(owner.ownershipBp) || owner.ownershipBp < 0)) throw new Error("Ownership percentages must be non-negative basis points");
  const ownershipTotal = owners.reduce((sum, owner) => sum + owner.ownershipBp, 0);
  if (ownershipTotal !== 10_000) throw new Error("Owner shares must total 10000 basis points");
  if (sumPaise(owners.map((owner) => ({ amountPaise: owner.askedPricePaise }))) !== basePricePaise) {
    throw new Error("Owner asking prices must equal the base price");
  }

  const settings = input.settings || {};
  const cpMarkupPaise = input.cpMarkupPaise != null
    ? toPaise(input.cpMarkupPaise, "cpMarkupPaise")
    : basisPointsAmount(basePricePaise, Number(input.cpMarkupBp ?? settings.cpMarkupBp ?? 0));
  const brokerCommissionPaise = input.brokerRule
    ? ruleAmount(input.brokerRule, { basePricePaise, listPricePaise, finalPricePaise })
    : input.brokerPartnerId
      ? basisPointsAmount(listPricePaise, Number(input.defaultBrokerRateBp ?? 100))
      : 0n;
  const cpCommissionPaise = input.cpCommissionRule
    ? ruleAmount(input.cpCommissionRule, { basePricePaise, listPricePaise, finalPricePaise })
    : 0n;
  const totalCommissionPaise = brokerCommissionPaise + cpCommissionPaise;
  const maxTotalCommissionBp = Number(settings.maxTotalCommissionBp ?? 1000);
  if (totalCommissionPaise > basisPointsAmount(finalPricePaise, maxTotalCommissionBp)) {
    throw new Error("Total commissions exceed the configured cap");
  }

  const ownerEntitlements = allocateByBasis(basePricePaise, owners).map((owner) => ({
    partnerId: owner.partnerId,
    partyType: "OWNER",
    kind: "OWNER_SHARE",
    amountPaise: owner.amountPaise,
  }));
  if (cpMarkupPaise > 0n && !input.channelPartnerId) throw new Error("A channel partner is required when CP markup is configured");
  if (brokerCommissionPaise > 0n && !input.brokerPartnerId) throw new Error("A broker partner is required when broker commission is configured");
  const companySharePaise = finalPricePaise - basePricePaise - cpMarkupPaise - brokerCommissionPaise - cpCommissionPaise;
  const floorMarginPaise = toPaise(settings.floorMarginPaise ?? 0, "floorMarginPaise");
  if (companySharePaise < floorMarginPaise) throw new Error("Company margin would fall below the configured floor");

  const entitlements = [...ownerEntitlements];
  if (cpMarkupPaise > 0n && input.channelPartnerId) {
    entitlements.push({ partnerId: Number(input.channelPartnerId), partyType: "CHANNEL_PARTNER", kind: "CP_MARKUP", amountPaise: cpMarkupPaise });
  }
  if (brokerCommissionPaise > 0n && input.brokerPartnerId) {
    entitlements.push({ partnerId: Number(input.brokerPartnerId), partyType: "BROKER", kind: "BROKER_COMMISSION", amountPaise: brokerCommissionPaise });
  }
  if (cpCommissionPaise > 0n && input.channelPartnerId) {
    entitlements.push({ partnerId: Number(input.channelPartnerId), partyType: "CHANNEL_PARTNER", kind: "CP_COMMISSION", amountPaise: cpCommissionPaise });
  }
  entitlements.push({ partnerId: null, partyType: "COMPANY", kind: "COMPANY_SHARE", amountPaise: companySharePaise });
  if (sumPaise(entitlements) !== finalPricePaise) throw new Error("Entitlements do not reconcile to the final price");
  return {
    basePricePaise,
    listPricePaise,
    finalPricePaise,
    cpMarkupPaise,
    brokerCommissionPaise,
    cpCommissionPaise,
    companySharePaise,
    entitlements,
  };
}

function computeCustomEntitlements(input) {
  const finalPricePaise = toPaise(input.finalPricePaise, "finalPricePaise");
  if (finalPricePaise <= 0n) throw new Error("Final price must be greater than zero");
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (!rawLines.length) throw new Error("At least one custom split line is required");

  const combined = new Map();
  for (const rawLine of rawLines) {
    const partyType = String(rawLine.partyType || "").toUpperCase();
    if (!["OWNER", "CHANNEL_PARTNER", "BROKER", "COMPANY"].includes(partyType)) {
      throw new Error("Custom split lines must identify an owner, channel partner, broker, or company");
    }
    const partnerId = partyType === "COMPANY" ? null : Number(rawLine.partnerId);
    if (partyType !== "COMPANY" && (!Number.isInteger(partnerId) || partnerId <= 0)) {
      throw new Error("Every non-company custom split line must have a valid partnerId");
    }
    const amountPaise = toPaise(rawLine.amountPaise, "custom amountPaise");
    if (amountPaise <= 0n) throw new Error("Custom split amounts must be greater than zero");
    const kind = String(rawLine.kind || ({ OWNER: "OWNER_SHARE", CHANNEL_PARTNER: "CP_COMMISSION", BROKER: "BROKER_COMMISSION", COMPANY: "COMPANY_SHARE" }[partyType])).toUpperCase();
    const key = `${partyType}:${partnerId ?? "company"}:${kind}`;
    const existing = combined.get(key);
    if (existing) existing.amountPaise += amountPaise;
    else combined.set(key, { partnerId, partyType, kind, amountPaise });
  }
  const entitlements = [...combined.values()];
  if (sumPaise(entitlements) !== finalPricePaise) throw new Error("Custom split amounts must exactly equal the final price");
  const cpMarkupPaise = sumPaise(entitlements.filter((line) => line.kind === "CP_MARKUP"));
  const cpCommissionPaise = sumPaise(entitlements.filter((line) => line.partyType === "CHANNEL_PARTNER" && line.kind !== "CP_MARKUP"));
  const brokerCommissionPaise = sumPaise(entitlements.filter((line) => line.partyType === "BROKER"));
  const companySharePaise = sumPaise(entitlements.filter((line) => line.partyType === "COMPANY"));
  return {
    basePricePaise: toPaise(input.basePricePaise ?? 0),
    listPricePaise: toPaise(input.listPricePaise ?? finalPricePaise),
    finalPricePaise,
    cpMarkupPaise,
    brokerCommissionPaise,
    cpCommissionPaise,
    companySharePaise,
    entitlements,
  };
}

function allocatePayment(paymentPaise, entitlements) {
  const payment = toPaise(paymentPaise, "paymentPaise");
  const total = sumPaise(entitlements);
  if (payment <= 0n || payment > total) throw new Error("Payment must be greater than zero and no more than the final price");
  let allocated = 0n;
  const rows = entitlements.map((entitlement, index) => {
    let amountPaise = (payment * entitlement.amountPaise) / total;
    if (index === entitlements.length - 1) amountPaise = payment - allocated;
    allocated += amountPaise;
    return { ...entitlement, amountPaise };
  });
  return rows;
}

function serializePaise(value) {
  const amount = toPaise(value);
  return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(amount) : amount.toString();
}

function serializeMoneyObject(value) {
  if (typeof value === "bigint") return serializePaise(value);
  if (Array.isArray(value)) return value.map(serializeMoneyObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeMoneyObject(item)]));
  return value;
}

module.exports = {
  BP_DENOMINATOR,
  toPaise,
  rupeesToPaise,
  basisPointsAmount,
  sumPaise,
  allocateByBasis,
  ruleAmount,
  computeEntitlements,
  computeCustomEntitlements,
  allocatePayment,
  serializePaise,
  serializeMoneyObject,
};
