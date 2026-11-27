"use strict";

const prisma = require("./prisma");
const { sendEmail } = require("./emailSender");
const { resolveSendGridConfig } = require("../services/travelSendGrid");

const DEFAULT_EMAIL_PRIMARY = "#0f766e";

function escapeAttribute(value) {
  return String(value || "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

async function resolveTravelBrand(tenantId, subBrand) {
  try {
    let brand = null;
    if (prisma.brandKit?.findFirst) {
      if (subBrand) {
        brand = await prisma.brandKit.findFirst({ where: { tenantId, subBrand, isActive: true } });
      }
      if (!brand) brand = await prisma.brandKit.findFirst({ where: { tenantId, subBrand: null, isActive: true } });
    }
    if (brand?.logoUrl || brand?.primaryColor) return brand;

    const tenant = await prisma.tenant?.findUnique?.({
      where: { id: tenantId },
      select: { logoUrl: true, brandColor: true },
    });
    return {
      ...(brand || {}),
      logoUrl: brand?.logoUrl || tenant?.logoUrl || null,
      primaryColor: brand?.primaryColor || tenant?.brandColor || null,
    };
  } catch (error) {
    console.warn(`[TravelEmailAutomation] brand kit could not be resolved: ${error.message}`);
    return null;
  }
}

async function renderTravelEmailHtml({ tenantId, subBrand, body, tenantName, defaultLogoUrl = "" }) {
  const brand = await resolveTravelBrand(tenantId, subBrand);
  let senderEmail = String(process.env.SENDGRID_FROM_EMAIL || "noreply@crm.globusdemos.com").trim();
  try {
    const provider = await resolveSendGridConfig(tenantId);
    senderEmail = provider.fromEmail || senderEmail;
  } catch (_error) {
    // The email sender will report provider configuration errors separately.
  }
  const primary = brand?.primaryColor || DEFAULT_EMAIL_PRIMARY;
  const publicOrigin = String(process.env.FRONTEND_URL || "https://crm.globusdemos.com").replace(/\/$/, "");
  const configuredLogo = brand?.logoUrl || defaultLogoUrl;
  const logoUrl = configuredLogo
    ? String(configuredLogo).startsWith("http")
      ? configuredLogo
      : `${publicOrigin}${String(configuredLogo).startsWith("/") ? "" : "/"}${configuredLogo}`
    : "";
  const logo = logoUrl
    ? `<img src="${escapeAttribute(logoUrl)}" alt="${escapeAttribute(tenantName || "Travel")}" style="display:block;max-width:180px;max-height:54px;width:auto;height:auto;margin:0 auto;">`
    : `<div style="font-size:22px;line-height:28px;font-weight:700;color:${escapeAttribute(primary)};">${escapeAttribute(tenantName || "Travel")}</div>`;
  const footer = brand?.footerText || brand?.tagline || `You received this email from ${tenantName || "our travel team"}.`;
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3f6f8;color:#24313a;font-family:Arial,Helvetica,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f8;padding:32px 12px;"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #d9e0e5;border-radius:12px;overflow:hidden;"><tr><td style="padding:28px 32px 24px;text-align:center;border-bottom:1px solid #e7ecef;">${logo}</td></tr><tr><td style="padding:32px;color:#24313a;font-size:16px;line-height:1.7;">${body}</td></tr><tr><td style="padding:20px 32px;background:#f8fafb;border-top:1px solid #e7ecef;text-align:center;color:#6b7780;font-size:12px;line-height:1.5;">${escapeAttribute(footer)}<br><span>Sent from </span><a href="mailto:${escapeAttribute(senderEmail)}" style="color:${escapeAttribute(primary)};text-decoration:none;">${escapeAttribute(senderEmail)}</a></td></tr></table></td></tr></table></body></html>`;
}

const REMOVED_EVENT_KEYS = new Set([
  "site_visit.scheduled", "trip.confirmed", "booking.confirmed", "trip.reminder", "trip.upcoming_reminder", "payment.reminder",
]);

const ESSENTIAL_EVENTS = Object.freeze([
  ["lead.created.welcome", "New lead created — welcome email", "Welcome to {{tenant.name}}", "Hello {{contact.first_name}},<br><br>Thank you for your interest. Our travel team will be in touch shortly.<br><br>Regards,<br>{{sender.name}}"],
  ["site_visit.scheduled", "Site visit scheduled", "Your site visit is scheduled for {{trip.destination}}", "Hello {{recipient.name}},<br><br>Your site visit has been scheduled.<br><br>Date and time: {{site_visit.date_time}}<br>Meeting point: {{site_visit.location}}<br>Coordinator: {{sender.name}}<br>Contact: {{sender.email}}<br><br>Please contact us at {{tenant.email}} if you need to change the appointment.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["account.created", "Travel account created", "Your {{tenant.name}} travel account is ready", "Hello {{recipient.name}},<br><br>Your travel account has been created successfully.<br><br>Sign in here: {{account.signInLink}}<br><br>For your security, we will never ask for your password by email. Contact {{tenant.email}} if you did not request this account.<br><br>Regards,<br>{{tenant.name}}<br>{{tenant.email}}"],
  ["diagnostic.completed", "Diagnostic report ready", "Your travel learning diagnostic report is ready", "Hello {{recipient.name}},<br><br>Thank you for completing the travel diagnostic for {{student.name}}.<br><br><a href=\"{{diagnostic.reportUrl}}\">View your diagnostic report</a><br><br>Contact {{tenant.email}} with questions.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["catalogue.request_submitted", "Catalogue request received", "Your {{catalogue.name}} catalogue is attached", "Hello {{recipient.name}},<br><br>Thank you for selecting the <strong>{{catalogue.name}}</strong> catalogue.<br><br>We have attached the catalogue you requested. Contact {{tenant.email}} with questions.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["trip.confirmed", "Trip confirmed", "Your trip to {{trip.destination}} is confirmed", "Hello {{recipient.name}},<br><br>Your trip to <strong>{{trip.destination}}</strong> is confirmed.<br><br>Trip: {{trip.name}}<br>Start date: {{trip.startDate}}<br>End date: {{trip.endDate}}<br>Trip reference: {{trip.code}}<br><br>Review your trip here: {{account.signInLink}}.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["booking.confirmed", "Booking confirmed", "Booking confirmation for {{trip.destination}} — {{trip.code}}", "Hello {{recipient.name}},<br><br>Your booking for <strong>{{trip.destination}}</strong> has been confirmed.<br><br>Booking reference: {{booking.reference}}<br>Trip: {{trip.name}}<br>Travel dates: {{trip.startDate}} to {{trip.endDate}}<br>Booking status: {{booking.status}}<br><br>Review your booking here: {{account.signInLink}}.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["payment.received", "Payment received", "Payment received for {{trip.name}}", "Hello {{recipient.name}},<br><br>We have received your payment for <strong>{{trip.name}}</strong>. Thank you.<br><br><strong>Payment details</strong><br>Amount: {{payment.amount}}<br>Installment: {{payment.installment}}<br>Payment method: {{payment.method}}<br>Payment date: {{payment.date}}<br>Payment reference: {{payment.reference}}<br><br>Contact {{tenant.email}} if this information is incorrect.<br><br>Thank you,<br>{{tenant.name}}"],
  ["payment.due_reminder", "Upcoming payment reminder", "Payment reminder for {{trip.name}}", "Hello {{recipient.name}},<br><br>A payment of <strong>{{payment.amount}}</strong> for {{trip.name}} is due on <strong>{{payment.dueDate}}</strong>.<br><br>Pay securely here: {{payment.link}}.<br><br>For help, contact {{tenant.email}}.<br><br>Regards,<br>{{tenant.name}}"],
  ["trip.reminder", "Upcoming trip reminder", "Your trip to {{trip.destination}} is coming up", "Hello {{recipient.name}},<br><br>Your trip to <strong>{{trip.destination}}</strong> is coming up.<br><br>Trip dates: {{trip.startDate}} to {{trip.endDate}}<br>Trip reference: {{trip.code}}<br><br>Review your itinerary here: {{account.signInLink}}.<br><br>Regards,<br>{{tenant.name}}"],
  ["trip.cancelled", "Trip cancellation notice", "Update regarding your trip to {{trip.destination}}", "Hello {{recipient.name}},<br><br>Your trip to <strong>{{trip.destination}}</strong>, scheduled for {{trip.startDate}}, has been cancelled.<br><br>Trip reference: {{trip.code}}<br>Reason: {{trip.cancellationReason}}<br><br>Contact {{tenant.email}} with questions.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["refund.processed", "Refund processed", "Refund processed for {{trip.name}}", "Hello {{recipient.name}},<br><br>A refund of <strong>{{refund.amount}}</strong> for {{trip.name}} has been processed.<br><br>Refund reference: {{refund.reference}}<br>Processed on: {{refund.date}}<br>Refund method: {{refund.method}}<br><br>Contact {{tenant.email}} with questions.<br><br>Regards,<br>{{tenant.name}}"],
  ["account.deleted", "Account deletion confirmed", "Your {{tenant.name}} travel account has been deleted", "Hello {{recipient.name}},<br><br>This confirms that your travel account has been deleted as requested.<br><br>Deletion reason: {{account.deletionReason}}<br><br>If you did not request this, contact {{tenant.email}} immediately.<br><br>Regards,<br>{{tenant.name}}"],
].filter(([eventKey]) => !REMOVED_EVENT_KEYS.has(eventKey)));

const OPTIONAL_EVENTS = Object.freeze([
  ["registration.started", "Registration started but not completed", "Complete your registration for {{trip.name}}", "Hello {{recipient.name}},<br><br>You started registering for <strong>{{trip.name}}</strong>, but the registration is not complete yet.<br><br><a href=\"{{account.setupLink}}\">Continue your registration: {{account.setupLink}}</a><br><br>If you need help, contact {{tenant.email}}.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["trip.completed", "Trip completed — review request", "How was your trip to {{trip.destination}}?", "Hello {{recipient.name}},<br><br>We hope you enjoyed your trip to <strong>{{trip.destination}}</strong>.<br><br>We would appreciate your feedback. <a href=\"{{review.url}}\">Share your review: {{review.url}}</a><br><br>Thank you for travelling with us.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
  ["payment.failed", "Payment failed or overdue", "Payment overdue for invoice {{event.invoiceNum}}", "Hello {{recipient.name}},<br><br>Your payment of <strong>{{payment.amount}}</strong> for invoice {{event.invoiceNum}} was due on {{payment.dueDate}} and is now overdue.<br><br>Please contact {{tenant.email}} to complete the payment or ask for assistance.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}"],
].filter(([eventKey]) => !REMOVED_EVENT_KEYS.has(eventKey)));

const DEFAULT_EVENTS = Object.freeze([...ESSENTIAL_EVENTS, ...OPTIONAL_EVENTS]);
const EVENT_LABELS = new Map(DEFAULT_EVENTS.map((x) => [x[0], x[1]]));

async function ensureDefaultTemplates(tenantId) {
  const existing = await prisma.travelEmailTemplate.findMany({ where: { tenantId, isDefault: true }, select: { eventKey: true, body: true } });
  const present = new Set(existing.map((row) => row.eventKey));
  const missing = DEFAULT_EVENTS.filter(([eventKey]) => !present.has(eventKey));
  const currentKeys = DEFAULT_EVENTS.map(([eventKey]) => eventKey);
  await prisma.travelEmailTemplate.updateMany({ where: { tenantId, isDefault: true, eventKey: { notIn: currentKeys } }, data: { isDefault: false, isActive: false } });
  if (missing.length) {
    await prisma.travelEmailTemplate.createMany({
      data: missing.map(([eventKey, name, subject, body]) => ({ tenantId, eventKey, name, subject, body, isDefault: true, isActive: false, subBrand: null })),
    });
  }
  const previousRegistrationApprovedBody = "Hello {{recipient.name}},<br><br>Your registration has been approved. We will share the next travel steps with you shortly.";
  const updatedRegistrationApproved = ESSENTIAL_EVENTS.find(([eventKey]) => eventKey === "registration.approved");
  const updatedRegistrationApprovedBody = updatedRegistrationApproved?.[3];
  if (updatedRegistrationApprovedBody && existing.some((row) => row.eventKey === "registration.approved" && row.body === previousRegistrationApprovedBody)) {
    await prisma.travelEmailTemplate.updateMany({
      where: { tenantId, eventKey: "registration.approved", isDefault: true, body: previousRegistrationApprovedBody },
      data: { body: updatedRegistrationApprovedBody },
    });
  }
  const diagnosticBody = ESSENTIAL_EVENTS.find(([eventKey]) => eventKey === "diagnostic.completed")?.[3];
  if (diagnosticBody && existing.some((row) => row.eventKey === "diagnostic.completed" && row.body !== diagnosticBody)) {
    await prisma.travelEmailTemplate.updateMany({
      where: { tenantId, eventKey: "diagnostic.completed", isDefault: true },
      data: { body: diagnosticBody },
    });
  }
  const paymentReceivedBody = ESSENTIAL_EVENTS.find(([eventKey]) => eventKey === "payment.received")?.[3];
  const previousPaymentReceivedBodies = [
    "Hello {{recipient.name}},<br><br>We have received your payment of <strong>{{payment.amount}}</strong> for {{trip.name}}.<br><br>Payment date: {{payment.date}}<br>Payment reference: {{payment.reference}}<br>Remaining balance: {{payment.balance}}<br><br>Contact {{tenant.email}} if this information is incorrect.<br><br>Thank you,<br>{{tenant.name}}",
    "Hello {{recipient.name}},<br><br>We have received your payment for {{trip.destination}}. Thank you.",
    "Hello {{recipient.name}},We have received your payment for {{trip.destination}}. Thank you.",
  ];
  if (paymentReceivedBody && existing.some((row) => row.eventKey === "payment.received" && previousPaymentReceivedBodies.includes(row.body))) {
    await prisma.travelEmailTemplate.updateMany({
      where: { tenantId, eventKey: "payment.received", isDefault: true, body: { in: previousPaymentReceivedBodies } },
      data: { body: paymentReceivedBody },
    });
  }
  const registrationStartedBody = OPTIONAL_EVENTS.find(([eventKey]) => eventKey === "registration.started")?.[3];
  const previousRegistrationStartedBody = "Hello {{recipient.name}},<br><br>You started registering for <strong>{{trip.name}}</strong>, but the registration is not complete yet.<br><br><a href=\"{{account.setupLink}}\">Continue your registration</a><br><br>If you need help, contact {{tenant.email}}.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}";
  if (registrationStartedBody && existing.some((row) => row.eventKey === "registration.started" && row.body === previousRegistrationStartedBody)) {
    await prisma.travelEmailTemplate.updateMany({
      where: { tenantId, eventKey: "registration.started", isDefault: true, body: previousRegistrationStartedBody },
      data: { body: registrationStartedBody },
    });
  }
  const tripCompletedBody = OPTIONAL_EVENTS.find(([eventKey]) => eventKey === "trip.completed")?.[3];
  const previousTripCompletedBody = "Hello {{recipient.name}},<br><br>We hope you enjoyed your trip to <strong>{{trip.destination}}</strong>.<br><br>We would appreciate your feedback. <a href=\"{{review.url}}\">Share your review</a><br><br>Thank you for travelling with us.<br><br>Regards,<br>{{sender.name}}<br>{{tenant.name}}";
  if (tripCompletedBody && existing.some((row) => row.eventKey === "trip.completed" && row.body === previousTripCompletedBody)) {
    await prisma.travelEmailTemplate.updateMany({
      where: { tenantId, eventKey: "trip.completed", isDefault: true, body: previousTripCompletedBody },
      data: { body: tripCompletedBody },
    });
  }
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current == null ? "" : current[key], value);
}

function renderText(value, context) {
  return String(value || "").replace(/{{\s*([^}]+?)\s*}}/g, (_match, key) => String(getPath(context, key.trim()) ?? ""));
}

function buildDiagnosticReportUrl({ id, subBrand, tenantSlug, reportSlugToken, reportPdfUrl }) {
  const base = String(process.env.FRONTEND_URL || process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (reportPdfUrl) {
    if (/^https?:\/\//i.test(reportPdfUrl)) return reportPdfUrl;
    return `${base || "http://localhost:5173"}${reportPdfUrl.startsWith("/") ? "" : "/"}${reportPdfUrl}`;
  }
  if (String(subBrand || "").trim().toLowerCase() === "tmc" && tenantSlug && reportSlugToken) {
    const reportSlug = encodeURIComponent(`${id}-${reportSlugToken}`);
    return `${base || "http://localhost:5173"}/diagnostic-form/${encodeURIComponent(tenantSlug)}/tmc/report/${reportSlug}`;
  }
  return "";
}

function recipientForEvent(payload = {}, contact = null) {
  return String(payload.recipientEmail || payload.parentEmail || payload.customerEmail || contact?.email || "").trim().toLowerCase();
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function mergeEventObject(payload, key, aliases = {}) {
  const alternateKey = key === "site_visit" ? "siteVisit" : null;
  const source = payload[key] && typeof payload[key] === "object"
    ? payload[key]
    : alternateKey && payload[alternateKey] && typeof payload[alternateKey] === "object"
      ? payload[alternateKey]
      : {};
  return { ...source, ...Object.fromEntries(
    Object.entries(aliases)
      .map(([field, values]) => [field, firstValue(source[field], ...values.map((alias) => getPath(payload, alias)))])
      .filter(([, value]) => value !== undefined && value !== null && value !== ""),
  ) };
}

async function buildContext(tenantId, payload = {}) {
  let contactId = Number(payload.contactId || payload.parentContactId || 0) || null;
  let paymentRecipientEmail = "";
  let paymentRecipientName = "";
  let paymentTripName = "";
  if (payload.paymentId && prisma.payment?.findFirst) {
    const paymentRecord = await prisma.payment.findFirst({
      where: { id: Number(payload.paymentId), tenantId },
      select: { contactId: true, metadata: true },
    }).catch(() => null);
    contactId = contactId || paymentRecord?.contactId || null;
    if (paymentRecord?.metadata) {
      try {
        const metadata = typeof paymentRecord.metadata === "string"
          ? JSON.parse(paymentRecord.metadata)
          : paymentRecord.metadata;
        const registration = metadata.registration && typeof metadata.registration === "object"
          ? metadata.registration
          : {};
        paymentRecipientEmail = registration.parentEmail || metadata.parentEmail || "";
        paymentRecipientName = registration.parentName || metadata.parentName || "";
        paymentTripName = metadata.tripName || metadata.pageTitle || metadata.destination || "";
      } catch (error) {
        console.warn("[TravelEmailAutomation] payment metadata could not be parsed:", error.message);
      }
    }
  }
  if (!contactId && payload.invoiceId && prisma.travelInvoice?.findFirst) {
    const invoice = await prisma.travelInvoice.findFirst({ where: { id: Number(payload.invoiceId), tenantId }, select: { contactId: true } }).catch(() => null);
    contactId = invoice?.contactId || null;
  }
  const [tenant, contact] = await Promise.all([
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true, ownerEmail: true } }),
    contactId ? prisma.contact.findFirst({ where: { id: contactId, tenantId }, select: { id: true, name: true, email: true, subBrand: true } }) : null,
  ]);
  const name = payload.recipientName || payload.parentName || payload.customerName || paymentRecipientName || contact?.name || "there";
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const recipientEmail = recipientForEvent(
    { ...payload, recipientEmail: payload.recipientEmail || paymentRecipientEmail },
    contact,
  );
  const tenantContext = tenant ? { ...tenant, email: tenant.ownerEmail || "" } : {};
  const trip = mergeEventObject(payload, "trip", {
    name: ["tripName", "event.tripName"],
    code: ["tripCode", "event.tripCode"],
    tripCode: ["tripCode", "event.tripCode", "trip.code"],
    destination: ["tripDestination", "destination", "event.tripDestination"],
    startDate: ["tripStartDate", "startDate", "departDate", "event.tripStartDate"],
    endDate: ["tripEndDate", "endDate", "returnDate", "event.tripEndDate"],
    status: ["tripStatus", "status", "event.tripStatus"],
    cancellationReason: ["cancellationReason", "reason", "event.cancellationReason"],
  });
  trip.name = trip.name || paymentTripName || trip.destination || "your trip";
  const payment = mergeEventObject(payload, "payment", {
    amount: ["amount", "event.amount"],
    transactionAmount: ["transactionAmount", "paymentAmount", "event.transactionAmount"],
    link: ["paymentLink", "event.paymentLink"],
    checkoutLink: ["checkoutLink", "event.checkoutLink"],
    date: ["paymentDate", "paidAt", "event.paymentDate"],
    reference: ["paymentReference", "event.paymentReference"],
    balance: ["paymentBalance", "remainingBalance", "event.paymentBalance"],
    dueDate: ["paymentDueDate", "dueDate", "event.paymentDueDate"],
  });
  const student = mergeEventObject(payload, "student", {
    name: ["studentName", "event.studentName"],
    school: ["studentSchool", "school", "event.studentSchool"],
    class: ["studentClass", "event.studentClass"],
  });
  const booking = mergeEventObject(payload, "booking", {
    reference: ["bookingReference", "event.bookingReference"],
    status: ["bookingStatus", "event.bookingStatus"],
    tripCode: ["bookingTripCode", "tripCode", "event.bookingTripCode"],
  });
  const catalogue = mergeEventObject(payload, "catalogue", {
    name: ["catalogueName", "event.catalogueName"],
  });
  const refund = mergeEventObject(payload, "refund", {
    amount: ["refundAmount", "amount", "event.refundAmount", "event.amount"],
    reference: ["refundReference", "refundId", "event.refundReference", "event.refundId"],
    date: ["refundDate", "processedAt", "event.refundDate"],
    method: ["refundMethod", "method", "event.refundMethod"],
  });
  const siteVisit = mergeEventObject(payload, "site_visit", {
    date_time: ["siteVisitDateTime", "siteVisitAt", "event.siteVisitDateTime"],
    location: ["siteVisitLocation", "event.siteVisitLocation"],
  });
  return {
    tenant: tenantContext, contact: { ...(contact || {}), first_name: firstName }, recipient: { name, email: recipientEmail },
    first_name: firstName,
    diagnostic_link: payload.diagnostic?.reportUrl || payload.reportUrl || "",
    sender: { name: payload.senderName || tenant?.name || "Travel Team", email: payload.senderEmail || tenant?.ownerEmail || "" },
    trip: { destination: "your trip", ...trip },
    account: {
      setupLink: payload.setupLink || payload.registrationLink || "",
      signInLink: payload.signInLink || payload.portalLink || "",
      deletionReason: payload.deletionReason || payload.reason || "",
    },
    event: payload,
    diagnostic: {
      ...(payload.diagnostic || {}),
      reportUrl: payload.diagnostic?.reportUrl || payload.reportUrl || "",
      classificationLabel: payload.diagnostic?.classificationLabel || payload.classificationLabel || "",
      recommendedTier: payload.diagnostic?.recommendedTier || payload.recommendedTier || "",
      score: payload.diagnostic?.score ?? payload.score ?? "",
    },
    student,
    review: payload.review || { url: payload.reviewUrl || "", destination: payload.destination || "" },
    site_visit: { ...siteVisit },
    catalogue,
    booking,
    payment,
    refund,
  };
}

async function processTravelEmailEvent(eventKey, payload = {}, tenantId) {
  if (REMOVED_EVENT_KEYS.has(eventKey)) return { ignored: true, reason: "event_removed" };
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
  if (tenant?.vertical !== "travel") return { ignored: true, reason: "not_travel" };
  if (!EVENT_LABELS.has(eventKey)) return { ignored: true, reason: "unsupported_event" };
  await ensureDefaultTemplates(tenantId);
  const context = await buildContext(tenantId, payload);
  const recipientEmail = context.recipient.email;
  if (!recipientEmail) return { ignored: true, reason: "missing_recipient" };
  const requestedBrand = payload.subBrand || context.contact?.subBrand || null;
  const templates = await prisma.travelEmailTemplate.findMany({
    where: { tenantId, eventKey, isActive: true, isArchived: false, OR: [{ subBrand: requestedBrand }, { subBrand: null }] },
    orderBy: [{ subBrand: "desc" }, { updatedAt: "desc" }],
    take: 1,
  });
  const template = templates[0];
  if (!template) return { ignored: true, reason: "no_template" };
  const subject = renderText(template.subject, context);
  context.event.subject = subject;
  const html = renderText(template.body, context);
  const brandedHtml = await renderTravelEmailHtml({ tenantId, subBrand: template.subBrand || requestedBrand, body: html, tenantName: context.tenant.name });
  context.event.customerMessage = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const result = await sendEmail({ tenantId, to: recipientEmail, subject, html: brandedHtml, text: brandedHtml.replace(/<[^>]+>/g, " ") });
  const deliveryData = {
    tenantId, templateId: template.id, contactId: context.contact?.id || null, eventKey, recipientEmail, subject, bodyHtml: brandedHtml,
    status: result.sent ? "SENT" : "FAILED", provider: "sendgrid", errorMessage: result.sent ? null : result.reason, sentAt: result.sent ? new Date() : null,
  };
  if (payload.resendLogId) {
    await prisma.travelEmailDeliveryLog.update({ where: { id: payload.resendLogId }, data: { ...deliveryData, status: result.sent ? "RESENT" : "FAILED" } });
  } else {
    await prisma.travelEmailDeliveryLog.create({ data: deliveryData });
  }
  return { sent: result.sent, templateId: template.id, recipientEmail, message: result.message || (result.sent ? "Email sent successfully." : "Email provider rejected the message."), code: result.code || result.reason };
}

async function resendTravelEmailDelivery(logId, tenantId) {
  const log = await prisma.travelEmailDeliveryLog.findFirst({
    where: { id: logId, tenantId },
  });
  if (!log) return { ignored: true, reason: "not_found" };
  if (!log.recipientEmail || !log.bodyHtml) return { ignored: true, reason: "missing_message" };

  // Rebuild diagnostic links so a resend cannot preserve an older readiness URL.
  if (log.eventKey === "diagnostic.completed" && log.contactId) {
    const diagnostic = await prisma.travelDiagnostic.findFirst({
      where: {
        tenantId,
        contactId: log.contactId,
        OR: [{ reportPdfUrl: { not: null } }, { reportSlugToken: { not: null } }],
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, contactId: true, subBrand: true, reportSlugToken: true, reportPdfUrl: true },
    });
    if (diagnostic) {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { slug: true },
      });
      const reportUrl = buildDiagnosticReportUrl({ ...diagnostic, tenantSlug: tenant?.slug });
      if (!reportUrl) return { ignored: true, reason: "report_unavailable" };
      const resent = await processTravelEmailEvent("diagnostic.completed", {
        diagnosticId: diagnostic.id,
        contactId: diagnostic.contactId,
        recipientEmail: log.recipientEmail,
        recipientName: log.recipientEmail,
        student: { name: log.recipientEmail },
        reportUrl,
        diagnostic: { reportUrl },
        resendLogId: log.id,
      }, tenantId);
      return resent;
    }
  }

  const result = await sendEmail({
    tenantId,
    to: log.recipientEmail,
    subject: log.subject,
    html: log.bodyHtml,
    text: log.bodyHtml.replace(/<[^>]+>/g, " "),
  });
  await prisma.travelEmailDeliveryLog.update({
    where: { id: log.id },
    data: { status: result.sent ? "RESENT" : "FAILED", errorMessage: result.sent ? null : result.reason, sentAt: result.sent ? new Date() : null },
  });
  return { sent: result.sent, recipientEmail: log.recipientEmail, message: result.message || (result.sent ? "Email sent successfully." : "Email provider rejected the message."), code: result.code || result.reason };
}

async function tickTravelEmailAutomation() {
  if (process.env.NODE_ENV !== "test") await sendRecentDiagnosticEmails();
  const rows = await prisma.travelEmailEnrollment.findMany({
    where: { status: "ACTIVE", nextRun: { lte: new Date() }, tenant: { vertical: "travel" } },
    include: { tenant: { select: { vertical: true } }, sequence: { include: { steps: { orderBy: { position: "asc" }, include: { template: true } } } } },
    take: 100,
  });
  for (const enrollment of rows) {
    const step = enrollment.sequence.steps[enrollment.currentStep];
    if (!step) {
      await prisma.travelEmailEnrollment.update({ where: { id: enrollment.id }, data: { status: "COMPLETED", nextRun: null } });
      continue;
    }
    const eventPayload = JSON.parse(enrollment.eventPayloadJson || "{}");
    const context = await buildContext(enrollment.tenantId, eventPayload);
    let template = step.template;
    if (!template?.isActive || template.isArchived) {
      await prisma.travelEmailEnrollment.update({ where: { id: enrollment.id }, data: { status: "COMPLETED", nextRun: null } });
      continue;
    }
    const eventSubBrand = eventPayload.subBrand || context.contact?.subBrand || null;
    if (eventSubBrand && !template.subBrand) {
      template = await prisma.travelEmailTemplate.findFirst({ where: { tenantId: enrollment.tenantId, eventKey: template.eventKey, subBrand: eventSubBrand, isActive: true, isArchived: false } }) || template;
    }
    const subject = renderText(template.subject, context);
    const html = renderText(template.body, context);
    const brandedHtml = await renderTravelEmailHtml({ tenantId: enrollment.tenantId, subBrand: template.subBrand || eventSubBrand, body: html, tenantName: context.tenant.name });
    const result = await sendEmail({ tenantId: enrollment.tenantId, to: enrollment.recipientEmail, subject, html: brandedHtml, text: brandedHtml.replace(/<[^>]+>/g, " ") });
    await prisma.travelEmailDeliveryLog.create({ data: {
      tenantId: enrollment.tenantId, sequenceId: enrollment.sequenceId, enrollmentId: enrollment.id, stepId: step.id, templateId: template.id,
      contactId: enrollment.contactId, eventKey: enrollment.eventKey, recipientEmail: enrollment.recipientEmail, subject, bodyHtml: brandedHtml,
      status: result.sent ? "SENT" : "FAILED", provider: "sendgrid", errorMessage: result.sent ? null : result.reason, sentAt: result.sent ? new Date() : null,
    } });
    const next = enrollment.currentStep + 1;
    const nextStep = enrollment.sequence.steps[next];
    await prisma.travelEmailEnrollment.update({ where: { id: enrollment.id }, data: nextStep && result.sent ? { currentStep: next, nextRun: new Date(Date.now() + Math.max(0, Number(nextStep.delayMinutes || 0)) * 60 * 1000) } : { status: result.sent ? "COMPLETED" : "FAILED", nextRun: null } });
  }
  return { processed: rows.length };
}

async function sendRecentDiagnosticEmails() {
  const since = new Date(Date.now() - 15 * 60 * 1000);
  const diagnostics = await prisma.travelDiagnostic.findMany({
    where: { createdAt: { gte: since } },
    select: { id: true, tenantId: true, contactId: true, subBrand: true, createdAt: true, reportSlugToken: true, reportPdfUrl: true },
    orderBy: { createdAt: "asc" },
  });
  for (const diagnostic of diagnostics) {
    if (!diagnostic.contactId) continue;
    const alreadyDelivered = await prisma.travelEmailDeliveryLog.findFirst({
      where: { tenantId: diagnostic.tenantId, contactId: diagnostic.contactId, eventKey: "diagnostic.completed", createdAt: { gte: diagnostic.createdAt } },
      select: { id: true },
    });
    if (alreadyDelivered) continue;
    const contact = await prisma.contact.findFirst({ where: { id: diagnostic.contactId, tenantId: diagnostic.tenantId }, select: { id: true, name: true, email: true } });
    if (!contact?.email) continue;
    const tenant = await prisma.tenant.findUnique({
      where: { id: diagnostic.tenantId },
      select: { slug: true },
    });
    const reportUrl = buildDiagnosticReportUrl({ ...diagnostic, tenantSlug: tenant?.slug });
    if (!reportUrl) continue;
    await processTravelEmailEvent("diagnostic.completed", {
      diagnosticId: diagnostic.id,
      contactId: contact.id,
      recipientEmail: contact.email,
      recipientName: contact.name,
      subBrand: diagnostic.subBrand,
      student: { name: contact.name },
      reportUrl,
      diagnostic: { reportUrl },
    }, diagnostic.tenantId);
  }
}

module.exports = { ESSENTIAL_EVENTS, OPTIONAL_EVENTS, EVENT_LABELS, REMOVED_EVENT_KEYS, ensureDefaultTemplates, renderText, renderTravelEmailHtml, buildDiagnosticReportUrl, processTravelEmailEvent, resendTravelEmailDelivery, tickTravelEmailAutomation, sendRecentDiagnosticEmails, buildContext };
