import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
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
  update: vi.fn(),
  updateMany: vi.fn(),
};
prisma.payment = {
  ...(prisma.payment || {}),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
};
prisma.emailVerificationOtp = {
  ...(prisma.emailVerificationOtp || {}),
  create: vi.fn(),
};

import express from "express";
import request from "supertest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const gatewayModule = requireCJS("../../lib/tenantPaymentGateway");
const originalGetTenantRazorpayClient = gatewayModule.getTenantRazorpayClient;
const getTenantRazorpayClientMock = vi.fn();
gatewayModule.getTenantRazorpayClient = getTenantRazorpayClientMock;
const paymentPortalRouter = requireCJS("../../routes/travel_payment_portal");
const { mintPaymentPortalToken } = requireCJS("../../lib/travelPaymentPortalToken");

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
  prisma.tripInstalmentPayment.update.mockReset().mockResolvedValue({});
  prisma.tripInstalmentPayment.updateMany.mockReset().mockResolvedValue({ count: 1 });
  prisma.payment.findMany.mockReset().mockResolvedValue([]);
  prisma.emailVerificationOtp.create.mockReset().mockResolvedValue({ id: 1 });
  getTenantRazorpayClientMock.mockReset().mockResolvedValue({
    keyId: "rzp_test_key",
    client: { orders: { create: vi.fn() } },
  });
});

afterAll(() => {
  gatewayModule.getTenantRazorpayClient = originalGetTenantRazorpayClient;
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

  test("blocks a second Razorpay order when the installment is fully paid by amount", async () => {
    const token = mintPaymentPortalToken({
      tenantId: trip.tenantId,
      tripId: trip.id,
      participantId: participant.id,
      email: participant.parentEmail,
      installmentId: 55,
    });
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 55,
      tripId: trip.id,
      participantId: participant.id,
      amount: 70000,
      paidAmount: 70000,
      status: "partial",
    });

    const res = await request(makeApp())
      .post("/api/travel/payment-portal/create-order")
      .send({ token, installmentId: 55 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "ALREADY_PAID" });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  test("atomically rejects a concurrent order request for the same installment", async () => {
    const token = mintPaymentPortalToken({
      tenantId: trip.tenantId,
      tripId: trip.id,
      participantId: participant.id,
      email: participant.parentEmail,
      installmentId: 55,
    });
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({
      id: 55,
      tripId: trip.id,
      participantId: participant.id,
      instalmentIndex: 0,
      amount: 70000,
      paidAmount: 0,
      status: "pending",
      paymentLinkUrl: null,
    });
    prisma.tripInstalmentPayment.updateMany.mockResolvedValueOnce({ count: 0 });

    const res = await request(makeApp())
      .post("/api/travel/payment-portal/create-order")
      .send({ token, installmentId: 55 });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "PAYMENT_IN_PROGRESS" });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });
});
