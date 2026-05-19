/**
 * Seed script for the Travel Stall demo tenant — Day 1 scaffolding.
 *
 * Idempotent — safe to re-run. Will:
 *   - upsert Tenant slug "travel-stall" with vertical="travel"
 *   - upsert Yasin (admin), 1 TMC operator, 1 RFU advisor, 1 telecaller
 *
 * Phase 1 will extend this with TMC school DB, RFU product ladder + cost
 * master, diagnostic Q-sets (per Q13 deliverable from Yasin), supplier
 * directory, and sample itineraries. For Day 1 we only need the tenant
 * + a handful of users so login → /travel works end-to-end.
 *
 * Run: cd backend && node prisma/seed-travel.js
 *
 * See docs/TRAVEL_CRM_PRD.md and docs/TRAVEL_CRM_OPEN_QUESTIONS.md for context.
 */
const path = require("path");
const dotenv = require("dotenv");

// Load .env (project root, 2 levels up from backend/prisma/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL not set in .env file");
  process.exit(1);
}

const prisma = new PrismaClient();

const TENANT_SLUG = "travel-stall";

async function main() {
  console.log("[seed-travel] starting…");

  // 1. Tenant — INR + en-IN match the parent Travel Stall entity registered
  // in India. The sub-brand split (TMC / RFU / Travel Stall / Visa Sure)
  // lives on a per-User `subBrandAccess[]` column (added in the Phase 1
  // schema migration, NOT in this Day 1 seed).
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: {
      vertical: "travel",
      name: "Travel Stall",
      ownerEmail: "yasin@travelstall.in",
      country: "IN",
      defaultCurrency: "INR",
      locale: "en-IN",
    },
    create: {
      slug: TENANT_SLUG,
      name: "Travel Stall",
      vertical: "travel",
      plan: "enterprise",
      ownerEmail: "yasin@travelstall.in",
      country: "IN",
      defaultCurrency: "INR",
      locale: "en-IN",
      isActive: true,
    },
  });
  console.log(
    `[seed-travel] tenant id=${tenant.id} slug=${tenant.slug} vertical=${tenant.vertical}`,
  );

  // 2. Users — Day 1 minimum to demo per-role landing.
  // Passwords all "password123" to match the existing demo convention.
  const pw = await bcrypt.hash("password123", 10);
  const trialStartDate = new Date();
  const trialEndsAt = new Date(Date.now() + 15 * 86400000);

  const users = [
    {
      email: "yasin@travelstall.in",
      role: "ADMIN",
      name: "Yasin (Owner)",
    },
    {
      email: "admin@travelstall.demo",
      role: "ADMIN",
      name: "Demo Admin",
    },
    {
      email: "tmc-ops@travelstall.demo",
      role: "MANAGER",
      name: "TMC Operator",
    },
    {
      email: "rfu-advisor@travelstall.demo",
      role: "MANAGER",
      name: "RFU Advisor",
    },
    {
      email: "telecaller@travelstall.demo",
      role: "USER",
      name: "Travel Telecaller",
    },
  ];

  for (const u of users) {
    await prisma.user.upsert({
      where: { email: u.email },
      update: {
        tenantId: tenant.id,
        role: u.role,
        name: u.name,
      },
      create: {
        email: u.email,
        password: pw,
        role: u.role,
        name: u.name,
        tenantId: tenant.id,
        subscriptionStatus: "TRIAL",
        trialStartDate,
        trialEndsAt,
      },
    });
  }
  console.log(`[seed-travel] users upserted: ${users.length}`);

  console.log("[seed-travel] done — Travel Stall demo tenant is reachable.");
  console.log("[seed-travel] Login: yasin@travelstall.in / password123");
}

main()
  .catch((e) => {
    console.error("[seed-travel] error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
