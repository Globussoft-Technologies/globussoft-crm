const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { sendEmail } = require("../lib/emailSender");
const { getTenantRazorpayClient, getTenantRazorpayCreds, NOT_CONFIGURED_MESSAGE } = require("../lib/tenantPaymentGateway");
const { mintPaymentPortalToken, verifyPaymentPortalToken } = require("../lib/travelPaymentPortalToken");

const router = express.Router();

const OTP_PURPOSE = "travel-payment-portal";
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
function bankTransferDetails() {
  return {
    accountName: process.env.TRAVEL_BANK_ACCOUNT_NAME || "Globussoft Travel",
    bankName: process.env.TRAVEL_BANK_NAME || "Bank transfer details will be shared by the travel advisor",
    accountNumber: process.env.TRAVEL_BANK_ACCOUNT_NUMBER || "Contact advisor",
    ifsc: process.env.TRAVEL_BANK_IFSC || "Contact advisor",
    upiId: process.env.TRAVEL_UPI_ID || "",
  };
}


function normaliseEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateOtpCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

async function loadTrip(tripId) {
  const trip = await prisma.tmcTrip.findFirst({
    where: { id: tripId },
    select: {
      id: true,
      tenantId: true,
      tripCode: true,
      destination: true,
      departDate: true,
      returnDate: true,
      status: true,
    },
  });
  if (!trip) {
    const err = new Error("Trip not found");
    err.status = 404;
    err.code = "TRIP_NOT_FOUND";
    throw err;
  }
  return trip;
}

async function loadParticipant(tripId, participantId) {
  const participant = await prisma.tripParticipant.findFirst({
    where: { id: participantId, tripId },
    select: {
      id: true,
      tripId: true,
      fullName: true,
      parentName: true,
      parentEmail: true,
      parentPhone: true,
      applicationStatus: true,
    },
  });
  if (!participant) {
    const err = new Error("Participant not found");
    err.status = 404;
    err.code = "PARTICIPANT_NOT_FOUND";
    throw err;
  }
  return participant;
}

async function loadInstalments(tripId, participantId) {
  return prisma.tripInstalmentPayment.findMany({
    where: { tripId, participantId },
    orderBy: { instalmentIndex: "asc" },
    select: {
      id: true,
      tripId: true,
      participantId: true,
      instalmentIndex: true,
      dueDate: true,
      amount: true,
      paidAmount: true,
      paidAt: true,
      status: true,
      invoiceId: true,
      paymentLinkUrl: true,
      paymentLinkGeneratedAt: true,
    },
  });
}

async function resolveParticipantByEmail(tripId, email) {
  const em = normaliseEmail(email);
  const participants = await prisma.tripParticipant.findMany({
    where: {
      tripId,
      parentEmail: em,
      applicationStatus: "approved",
    },
    select: {
      id: true,
      tripId: true,
      fullName: true,
      parentName: true,
      parentEmail: true,
      parentPhone: true,
      applicationStatus: true,
    },
  });
  if (participants.length === 0) {
    const err = new Error("Participant not found for this email");
    err.status = 404;
    err.code = "PARTICIPANT_NOT_FOUND";
    throw err;
  }
  if (participants.length > 1) {
    const err = new Error("More than one approved participant uses this email");
    err.status = 409;
    err.code = "AMBIGUOUS_PARTICIPANT";
    throw err;
  }
  return participants[0];
}

async function sendOtpEmail({ to, code, trip, participant }) {
  const subject = `Your payment portal verification code for ${trip.tripCode || trip.destination || "trip"}`;
  const text = [
    `Hello ${participant.parentName || participant.fullName || "there"},`,
    "",
    `Your payment portal verification code is ${code}.`,
    "This code expires in 10 minutes.",
    "",
    `Trip: ${trip.tripCode || trip.destination || "Travel payment"}`,
    "",
    "If you did not request this code, please ignore this email.",
  ].join("\n");
  await sendEmail({
    to,
    subject,
    text,
    html: text.replace(/\n/g, "<br>"),
  });
}

async function createPortalOtp({ email, trip, participant }) {
  const code = generateOtpCode();
  const otpHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS);
  await prisma.emailVerificationOtp.create({
    data: {
      email: normaliseEmail(email),
      purpose: OTP_PURPOSE,
      otpHash,
      expiresAt,
      attempts: 0,
    },
  });
  await sendOtpEmail({ to: normaliseEmail(email), code, trip, participant });
  return { sent: true };
}

