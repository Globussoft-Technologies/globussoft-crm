const { createRequire } = require("module");

const requireCJS = createRequire(__filename);
const {
  reconcileTripInstalmentPayment,
  reconcileTripPaymentRecord,
} = requireCJS("../../lib/tripPaymentReconciliation");

describe("trip payment reconciliation", () => {
  test("updates the installment cumulatively without itinerary linkage", async () => {
    const db = {
      tripInstalmentPayment: {
        update: vi.fn().mockResolvedValue({ id: 11, status: "paid", paidAmount: 10000 }),
        findMany: vi.fn().mockResolvedValue([{ amount: 10000, paidAmount: 10000, status: "paid" }]),
      },
      tripParticipant: {
        findFirst: vi.fn().mockResolvedValue({ parentEmail: "parent@example.com" }),
      },
      itinerary: {
        findFirst: vi.fn().mockResolvedValue({ id: 91 }),
        update: vi.fn().mockResolvedValue({ id: 91, status: "advance_paid", advancePaidAmount: 10000 }),
      },
    };

    await reconcileTripInstalmentPayment({
      db,
      instalment: { id: 11, participantId: 7, amount: 10000, paidAmount: 0, status: "pending" },
      amountMajor: 10000,
      tenantId: 3,
    });

    expect(db.tripInstalmentPayment.update).toHaveBeenCalledWith({
      where: { id: 11 },
      data: expect.objectContaining({ status: "paid", paidAmount: 10000 }),
    });
    expect(db.itinerary.update).not.toHaveBeenCalled();
  });

  test("adds a second payment instead of replacing the previous amount", async () => {
    const db = {
      tripInstalmentPayment: {
        update: vi.fn().mockResolvedValue({ id: 12, status: "paid", paidAmount: 10000 }),
        findMany: vi.fn().mockResolvedValue([{ amount: 10000, paidAmount: 10000, status: "paid" }]),
      },
      tripParticipant: { findFirst: vi.fn().mockResolvedValue(null) },
      itinerary: { findFirst: vi.fn(), update: vi.fn() },
    };

    await reconcileTripInstalmentPayment({
      db,
      instalment: { id: 12, participantId: 8, amount: 10000, paidAmount: 4000, status: "partial" },
      amountMajor: 6000,
      tenantId: 3,
    });

    expect(db.tripInstalmentPayment.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: expect.objectContaining({ status: "paid", paidAmount: 10000 }),
    });
  });

  test("recovers a captured hosted-link payment when the webhook is delayed", async () => {
    const db = {
      payment: {
        update: vi.fn().mockResolvedValue({
          id: 90,
          amount: 5000,
          status: "SUCCESS",
          paidAt: new Date("2026-08-31T10:00:00Z"),
          metadata: JSON.stringify({
            kind: "tmc-instalment",
            tripId: 21,
            participantId: 31,
            instalmentId: 41,
            plinkId: "plink_90",
          }),
        }),
      },
      tripInstalmentPayment: {
        findFirst: vi.fn().mockResolvedValue({
          id: 41,
          tripId: 21,
          participantId: 31,
          amount: 5000,
          paidAmount: 0,
          status: "pending",
        }),
        update: vi.fn().mockResolvedValue({ id: 41, amount: 5000, paidAmount: 5000, status: "paid" }),
      },
    };
    const gateway = {
      client: {
        paymentLink: {
          fetch: vi.fn().mockResolvedValue({ status: "PAID", updated_at: 1788170400 }),
        },
      },
    };

    await reconcileTripPaymentRecord({
      db,
      payment: {
        id: 90,
        amount: 5000,
        gateway: "razorpay",
        status: "PENDING",
        metadata: JSON.stringify({
          kind: "tmc-instalment",
          tripId: 21,
          participantId: 31,
          instalmentId: 41,
          plinkId: "plink_90",
        }),
      },
      gateway,
    });

    expect(gateway.client.paymentLink.fetch).toHaveBeenCalledWith("plink_90");
    expect(db.payment.update).toHaveBeenCalledWith({
      where: { id: 90 },
      data: expect.objectContaining({ status: "SUCCESS", paidAt: expect.any(Date) }),
    });
    expect(db.tripInstalmentPayment.update).toHaveBeenCalledWith({
      where: { id: 41 },
      data: expect.objectContaining({ status: "paid", paidAmount: 5000 }),
    });
  });
});
