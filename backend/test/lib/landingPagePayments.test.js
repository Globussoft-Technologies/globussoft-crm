const { createRequire } = require("module");

const requireCJS = createRequire(__filename);
const instalmentModule = requireCJS("../../lib/travelTripInstalments");
const originalMaterialize = instalmentModule.materializeTripInstalmentsFromPlan;
const materializeMock = vi.fn();
instalmentModule.materializeTripInstalmentsFromPlan = materializeMock;

const {
  parseMoneyAmount,
  getLandingPagePaymentConfig,
  resolveLandingPagePaymentSelection,
  applyLandingPagePaymentToTrip,
} = requireCJS("../../lib/landingPagePayments");

afterAll(() => {
  instalmentModule.materializeTripInstalmentsFromPlan = originalMaterialize;
});

function paymentPage(overrides = {}) {
  return {
    content: JSON.stringify({
      investment: {
        installments: [
          { tag: "Booking fee", title: "Booking fee", amount: "4,500" },
          { tag: "Final payment", title: "Final payment", amount: "5,000" },
        ],
        payment: {
          enabled: true,
          defaultMode: "installment",
          allowCompletePayment: true,
          ...overrides,
        },
      },
    }),
  };
}

describe("landingPagePayments", () => {
  beforeEach(() => {
    materializeMock.mockReset();
  });

  test("parses formatted money values safely", () => {
    expect(parseMoneyAmount(null)).toBeNull();
    expect(parseMoneyAmount("₹18,750.50")).toBe(18750.5);
    expect(parseMoneyAmount("1,200")).toBe(1200);
    expect(parseMoneyAmount("not money")).toBeNull();
  });

  test("resolves a selected installment and complete payment", () => {
    const page = paymentPage();

    const installment = resolveLandingPagePaymentSelection(page, {
      mode: "installment",
      installmentIndex: 1,
    });
    expect(installment).toMatchObject({
      mode: "installment",
      installmentIndex: 1,
      installmentIndexes: [1],
      amountMajor: 5000,
      amountPaise: 500000,
      paymentTitle: "Final payment",
    });

    const complete = resolveLandingPagePaymentSelection(page, { mode: "complete" });
    expect(complete).toMatchObject({
      mode: "complete",
      installmentIndexes: [0, 1],
      amountMajor: 9500,
      amountPaise: 950000,
      paymentTitle: "Complete payment",
    });
  });

  test("allocates a complete payment across outstanding participant installments", async () => {
    const updates = [];
    const rows = [
      { id: 11, instalmentIndex: 0, amount: 1000, paidAmount: 1000, status: "paid" },
      { id: 12, instalmentIndex: 1, amount: 3000, paidAmount: 500, status: "partial" },
      { id: 13, instalmentIndex: 2, amount: 2500, paidAmount: 0, status: "pending" },
    ];
    const db = {
      tripInstalmentPayment: {
        findMany: vi.fn().mockResolvedValue(rows),
        update: vi.fn().mockImplementation(async ({ where, data }) => {
          const row = rows.find((item) => item.id === where.id);
          const updated = { ...row, ...data };
          updates.push(updated);
          return updated;
        }),
      },
    };

    const result = await applyLandingPagePaymentToTrip({
      db,
      tripId: 7,
      participantId: 42,
      amountMajor: 5000,
      mode: "complete",
      capturedAt: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(materializeMock).toHaveBeenCalledWith({
      db,
      tripId: 7,
      participantIds: [42],
    });
    expect(db.tripInstalmentPayment.findMany).toHaveBeenCalledWith({
      where: { tripId: 7, participantId: 42 },
      orderBy: { instalmentIndex: "asc" },
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ id: 12, paidAmount: 3000, status: "paid" });
    expect(updates[1]).toMatchObject({ id: 13, paidAmount: 2500, status: "paid" });
    expect(result).toMatchObject({
      tripId: 7,
      participantId: 42,
      paidMajor: 5000,
      mode: "complete",
    });
    expect(result.allocations.map((item) => item.appliedMajor)).toEqual([2500, 2500]);
  });
});