async function verifyPortalOtp({ email, code }) {
  const otp = await prisma.emailVerificationOtp.findFirst({
    where: { email: normaliseEmail(email), purpose: OTP_PURPOSE },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) {
    const err = new Error("Invalid or expired code");
    err.status = 401;
    err.code = "OTP_INVALID";
    throw err;
  }
  if (otp.usedAt) {
    const err = new Error("Code already used");
    err.status = 409;
    err.code = "OTP_USED";
    throw err;
  }
  if (otp.expiresAt && new Date(otp.expiresAt) < new Date()) {
    const err = new Error("Code expired");
    err.status = 410;
    err.code = "OTP_EXPIRED";
    throw err;
  }
  if (otp.attempts >= OTP_MAX_ATTEMPTS) {
    const err = new Error("Too many invalid attempts");
    err.status = 429;
    err.code = "OTP_LOCKED";
    throw err;
  }
  const match = await bcrypt.compare(String(code || ""), otp.otpHash);
  if (!match) {
    await prisma.emailVerificationOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    const err = new Error("Invalid code");
    err.status = 401;
    err.code = "OTP_INVALID";
    throw err;
  }
  await prisma.emailVerificationOtp.update({
    where: { id: otp.id },
    data: { usedAt: new Date() },
  });
}

async function reconcilePaidInstalment({ trip, participant, instalment, payment, capturedAt }) {
  const amountPaid = Number(payment?.amount || instalment.amount);
  const dueAmount = Number(instalment.amount) - Number(instalment.paidAmount || 0);
  const paidAmount = Number.isFinite(amountPaid) && amountPaid > 0 ? amountPaid : Math.max(dueAmount, 0);
  const newStatus = paidAmount >= Number(dueAmount || instalment.amount) ? "paid" : "partial";

  const updated = await prisma.tripInstalmentPayment.update({
    where: { id: instalment.id },
    data: {
      status: newStatus,
      paidAmount,
      paidAt: capturedAt || new Date(),
    },
  });

  try {
    const parentEmail = participant?.parentEmail || null;
    if (parentEmail) {
      const itinerary = await prisma.itinerary.findFirst({
        where: {
          tenantId: trip.tenantId,
          contact: { email: parentEmail },
        },
        select: { id: true, advancePaidAmount: true },
      });
      if (itinerary) {
        const paidRows = await prisma.tripInstalmentPayment.findMany({
          where: { participantId: participant.id, status: "paid" },
          select: { paidAmount: true, amount: true },
        });
        const totalPaid = paidRows.reduce(
          (sum, row) => sum + (Number(row.paidAmount) || Number(row.amount) || 0),
          0,
        );
        await prisma.itinerary.update({
          where: { id: itinerary.id },
          data: {
            status: "advance_paid",
            advancePaidAmount: totalPaid,
          },
        });
      }
    }
  } catch (_err) {
    // Non-fatal: the payment record itself is the source of truth.
  }

  return updated;
}

router.get("/payment-portal/session/:token", async (req, res) => {
  try {
    const claims = verifyPaymentPortalToken(req.params.token);
    const trip = await loadTrip(claims.tripId);
    if (trip.tenantId !== claims.tenantId) {
      return res.status(403).json({ error: "Token scoped to a different tenant", code: "TOKEN_SCOPE" });
    }
    const participant = await loadParticipant(trip.id, claims.participantId);
    const instalments = await loadInstalments(trip.id, participant.id);
    res.json({
      token: req.params.token,
      trip,
      participant,
      selectedInstalmentId: claims.installmentId,
      instalments,
      bankTransfer: bankTransferDetails(),
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(410).json({ error: "Payment portal link expired", code: "TOKEN_EXPIRED" });
    }
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] resolve session error:", err.message);
    res.status(500).json({ error: "Failed to load payment portal" });
  }
});

router.post("/payment-portal/request-otp", async (req, res) => {
  try {
    const tripId = parseInt(req.body?.tripId, 10);
    const email = normaliseEmail(req.body?.email);
    if (!Number.isFinite(tripId)) {
      return res.status(400).json({ error: "tripId must be a number", code: "INVALID_TRIP_ID" });
    }
    if (!email) {
      return res.status(400).json({ error: "email is required", code: "MISSING_FIELDS" });
    }
    const trip = await loadTrip(tripId);
    const participant = await resolveParticipantByEmail(trip.id, email);
    await createPortalOtp({ email, trip, participant });
    res.json({ sent: true });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] request-otp error:", err.message);
    res.status(500).json({ error: "Failed to send verification code" });
  }
});

