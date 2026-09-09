import { beforeEach, describe, expect, test, vi } from "vitest";
import prisma from "../../lib/prisma.js";

prisma.tmcTrip = {
  ...(prisma.tmcTrip || {}),
  findFirst: vi.fn(),
};
prisma.tripParticipant = {
  ...(prisma.tripParticipant || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
};
prisma.tripInstalmentPayment = {
  ...(prisma.tripInstalmentPayment || {}),
  findFirst: vi.fn(),
};
prisma.emailVerificationOtp = {
  ...(prisma.emailVerificationOtp || {}),
  create: vi.fn(),
};

import express from "express";
import request from "supertest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const paymentPortalRouter = requireCJS("../../routes/travel_payment_portal");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel", paymentPortalRouter);
  return app;
}

const trip = {
  id: 16,
  tenantId: 3,
  tripCode: "HAMP-2026",
  destination: "Hampi",
  departDate: new Date("2026-11-07"),
  returnDate: new Date("2026-11-11"),
  status: "confirmed",
};

const participant = {
  id: 41,
  tripId: 16,
  fullName: "Juhi Sen",
  parentName: "Manik Saha",
  parentEmail: "manik@getairmail.com",
  parentPhone: "7894563210",
  applicationStatus: "pending",
};

beforeEach(() => {
  prisma.tmcTrip.findFirst.mockReset().mockResolvedValue(trip);
  prisma.tripParticipant.findFirst.mockReset().mockResolvedValue(participant);
  prisma.tripParticipant.findMany.mockReset().mockResolvedValue([participant]);
  prisma.tripInstalmentPayment.findFirst.mockReset().mockResolvedValue({ participantId: participant.id });
  prisma.emailVerificationOtp.create.mockReset().mockResolvedValue({ id: 1 });
});

describe("travel payment portal email verification", () => {
  test("accepts a non-approved participant and uses the selected installment to disambiguate shared email", async () => {
    const res = await request(makeApp())
      .post("/api/travel/payment-portal/request-otp")
      .send({
        tripId: 16,
        installmentId: 55,
        email: "  MANIK@GetAirMail.com ",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(prisma.tripInstalmentPayment.findFirst).toHaveBeenCalledWith({
      where: { id: 55, tripId: 16 },
      select: { participantId: true },
    });
    expect(prisma.tripParticipant.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 41,
        tripId: 16,
        parentEmail: "manik@getairmail.com",
      },
    }));
    expect(prisma.emailVerificationOtp.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        email: "manik@getairmail.com",
        purpose: "travel-payment-portal",
      }),
    }));
  });

  test("matches a single pending participant by email when no installment id is supplied", async () => {
    const res = await request(makeApp())
      .post("/api/travel/payment-portal/request-otp")
      .send({ tripId: 16, email: "manik@getairmail.com" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true });
    expect(prisma.tripParticipant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tripId: 16, parentEmail: "manik@getairmail.com" },
    }));
  });
});
