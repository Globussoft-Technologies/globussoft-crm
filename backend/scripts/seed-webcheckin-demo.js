#!/usr/bin/env node
/**
 * Demo seed for the Web Check-ins queue (manual-only model).
 * Creates, for tenant 1:
 *   - a demo contact
 *   - a PAID, non-Visa-Sure (tmc) itinerary
 *   - 3 WebCheckin rows in status 'pending' with departureAt within the next
 *     24 hours so the scheduler cron will notify operators on its next tick.
 *
 * Usage (from backend/):
 *   node scripts/seed-webcheckin-demo.js
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
      status: "fully_paid",
    },
  });

  const flights = [
    { pnr: "DEMO6E01", airlineCode: "6E", flightNumber: "6E-201" },
    { pnr: "DEMOEK01", airlineCode: "EK", flightNumber: "EK-512" },
    { pnr: "DEMOAI01", airlineCode: "AI", flightNumber: "AI-840" },
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
        departureAt: new Date(now + 12 * HOUR), // within 24h → scheduler will notify
        windowOpenAt: new Date(now - 2 * HOUR),
        status: "pending",
      },
    });
    made.push({ id: row.id, ...f });
  }

  console.log("Seeded demo web check-in queue data:");
  console.log("  contact   id =", contact.id);
  console.log("  itinerary id =", itinerary.id, "(status fully_paid, subBrand tmc)");
  for (const m of made) console.log(`  webcheckin id = ${m.id}  ${m.airlineCode} ${m.pnr}`);
  console.log("\nNext: wait for the scheduler cron (every 15 min) or open /travel/web-checkins.");
}

main()
  .catch((e) => {
    console.error("seed failed:", e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