router.post("/payment-portal/verify-otp", async (req, res) => {
  try {
    const tripId = parseInt(req.body?.tripId, 10);
    const email = normaliseEmail(req.body?.email);
    const code = String(req.body?.code || "").trim();
    const installmentId = Number.isFinite(Number(req.body?.installmentId)) ? Number(req.body.installmentId) : null;
    if (!Number.isFinite(tripId)) {
      return res.status(400).json({ error: "tripId must be a number", code: "INVALID_TRIP_ID" });
    }
    if (!email || !code) {
      return res.status(400).json({ error: "email and code are required", code: "MISSING_FIELDS" });
    }
    const trip = await loadTrip(tripId);
    await verifyPortalOtp({ email, code });
    const participant = await resolveParticipantByEmail(trip.id, email);
    const sessionToken = mintPaymentPortalToken({
      tenantId: trip.tenantId,
      tripId: trip.id,
      participantId: participant.id,
      email,
      installmentId,
      expiresInDays: 30,
    });
    const instalments = await loadInstalments(trip.id, participant.id);
    res.json({
      token: sessionToken,
      trip,
      participant,
      selectedInstalmentId: installmentId,
      instalments,
      bankTransfer: bankTransferDetails(),
    });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] verify-otp error:", err.message);
    res.status(500).json({ error: "Failed to verify code" });
  }
});

router.post("/payment-portal/create-order", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    const installmentId = parseInt(req.body?.installmentId, 10);
    if (!token) {
      return res.status(400).json({ error: "token is required", code: "MISSING_FIELDS" });
    }
    if (!Number.isFinite(installmentId)) {
      return res.status(400).json({ error: "installmentId must be a number", code: "INVALID_ID" });
    }
    const claims = verifyPaymentPortalToken(token);
    const trip = await loadTrip(claims.tripId);
    const participant = await loadParticipant(trip.id, claims.participantId);
    const instalment = await prisma.tripInstalmentPayment.findFirst({
      where: { id: installmentId, tripId: trip.id, participantId: participant.id },
    });
    if (!instalment) {
      return res.status(404).json({ error: "Instalment not found", code: "NOT_FOUND" });
    }
    if (instalment.status === "paid") {
      return res.status(409).json({ error: "This instalment is already paid", code: "ALREADY_PAID" });
    }
    const amountDue = Math.max(0, Number(instalment.amount) - Number(instalment.paidAmount || 0));
    if (!amountDue || amountDue <= 0) {
      return res.status(400).json({ error: "Instalment amount must be greater than zero", code: "INVALID_AMOUNT" });
    }
    const rp = await getTenantRazorpayClient(trip.tenantId);
    if (!rp) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const receipt = `trip_${trip.id}_p_${participant.id}_i_${instalment.id}_${Date.now()}`;
    const notes = {
      tenantId: String(trip.tenantId),
      kind: "travel-trip-installment",
      tripId: String(trip.id),
      participantId: String(participant.id),
      instalmentId: String(instalment.id),
    };
    const order = await rp.client.orders.create({
      amount: Math.round(amountDue * 100),
      currency: "INR",
      receipt,
      notes,
    });
    const payment = await prisma.payment.create({
      data: {
        tenantId: trip.tenantId,
        invoiceId: null,
        contactId: null,
        description: `${trip.tripCode || "Trip"} instalment #${instalment.instalmentIndex + 1} payment`,
        amount: amountDue,
        currency: "INR",
        gateway: "razorpay",
        gatewayId: order.id,
        status: "PENDING",
        metadata: JSON.stringify({
          kind: "travel-trip-installment",
          tripId: trip.id,
          participantId: participant.id,
          instalmentId: instalment.id,
          amountDue,
          receipt,
          orderId: order.id,
        }),
      },
    });
    res.json({
      orderId: order.id,
      amount: Math.round(amountDue * 100),
      currency: order.currency || "INR",
      keyId: rp.keyId,
      paymentId: payment.id,
      receipt,
      trip: {
        id: trip.id,
        tripCode: trip.tripCode,
        destination: trip.destination,
      },
      participant: {
        id: participant.id,
        fullName: participant.fullName,
      },
      instalment: {
        id: instalment.id,
        instalmentIndex: instalment.instalmentIndex,
        dueDate: instalment.dueDate,
        amount: instalment.amount,
        paidAmount: instalment.paidAmount,
        status: instalment.status,
      },
    });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] create-order error:", err.message);
    res.status(500).json({ error: "Failed to create payment order" });
  }
});


