const cron = require("node-cron");
const { PrismaClient } = require("@prisma/client");
const { findDuplicateMarketplaceLead } = require("../utils/deduplication");

const prisma = new PrismaClient();

/**
 * Sync leads from a specific marketplace provider API.
 * Called by the cron job or manually via the sync endpoint.
 */
async function syncMarketplace(provider, io) {
  const config = await prisma.marketplaceConfig.findUnique({ where: { provider } });
  if (!config || !config.isActive) {
    return { provider, skipped: true, reason: "Not configured or inactive" };
  }

  let fetched = 0;
  let created = 0;
  let duplicates = 0;

  try {
    if (provider === "indiamart") {
      fetched = await syncIndiaMART(config, (count) => { created += count; }, (count) => { duplicates += count; });
    } else if (provider === "justdial") {
      fetched = await syncJustDial(config, (count) => { created += count; }, (count) => { duplicates += count; });
    } else if (provider === "tradeindia") {
      fetched = await syncTradeIndia(config, (count) => { created += count; }, (count) => { duplicates += count; });
    }

    // Update last sync timestamp
    await prisma.marketplaceConfig.update({
      where: { provider },
      data: { lastSyncAt: new Date() },
    });

    if (created > 0 && io) {
      io.emit("marketplace_lead_new", { provider, count: created });
    }

    console.log(`[MarketplaceEngine] ${provider}: fetched=${fetched}, created=${created}, duplicates=${duplicates}`);
    return { provider, fetched, created, duplicates };
  } catch (err) {
    console.error(`[MarketplaceEngine] ${provider} sync error:`, err.message);
    return { provider, error: err.message };
  }
}

/**
 * IndiaMART CRM Listing API
 * Docs: https://developer.indiamart.com/
 */
async function syncIndiaMART(config, onCreated, onDuplicate) {
  const key = config.glueCrmKey || config.apiKey;
  if (!key) return 0;

  // Calculate start_time: last sync or 24 hours ago
  const since = config.lastSyncAt || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const startTime = formatIndiaMARTDate(since);

  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${encodeURIComponent(key)}&start_time=${encodeURIComponent(startTime)}`;

  const response = await fetch(url, { method: "GET", headers: { "Content-Type": "application/json" } });
  if (!response.ok) {
    throw new Error(`IndiaMART API returned ${response.status}`);
  }

  const data = await response.json();
  const leads = Array.isArray(data) ? data : data.RESPONSE || [];

  let count = 0;
  for (const raw of leads) {
    const externalId = String(raw.UNIQUE_QUERY_ID || raw.QUERY_ID || "");
    if (!externalId) continue;

    const existing = await findDuplicateMarketplaceLead("indiamart", externalId);
    if (existing) { onDuplicate(1); continue; }

    await prisma.marketplaceLead.create({
      data: {
        provider: "indiamart",
        externalLeadId: externalId,
        rawPayload: JSON.stringify(raw),
        name: raw.SENDER_NAME || null,
        email: raw.SENDER_EMAIL || null,
        phone: raw.SENDER_MOBILE || raw.SENDER_PHONE || null,
        company: raw.SENDER_COMPANY || null,
        product: raw.QUERY_PRODUCT_NAME || null,
        message: raw.QUERY_MESSAGE || null,
        city: raw.SENDER_CITY || null,
        status: "New",
      },
    });
    onCreated(1);
    count++;
  }

  return leads.length;
}

/**
 * JustDial Leads API (pull-based)
 */
async function syncJustDial(config, onCreated, onDuplicate) {
  const key = config.apiKey;
  if (!key) return 0;

  // JustDial API endpoint — adjust based on their actual API docs
  const url = `https://api.justdial.com/leads?api_key=${encodeURIComponent(key)}&since=${config.lastSyncAt ? config.lastSyncAt.toISOString() : ""}`;

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      console.warn(`[MarketplaceEngine] JustDial API returned ${response.status} — may need API key update`);
      return 0;
    }

    const data = await response.json();
    const leads = Array.isArray(data) ? data : data.leads || [];

    let count = 0;
    for (const raw of leads) {
      const externalId = String(raw.leadid || raw.lead_id || raw.id || "");
      if (!externalId) continue;

      const existing = await findDuplicateMarketplaceLead("justdial", externalId);
      if (existing) { onDuplicate(1); continue; }

      await prisma.marketplaceLead.create({
        data: {
          provider: "justdial",
          externalLeadId: externalId,
          rawPayload: JSON.stringify(raw),
          name: raw.name || null,
          email: raw.email || null,
          phone: raw.phone || raw.mobile || null,
          company: raw.company || null,
          product: raw.category || null,
          message: raw.description || null,
          city: raw.city || null,
          status: "New",
        },
      });
      onCreated(1);
      count++;
    }

    return leads.length;
  } catch (err) {
    console.warn(`[MarketplaceEngine] JustDial sync skipped:`, err.message);
    return 0;
  }
}

/**
 * TradeIndia Leads API (pull-based)
 */
async function syncTradeIndia(config, onCreated, onDuplicate) {
  const key = config.apiKey;
  if (!key) return 0;

  const url = `https://www.tradeindia.com/utils/my_inquiry.html?userid=${encodeURIComponent(config.apiSecret || "")}&profile_id=${encodeURIComponent(key)}&key=MY_KEY`;

  try {
    const response = await fetch(url, { method: "GET" });
    if (!response.ok) {
      console.warn(`[MarketplaceEngine] TradeIndia API returned ${response.status}`);
      return 0;
    }

    const data = await response.json();
    const leads = Array.isArray(data) ? data : data.inquiries || [];

    let count = 0;
    for (const raw of leads) {
      const externalId = String(raw.inquiry_id || raw.rfi_id || "");
      if (!externalId) continue;

      const existing = await findDuplicateMarketplaceLead("tradeindia", externalId);
      if (existing) { onDuplicate(1); continue; }

      await prisma.marketplaceLead.create({
        data: {
          provider: "tradeindia",
          externalLeadId: externalId,
          rawPayload: JSON.stringify(raw),
          name: raw.sender_name || raw.contact_person || null,
          email: raw.sender_email || null,
          phone: raw.sender_mobile || null,
          company: raw.sender_company || null,
          product: raw.product_name || null,
          message: raw.message || null,
          city: raw.sender_city || null,
          status: "New",
        },
      });
      onCreated(1);
      count++;
    }

    return leads.length;
  } catch (err) {
    console.warn(`[MarketplaceEngine] TradeIndia sync skipped:`, err.message);
    return 0;
  }
}

// Helper: format date for IndiaMART API (DD-Mon-YYYY HH:MM:SS)
function formatIndiaMARTDate(date) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, "0");
  const mon = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}-${mon}-${yyyy} ${hh}:${mm}:${ss}`;
}

/**
 * Initialize the marketplace sync cron job.
 * Runs every 5 minutes, syncs all active providers.
 */
function initMarketplaceCron(io) {
  cron.schedule("*/5 * * * *", async () => {
    console.log("[MarketplaceEngine] Running sync cycle...");
    const configs = await prisma.marketplaceConfig.findMany({ where: { isActive: true } });
    for (const config of configs) {
      await syncMarketplace(config.provider, io);
    }
  });
  console.log("[MarketplaceEngine] Cron scheduled: every 5 minutes");
}

module.exports = { initMarketplaceCron, syncMarketplace };
