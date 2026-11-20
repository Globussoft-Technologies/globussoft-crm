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
  update: vi.fn(),
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
const originalGetTenantRazorpayCreds = gatewayModule.getTenantRazorpayCreds;
const getTenantRazorpayClientMock = vi.fn();
const getTenantRazorpayCredsMock = vi.fn();
gatewayModule.getTenantRazorpayClient = getTenantRazorpayClientMock;
gatewayModule.getTenantRazorpayCreds = getTenantRazorpayCredsMock;
const reconciliationModule = requireCJS("../../lib/tripPaymentReconciliation");
const originalReconcileTripInstalmentPayment = reconciliationModule.reconcileTripInstalmentPayment;
const reconcileTripInstalmentPaymentMock = vi.fn();
reconciliationModule.reconcileTripInstalmentPayment = reconcileTripInstalmentPaymentMock;
const eventBusModule = requireCJS("../../lib/eventBus");
const originalSafeEmitEvent = eventBusModule.safeEmitEvent;
const safeEmitEventMock = vi.fn();
eventBusModule.safeEmitEvent = safeEmitEventMock;
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
  prisma.payment.update.mockReset();
  prisma.emailVerificationOtp.create.mockReset().mockResolvedValue({ id: 1 });
  getTenantRazorpayClientMock.mockReset().mockResolvedValue({
    keyId: "rzp_test_key",
    client: { orders: { create: vi.fn() } },
  });
  getTenantRazorpayCredsMock.mockReset().mockResolvedValue({ keySecret: "test-secret" });
  reconcileTripInstalmentPaymentMock.mockReset().mockResolvedValue({ id: 55, status: "paid" });
  safeEmitEventMock.mockReset();
});

afterAll(() => {
  gatewayModule.getTenantRazorpayClient = originalGetTenantRazorpayClient;
  gatewayModule.getTenantRazorpayCreds = originalGetTenantRazorpayCreds;
  reconciliationModule.reconcileTripInstalmentPayment = originalReconcileTripInstalmentPayment;
  eventBusModule.safeEmitEvent = originalSafeEmitEvent;
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

  test("confirmed parent-portal payment emits payment.collected with the parent recipient", async () => {
    const token = mintPaymentPortalToken({
      tenantId: trip.tenantId,
      tripId: trip.id,
      participantId: participant.id,
      email: participant.parentEmail,
      installmentId: 55,
    });
    const payment = {
      id: 901,
      tenantId: trip.tenantId,
      contactId: 77,
      amount: 25000,
      currency: "INR",
      gateway: "razorpay",
      gatewayId: "order_123",
      status: "PENDING",
      metadata: JSON.stringify({ instalmentId: 55, orderId: "order_123" }),
    };
    prisma.payment.findFirst.mockResolvedValue(payment);
    prisma.payment.update.mockImplementation(async ({ data }) => ({ ...payment, ...data }));
    prisma.tripInstalmentPayment.findFirst.mockResolvedValue({ id: 55, tripId: trip.id, participantId: participant.id });
    const razorpayPaymentId = "pay_123";
    const signature = requireCJS("node:crypto")
      .createHmac("sha256", "test-secret")
      .update(`order_123|${razorpayPaymentId}`)
      .digest("hex");

    const res = await request(makeApp())
      .post("/api/travel/payment-portal/confirm-razorpay")
      .send({
        token,
        razorpay_order_id: "order_123",
        razorpay_payment_id: razorpayPaymentId,
        razorpay_signature: signature,
      });

    expect(res.status).toBe(200);
    expect(safeEmitEventMock).toHaveBeenCalledWith(
      "payment.collected",
      expect.objectContaining({
        paymentId: 901,
        contactId: 77,
        recipientEmail: participant.parentEmail,
        recipientName: participant.parentName,
        subBrand: "tmc",
        amount: 25000,
        payment: expect.objectContaining({
          amount: "INR 25,000.00",
          installment: "Installment 1",
          method: "Razorpay",
          reference: razorpayPaymentId,
        }),
      }),
      trip.tenantId,
      "travel-payment-portal/confirm-razorpay",
    );
  });
});