router.post("/payment-portal/submit-bank-transfer", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    const installmentId = parseInt(req.body?.installmentId, 10);
    const proofReference = String(req.body?.proofReference || "").trim().slice(0, 500);
    const proofFileName = String(req.body?.proofFileName || "").trim().slice(0, 255);
    if (!token || !Number.isFinite(installmentId)) {
      return res.status(400).json({ error: "token and installmentId are required", code: "MISSING_FIELDS" });
    }
    if (!proofReference && !proofFileName) {
      return res.status(400).json({ error: "Payment proof reference is required", code: "MISSING_PROOF" });
    }
    const claims = verifyPaymentPortalToken(token);
    const trip = await loadTrip(claims.tripId);
    const participant = await loadParticipant(trip.id, claims.participantId);
    const instalment = await prisma.tripInstalmentPayment.findFirst({
      where: { id: installmentId, tripId: trip.id, participantId: participant.id },
    });
    if (!instalment) return res.status(404).json({ error: "Instalment not found", code: "NOT_FOUND" });
    if (instalment.status === "paid") return res.status(409).json({ error: "This instalment is already paid", code: "ALREADY_PAID" });
    if (instalment.status === "pending_verification") {
      return res.status(409).json({ error: "Bank transfer proof is already pending verification", code: "PENDING_VERIFICATION" });
    }
    const amountDue = Math.max(0, Number(instalment.amount) - Number(instalment.paidAmount || 0));
    const payment = await prisma.payment.create({
      data: {
        tenantId: trip.tenantId,
        invoiceId: null,
        contactId: null,
        description: `${trip.tripCode || "Trip"} instalment #${instalment.instalmentIndex + 1} bank transfer proof`,
        amount: amountDue,
        currency: "INR",
        gateway: "manual_bank_transfer",
        gatewayId: proofReference || proofFileName || null,
        status: "PENDING",
        metadata: JSON.stringify({
          kind: "travel-trip-installment-bank-transfer",
          tripId: trip.id,
          participantId: participant.id,
          instalmentId: instalment.id,
          amountDue,
          proofReference,
          proofFileName,
          submittedAt: new Date().toISOString(),
        }),
      },
    });
    const updatedInstalment = await prisma.tripInstalmentPayment.update({
      where: { id: instalment.id },
      data: { status: "pending_verification" },
    });
    res.json({ success: true, payment, instalment: updatedInstalment });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] submit-bank-transfer error:", err.message);
    res.status(500).json({ error: "Failed to submit bank transfer proof" });
  }
});
router.post("/payment-portal/confirm-razorpay", async (req, res) => {
  try {
    const token = String(req.body?.token || "");
    const razorpayOrderId = String(req.body?.razorpay_order_id || "");
    const razorpayPaymentId = String(req.body?.razorpay_payment_id || "");
    const razorpaySignature = String(req.body?.razorpay_signature || "");
    if (!token || !razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: "Missing required fields", code: "MISSING_FIELDS" });
    }
    const claims = verifyPaymentPortalToken(token);
    const trip = await loadTrip(claims.tripId);
    const participant = await loadParticipant(trip.id, claims.participantId);
    const payment = await prisma.payment.findFirst({
      where: {
        tenantId: trip.tenantId,
        gateway: "razorpay",
        gatewayId: razorpayOrderId,
      },
    });
    if (!payment) {
      return res.status(404).json({ error: "Payment not found", code: "NOT_FOUND" });
    }
    const creds = await getTenantRazorpayCreds(trip.tenantId);
    const secret = creds && creds.keySecret;
    if (!secret) {
      return res.status(503).json({ error: NOT_CONFIGURED_MESSAGE, code: "GATEWAY_NOT_CONFIGURED" });
    }
    const expected = crypto.createHmac("sha256", secret).update(`${razorpayOrderId}|${razorpayPaymentId}`).digest("hex");
    if (expected !== razorpaySignature) {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: "FAILED" },
      });
      return res.status(400).json({ error: "Signature verification failed", code: "INVALID_SIGNATURE" });
    }

    const paymentMeta = (() => {
      try { return JSON.parse(payment.metadata || "{}"); } catch { return {}; }
    })();
    const instalmentId = Number.isFinite(Number(paymentMeta.instalmentId)) ? Number(paymentMeta.instalmentId) : null;
    const instalment = instalmentId
      ? await prisma.tripInstalmentPayment.findFirst({
          where: { id: instalmentId, tripId: trip.id, participantId: participant.id },
        })
      : null;
    if (!instalment) {
      return res.status(404).json({ error: "Instalment not found", code: "NOT_FOUND" });
    }

    const capturedAt = new Date();
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: "SUCCESS",
        paidAt: capturedAt,
        gatewayId: razorpayPaymentId,
        metadata: JSON.stringify({
          ...paymentMeta,
          verifiedAt: capturedAt.toISOString(),
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id: razorpayPaymentId,
        }),
      },
    });
    const updatedInstalment = await reconcilePaidInstalment({
      trip,
      participant,
      instalment,
      payment,
      paymentId: razorpayPaymentId,
      capturedAt,
    });
    res.json({
      success: true,
      payment: updatedPayment,
      instalment: updatedInstalment,
    });
  } catch (err) {
    if (err.code) return res.status(err.status || 400).json({ error: err.message, code: err.code });
    console.error("[travel-payment-portal] confirm-razorpay error:", err.message);
    res.status(500).json({ error: "Failed to confirm payment" });
  }
});

module.exports = router;
