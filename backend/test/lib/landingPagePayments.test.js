const { createRequire } = require("module");

const requireCJS = createRequire(__filename);
const instalmentModule = requireCJS("../../lib/travelTripInstalments");
const originalMaterialize = instalmentModule.materializeTripInstalmentsFromPlan;
const materializeMock = vi.fn();
instalmentModule.materializeTripInstalmentsFromPlan = materializeMock;
const participantInvoiceModule = requireCJS("../../lib/tmcParticipantInvoice");
const originalCreateDraftInvoice = participantInvoiceModule.createDraftInvoiceForParticipant;
const createDraftInvoiceMock = vi.fn();
participantInvoiceModule.createDraftInvoiceForParticipant = createDraftInvoiceMock;

const {
  parseMoneyAmount,
  getLandingPagePaymentConfig,
  resolveLandingPagePaymentSelection,
  applyLandingPagePaymentToTrip,
  ensureLandingPagePaymentRegistration,
} = requireCJS("../../lib/landingPagePayments");

afterAll(() => {
  instalmentModule.materializeTripInstalmentsFromPlan = originalMaterialize;
  participantInvoiceModule.createDraftInvoiceForParticipant = originalCreateDraftInvoice;
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
    createDraftInvoiceMock.mockReset().mockResolvedValue(null);
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
      tmcTrip: { findFirst: vi.fn().mockResolvedValue(null) },
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

  test("treats a repeated hosted-payment callback as idempotent", async () => {
    const db = {
      tmcTrip: { findFirst: vi.fn().mockResolvedValue(null) },
      tripInstalmentPayment: {
        findMany: vi.fn().mockResolvedValue([
          { id: 21, instalmentIndex: 0, amount: 5000, paidAmount: 5000, status: "paid" },
        ]),
        update: vi.fn(),
      },
    };
    const result = await applyLandingPagePaymentToTrip({
      db, tripId: 7, participantId: 42, amountMajor: 5000,
      mode: "installment", installmentIndex: 0,
    });
    expect(db.tripInstalmentPayment.update).not.toHaveBeenCalled();
    expect(result.allocations[0]).toMatchObject({ paidMajor: 5000, appliedMajor: 0, status: "paid" });
  });

  test("treats a repeated complete payment after all installments are paid as idempotent", async () => {
    const participantUpdate = vi.fn();
    const db = {
      tmcTrip: { findFirst: vi.fn().mockResolvedValue(null) },
      tripParticipant: { update: participantUpdate },
      tripInstalmentPayment: {
        findMany: vi.fn().mockResolvedValue([
          { id: 22, instalmentIndex: 0, amount: 5000, paidAmount: 5000, status: "paid" },
          { id: 23, instalmentIndex: 1, amount: 5000, paidAmount: 5000, status: "paid" },
        ]),
        update: vi.fn(),
      },
    };

    const result = await applyLandingPagePaymentToTrip({
      db, tripId: 7, participantId: 42, amountMajor: 10000, mode: "complete",
    });

    expect(result.paidMajor).toBe(0);
    expect(db.tripInstalmentPayment.update).not.toHaveBeenCalled();
    expect(participantUpdate).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { applicationStatus: "approved" },
    });
  });

  test("matches an installment index serialized by gateway metadata", async () => {
    const rows = [
      { id: 31, instalmentIndex: 0, amount: 5000, paidAmount: 0, status: "pending" },
      { id: 32, instalmentIndex: 1, amount: 5000, paidAmount: 0, status: "pending" },
    ];
    const db = {
      tmcTrip: { findFirst: vi.fn().mockResolvedValue(null) },
      tripInstalmentPayment: {
        findMany: vi.fn().mockResolvedValue(rows),
        update: vi.fn().mockImplementation(async ({ where, data }) => ({ ...rows.find((row) => row.id === where.id), ...data })),
      },
    };

    await applyLandingPagePaymentToTrip({
      db, tripId: 7, participantId: 42, amountMajor: 5000,
      mode: "installment", installmentIndex: "1",
    });

    expect(db.tripInstalmentPayment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 32 } }));
  });

  test("recovers a stale installment index only when the unpaid amount is unambiguous", async () => {
    const rows = [
      { id: 33, instalmentIndex: 0, amount: 5000, paidAmount: 0, status: "pending" },
      { id: 34, instalmentIndex: 1, amount: 7000, paidAmount: 0, status: "pending" },
    ];
    const db = {
      tmcTrip: { findFirst: vi.fn().mockResolvedValue(null) },
      tripInstalmentPayment: {
        findMany: vi.fn().mockResolvedValue(rows),
        update: vi.fn().mockImplementation(async ({ where, data }) => ({ ...rows.find((row) => row.id === where.id), ...data })),
      },
    };

    const result = await applyLandingPagePaymentToTrip({
      db, tripId: 7, participantId: 42, amountMajor: 5000,
      mode: "installment", installmentIndex: 99,
    });

    expect(result.installmentIndex).toBe(0);
    expect(db.tripInstalmentPayment.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 33 } }));
  });

  test("stores a travel invoice link in payment metadata without reusing generic invoiceId", async () => {
    const rows = [
      { id: 41, instalmentIndex: 0, amount: 5000, paidAmount: 0, status: "pending" },
    ];
    createDraftInvoiceMock.mockResolvedValue({ id: 91, totalAmount: 5000 });
    const db = {
      tmcTrip: { findFirst: vi.fn().mockResolvedValue({ tenantId: 8 }) },
      payment: {
        findUnique: vi.fn().mockResolvedValue({ metadata: JSON.stringify({ kind: "landing-page-registration" }) }),
        update: vi.fn().mockResolvedValue({ id: 55 }),
      },
      travelInvoice: { update: vi.fn().mockResolvedValue({ id: 91, status: "Paid" }) },
      tripInstalmentPayment: {
        findMany: vi.fn()
          .mockResolvedValueOnce(rows)
          .mockResolvedValueOnce([{ paidAmount: 5000 }]),
        update: vi.fn().mockResolvedValue({ ...rows[0], paidAmount: 5000, status: "paid" }),
      },
    };

    await applyLandingPagePaymentToTrip({
      db,
      tripId: 7,
      participantId: 42,
      paymentId: 55,
      amountMajor: 5000,
      mode: "installment",
      installmentIndex: 0,
    });

    expect(createDraftInvoiceMock).toHaveBeenCalledWith({
      db,
      tenantId: 8,
      tripId: 7,
      participantId: 42,
    });
    const paymentData = db.payment.update.mock.calls[0][0].data;
    expect(paymentData).not.toHaveProperty("invoiceId");
    expect(JSON.parse(paymentData.metadata)).toMatchObject({
      travelInvoiceId: 91,
      tripId: 7,
      participantId: 42,
    });
  });

  test("converts a successful hosted registration into a participant and links the lead contact", async () => {
    const payment = {
      id: 501,
      metadata: JSON.stringify({
        kind: "landing-page-registration",
        tenantId: 8,
        tripId: 7,
        pageTitle: "Singapore 7 Days",
        draftToken: "draft-501",
        amountMajor: 170000,
        paymentMode: "complete",
      }),
    };
    const db = {
      tmcTrip: {
        findFirst: vi.fn().mockResolvedValue({ id: 7, tenantId: 8, destination: "Singapore", tripCode: "singapore-2027" }),
      },
      pendingTripRegistration: {
        findUnique: vi.fn().mockResolvedValue({
          id: 91,
          tenantId: 8,
          tripId: 7,
          landingPageId: 51,
          studentName: "Yamuna Roy",
          studentSchool: "Modern School",
          studentClass: "8",
          parentName: "Ravi Roy",
          parentEmail: "parent@example.com",
          parentPhone: "+919876543210",
          passportNumber: "P1234567",
          status: "DRAFT",
          convertedToParticipantId: null,
        }),
        update: vi.fn().mockResolvedValue({ id: 91, status: "CONVERTED", convertedToParticipantId: 77 }),
      },
      tripParticipant: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({
          id: 77,
          tripId: 7,
          fullName: "Yamuna Roy",
          parentName: "Ravi Roy",
          parentEmail: "parent@example.com",
          parentPhone: "+919876543210",
        }),
      },
      contact: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 88, name: "Ravi Roy", email: "parent@example.com" }),
      },
      deal: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 99 }),
      },
      payment: {
        update: vi.fn().mockImplementation(async ({ data }) => ({
          ...payment,
          ...data,
        })),
      },
    };
    db.$queryRawUnsafe = vi.fn().mockResolvedValue([{ id: 91 }]);
    db.$transaction = vi.fn(async (callback) => callback(db));

    const result = await ensureLandingPagePaymentRegistration({ db, payment, tenantId: 8 });

    expect(result).toMatchObject({ participantId: 77, contactId: 88 });
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      "SELECT id FROM `PendingTripRegistration` WHERE id = ? FOR UPDATE",
      91,
    );
    expect(db.tripParticipant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tripId: 7,
        fullName: "Yamuna Roy",
        parentName: "Ravi Roy",
        parentEmail: "parent@example.com",
        passportNumber: "P1234567",
        applicationStatus: "approved",
      }),
    }));
    expect(db.tripParticipant.create.mock.calls[0][0].data).not.toHaveProperty("passportNationality");
    expect(db.tripParticipant.create.mock.calls[0][0].data).not.toHaveProperty("passportPlaceOfIssue");
    expect(db.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        tenantId: 8,
        name: "Ravi Roy",
        email: "parent@example.com",
        status: "Lead",
      }),
    }));
    expect(db.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 91 },
      data: expect.objectContaining({ status: "CONVERTED", convertedToParticipantId: 77 }),
    });
    expect(db.payment.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: expect.objectContaining({ contactId: 88, metadata: expect.any(String) }),
    });
    expect(JSON.parse(db.payment.update.mock.calls[0][0].data.metadata)).toMatchObject({
      participantId: 77,
      contactId: 88,
      registrationLinkedAt: expect.any(String),
    });
  });

  test("keeps payment reconciliation successful when another draft already owns the participant link", async () => {
    const payment = {
      id: 502,
      metadata: JSON.stringify({
        kind: "landing-page-registration",
        tenantId: 8,
        tripId: 7,
        draftToken: "duplicate-draft",
        participantId: 77,
      }),
    };
    const db = {
      tmcTrip: {
        findFirst: vi.fn().mockResolvedValue({ id: 7, tenantId: 8, destination: "Singapore", tripCode: "singapore-2027" }),
      },
      pendingTripRegistration: {
        findUnique: vi.fn().mockResolvedValue({
          id: 92,
          tenantId: 8,
          tripId: 7,
          studentName: "Yamuna Roy",
          parentName: "Ravi Roy",
          parentEmail: "parent@example.com",
          parentPhone: "+919876543210",
          convertedToParticipantId: null,
        }),
        findFirst: vi.fn().mockResolvedValue({
          id: 91,
          status: "CONVERTED",
          convertedToParticipantId: 77,
        }),
        update: vi.fn().mockResolvedValue({ id: 92, status: "REJECTED" }),
      },
      tripParticipant: {
        findFirst: vi.fn().mockResolvedValue({
          id: 77,
          tripId: 7,
          fullName: "Yamuna Roy",
          parentName: "Ravi Roy",
          parentEmail: "parent@example.com",
          parentPhone: "+919876543210",
          applicationStatus: "approved",
        }),
        create: vi.fn(),
      },
      contact: {
        findFirst: vi.fn().mockResolvedValue({ id: 88, name: "Ravi Roy", email: "parent@example.com" }),
      },
      deal: {
        findFirst: vi.fn().mockResolvedValue({ id: 99 }),
        create: vi.fn(),
      },
      payment: {
        update: vi.fn().mockImplementation(async ({ data }) => ({ ...payment, ...data })),
      },
    };

    const result = await ensureLandingPagePaymentRegistration({ db, payment, tenantId: 8 });

    expect(result).toMatchObject({ participantId: 77, contactId: 88 });
    expect(db.pendingTripRegistration.update).toHaveBeenCalledWith({
      where: { id: 92 },
      data: {
        status: "REJECTED",
        reviewNotes: "Duplicate registration; participant #77 is already linked to another registration.",
      },
    });
    expect(db.payment.update).toHaveBeenCalled();
  });
});
