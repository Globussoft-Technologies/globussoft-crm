#!/usr/bin/env node
/**
 * Demo seed for the web check-in AUTOMATION feature
 * (PRD_AIRLINE_WEBCHECKIN_AUTOMATION). Creates, for tenant 1:
 *   - a demo contact
 *   - a PAID, non-Visa-Sure (tmc) itinerary  ← the engine's gate
 *   - 3 WebCheckin rows in status 'reminded' whose PNR prefix drives the
 *     deterministic stub adapter (services/airlineAdapters/_stub.js):
 *         OK6E...     (6E / IndiGo)   -> success      -> status 'done'
 *         CAPTCHAEK.. (EK / Emirates) -> captcha      -> 'fallback-agent'
 *         FAILAI...   (AI / Air India)-> transient    -> retries -> 'fallback-agent'
 *
 * Usage (from backend/):
 *   node scripts/seed-webcheckin-demo.js
 *   WEBCHECKIN_AUTOMATION_STUB=1 node -e "require('./cron/webCheckinAutomation').runWebCheckinAutomationTick().then(s=>console.log(s))"
 *
 * Idempotent-ish: re-running creates a fresh itinerary + rows each time (so you
 * can re-demo). Delete demo rows in Prisma Studio when done. Tenant 1 must exist
 * and be a travel-vertical tenant for the UI pages to render.
 */

const prisma = require("../lib/prisma");

const TENANT_ID = Number(process.env.SEED_TENANT_ID || 1);
const HOUR = 3600 * 1000;

async function main() {
  const now = Date.now();

  const contact = await prisma.contact.create({
    data: {
      tenantId: TENANT_ID,
      name: "Web Check-in Demo Passenger",
      email: "webcheckin.demo@example.com",
      phone: "+919999900000",
      subBrand: "tmc",
    },
  });

  const itinerary = await prisma.itinerary.create({
    data: {
      tenantId: TENANT_ID,
      contactId: contact.id,
      destination: "Dubai",
      subBrand: "tmc",
      status: "fully_paid", // PAID gate the engine requires
    },
  });

  const flights = [
    { pnr: "OK6E01", airlineCode: "6E", flightNumber: "6E-201", note: "-> success" },
    { pnr: "CAPTCHAEK1", airlineCode: "EK", flightNumber: "EK-512", note: "-> captcha/fallback" },
    { pnr: "FAILAI1", airlineCode: "AI", flightNumber: "AI-840", note: "-> retry/fallback" },
  ];

  const made = [];
  for (const f of flights) {
    const row = await prisma.webCheckin.create({
      data: {
        tenantId: TENANT_ID,
        contactId: contact.id,
        itineraryId: itinerary.id,
        pnr: f.pnr,
        airlineCode: f.airlineCode,
        flightNumber: f.flightNumber,
        passengerName: "Web Check-in Demo Passenger",
        departureAt: new Date(now + 30 * HOUR), // future flight
        windowOpenAt: new Date(now - 2 * HOUR), // window already open
        status: "reminded", // ready for the engine to pick up
        automationSkipped: false,
      },
    });
    made.push({ id: row.id, ...f });
  }

  console.log("Seeded demo web check-in automation data:");
  console.log("  contact   id =", contact.id);
  console.log("  itinerary id =", itinerary.id, "(status fully_paid, subBrand tmc)");
  for (const m of made) console.log(`  webcheckin id = ${m.id}  ${m.airlineCode} ${m.pnr}  ${m.note}`);
  console.log("\nNext: run the engine tick with the stub adapter:");
  console.log("  WEBCHECKIN_AUTOMATION_STUB=1 node -e \"require('./cron/webCheckinAutomation').runWebCheckinAutomationTick().then(s=>console.log(s))\"");
}

main()
  .catch((e) => {
    console.error("seed failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
