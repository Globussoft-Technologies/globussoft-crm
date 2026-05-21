// Travel CRM Phase 2 — birthday + anniversary greetings cron
// (PRD §4.8 "Birthday / anniversary greetings — Phase 2").
//
// Daily 08:13 IST. Scans travel-tenant Contacts whose birthDate OR
// anniversary's month+day equals today (year-agnostic match) and
// creates one Notification per matched contact per occasion per year.
//
// Idempotency: dedupe by (entityType='Contact', entityId, title
// contains year-tagged marker like `birthday-2026` / `anniv-2026`).
// Each contact gets at most ONE birthday notification per year + ONE
// anniversary notification per year — re-running on the same day is
// a no-op once notifications exist.
//
// Dispatch deferred: Wati WhatsApp + email send waits on Q9 BSP creds.
// The Notification row is the visible Phase 2 output today; the advisor
// dashboard surfaces it as a "send a greeting" prompt.
//
// Scoped to vertical=travel tenants per the PRD's Phase 2 scope. Other
// verticals (wellness, generic) can adopt this engine by widening the
// tenant query in a follow-up commit.

const cron = require("node-cron");
const prisma = require("../lib/prisma");

const PORTAL_BASE = process.env.PUBLIC_BASE_URL || "https://crm.globusdemos.com";

/**
 * Year-agnostic month+day match. Returns true if `date` falls on
 * today's calendar day-of-year, regardless of stored year.
 * @param {Date|string|null} date
 */
function isTodayMonthDay(date) {
  if (!date) return false;
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return false;
  const now = new Date();
  return d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/**
 * Run the greetings sweep for one travel tenant.
 * @param {number} tenantId
 * @returns {Promise<{ birthdays: number, anniversaries: number }>}
 */
async function runContactGreetingsForTenant(tenantId) {
  // Fetch all contacts with either a birthDate or an anniversary set.
  // For Phase 2 Travel Stall volumes (low thousands), the fetch +
  // JS month/day filter is cheaper than a Prisma raw query with
  // DAYOFMONTH() / MONTH() helpers.
  const contacts = await prisma.contact.findMany({
    where: {
      tenantId,
      deletedAt: null,
      OR: [{ birthDate: { not: null } }, { anniversary: { not: null } }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      birthDate: true,
      anniversary: true,
    },
    take: 2000,
  });

  if (contacts.length === 0) return { birthdays: 0, anniversaries: 0 };

  const currentYear = new Date().getFullYear();
  let birthdays = 0;
  let anniversaries = 0;

  for (const c of contacts) {
    const birthdayHit = isTodayMonthDay(c.birthDate);
    const anniversaryHit = isTodayMonthDay(c.anniversary);
    if (!birthdayHit && !anniversaryHit) continue;

    if (birthdayHit) {
      const tag = `[birthday-${currentYear}]`;
      const existing = await prisma.notification.findFirst({
        where: {
          tenantId,
          entityType: "Contact",
          entityId: c.id,
          title: { contains: tag },
        },
        select: { id: true },
      });
      if (!existing) {
        try {
          await prisma.notification.create({
            data: {
              tenantId,
              title: `🎂 Birthday today: ${c.name || `Contact #${c.id}`} ${tag}`,
              message:
                `${c.name || `Contact #${c.id}`} (${c.phone || c.email || "no contact info"}) ` +
                `has a birthday today. Send a greeting — dispatch via WhatsApp pending Wati creds. ` +
                `Open ${PORTAL_BASE}/contacts/${c.id}`,
              type: "info",
              priority: "normal",
              entityType: "Contact",
              entityId: c.id,
            },
          });
          console.log(
            `[ContactGreetings] tenant ${tenantId} contact ${c.id} → birthday notification ` +
              `(WhatsApp dispatch pending Wati creds)`,
          );
          birthdays++;
        } catch (e) {
          console.error(
            `[ContactGreetings] tenant ${tenantId} contact ${c.id} birthday create error:`,
            e.message,
          );
        }
      }
    }

    if (anniversaryHit) {
      const tag = `[anniv-${currentYear}]`;
      const existing = await prisma.notification.findFirst({
        where: {
          tenantId,
          entityType: "Contact",
          entityId: c.id,
          title: { contains: tag },
        },
        select: { id: true },
      });
      if (!existing) {
        try {
          await prisma.notification.create({
            data: {
              tenantId,
              title: `💐 Anniversary today: ${c.name || `Contact #${c.id}`} ${tag}`,
              message:
                `${c.name || `Contact #${c.id}`} (${c.phone || c.email || "no contact info"}) ` +
                `has an anniversary today. Send a greeting — dispatch via WhatsApp pending Wati creds. ` +
                `Open ${PORTAL_BASE}/contacts/${c.id}`,
              type: "info",
              priority: "normal",
              entityType: "Contact",
              entityId: c.id,
            },
          });
          console.log(
            `[ContactGreetings] tenant ${tenantId} contact ${c.id} → anniversary notification ` +
              `(WhatsApp dispatch pending Wati creds)`,
          );
          anniversaries++;
        } catch (e) {
          console.error(
            `[ContactGreetings] tenant ${tenantId} contact ${c.id} anniversary create error:`,
            e.message,
          );
        }
      }
    }
  }

  return { birthdays, anniversaries };
}

async function runContactGreetingsForAllTravelTenants() {
  const tenants = await prisma.tenant.findMany({
    where: { vertical: "travel", isActive: true },
    select: { id: true, slug: true },
  });
  let totalBirthdays = 0;
  let totalAnniversaries = 0;
  for (const t of tenants) {
    try {
      const { birthdays, anniversaries } = await runContactGreetingsForTenant(t.id);
      totalBirthdays += birthdays;
      totalAnniversaries += anniversaries;
      if (birthdays || anniversaries) {
        console.log(
          `[ContactGreetings] tenant ${t.slug}: ${birthdays} birthday + ${anniversaries} anniversary notifications`,
        );
      }
    } catch (e) {
      console.error("[ContactGreetings] tenant fail:", t.slug, e.message);
    }
  }
  return { birthdays: totalBirthdays, anniversaries: totalAnniversaries };
}

function initContactGreetingsCron() {
  // Daily 08:13 IST — :13 minute offset per the standing rule (avoid
  // :00 / :30 cluster). PRD §4.8 says "1-2d plug-in"; the cron itself
  // is one daily fire that scans the whole tenant's contact base.
  cron.schedule("13 8 * * *", () => {
    runContactGreetingsForAllTravelTenants().catch((e) =>
      console.error("[ContactGreetings] cron fail:", e.message),
    );
  });
  console.log("[ContactGreetings] cron initialized (daily 08:13 IST)");
}

module.exports = {
  initContactGreetingsCron,
  runContactGreetingsForTenant,
  runContactGreetingsForAllTravelTenants,
  // Exported for unit-test introspection only.
  isTodayMonthDay,
};
