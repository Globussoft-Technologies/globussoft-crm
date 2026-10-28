const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { Prisma } = require("@prisma/client");
const { sendEmail } = require("../lib/emailSender");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { requirePermission, clearUserCache } = require("../middleware/requirePermission");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const { cleanPickupAddress } = require("../lib/callifiedPickup");
const { safeNotifyCustomerPickupPlotAssignments } = require("../lib/pickupPlotAssignmentWhatsApp");
const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
const { syncPlotBookingInvoice } = require("../lib/plotBookingInvoice");
const { allocateCommissionAcrossPayments, syncPlotCommission } = require("../lib/genericPlotCommission");
const { verifySelectionToken } = require("../lib/genericPickupPlotSelection");
const callifiedClient = require("../services/callifiedClient");
const { startBrowserCall } = require("../lib/callifiedAgentBridge");
const { sendCallifiedError } = require("../lib/callifiedErrors");
const { wasRecentlyDialed, redialCooldownError } = require("../lib/callifiedRedialGuard");
const { clearDnpRetryState } = require("../lib/callifiedDnpRetryEngine");
const { CALL_STATUS } = require("../lib/callifiedLeadStatus");
const { writeAudit } = require("../lib/audit");
const {
  normalizeBoundary,
  calculateBoundaryAreaSqFt,
  parseStoredBoundary,
} = require("../lib/plotBoundary");
const {
  validateEmail,
  validateMoney,
  validateName,
  validateOptionalText,
  validatePersonName,
  validatePhone,
  validateRequiredText,
  validateVehicleNumber,
} = require("../lib/pickupPlotValidation");

const router = express.Router();
const adminOnly = verifyRole(["ADMIN"]);
const AVAILABILITY = new Set(["AVAILABLE", "HOLD", "BOOKED", "REGISTERED", "RESERVED", "SOLD"]);
const PLOT_AREA_UNITS = new Set(["SQ_FT", "KATHA"]);
const PLOT_FACINGS = new Set(["NORTH", "SOUTH", "EAST", "WEST", "NORTH_EAST", "NORTH_WEST", "SOUTH_EAST", "SOUTH_WEST"]);
const PLOT_PROPERTY_TYPES = new Set(["RESIDENTIAL", "COMMERCIAL"]);
const MAX_INVENTORY_IMPORT_ROWS = 200;
const INVALID_IMPORT_BOOLEAN = Symbol("INVALID_IMPORT_BOOLEAN");
const TRANSPORT_STATUS_FLOW = [
  "ASSIGNED",
  "ACCEPTED",
  "HEADING_TO_PICKUP",
  "ARRIVED_AT_PICKUP",
  "PICKED_UP",
  "EN_ROUTE",
  "ARRIVED_AT_DROP",
  "COMPLETED",
];
const BROKER_WORKFLOW = [
  "READY_TO_SCHEDULE",
  "VISIT_SCHEDULED",
  "VISIT_CONFIRMED",
  "REMINDER_SENT",
  "ATTENDED",
  "NO_SHOW",
  "VISIT_RESCHEDULED",
  "PLOT_SHOWN",
  "PLOT_SELECTED",
];
const LEGACY_BROKER_STATUS_MAP = {
  READY_TO_EXPLAIN: "READY_TO_SCHEDULE",
  EXPLANATION_STARTED: "VISIT_SCHEDULED",
  EXPLANATION_COMPLETED: "PLOT_SHOWN",
  INTEREST_CONFIRMED: "PLOT_SELECTED",
  NOT_INTERESTED: "CLOSED_NO_INTEREST",
};
const BILLING_WORKFLOW = [
  "PLOT_RESERVED",
  "BILLING",
  "INVOICE_CREATED",
  "INVOICE_SENT",
  "PAYMENT_PENDING",
  "PAYMENT_RECEIVED",
  "PAYMENT_VERIFIED",
  "BOOKING_CONFIRMED",
  "PLOT_SOLD",
  "TRANSACTION_COMPLETED",
];
const WORKFLOW_LABELS = {
  ACCEPTED: "Driver accepted",
  HEADING_TO_PICKUP: "Driver heading to pickup",
  ARRIVED_AT_PICKUP: "Arrived at pickup",
  PICKED_UP: "Customer picked up",
  EN_ROUTE: "Travelling to plot",
  ARRIVED_AT_DROP: "Arrived at plot",
  COMPLETED: "Trip completed",
  VISIT_SCHEDULED: "Site visit scheduled",
  VISIT_CONFIRMED: "Site visit confirmed",
  REMINDER_SENT: "Site visit reminder sent",
  ATTENDED: "Customer attended site visit",
  NO_SHOW: "Customer did not attend",
  VISIT_RESCHEDULED: "Site visit rescheduled",
  PLOT_SHOWN: "Plot shown to customer",
  PLOT_SELECTED: "Plot selected",
  CLOSED_NO_INTEREST: "Closed (not interested)",
  PLOT_RESERVED: "Plot reserved",
  BILLING: "Billing started",
  INVOICE_CREATED: "Invoice prepared",
  INVOICE_SENT: "Invoice sent",
  PAYMENT_PENDING: "Payment pending",
  PAYMENT_RECEIVED: "Payment received",
  PAYMENT_VERIFIED: "Payment verified",
  BOOKING_CONFIRMED: "Booking confirmed",
  PLOT_SOLD: "Plot marked sold",
  TRANSACTION_COMPLETED: "Transaction completed",
};

function firstError(...errors) {
  return errors.find(Boolean) || null;
}

function text(value, maxLength = 500) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function addUtcMonthsClamped(date, months) {
  const result = new Date(date);
  const desiredDay = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(desiredDay, lastDay));
  return result;
}

function parseBoolean(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function parsePrice(value) {
  if (value === "" || value === null || value === undefined) return null;
  const price = Number(value);
  return Number.isFinite(price) && price >= 0 ? price : NaN;
}

function parseCommission(value) {
  if (value === "" || value === null || value === undefined) return null;
  const commission = Number(value);
  return Number.isFinite(commission) && commission >= 0 && commission <= 100 ? commission : NaN;
}

function isGoogleMapsLink(value) {
  if (!value) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (host === "maps.app.goo.gl") return true;
    if (host === "goo.gl") return url.pathname.startsWith("/maps");
    if (/^maps\.google\.[a-z.]+$/.test(host)) return true;
    return /^(www\.)?google\.[a-z.]+$/.test(host) && url.pathname.startsWith("/maps");
  } catch {
    return false;
  }
}

function boundaryData(input) {
  const boundary = normalizeBoundary(input);
  if (boundary.length === 0) return { boundaryJson: null, boundaryAreaSqFt: null };
  return {
    boundaryJson: sanitizeJsonForStringColumn(boundary),
    boundaryAreaSqFt: calculateBoundaryAreaSqFt(boundary),
  };
}

function serializePlot(plot) {
  const { boundaryJson, pickupLocationIdsJson, ...rest } = plot;
  const pickupLocationIds = parseStoredArray(pickupLocationIdsJson);
  if (pickupLocationIds.length === 0 && rest.pickupLocationId) pickupLocationIds.push(rest.pickupLocationId);
  return {
    ...rest,
    pickupLocationIds: [...new Set(pickupLocationIds.map(Number).filter(Number.isInteger))],
    boundary: parseStoredBoundary(boundaryJson),
  };
}

function parseMaxAssignments(value) {
  if (value === "" || value === null || value === undefined) return null;
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 && limit <= 100000 ? limit : NaN;
}

function importBoolean(value, fallback = true) {
  if (value === "" || value === null || value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1", "active"].includes(normalized)) return true;
  if (["false", "no", "n", "0", "inactive"].includes(normalized)) return false;
  return INVALID_IMPORT_BOOLEAN;
}

function importKey(...values) {
  return values.map((value) => String(value || "").trim().toLowerCase()).join("\u0000");
}

function importRows(body) {
  if (!Array.isArray(body?.rows) || body.rows.length === 0) {
    return { error: "Add at least one spreadsheet row to import." };
  }
  if (body.rows.length > MAX_INVENTORY_IMPORT_ROWS) {
    return { error: `Import up to ${MAX_INVENTORY_IMPORT_ROWS} rows at a time.` };
  }
  if (body.rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    return { error: "Every imported row must be an object." };
  }
  return { rows: body.rows };
}

function parseStoredArray(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoredObject(value) {
  if (!value) return {};
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assignmentKey(customerId, plotSiteId) {
  return `customer-${Number(customerId)}-plot-${Number(plotSiteId)}`;
}

function assignmentPairs(person) {
  const stored = parseStoredArray(person?.assignmentPairsJson)
    .map((row) => ({ customerId: Number(row?.customerId), plotSiteId: Number(row?.plotSiteId) }))
    .filter((row) => Number.isInteger(row.customerId) && Number.isInteger(row.plotSiteId));
  if (stored.length > 0) return stored;
  const customerIds = parseStoredArray(person?.customerIdsJson).map(Number).filter(Number.isInteger);
  const plotIds = parseStoredArray(person?.plotSiteIdsJson).map(Number).filter(Number.isInteger);
  if (plotIds.length === 0 && person?.plotSiteId) plotIds.push(Number(person.plotSiteId));
  return customerIds.map((customerId, index) => ({
    customerId,
    plotSiteId: plotIds[index] || plotIds[0] || null,
  }));
}

function appendPersonAssignment(person, customerId, plotSiteId) {
  const nextPair = { customerId: Number(customerId), plotSiteId: Number(plotSiteId) };
  const pairs = [
    ...assignmentPairs(person).filter((pair) => pair.customerId !== nextPair.customerId),
    nextPair,
  ];
  const customerIds = [...new Set([
    ...parseStoredArray(person.customerIdsJson).map(Number).filter(Number.isInteger),
    nextPair.customerId,
  ])];
  const plotSiteIds = [...new Set([
    ...parseStoredArray(person.plotSiteIdsJson).map(Number).filter(Number.isInteger),
    nextPair.plotSiteId,
  ])];
  return {
    customerIdsJson: sanitizeJsonForStringColumn(customerIds),
    plotSiteIdsJson: sanitizeJsonForStringColumn(plotSiteIds),
    assignmentPairsJson: sanitizeJsonForStringColumn(pairs),
  };
}

function replacePersonPlotAssignment(person, customerId, previousPlotSiteId, replacementPlotSiteId, statusField = null) {
  const currentPairs = assignmentPairs(person);
  const hasMatchingPair = currentPairs.some((pair) => (
    pair.customerId === Number(customerId) && pair.plotSiteId === Number(previousPlotSiteId)
  ));
  if (!hasMatchingPair) return null;

  const pairs = currentPairs.map((pair) => (
    pair.customerId === Number(customerId) && pair.plotSiteId === Number(previousPlotSiteId)
      ? { ...pair, plotSiteId: Number(replacementPlotSiteId) }
      : pair
  ));
  const pairPlotIds = new Set(pairs.map((pair) => Number(pair.plotSiteId)));
  const plotSiteIds = [...new Set([
    ...parseStoredArray(person.plotSiteIdsJson)
      .map(Number)
      .filter((id) => Number.isInteger(id) && (
        id !== Number(previousPlotSiteId) || pairPlotIds.has(id)
      )),
    Number(replacementPlotSiteId),
  ])];
  const data = {
    plotSiteIdsJson: sanitizeJsonForStringColumn(plotSiteIds),
    assignmentPairsJson: sanitizeJsonForStringColumn(pairs),
  };
  if (Object.hasOwn(person, "plotSiteId") && Number(person.plotSiteId) === Number(previousPlotSiteId)) {
    data.plotSiteId = Number(replacementPlotSiteId);
  }
  if (statusField) {
    const statuses = parseStoredObject(person[statusField]);
    const previousKey = assignmentKey(customerId, previousPlotSiteId);
    const replacementKey = assignmentKey(customerId, replacementPlotSiteId);
    if (statuses[previousKey]) {
      statuses[replacementKey] = {
        ...statuses[previousKey],
        ...(Number(statuses[previousKey].plotId) === Number(previousPlotSiteId)
          ? { plotId: Number(replacementPlotSiteId) }
          : {}),
      };
      delete statuses[previousKey];
    }
    const legacyKey = `customer-${Number(customerId)}`;
    if (Number(statuses[legacyKey]?.plotId) === Number(previousPlotSiteId)) {
      statuses[legacyKey] = { ...statuses[legacyKey], plotId: Number(replacementPlotSiteId) };
    }
    data[statusField] = sanitizeJsonForStringColumn(statuses);
  }
  return data;
}

function removeCustomerFromPerson(person, customerId, statusField = null) {
  const remainingCustomerIds = parseStoredArray(person.customerIdsJson)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id !== Number(customerId));
  const remainingPairs = assignmentPairs(person)
    .filter((pair) => pair.customerId !== Number(customerId));
  const data = {
    customerIdsJson: remainingCustomerIds.length
      ? sanitizeJsonForStringColumn(remainingCustomerIds)
      : null,
    assignmentPairsJson: remainingPairs.length
      ? sanitizeJsonForStringColumn(remainingPairs)
      : null,
  };
  if (statusField) {
    const statuses = parseStoredObject(person[statusField]);
    for (const key of Object.keys(statuses)) {
      if (key === `customer-${Number(customerId)}` || key.startsWith(`customer-${Number(customerId)}-plot-`)) {
        delete statuses[key];
      }
    }
    data[statusField] = Object.keys(statuses).length
      ? sanitizeJsonForStringColumn(statuses)
      : null;
  }
  return data;
}

function personStartedCustomer(person, customerId, roleType, statusField) {
  const statuses = parseStoredObject(person[statusField]);
  return assignmentPairs(person)
    .filter((pair) => pair.customerId === Number(customerId))
    .some((pair) => {
      const saved = statuses[assignmentKey(pair.customerId, pair.plotSiteId)]
        || statuses[`customer-${pair.customerId}`];
      if (roleType === "transport") {
        return TRANSPORT_STATUS_FLOW.includes(saved?.status) && saved.status !== TRANSPORT_STATUS_FLOW[0];
      }
      if (roleType === "billing") {
        return normalizeBillingWorkflowStatus(saved) !== BILLING_WORKFLOW[0];
      }
      return normalizeBrokerWorkflowStatus(saved) !== BROKER_WORKFLOW[0];
    });
}

function customerTransportStarted(transportPeople, customerId) {
  return (transportPeople || []).some((person) => (
    assignmentPairs(person).some((pair) => pair.customerId === Number(customerId))
  ));
}

// Serialize plot deselection with transport assignment for the same customer.
// A historical cancelled booking must not be resurrected by a request that
// validated its transport assignments before waiting for the lock. Legacy
// transport assignments without any booking remain supported.
async function lockPlotAssignmentCustomers(tx, tenantId, pairs, previousPairs = []) {
  const previous = new Set(previousPairs.map((pair) => assignmentKey(pair.customerId, pair.plotSiteId)));
  const added = pairs.filter((pair) => !previous.has(assignmentKey(pair.customerId, pair.plotSiteId)));
  const customers = [...new Set(added.map((pair) => Number(pair.customerId)))].sort((a, b) => a - b);
  for (const customerId of customers) {
    await tx.$queryRaw`SELECT id FROM Contact WHERE id = ${customerId} AND tenantId = ${tenantId} FOR UPDATE`;
  }
  for (const pair of added) {
    if (!Number.isInteger(pair.plotSiteId) || pair.plotSiteId <= 0) continue;
    const bookings = await tx.plotBooking.findMany({
      where: { tenantId, contactId: pair.customerId, plotSiteId: pair.plotSiteId },
      select: { status: true },
    });
    if (bookings.length && !bookings.some((booking) => booking.status !== "CANCELLED")) {
      const error = new Error("The plot assignment was removed. Refresh and select an assigned plot.");
      error.code = "PLOT_ASSIGNMENT_REMOVED";
      error.statusCode = 409;
      throw error;
    }
  }
}

function startedCustomerOwners(people, roleType, statusField) {
  const owners = new Map();
  for (const person of people || []) {
    for (const pair of assignmentPairs(person)) {
      if (!owners.has(pair.customerId) && personStartedCustomer(person, pair.customerId, roleType, statusField)) {
        owners.set(pair.customerId, Number(person.id));
      }
    }
  }
  return owners;
}

function billingCustomerOwners(bookings) {
  const owners = new Map();
  for (const booking of bookings || []) {
    const customerId = Number(booking.contactId);
    const billingPersonId = Number(booking.billingPersonId);
    if (Number.isInteger(customerId) && Number.isInteger(billingPersonId) && !owners.has(customerId)) {
      owners.set(customerId, billingPersonId);
    }
  }
  return owners;
}

function markClaimedCustomers(customers, owners) {
  return (customers || []).map((customer) => ({
    ...customer,
    claimedByPersonId: owners.get(Number(customer.id)) || null,
  }));
}

function keepOnlyOwnedClaims(row, owners) {
  const customerIds = (row.customerIds || []).filter((customerId) => {
    const ownerId = owners.get(Number(customerId));
    return !ownerId || ownerId === Number(row.id);
  });
  const allowed = new Set(customerIds.map(Number));
  return {
    ...row,
    customerIds,
    assignments: (row.assignments || []).filter((pair) => allowed.has(Number(pair.customerId))),
    customers: (row.customers || []).filter((customer) => allowed.has(Number(customer.id))),
  };
}

async function validateRoleClaims(tenantId, customerIds, roleType, claimantId = null) {
  if (!Array.isArray(customerIds) || customerIds.length === 0) return null;
  let owners;
  if (roleType === "billing") {
    const bookings = await prisma.plotBooking.findMany({
      where: {
        tenantId,
        contactId: { in: customerIds },
        billingPersonId: { not: null },
        status: { not: BILLING_WORKFLOW[0] },
      },
      select: { contactId: true, billingPersonId: true },
    });
    owners = billingCustomerOwners(bookings);
  } else {
    const modelName = roleType === "transport" ? "transportPerson" : "plotBroker";
    const statusField = roleType === "transport" ? "assignmentStatusJson" : "workflowStatusJson";
    const people = await prisma[modelName].findMany({
      where: { tenantId, isActive: true },
      select: {
        id: true,
        customerIdsJson: true,
        plotSiteIdsJson: true,
        assignmentPairsJson: true,
        [statusField]: true,
      },
    });
    owners = startedCustomerOwners(people, roleType, statusField);
  }
  const claimedByAnother = customerIds.find((customerId) => {
    const ownerId = owners.get(Number(customerId));
    return ownerId && ownerId !== Number(claimantId);
  });
  return claimedByAnother
    ? { error: "This customer was already started by another person.", code: "CUSTOMER_ALREADY_CLAIMED", status: 409 }
    : null;
}

async function claimCustomerForPerson(client, {
  modelName, tenantId, claimantId, customerId, roleType, statusField = null,
}) {
  const select = {
    id: true,
    customerIdsJson: true,
    plotSiteIdsJson: true,
    assignmentPairsJson: true,
  };
  if (statusField) select[statusField] = true;
  const peers = await client[modelName].findMany({
    where: { tenantId, isActive: true, id: { not: claimantId } },
    select,
  });
  const assignedPeers = peers.filter((person) => (
    assignmentPairs(person).some((pair) => pair.customerId === Number(customerId))
  ));
  const existingClaim = statusField
    ? assignedPeers.find((person) => personStartedCustomer(person, customerId, roleType, statusField))
    : null;
  if (existingClaim) {
    const error = new Error("This customer was already started by another person.");
    error.code = "CUSTOMER_ALREADY_CLAIMED";
    error.statusCode = 409;
    throw error;
  }
  for (const peer of assignedPeers) {
    await client[modelName].update({
      where: { id: peer.id },
      data: removeCustomerFromPerson(peer, customerId, statusField),
    });
  }
}

function handleClaimError(error, res) {
  if (!["CUSTOMER_ALREADY_CLAIMED", "WORKFLOW_CONFLICT", "PLOT_NOT_AVAILABLE", "PLOT_ASSIGNMENT_REMOVED"].includes(error?.code)) return false;
  res.status(error.statusCode || 409).json({ error: error.message, code: error.code });
  return true;
}

function transportPlotMap(transportPeople) {
  const result = new Map();
  for (const person of transportPeople || []) {
    for (const pair of assignmentPairs(person)) {
      if (!result.has(pair.customerId) && Number.isInteger(pair.plotSiteId)) {
        result.set(pair.customerId, pair.plotSiteId);
      }
    }
  }
  return result;
}

function attachTransportPlots(customers, transportPeople) {
  const assignedPlots = transportPlotMap(transportPeople);
  return (customers || []).map((customer) => ({
    ...customer,
    transportPlotSiteId: assignedPlots.get(Number(customer.id)) || null,
  }));
}

function billingCanAccess(person, customerId, plotSiteId) {
  return assignmentPairs(person).some((pair) => pair.customerId === Number(customerId));
}

function isAdminWorkspaceOverview(req) {
  return req.user.role === "ADMIN";
}

function assignedStaff(person) {
  return {
    id: person.userId || null,
    profileId: person.id,
    name: person.name || "Assigned staff",
    email: person.email || null,
    phone: person.phone || null,
  };
}

function adminAssignedProfileId(req) {
  if (!isAdminWorkspaceOverview(req)) return null;
  const profileId = Number(req.query.assignedProfileId);
  return Number.isInteger(profileId) && profileId > 0 ? profileId : null;
}

async function saveWorkflowOptimistically(model, record, field, statuses, tenantId) {
  const result = await model.updateMany({
    where: {
      id: record.id,
      tenantId,
      [field]: record[field] ?? null,
      updatedAt: record.updatedAt,
    },
    data: { [field]: sanitizeJsonForStringColumn(statuses) },
  });
  if (result.count !== 1) {
    const error = new Error("Assignments changed. Refresh and retry.");
    error.code = "WORKFLOW_CONFLICT";
    error.statusCode = 409;
    throw error;
  }
}

async function appendWorkflowEvent(client, req, {
  bookingId = null, contactId, plotSiteId = null, stage, fromStatus = null,
  toStatus, metadata = null, occurredAt = new Date(),
}) {
  return client.plotWorkflowEvent.create({
    data: {
      tenantId: req.user.tenantId,
      plotBookingId: bookingId,
      contactId: Number(contactId),
      plotSiteId: Number(plotSiteId) || null,
      stage,
      eventType: toStatus,
      label: WORKFLOW_LABELS[toStatus] || String(toStatus).replaceAll("_", " ").toLowerCase(),
      fromStatus,
      toStatus,
      actorUserId: req.user.userId,
      metadataJson: metadata ? sanitizeJsonForStringColumn(metadata) : null,
      occurredAt: occurredAt instanceof Date ? occurredAt : new Date(occurredAt),
    },
  });
}

async function findActivePlotBooking(client, tenantId, contactId, plotSiteId) {
  return client.plotBooking.findFirst({
    where: {
      tenantId,
      contactId: Number(contactId),
      plotSiteId: Number(plotSiteId),
      status: { notIn: ["CANCELLED", "PLOT_ASSIGNED"] },
    },
    orderBy: { createdAt: "desc" },
  });
}

function normalizeAssignmentPairs(value, customerIds, plotSiteIds) {
  if (value !== undefined) {
    if (!Array.isArray(value)) return { error: "Assignments must be an array." };
    const pairs = value.map((row) => ({ customerId: Number(row?.customerId), plotSiteId: Number(row?.plotSiteId) }));
    if (pairs.some((row) => !Number.isInteger(row.customerId) || !Number.isInteger(row.plotSiteId))) {
      return { error: "Every assignment must select both a customer and a plot." };
    }
    return [...new Map(pairs.map((row) => [assignmentKey(row.customerId, row.plotSiteId), row])).values()];
  }
  return customerIds.map((customerId, index) => ({
    customerId,
    plotSiteId: plotSiteIds[index] || plotSiteIds[0] || null,
  })).filter((row) => Number.isInteger(row.plotSiteId));
}

function validateSelectedAssignmentPairs(value, customerIds, plotSiteIds) {
  const pairs = normalizeAssignmentPairs(value, customerIds, plotSiteIds);
  if (!Array.isArray(pairs)) return pairs;
  const selectedCustomers = new Set(customerIds);
  const selectedPlots = new Set(plotSiteIds);
  if (pairs.some((row) => !selectedCustomers.has(row.customerId) || !selectedPlots.has(row.plotSiteId))) {
    return { error: "Customer assignments must use the selected customers and plots." };
  }
  const assignedCustomers = pairs.map((row) => row.customerId);
  if (pairs.length !== customerIds.length || new Set(assignedCustomers).size !== customerIds.length) {
    return { error: "Assign exactly one selected plot to every selected customer." };
  }
  return pairs;
}

async function transportLockedAssignmentPairs(tenantId, customerIds, plotSiteIds) {
  if (customerIds.length === 0) return [];
  const transportPeople = await prisma.transportPerson.findMany({
    where: { tenantId, isActive: true },
    orderBy: { updatedAt: "desc" },
    select: { assignmentPairsJson: true, customerIdsJson: true, plotSiteIdsJson: true },
  });
  const assignedPlots = transportPlotMap(transportPeople);
  const pairs = customerIds.map((customerId) => ({
    customerId,
    plotSiteId: assignedPlots.get(customerId),
  }));
  if (pairs.some((pair) => !Number.isInteger(pair.plotSiteId) || !plotSiteIds.includes(pair.plotSiteId))) {
    return { error: "Select only customers whose Transport-assigned plot is selected." };
  }
  return pairs;
}

function completedTransportTrips(transportPeople) {
  const completedTrips = new Map();
  for (const person of transportPeople) {
    const statuses = parseStoredObject(person.assignmentStatusJson);
    for (const pair of assignmentPairs(person)) {
      const key = assignmentKey(pair.customerId, pair.plotSiteId);
      const saved = statuses[key] || statuses[`customer-${pair.customerId}`];
      if (saved?.status === "COMPLETED") {
        completedTrips.set(key, {
          updatedAt: saved.updatedAt || null,
          pickupAt: saved.pickupAt || null,
          dropOffAt: saved.dropOffAt || saved.updatedAt || null,
          scheduledPickupAt: saved.scheduledPickupAt || null,
          scheduledDropOffAt: saved.scheduledDropOffAt || null,
          transportPersonId: person.id || null,
        });
        completedTrips.set(pair.customerId, saved.updatedAt || null);
      }
    }
  }
  return completedTrips;
}

function transportTripDetails(transportPeople) {
  const trips = new Map();
  for (const person of transportPeople) {
    const statuses = parseStoredObject(person.assignmentStatusJson);
    for (const pair of assignmentPairs(person)) {
      const key = assignmentKey(pair.customerId, pair.plotSiteId);
      const saved = statuses[key] || statuses[`customer-${pair.customerId}`] || {};
      trips.set(key, {
        status: TRANSPORT_STATUS_FLOW.includes(saved.status) ? saved.status : "ASSIGNED",
        updatedAt: saved.updatedAt || null,
        pickupAt: saved.pickupAt || null,
        dropOffAt: saved.dropOffAt || null,
        scheduledPickupAt: saved.scheduledPickupAt || null,
        scheduledDropOffAt: saved.scheduledDropOffAt || null,
        transportPersonId: person.id || null,
      });
    }
  }
  return trips;
}

function normalizeBrokerWorkflowStatus(saved) {
  if (BROKER_WORKFLOW.includes(saved?.status)) return saved.status;
  if (LEGACY_BROKER_STATUS_MAP[saved?.status]) return LEGACY_BROKER_STATUS_MAP[saved.status];
  if (["DOCUMENTATION", "BILLING", "BILLED"].includes(saved?.status)) return "PLOT_SELECTED";
  return BROKER_WORKFLOW[0];
}

function normalizeBillingWorkflowStatus(saved) {
  if (BILLING_WORKFLOW.includes(saved?.billingStatus)) return saved.billingStatus;
  const legacyStatuses = {
    READY_FOR_BILLING: "PLOT_RESERVED",
    DETAILS_VERIFIED: "PLOT_RESERVED",
    INVOICE_PREPARED: "INVOICE_CREATED",
    BILLING_COMPLETED: "TRANSACTION_COMPLETED",
  };
  if (legacyStatuses[saved?.billingStatus]) return legacyStatuses[saved.billingStatus];
  return saved?.status === "BILLED" ? "TRANSACTION_COMPLETED" : BILLING_WORKFLOW[0];
}

function billingStatusWithBooking(status, booking) {
  if (!booking) return status;
  const totalAmount = Number(booking.totalAmount || 0);
  const balance = Number(booking.balance ?? totalAmount);
  const fullyPaid = booking.paymentStatus === "PAID" || (totalAmount > 0 && balance <= 0);
  if (!fullyPaid) return status;

  const currentIndex = BILLING_WORKFLOW.indexOf(status);
  const verifiedIndex = BILLING_WORKFLOW.indexOf("PAYMENT_VERIFIED");
  return currentIndex >= 0 && currentIndex < verifiedIndex ? "PAYMENT_VERIFIED" : status;
}

async function requireBillingProfile(req, res) {
  const assignedProfileId = adminAssignedProfileId(req);
  const billingPerson = await prisma.billingPerson.findFirst({
    where: {
      tenantId: req.user.tenantId,
      ...(assignedProfileId ? { id: assignedProfileId } : { userId: req.user.userId }),
      isActive: true,
    },
  });
  if (!billingPerson) {
    res.status(403).json({ error: "No active billing person profile is linked to this login", code: "BILLING_PROFILE_NOT_LINKED" });
    return null;
  }
  return { id: req.user.userId, billingPerson };
}

function parseIdList(value, label) {
  if (value === null || value === undefined || value === "") return [];
  if (!Array.isArray(value)) return { error: `${label} must be an array.` };
  if (value.length > 100) return { error: `Select no more than 100 ${label.toLowerCase()}.` };
  const ids = [...new Set(value.map(Number))];
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return { error: `Select valid ${label.toLowerCase()}.` };
  return ids;
}

async function validateTenantIds(model, tenantId, value, label) {
  const ids = parseIdList(value, label);
  if (!Array.isArray(ids)) return ids;
  if (ids.length === 0) return ids;
  const rows = await model.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true } });
  return rows.length === ids.length ? ids : { error: `One or more ${label.toLowerCase()} were not found.` };
}

async function findCompletedCustomerIds(tenantId, candidateIds = null) {
  const bookingWhere = { tenantId, status: "TRANSACTION_COMPLETED" };
  if (Array.isArray(candidateIds)) bookingWhere.contactId = { in: candidateIds };
  const [completedBookings, brokers] = await Promise.all([
    prisma.plotBooking.findMany({ where: bookingWhere, select: { contactId: true } }),
    prisma.plotBroker.findMany({
      where: { tenantId },
      select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, workflowStatusJson: true },
    }),
  ]);
  const completed = new Set(completedBookings.map((row) => Number(row.contactId)));
  for (const broker of brokers) {
    const statuses = parseStoredObject(broker.workflowStatusJson);
    for (const pair of assignmentPairs(broker)) {
      if (Array.isArray(candidateIds) && !candidateIds.includes(pair.customerId)) continue;
      const saved = statuses[assignmentKey(pair.customerId, pair.plotSiteId)] || statuses[`customer-${pair.customerId}`];
      if (normalizeBillingWorkflowStatus(saved) === "TRANSACTION_COMPLETED") completed.add(pair.customerId);
    }
  }
  return completed;
}

async function validateAssignableCustomerIds(tenantId, value) {
  const ids = await validateTenantIds(prisma.contact, tenantId, value, "Customers");
  if (!Array.isArray(ids) || ids.length === 0) return ids;
  const completedCustomerIds = await findCompletedCustomerIds(tenantId, ids);
  if (completedCustomerIds.size > 0) {
    return { error: "A completed customer cannot be assigned again." };
  }
  return ids;
}

function normalizeServiceAreas(value) {
  if (value === null || value === undefined || value === "") return [];
  if (!Array.isArray(value)) return { error: "Service areas must be an array." };
  if (value.length > 50) return { error: "Add no more than 50 service areas." };
  const rows = value
    .map((row) => ({
      plotSiteId: Number.isInteger(Number(row?.plotSiteId)) ? Number(row.plotSiteId) : null,
      area: text(row?.area, 150),
      state: text(row?.state, 100),
      pincode: text(row?.pincode, 10),
    }))
    .filter((row) => row.area || row.state || row.pincode);
  for (const row of rows) {
    if (!row.area) return { error: "Area could not be resolved from the selected plot address." };
    if (row.pincode && !/^\d{6}$/.test(row.pincode)) return { error: "PIN code must contain exactly 6 digits." };
  }
  return rows;
}

function serializeTransportPerson(person, pickupLocationMap = new Map(), plotSiteMap = new Map(), customerMap = new Map(), filterMissingCustomers = false) {
  const {
    pickupLocationIdsJson, plotSiteIdsJson, serviceAreasJson, customerIdsJson,
    assignmentPairsJson, assignmentStatusJson, pickupLocation,
    ...rest
  } = person;
  const pickupLocationIds = parseStoredArray(pickupLocationIdsJson)
    .map(Number)
    .filter(Number.isInteger);
  if (pickupLocationIds.length === 0 && rest.pickupLocationId) pickupLocationIds.push(rest.pickupLocationId);
  const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
  const customerIds = parseStoredArray(customerIdsJson)
    .map(Number)
    .filter((id) => Number.isInteger(id) && (!filterMissingCustomers || customerMap.has(id)));
  const statuses = parseStoredObject(assignmentStatusJson);
  const assignments = assignmentPairs({ assignmentPairsJson, customerIdsJson, plotSiteIdsJson })
    .filter((pair) => customerIds.includes(pair.customerId))
    .map((pair) => {
      const saved = statuses[assignmentKey(pair.customerId, pair.plotSiteId)]
        || statuses[`customer-${pair.customerId}`];
      const status = TRANSPORT_STATUS_FLOW.includes(saved?.status) ? saved.status : TRANSPORT_STATUS_FLOW[0];
      return status === TRANSPORT_STATUS_FLOW[0]
        ? pair
        : { ...pair, status, plotLocked: true };
    });
  const serviceAreas = parseStoredArray(serviceAreasJson).map((area) => {
    const plot = plotSiteMap.get(Number(area.plotSiteId));
    return plot ? { ...area, plotName: plot.name, address: plot.address || "" } : area;
  });
  if (serviceAreas.length === 0 && rest.serviceArea) {
    serviceAreas.push({ area: rest.serviceArea, state: "", pincode: "" });
  }
  return {
    ...rest,
    name: person.user?.name || rest.name,
    phone: person.user?.phone || rest.phone,
    pickupLocation: pickupLocation || pickupLocationMap.get(rest.pickupLocationId) || null,
    pickupLocationIds,
    plotSiteIds,
    customerIds,
    assignments,
    pickupLocations: pickupLocationIds.map((id) => pickupLocationMap.get(id)).filter(Boolean),
    plots: plotSiteIds.map((id) => plotSiteMap.get(id)).filter(Boolean),
    customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
    serviceAreas,
  };
}

function buildTransportAssignments(
  person,
  pickupLocations,
  plots,
  customers,
  customerPickupMap = new Map(),
  filterMissingReferences = false,
) {
  const pickupLocationIds = parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
  if (pickupLocationIds.length === 0 && person.pickupLocationId) pickupLocationIds.push(person.pickupLocationId);
  const statuses = parseStoredObject(person.assignmentStatusJson);
  const pickupMap = new Map(pickupLocations.map((row) => [row.id, row]));
  const plotMap = new Map(plots.map((row) => [row.id, row]));
  const customerMap = new Map(customers.map((row) => [row.id, row]));
  const pairs = assignmentPairs(person);

  return pairs.map(({ customerId, plotSiteId }, index) => {
    const pickupLocationId = pickupLocationIds[index] || pickupLocationIds[0] || null;
    const key = assignmentKey(customerId, plotSiteId);
    const saved = statuses[key] || statuses[`customer-${customerId}`] || {};
    const status = TRANSPORT_STATUS_FLOW.includes(saved.status) ? saved.status : "ASSIGNED";
    const customerPickup = customerId ? customerPickupMap.get(customerId) : null;
    return {
      assignmentKey: key,
      status,
      statusUpdatedAt: saved.updatedAt || null,
      pickupAt: saved.pickupAt || null,
      dropOffAt: saved.dropOffAt || null,
      scheduledPickupAt: saved.scheduledPickupAt || null,
      scheduledDropOffAt: saved.scheduledDropOffAt || null,
      customer: customerId ? customerMap.get(customerId) || null : null,
      pickup: customerPickup ? {
        id: customerPickup.id,
        name: "Customer pickup",
        address: cleanPickupAddress(customerPickup.pickupAddress) || customerPickup.pickupAddress,
        source: "CALLIFIED_TRANSCRIPT",
      } : pickupLocationId ? pickupMap.get(pickupLocationId) || null : null,
      drop: plotSiteId ? plotMap.get(plotSiteId) || null : null,
    };
  }).filter((assignment) => (
    !filterMissingReferences || (assignment.customer && assignment.drop)
  ));
}

function findCustomerTransportStatus(customerId, transportPeople) {
  for (const person of transportPeople) {
    const pair = assignmentPairs(person).find((row) => row.customerId === Number(customerId));
    if (!pair) continue;
    const statuses = parseStoredObject(person.assignmentStatusJson);
    const saved = statuses[assignmentKey(customerId, pair.plotSiteId)] || statuses[`customer-${customerId}`] || {};
    return {
      status: TRANSPORT_STATUS_FLOW.includes(saved.status) ? saved.status : "ASSIGNED",
      statusUpdatedAt: saved.updatedAt || person.updatedAt || null,
      pickupAt: saved.pickupAt || null,
      dropOffAt: saved.dropOffAt || null,
      scheduledPickupAt: saved.scheduledPickupAt || null,
      scheduledDropOffAt: saved.scheduledDropOffAt || null,
      transportPerson: { id: person.id, name: person.name, phone: person.phone },
    };
  }
  return { status: "PICKUP_LOCATION_CAPTURED", statusUpdatedAt: null, transportPerson: null };
}

function findCustomerWorkflowStatus(customerId, transportPeople, brokers, plotMap = new Map()) {
  const transport = findCustomerTransportStatus(customerId, transportPeople);
  const transportPerson = transportPeople.find((row) => (
    assignmentPairs(row).some((pair) => pair.customerId === Number(customerId))
  )) || null;
  const transportPair = transportPerson
    ? assignmentPairs(transportPerson).find((pair) => pair.customerId === Number(customerId))
    : null;
  const broker = brokers.find((row) => assignmentPairs(row).some((pair) => pair.customerId === Number(customerId))) || null;
  const brokerPair = broker ? assignmentPairs(broker).find((pair) => pair.customerId === Number(customerId)) : null;
  const brokerStatuses = broker ? parseStoredObject(broker.workflowStatusJson) : {};
  const saved = brokerPair
    ? brokerStatuses[assignmentKey(customerId, brokerPair.plotSiteId)] || brokerStatuses[`customer-${customerId}`]
    : null;
  const brokerStatus = broker
    ? normalizeBrokerWorkflowStatus(saved)
    : transport.status === "COMPLETED" ? "AWAITING_BROKER_ASSIGNMENT" : "PENDING";
  const billingStatus = brokerStatus === "PLOT_SELECTED"
    ? normalizeBillingWorkflowStatus(saved)
    : "PENDING";

  let currentStage = "transport";
  let currentStatus = transport.status;
  let currentStatusUpdatedAt = transport.statusUpdatedAt;
  if (transport.status === "COMPLETED") {
    currentStage = "broker";
    currentStatus = brokerStatus;
    currentStatusUpdatedAt = saved?.updatedAt || transport.statusUpdatedAt;
    if (brokerStatus === "PLOT_SELECTED") {
      currentStage = "billing";
      currentStatus = billingStatus;
      currentStatusUpdatedAt = saved?.billingUpdatedAt || saved?.updatedAt || transport.statusUpdatedAt;
    }
  }

  return {
    ...transport,
    assignedPlot: plotMap.get(Number(saved?.plotId || transportPair?.plotSiteId || brokerPair?.plotSiteId)) || null,
    currentStage,
    currentStatus,
    currentStatusUpdatedAt,
    workflow: {
      transport: {
        status: transport.status,
        updatedAt: transport.statusUpdatedAt,
        pickupAt: transport.pickupAt,
        dropOffAt: transport.dropOffAt,
        scheduledPickupAt: transport.scheduledPickupAt,
        scheduledDropOffAt: transport.scheduledDropOffAt,
        assignee: transport.transportPerson,
      },
      broker: {
        status: brokerStatus,
        updatedAt: saved?.updatedAt || null,
        assignee: broker ? { id: broker.id, name: broker.name, phone: broker.phone, commissionPercent: broker.commissionPercent == null ? null : Number(broker.commissionPercent) } : null,
      },
      billing: {
        status: billingStatus,
        updatedAt: saved?.billingUpdatedAt || null,
      },
    },
  };
}

function customerJourneyBucket(customer) {
  if (customer.currentStatus === "TRANSACTION_COMPLETED") return "completed";
  if (customer.currentStage === "transport" && customer.currentStatus === "PICKUP_LOCATION_CAPTURED") return "waiting";
  return "active";
}

function serializePlotBroker(broker, customerMap = new Map(), plotSiteMap = new Map(), pickupLocationMap = new Map(), filterMissingCustomers = false) {
  const { customerIdsJson, plotSiteIdsJson, pickupLocationIdsJson, assignmentPairsJson, workflowStatusJson: _workflowStatusJson, ...rest } = broker;
  const customerIds = parseStoredArray(customerIdsJson)
    .map(Number)
    .filter((id) => Number.isInteger(id) && (!filterMissingCustomers || customerMap.has(id)));
  const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
  const pickupLocationIds = parseStoredArray(pickupLocationIdsJson).map(Number).filter(Number.isInteger);
  if (plotSiteIds.length === 0 && rest.plotSiteId) plotSiteIds.push(rest.plotSiteId);
  return {
    ...rest,
    customerIds,
    plotSiteIds,
    pickupLocationIds,
    assignments: assignmentPairs({ assignmentPairsJson, customerIdsJson, plotSiteIdsJson, plotSiteId: rest.plotSiteId })
      .filter((pair) => customerIds.includes(pair.customerId)),
    customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
    plots: plotSiteIds.map((id) => plotSiteMap.get(id)).filter(Boolean),
    pickupLocations: pickupLocationIds.map((id) => pickupLocationMap.get(id)).filter(Boolean),
  };
}

function roleHasWorkspacePermission(role, module, action = "read") {
  return (role?.permissions || []).some((permission) => (
    permission.module === module && permission.action === action
  ));
}

function userHasWorkspacePermission(user, module, action = "read") {
  return (user?.userRoles || []).some(({ role }) => roleHasWorkspacePermission(role, module, action));
}

const NON_ASSIGNABLE_STAFF_ROLE_KEYS = new Set(["CUSTOMER", "MANAGER", "ADMIN", "OWNER"]);

async function findWorkspaceRole(tenantId, module, preferredKeys = [], client = prisma) {
  const roles = await client.role.findMany({
    where: { tenantId, userType: "STAFF", isActive: true },
    select: {
      id: true,
      key: true,
      name: true,
      permissions: { where: { module, action: "read" }, select: { module: true, action: true } },
    },
    orderBy: { id: "asc" },
  });
  const eligible = roles.filter((role) => roleHasWorkspacePermission(role, module));
  const normalizedPreferredKeys = preferredKeys.map((key) => String(key).toUpperCase());
  return normalizedPreferredKeys
    .map((key) => eligible.find((role) => String(role.key || "").toUpperCase() === key))
    .find(Boolean)
    || eligible.find((role) => !NON_ASSIGNABLE_STAFF_ROLE_KEYS.has(String(role.key || "").toUpperCase()))
    || null;
}

const findTransportRole = (tenantId, client = prisma) => findWorkspaceRole(
  tenantId, "transport_workspace", ["TRANSPORT_PERSON", "TRANSPORT"], client,
);
const findBrokerRole = (tenantId, client = prisma) => findWorkspaceRole(
  tenantId, "broker_workspace", ["BROOKER", "BROKER"], client,
);
const findBillingRole = (tenantId, client = prisma) => findWorkspaceRole(
  tenantId, "billing_workspace", ["BILLING"], client,
);

async function findConfirmedPickupCustomers(tenantId) {
  const [pickups, completedCustomerIds] = await Promise.all([
    prisma.customerPickup.findMany({
      where: { tenantId, contact: { deletedAt: null } },
      orderBy: { updatedAt: "desc" },
      select: {
        pickupAddress: true,
        contact: { select: { id: true, name: true, phone: true, email: true, company: true } },
      },
    }),
    findCompletedCustomerIds(tenantId),
  ]);
  return pickups
    .map((pickup) => pickup.contact ? {
      ...pickup.contact,
      pickupAddress: cleanPickupAddress(pickup.pickupAddress) || pickup.pickupAddress,
    } : null)
    .filter((contact) => contact && !completedCustomerIds.has(Number(contact.id)))
    .sort((left, right) => String(left.name || "").localeCompare(String(right.name || "")));
}

async function validateAssignableTransportUser(tenantId, staffUserId, excludeTransportPersonId = null) {
  const userId = Number(staffUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { error: "Select a valid transport staff member.", code: "INVALID_TRANSPORT_USER" };
  }
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deactivatedAt: null, userType: { in: ["STAFF", "OWNER"] } },
    include: { userRoles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user || !userHasWorkspacePermission(user, "transport_workspace")) {
    return { error: "The selected staff member does not have Transport Workspace access.", code: "INVALID_TRANSPORT_USER" };
  }
  const linked = await prisma.transportPerson.findFirst({ where: { userId, tenantId } });
  if (linked && Number(linked.id) !== Number(excludeTransportPersonId)) {
    return { error: "That staff member already has a transport profile.", code: "TRANSPORT_USER_ALREADY_LINKED" };
  }
  return { user };
}

async function validateAssignableBrokerUser(tenantId, staffUserId, excludeBrokerId = null) {
  const userId = Number(staffUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { error: "Select a valid broker staff member.", code: "INVALID_BROKER_USER" };
  }
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deactivatedAt: null, userType: { in: ["STAFF", "OWNER"] } },
    include: { userRoles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user || !userHasWorkspacePermission(user, "broker_workspace")) {
    return { error: "The selected staff member does not have Site Visits Workspace access.", code: "INVALID_BROKER_USER" };
  }
  const linked = await prisma.plotBroker.findFirst({ where: { userId, tenantId } });
  if (linked && Number(linked.id) !== Number(excludeBrokerId)) {
    return { error: "That staff member already has a broker profile.", code: "BROKER_USER_ALREADY_LINKED" };
  }
  return { user };
}

async function validateAssignableBillingUser(tenantId, staffUserId, excludeBillingPersonId = null) {
  const userId = Number(staffUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { error: "Select a valid billing staff member.", code: "INVALID_BILLING_USER" };
  }
  const user = await prisma.user.findFirst({
    where: { id: userId, tenantId, deactivatedAt: null, userType: { in: ["STAFF", "OWNER"] } },
    include: { userRoles: { include: { role: { include: { permissions: true } } } } },
  });
  if (!user || !userHasWorkspacePermission(user, "billing_workspace")) {
    return { error: "The selected staff member does not have Billing Workspace access.", code: "INVALID_BILLING_USER" };
  }
  const linked = await prisma.billingPerson.findFirst({ where: { userId, tenantId } });
  if (linked && Number(linked.id) !== Number(excludeBillingPersonId)) {
    return { error: "That staff member already has a billing profile.", code: "BILLING_USER_ALREADY_LINKED" };
  }
  return { user };
}

async function requireGenericTenant(req, res, next) {
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { id: req.user.tenantId },
      select: { vertical: true },
    });
    if (!tenant || tenant.vertical !== "generic") {
      return res.status(403).json({
        error: "Pickup and plot inventory is available only in Generic CRM",
        code: "GENERIC_ONLY",
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// Public, token-scoped customer selection used by Generic web-form leads.
// This is intentionally defined before the authenticated router middleware.
const PUBLIC_SELECTION_SOURCE = "Selected by customer from Generic web-form link";

async function hasCompletedPublicSelection(db, tenantId, contactId) {
  const [pickup, booking] = await Promise.all([
    db.customerPickup.findFirst({
      where: { tenantId, contactId, sourceExcerpt: PUBLIC_SELECTION_SOURCE },
      select: { id: true },
    }),
    db.plotBooking.findFirst({
      where: { tenantId, contactId },
      select: { id: true },
    }),
  ]);
  return Boolean(pickup || booking);
}

router.get("/public/selection/:token", async (req, res) => {
  try {
    const { tenantId, contactId } = verifySelectionToken(req.params.token);
    const [tenant, contact, pickupLocations, plots, completed] = await Promise.all([
      prisma.tenant.findFirst({ where: { id: tenantId, vertical: "generic" }, select: { id: true, name: true } }),
      prisma.contact.findFirst({ where: { id: contactId, tenantId, deletedAt: null }, select: { id: true, name: true } }),
      prisma.pickupLocation.findMany({ where: { tenantId, isActive: true }, orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, address: true } }),
      prisma.plotSite.findMany({ where: { tenantId, isActive: true, availability: "AVAILABLE", plotNumber: { not: null } }, orderBy: [{ name: "asc" }, { plotNumber: "asc" }], select: { id: true, name: true, plotNumber: true, address: true, area: true, areaUnit: true, price: true } }),
      hasCompletedPublicSelection(prisma, tenantId, contactId),
    ]);
    if (!tenant || !contact) return res.status(404).json({ error: "This selection link is no longer available.", code: "SELECTION_NOT_FOUND" });
    if (completed) return res.json({ completed: true, contact: { name: contact.name } });
    return res.json({ contact: { name: contact.name }, pickupLocations, plots: plots.map((plot) => ({ ...plot, price: plot.price == null ? null : Number(plot.price) })) });
  } catch (_error) {
    return res.status(400).json({ error: "This selection link is invalid or expired.", code: "SELECTION_TOKEN_INVALID" });
  }
});

router.post("/public/selection/:token", async (req, res) => {
  try {
    const { tenantId, contactId } = verifySelectionToken(req.params.token);
    const pickupLocationId = Number(req.body?.pickupLocationId);
    const plotSiteId = Number(req.body?.plotSiteId);
    if (!Number.isInteger(pickupLocationId) || pickupLocationId <= 0 || !Number.isInteger(plotSiteId) || plotSiteId <= 0) {
      return res.status(400).json({ error: "Select a pickup location and an interested plot.", code: "SELECTION_REQUIRED" });
    }
    const [tenant, contact, pickupLocation, plot] = await Promise.all([
      prisma.tenant.findFirst({ where: { id: tenantId, vertical: "generic" }, select: { id: true } }),
      prisma.contact.findFirst({ where: { id: contactId, tenantId, deletedAt: null }, select: { id: true } }),
      prisma.pickupLocation.findFirst({ where: { id: pickupLocationId, tenantId, isActive: true }, select: { id: true, address: true } }),
      prisma.plotSite.findFirst({ where: { id: plotSiteId, tenantId, isActive: true }, select: { id: true, name: true, plotNumber: true, price: true, availability: true } }),
    ]);
    if (!tenant || !contact) return res.status(404).json({ error: "This selection link is no longer available.", code: "SELECTION_NOT_FOUND" });
    if (!pickupLocation) return res.status(400).json({ error: "That pickup location is no longer available.", code: "PICKUP_LOCATION_UNAVAILABLE" });
    if (!plot || String(plot.availability || "").toUpperCase() !== "AVAILABLE") return res.status(409).json({ error: "That plot is no longer available. Please choose another.", code: "PLOT_NOT_AVAILABLE" });

    const result = await prisma.$transaction(async (tx) => {
      // Serialize submissions for this contact. Without this lock, two quick
      // clicks could both pass the read check and create different bookings.
      await tx.$queryRaw`SELECT id FROM Contact WHERE id = ${contactId} AND tenantId = ${tenantId} FOR UPDATE`;
      if (await hasCompletedPublicSelection(tx, tenantId, contactId)) {
        const alreadyCompleted = new Error("This selection link has already been used.");
        alreadyCompleted.code = "SELECTION_ALREADY_COMPLETED";
        throw alreadyCompleted;
      }
      await tx.contact.update({
        where: { id: contactId },
        data: { interestedPlotArea: `${plot.name}${plot.plotNumber ? ` - Plot ${plot.plotNumber}` : ""}` },
      });
      const pickup = await tx.customerPickup.upsert({
        where: { tenantId_contactId: { tenantId, contactId } },
        create: { tenantId, contactId, pickupAddress: pickupLocation.address, sourceExcerpt: PUBLIC_SELECTION_SOURCE },
        update: { pickupAddress: pickupLocation.address, sourceExcerpt: PUBLIC_SELECTION_SOURCE },
      });
      const existing = await tx.plotBooking.findFirst({ where: { tenantId, contactId, plotSiteId, status: { not: "CANCELLED" } }, select: { id: true, bookingNumber: true } });
      const booking = existing || await tx.plotBooking.create({ data: { bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`, tenantId, contactId, customerPickupId: pickup.id, plotSiteId, status: "PLOT_ASSIGNED", paymentStatus: "UNPAID", totalAmount: Number(plot.price || 0), balance: Number(plot.price || 0) }, select: { id: true, bookingNumber: true } });
      return { pickup, booking };
    });
    require("../lib/eventBus").emitEvent(
      "pickup_plot.selected",
      {
        contactId,
        pickupPointId: result.pickup.id,
        pickupLocationId,
        plotSiteId,
        bookingId: result.booking.id,
      },
      tenantId,
    ).catch((eventError) => console.error("[GenericCampaign] pickup/plot selection event failed:", eventError.message));
    return res.status(200).json({ saved: true, pickupAddress: result.pickup.pickupAddress, plot: { id: plot.id, name: plot.name, plotNumber: plot.plotNumber }, bookingId: result.booking.id });
  } catch (error) {
    if (error?.code === "SELECTION_ALREADY_COMPLETED") return res.status(409).json({ error: "This selection link has already been used.", code: error.code, completed: true });
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError") return res.status(400).json({ error: "This selection link is invalid or expired.", code: "SELECTION_TOKEN_INVALID" });
    console.error("pickup-plot-inventory public selection error:", error);
    return res.status(500).json({ error: "Unable to save your selection. Please try again.", code: "SELECTION_SAVE_FAILED" });
  }
});

router.use(verifyToken, requireGenericTenant);

async function workspaceCallingProfiles(req) {
  const select = { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true };
  const tenantId = req.user.tenantId;
  if (isAdminWorkspaceOverview(req)) {
    const [transportPeople, brokers] = await Promise.all([
      prisma.transportPerson.findMany({ where: { tenantId, isActive: true }, select }),
      prisma.plotBroker.findMany({ where: { tenantId, isActive: true }, select }),
    ]);
    return [...transportPeople, ...brokers];
  }
  const [transportPerson, broker] = await Promise.all([
    prisma.transportPerson.findFirst({ where: { tenantId, userId: req.user.userId, isActive: true }, select }),
    prisma.plotBroker.findFirst({ where: { tenantId, userId: req.user.userId, isActive: true }, select }),
  ]);
  return [transportPerson, broker].filter(Boolean);
}

async function findWorkspaceCallCustomer(req) {
  const contactId = Number(req.params.contactId);
  if (!Number.isInteger(contactId) || contactId <= 0) return null;
  const profiles = await workspaceCallingProfiles(req);
  const assigned = profiles.some((profile) => assignmentPairs(profile)
    .some((pair) => pair.customerId === contactId));
  if (!assigned) return null;
  return prisma.contact.findFirst({
    where: { id: contactId, tenantId: req.user.tenantId, deletedAt: null },
    select: { id: true, name: true, phone: true, email: true, company: true },
  });
}

router.get("/calling/campaigns", async (req, res) => {
  try {
    const profiles = await workspaceCallingProfiles(req);
    if (!isAdminWorkspaceOverview(req) && profiles.length === 0) {
      return res.status(403).json({ error: "No active transport or Sales Executive profile is linked to this login", code: "CALLING_PROFILE_NOT_LINKED" });
    }
    const campaigns = await callifiedClient.listCampaigns(req.user.tenantId);
    return res.json({ campaigns: Array.isArray(campaigns) ? campaigns : [] });
  } catch (error) {
    return sendCallifiedError(res, error, "[pickup-plot-inventory] calling campaigns", "Failed to fetch Callified campaigns");
  }
});

router.get("/calling/customers/:contactId/context", async (req, res) => {
  try {
    const customer = await findWorkspaceCallCustomer(req);
    if (!customer) return res.status(404).json({ error: "Assigned customer not found", code: "CALLING_CUSTOMER_NOT_FOUND" });
    const normalizedPhone = callifiedClient.normalizeCallifiedPhone(customer.phone || "");
    const phoneValid = normalizedPhone.replace(/\D/g, "").length >= 10;
    const recent = await wasRecentlyDialed(req.user.tenantId, customer.id);
    return res.json({
      contactId: customer.id,
      patientName: customer.name,
      phone: customer.phone || null,
      normalizedPhone: phoneValid ? normalizedPhone : null,
      phoneValid,
      recentCallAt: recent ? recent.toISOString() : null,
    });
  } catch (error) {
    return sendCallifiedError(res, error, "[pickup-plot-inventory] calling context", "Failed to load call details for this customer");
  }
});

router.post("/calling/customers/:contactId/ai-call", async (req, res) => {
  try {
    const campaignId = Number(req.body?.campaignId);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
    }
    const customer = await findWorkspaceCallCustomer(req);
    if (!customer) return res.status(404).json({ error: "Assigned customer not found", code: "CALLING_CUSTOMER_NOT_FOUND" });
    const recent = await wasRecentlyDialed(req.user.tenantId, customer.id);
    if (recent) return res.status(429).json(redialCooldownError(recent));

    await clearDnpRetryState(customer.id).catch((error) => {
      console.error(`[pickup-plot-inventory] failed to clear DNP retry state for contact ${customer.id}:`, error.message);
    });
    await prisma.contact.update({
      where: { id: customer.id, tenantId: req.user.tenantId },
      data: {
        callifiedLeadStatus: CALL_STATUS.CONNECTED,
        callifiedLeadStatusSource: "manual",
        callifiedLeadStatusReason: "Workspace call in progress.",
        callifiedLeadStatusUpdatedAt: new Date(),
      },
    });
    const result = await callifiedClient.initiateCallForContact({
      tenantId: req.user.tenantId,
      contactId: customer.id,
      campaignId,
      userId: req.user.userId,
      interest: "Generic CRM pickup and plot customer",
    });
    await writeAudit("CallifiedCall", "INITIATE", String(result.callifiedLeadId), req.user.userId, req.user.tenantId, {
      surface: "generic_pickup_plot_workspace",
      mode: "ai",
      contactId: customer.id,
      campaignId,
    });
    return res.json({ ...result, mode: "ai", contactId: customer.id });
  } catch (error) {
    return sendCallifiedError(res, error, "[pickup-plot-inventory] customer ai-call", "Failed to start the AI call");
  }
});

router.post("/calling/customers/:contactId/manual-call", async (req, res) => {
  try {
    const campaignId = Number(req.body?.campaignId);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      return res.status(400).json({ error: "campaignId is required", code: "MISSING_CAMPAIGN_ID" });
    }
    const customer = await findWorkspaceCallCustomer(req);
    if (!customer) return res.status(404).json({ error: "Assigned customer not found", code: "CALLING_CUSTOMER_NOT_FOUND" });
    const recent = await wasRecentlyDialed(req.user.tenantId, customer.id);
    if (recent) return res.status(429).json(redialCooldownError(recent));

    const result = await startBrowserCall({
      tenantId: req.user.tenantId,
      contactId: customer.id,
      campaignId,
      userId: req.user.userId,
      interest: "Generic CRM pickup and plot customer",
    });
    await writeAudit("CallifiedCall", "BROWSER_CALL", String(result.callifiedLeadId), req.user.userId, req.user.tenantId, {
      surface: "generic_pickup_plot_workspace",
      mode: "browser",
      contactId: customer.id,
      campaignId,
      callSid: result.callSid,
    });
    return res.json({ ...result, contactId: customer.id });
  } catch (error) {
    return sendCallifiedError(res, error, "[pickup-plot-inventory] customer manual-call", "Failed to start the manual call");
  }
});

const WORKSPACE_ASSIGNMENT_TYPES = Object.freeze({
  transport: {
    module: "transport_workspace",
    model: "transportPerson",
  },
  broker: {
    module: "broker_workspace",
    model: "plotBroker",
  },
  billing: {
    module: "billing_workspace",
    model: "billingPerson",
  },
});
function isAssignableOperationalStaff(user) {
  if (user?.userType !== "STAFF" || user?.deactivatedAt) return false;
  const assignedRoleKeys = (user?.userRoles || [])
    .map(({ role }) => String(role?.key || "").trim().toUpperCase())
    .filter(Boolean);
  const effectiveRoleKeys = assignedRoleKeys.length
    ? assignedRoleKeys
    : [String(user?.role || "").trim().toUpperCase()].filter(Boolean);
  return effectiveRoleKeys.length > 0
    && effectiveRoleKeys.every((key) => !NON_ASSIGNABLE_STAFF_ROLE_KEYS.has(key));
}

function operationalProfileData(type, user, tenantId) {
  const shared = {
    name: user.name,
    phone: user.phone || "",
    userId: user.id,
    tenantId,
    isActive: true,
  };
  if (type === "transport") return shared;
  return { ...shared, email: user.email };
}

// One admin surface for assigning any combination of operational work to an
// existing staff member. The person's normal RBAC role is retained; workspace
// permissions are additive capabilities, while these linked profiles decide
// which queues actually contain work for that login.
router.get("/work-assignments", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [users, transportPeople, brokers, billingPeople] = await Promise.all([
      prisma.user.findMany({
        where: {
          tenantId,
          deactivatedAt: null,
          userType: "STAFF",
        },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          role: true,
          userType: true,
          deactivatedAt: true,
          userRoles: {
            select: { role: { select: { key: true } } },
          },
        },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId },
        select: { id: true, userId: true, isActive: true },
      }),
      prisma.plotBroker.findMany({
        where: { tenantId },
        select: { id: true, userId: true, isActive: true },
      }),
      prisma.billingPerson.findMany({
        where: { tenantId },
        select: { id: true, userId: true, isActive: true },
      }),
    ]);
    const byUser = (rows) => new Map(rows.filter((row) => row.userId).map((row) => [Number(row.userId), row]));
    const transportByUser = byUser(transportPeople);
    const brokerByUser = byUser(brokers);
    const billingByUser = byUser(billingPeople);
    return res.json({
      staff: users.filter(isAssignableOperationalStaff).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        workTypes: [
          ...(transportByUser.get(user.id)?.isActive ? ["transport"] : []),
          ...(brokerByUser.get(user.id)?.isActive ? ["broker"] : []),
          ...(billingByUser.get(user.id)?.isActive ? ["billing"] : []),
        ],
        profiles: {
          transport: transportByUser.get(user.id)?.id || null,
          broker: brokerByUser.get(user.id)?.id || null,
          billing: billingByUser.get(user.id)?.id || null,
        },
      })),
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /work-assignments error:", error);
    return res.status(500).json({ error: "Failed to load staff work assignments", code: "WORK_ASSIGNMENTS_LOAD_FAILED" });
  }
});

router.put("/work-assignments", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const targetUserId = Number(req.body?.targetUserId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
      return res.status(400).json({ error: "Select a valid staff member.", code: "INVALID_STAFF_USER" });
    }
    if (!Array.isArray(req.body?.workTypes)) {
      return res.status(400).json({ error: "workTypes must be an array.", code: "INVALID_WORK_TYPES" });
    }
    const requested = [...new Set(req.body.workTypes.map((value) => String(value || "").trim().toLowerCase()))];
    if (requested.some((type) => !WORKSPACE_ASSIGNMENT_TYPES[type])) {
      return res.status(400).json({ error: "Choose only Transport, Site Visits, or Billing work.", code: "INVALID_WORK_TYPES" });
    }
    const user = await prisma.user.findFirst({
      where: {
        id: targetUserId,
        tenantId,
        deactivatedAt: null,
        userType: "STAFF",
      },
      include: { userRoles: { select: { role: { select: { key: true } } } } },
    });
    if (!user) {
      return res.status(404).json({ error: "Staff member not found.", code: "STAFF_USER_NOT_FOUND" });
    }
    if (!isAssignableOperationalStaff(user)) {
      return res.status(400).json({
        error: "Admin, Manager, Customer, and Owner accounts cannot receive operational work here.",
        code: "STAFF_ROLE_NOT_ASSIGNABLE",
      });
    }
    await prisma.$transaction(async (tx) => {
      for (const [type, config] of Object.entries(WORKSPACE_ASSIGNMENT_TYPES)) {
        const enabled = requested.includes(type);
        if (enabled) {
          await tx[config.model].upsert({
            where: { userId: targetUserId },
            create: operationalProfileData(type, user, tenantId),
            update: { isActive: true },
          });
        } else {
          await tx[config.model].updateMany({
            where: { tenantId, userId: targetUserId },
            data: { isActive: false },
          });
        }
      }
    });
    clearUserCache(targetUserId, tenantId);
    return res.json({
      targetUserId,
      workTypes: requested,
      message: requested.length
        ? "Staff work assignments updated."
        : "Operational work removed from this staff member.",
    });
  } catch (error) {
    console.error("pickup-plot-inventory PUT /work-assignments error:", error);
    return res.status(500).json({ error: "Failed to update staff work assignments", code: "WORK_ASSIGNMENTS_UPDATE_FAILED" });
  }
});

function selfOperationalProfile(
  person,
  roleType,
  plotMap,
  customerMap = new Map(),
  pickupLocationMap = new Map(),
  completedCustomerIds = new Set(),
) {
  const pairs = assignmentPairs(person);
  const plotIds = parseStoredArray(person.plotSiteIdsJson).map(Number).filter(Number.isInteger);
  if (plotIds.length === 0 && person.plotSiteId) plotIds.push(Number(person.plotSiteId));
  if (plotIds.length === 0) plotIds.push(...pairs.map((pair) => pair.plotSiteId));
  const pickupLocationIds = roleType === "transport"
    ? parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger)
    : [];
  if (roleType === "transport" && pickupLocationIds.length === 0 && person.pickupLocationId) {
    pickupLocationIds.push(Number(person.pickupLocationId));
  }
  return {
    roleType,
    profile: {
      id: person.id,
      alternatePhone: person.alternatePhone || null,
      vehicleType: person.vehicleType || null,
      vehicleNumber: person.vehicleNumber || null,
      agency: person.agency || null,
      commissionPercent: person.commissionPercent ?? null,
      notes: person.notes || null,
      serviceAreas: roleType === "transport" ? parseStoredArray(person.serviceAreasJson) : [],
      isActive: person.isActive,
    },
    assignedPlots: plotIds.map((id) => plotMap.get(id)).filter(Boolean),
    ...(roleType === "transport" ? {
      assignedPickupLocations: pickupLocationIds.map((id) => pickupLocationMap.get(id)).filter(Boolean),
    } : {}),
    assignments: pairs.filter((pair) => !completedCustomerIds.has(pair.customerId)).map((pair) => ({
      customerId: pair.customerId,
      plotSiteId: pair.plotSiteId,
      customer: customerMap.get(pair.customerId) || null,
      plot: plotMap.get(pair.plotSiteId) || null,
    })).filter((row) => row.customer),
  };
}

function completedSelfProfileCustomerIds(person, roleType, fullyCompletedCustomerIds = new Set()) {
  const completed = new Set(fullyCompletedCustomerIds);
  const statusField = roleType === "transport" ? "assignmentStatusJson" : "workflowStatusJson";
  const statuses = parseStoredObject(person?.[statusField]);

  for (const pair of assignmentPairs(person)) {
    const saved = statuses[assignmentKey(pair.customerId, pair.plotSiteId)]
      || statuses[`customer-${pair.customerId}`];
    if (roleType === "transport" && saved?.status === "COMPLETED") {
      completed.add(pair.customerId);
    }
    if (roleType === "broker" && (
      normalizeBrokerWorkflowStatus(saved) === "PLOT_SELECTED"
      || saved?.status === "CLOSED_NO_INTEREST"
    )) {
      completed.add(pair.customerId);
    }
  }

  return completed;
}

function validateStartedTransportAssignments(existing, nextPairs) {
  if (!existing) return null;
  const statuses = parseStoredObject(existing.assignmentStatusJson);
  for (const currentPair of assignmentPairs(existing)) {
    const saved = statuses[assignmentKey(currentPair.customerId, currentPair.plotSiteId)]
      || statuses[`customer-${currentPair.customerId}`];
    if (!TRANSPORT_STATUS_FLOW.includes(saved?.status) || saved.status === TRANSPORT_STATUS_FLOW[0]) continue;
    const nextPair = nextPairs.find((pair) => pair.customerId === currentPair.customerId);
    if (!nextPair || nextPair.plotSiteId !== currentPair.plotSiteId) {
      return {
        error: "The assigned plot cannot be changed after the trip has started.",
        code: "ASSIGNMENT_PLOT_LOCKED",
        status: 409,
      };
    }
  }
  return null;
}

function completedTransportAssignmentPairs(person) {
  if (!person) return [];
  const statuses = parseStoredObject(person.assignmentStatusJson);
  return assignmentPairs(person).filter((pair) => {
    const saved = statuses[assignmentKey(pair.customerId, pair.plotSiteId)]
      || statuses[`customer-${pair.customerId}`];
    return saved?.status === "COMPLETED";
  });
}

function assignmentPairsChanged(currentPairs, requestedPairs) {
  const canonical = (pairs) => pairs
    .map((row) => `${Number(row.customerId)}:${Number(row.plotSiteId)}`)
    .sort()
    .join("|");
  return canonical(currentPairs) !== canonical(requestedPairs);
}

function idListsChanged(currentIds, requestedIds) {
  const canonical = (ids) => [...new Set(ids.map(Number).filter(Number.isInteger))].sort((a, b) => a - b).join("|");
  return canonical(currentIds) !== canonical(requestedIds);
}

async function findSelfOperationalRecord(tenantId, userId) {
  const where = { tenantId, userId };
  const [transport, broker, billing] = await Promise.all([
    prisma.transportPerson.findFirst({ where }),
    prisma.plotBroker.findFirst({ where }),
    prisma.billingPerson.findFirst({ where }),
  ]);
  if (transport) return { roleType: "transport", person: transport, model: prisma.transportPerson };
  if (broker) return { roleType: "broker", person: broker, model: prisma.plotBroker };
  if (billing) return { roleType: "billing", person: billing, model: prisma.billingPerson };
  return null;
}

// Self-service operational profile for Transport, Broker, and Billing staff.
// The linked userId + tenantId pair is the authority boundary: callers never
// provide a profile id and therefore cannot read or update another employee.
router.get("/people/me", async (req, res) => {
  try {
    const linked = await findSelfOperationalRecord(req.user.tenantId, req.user.userId);
    if (!linked) {
      return res.status(404).json({
        error: "No transport, broker, or billing profile is linked to this login",
        code: "OPERATIONAL_PROFILE_NOT_LINKED",
      });
    }
    const pairs = assignmentPairs(linked.person);
    const assignedPlotIds = parseStoredArray(linked.person.plotSiteIdsJson).map(Number).filter(Number.isInteger);
    if (assignedPlotIds.length === 0 && linked.person.plotSiteId) assignedPlotIds.push(Number(linked.person.plotSiteId));
    const plotIds = [...new Set([...assignedPlotIds, ...pairs.map((row) => row.plotSiteId)])];
    const customerIds = [...new Set(pairs.map((row) => row.customerId))];
    const assignedPickupLocationIds = linked.roleType === "transport"
      ? parseStoredArray(linked.person.pickupLocationIdsJson).map(Number).filter(Number.isInteger)
      : [];
    if (linked.roleType === "transport" && assignedPickupLocationIds.length === 0 && linked.person.pickupLocationId) {
      assignedPickupLocationIds.push(Number(linked.person.pickupLocationId));
    }
    const [plots, customers, plotOptions, pickupLocations, pickupLocationOptions, completedCustomerIds] = await Promise.all([
      plotIds.length ? prisma.plotSite.findMany({
        where: { tenantId: req.user.tenantId, id: { in: plotIds } },
        select: { id: true, name: true, address: true, referenceCode: true, availability: true },
      }) : [],
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId: req.user.tenantId, id: { in: customerIds } },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      prisma.plotSite.findMany({
        where: { tenantId: req.user.tenantId, isActive: true },
        select: { id: true, name: true, address: true, referenceCode: true, availability: true },
        orderBy: { name: "asc" },
      }),
      linked.roleType === "transport" && assignedPickupLocationIds.length
        ? prisma.pickupLocation.findMany({
            where: { tenantId: req.user.tenantId, id: { in: assignedPickupLocationIds } },
            select: { id: true, name: true, address: true, isActive: true },
          })
        : [],
      linked.roleType === "transport"
        ? prisma.pickupLocation.findMany({
            where: { tenantId: req.user.tenantId, isActive: true },
            select: { id: true, name: true, address: true, isActive: true },
            orderBy: { name: "asc" },
          })
        : [],
      findCompletedCustomerIds(req.user.tenantId, customerIds),
    ]);
    const hiddenCustomerIds = completedSelfProfileCustomerIds(
      linked.person,
      linked.roleType,
      completedCustomerIds,
    );
    return res.json({ ...selfOperationalProfile(
      linked.person,
      linked.roleType,
      new Map(plots.map((row) => [row.id, row])),
      new Map(customers.map((row) => [row.id, row])),
      new Map(pickupLocations.map((row) => [row.id, row])),
      hiddenCustomerIds,
    ), plotOptions, ...(linked.roleType === "transport" ? { pickupLocationOptions } : {}) });
  } catch (error) {
    console.error("pickup-plot-inventory GET /people/me error:", error);
    return res.status(500).json({ error: "Failed to load your work profile", code: "SELF_PROFILE_LOAD_FAILED" });
  }
});

router.put("/people/me", async (req, res) => {
  try {
    const linked = await findSelfOperationalRecord(req.user.tenantId, req.user.userId);
    if (!linked) {
      return res.status(404).json({
        error: "No transport, broker, or billing profile is linked to this login",
        code: "OPERATIONAL_PROFILE_NOT_LINKED",
      });
    }
    if (req.body?.roleType && req.body.roleType !== linked.roleType) {
      return res.status(403).json({ error: "This profile type is not linked to your login", code: "PROFILE_TYPE_MISMATCH" });
    }

    const currentPairs = assignmentPairs(linked.person);
    const customerIds = [...new Set(currentPairs.map((row) => row.customerId))];
    let incompleteAssignments = null;
    const hasIncompleteAssignments = async () => {
      if (incompleteAssignments !== null) return incompleteAssignments;
      const fullyCompletedCustomerIds = await findCompletedCustomerIds(req.user.tenantId, customerIds);
      const completedCustomerIds = completedSelfProfileCustomerIds(
        linked.person,
        linked.roleType,
        fullyCompletedCustomerIds,
      );
      incompleteAssignments = currentPairs.some((pair) => !completedCustomerIds.has(pair.customerId));
      return incompleteAssignments;
    };
    if (req.body?.assignments !== undefined) {
      const requestedPairs = normalizeAssignmentPairs(
        req.body.assignments,
        customerIds,
        Array.isArray(req.body.assignments)
          ? req.body.assignments.map((row) => Number(row?.plotSiteId))
          : [],
      );
      if (!Array.isArray(requestedPairs) || assignmentPairsChanged(currentPairs, requestedPairs)) {
        return res.status(403).json({
          error: "Customer plot assignments can only be changed by an administrator.",
          code: "CUSTOMER_ASSIGNMENTS_ADMIN_ONLY",
        });
      }
    }

    const data = {
      notes: text(req.body?.notes, 4000),
    };
    if (req.body?.plotSiteIds !== undefined) {
      const selectedPlotIds = parseIdList(req.body.plotSiteIds, "Plots or sites");
      if (!Array.isArray(selectedPlotIds)) {
        return res.status(400).json({ error: selectedPlotIds.error, code: "INVALID_PLOT_SITE" });
      }
      const currentPlotIds = parseStoredArray(linked.person.plotSiteIdsJson).map(Number).filter(Number.isInteger);
      if (currentPlotIds.length === 0 && linked.person.plotSiteId) currentPlotIds.push(Number(linked.person.plotSiteId));
      if (idListsChanged(currentPlotIds, selectedPlotIds) && await hasIncompleteAssignments()) {
        return res.status(409).json({
          error: "Complete all assigned customer steps before changing plots or sites.",
          code: "ASSIGNED_CUSTOMERS_INCOMPLETE",
        });
      }
      const validPlots = selectedPlotIds.length ? await prisma.plotSite.findMany({
        where: { tenantId: req.user.tenantId, id: { in: selectedPlotIds }, isActive: true },
        select: { id: true },
      }) : [];
      if (validPlots.length !== selectedPlotIds.length) {
        return res.status(400).json({ error: "Select valid active plots or sites.", code: "INVALID_PLOT_SITE" });
      }
      data.plotSiteIdsJson = selectedPlotIds.length ? sanitizeJsonForStringColumn(selectedPlotIds) : null;
      if (linked.roleType === "broker") {
        data.plotSiteId = selectedPlotIds[0] || null;
      }
    }
    if (req.body?.pickupLocationIds !== undefined) {
      if (linked.roleType !== "transport") {
        return res.status(403).json({
          error: "Pickup locations can only be changed from a transport profile.",
          code: "PICKUP_LOCATIONS_TRANSPORT_ONLY",
        });
      }
      const selectedPickupLocationIds = parseIdList(req.body.pickupLocationIds, "Pickup locations");
      if (!Array.isArray(selectedPickupLocationIds)) {
        return res.status(400).json({ error: selectedPickupLocationIds.error, code: "INVALID_PICKUP_LOCATION" });
      }
      const currentPickupLocationIds = parseStoredArray(linked.person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
      if (currentPickupLocationIds.length === 0 && linked.person.pickupLocationId) {
        currentPickupLocationIds.push(Number(linked.person.pickupLocationId));
      }
      if (idListsChanged(currentPickupLocationIds, selectedPickupLocationIds) && await hasIncompleteAssignments()) {
        return res.status(409).json({
          error: "Complete all assigned customer steps before changing pickup locations.",
          code: "ASSIGNED_CUSTOMERS_INCOMPLETE",
        });
      }
      const validPickupLocations = selectedPickupLocationIds.length ? await prisma.pickupLocation.findMany({
        where: { tenantId: req.user.tenantId, id: { in: selectedPickupLocationIds }, isActive: true },
        select: { id: true },
      }) : [];
      if (validPickupLocations.length !== selectedPickupLocationIds.length) {
        return res.status(400).json({ error: "Select valid active pickup locations.", code: "INVALID_PICKUP_LOCATION" });
      }
      data.pickupLocationIdsJson = selectedPickupLocationIds.length
        ? sanitizeJsonForStringColumn(selectedPickupLocationIds)
        : null;
      data.pickupLocationId = selectedPickupLocationIds[0] || null;
    }
    let validationError = validateOptionalText(req.body?.notes, "Notes", 4000);
    if (linked.roleType === "transport") {
      validationError = firstError(
        validationError,
        validatePhone(req.body?.alternatePhone, "Alternate phone", { required: false }),
        validateOptionalText(req.body?.vehicleType, "Vehicle type", 100),
        validateVehicleNumber(req.body?.vehicleNumber),
      );
      data.alternatePhone = text(req.body?.alternatePhone, 25);
      data.vehicleType = text(req.body?.vehicleType, 100);
      data.vehicleNumber = text(req.body?.vehicleNumber, 100);
    } else if (linked.roleType === "broker") {
      validationError = firstError(validationError, validateOptionalText(req.body?.agency, "Agency", 150));
      data.agency = text(req.body?.agency, 150);
    }
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });

    const updated = await linked.model.update({ where: { id: linked.person.id }, data });
    const updatedPairs = assignmentPairs(updated);
    const assignedPlotIds = parseStoredArray(updated.plotSiteIdsJson).map(Number).filter(Number.isInteger);
    if (assignedPlotIds.length === 0 && updated.plotSiteId) assignedPlotIds.push(Number(updated.plotSiteId));
    const updatedPlotIds = [...new Set([...assignedPlotIds, ...updatedPairs.map((row) => row.plotSiteId)])];
    const updatedPickupLocationIds = linked.roleType === "transport"
      ? parseStoredArray(updated.pickupLocationIdsJson).map(Number).filter(Number.isInteger)
      : [];
    if (linked.roleType === "transport" && updatedPickupLocationIds.length === 0 && updated.pickupLocationId) {
      updatedPickupLocationIds.push(Number(updated.pickupLocationId));
    }
    const [plots, customers, plotOptions, pickupLocations, pickupLocationOptions, completedCustomerIds] = await Promise.all([
      updatedPlotIds.length ? prisma.plotSite.findMany({
        where: { tenantId: req.user.tenantId, id: { in: updatedPlotIds } },
        select: { id: true, name: true, address: true, referenceCode: true, availability: true },
      }) : [],
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId: req.user.tenantId, id: { in: customerIds } },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      prisma.plotSite.findMany({
        where: { tenantId: req.user.tenantId, isActive: true },
        select: { id: true, name: true, address: true, referenceCode: true, availability: true },
        orderBy: { name: "asc" },
      }),
      linked.roleType === "transport" && updatedPickupLocationIds.length
        ? prisma.pickupLocation.findMany({
            where: { tenantId: req.user.tenantId, id: { in: updatedPickupLocationIds } },
            select: { id: true, name: true, address: true, isActive: true },
          })
        : [],
      linked.roleType === "transport"
        ? prisma.pickupLocation.findMany({
            where: { tenantId: req.user.tenantId, isActive: true },
            select: { id: true, name: true, address: true, isActive: true },
            orderBy: { name: "asc" },
          })
        : [],
      findCompletedCustomerIds(req.user.tenantId, customerIds),
    ]);
    const hiddenCustomerIds = completedSelfProfileCustomerIds(
      updated,
      linked.roleType,
      completedCustomerIds,
    );
    return res.json({ ...selfOperationalProfile(
      updated,
      linked.roleType,
      new Map(plots.map((row) => [row.id, row])),
      new Map(customers.map((row) => [row.id, row])),
      new Map(pickupLocations.map((row) => [row.id, row])),
      hiddenCustomerIds,
    ), plotOptions, ...(linked.roleType === "transport" ? { pickupLocationOptions } : {}) });
  } catch (error) {
    console.error("pickup-plot-inventory PUT /people/me error:", error);
    return res.status(500).json({ error: "Failed to update your work profile", code: "SELF_PROFILE_UPDATE_FAILED" });
  }
});

router.get("/transport-persons/me", requirePermission("transport_workspace", "read"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const adminOverview = isAdminWorkspaceOverview(req);
    const people = adminOverview
      ? await prisma.transportPerson.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } })
      : [await prisma.transportPerson.findFirst({
          where: { tenantId, userId: req.user.userId, isActive: true },
        })].filter(Boolean);
    if (people.length === 0 && !adminOverview) {
      return res.status(403).json({
        error: "No active transport profile is linked to this login",
        code: "TRANSPORT_PROFILE_NOT_LINKED",
      });
    }
    const pickupLocationIds = [...new Set(people.flatMap((person) => {
      const ids = parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
      if (ids.length === 0 && person.pickupLocationId) ids.push(person.pickupLocationId);
      return ids;
    }))];
    const pairs = people.flatMap(assignmentPairs);
    const plotSiteIds = [...new Set(pairs.map((row) => row.plotSiteId).filter(Number.isInteger))];
    const customerIds = [...new Set(pairs.map((row) => row.customerId).filter(Number.isInteger))];
    const [pickupLocations, plots, customers, customerPickups] = await Promise.all([
      pickupLocationIds.length ? prisma.pickupLocation.findMany({
        where: { tenantId, id: { in: pickupLocationIds } },
        select: { id: true, name: true, address: true, googleMapsLink: true },
      }) : [],
      plotSiteIds.length ? prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotSiteIds }, isActive: true },
        select: { id: true, name: true, address: true, referenceCode: true },
      }) : [],
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds }, deletedAt: null },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      customerIds.length ? prisma.customerPickup.findMany({
        where: { tenantId, contactId: { in: customerIds } },
        select: { id: true, contactId: true, pickupAddress: true },
      }) : [],
    ]);
    const customerPickupMap = new Map(customerPickups.map((row) => [row.contactId, row]));
    const assignments = people.flatMap((person) => buildTransportAssignments(
      person, pickupLocations, plots, customers, customerPickupMap, true,
    ).map((assignment) => ({ ...assignment, assignedStaff: assignedStaff(person) })));
    const person = people[0] || null;
    return res.json({
      isAdminOverview: adminOverview,
      transportPerson: adminOverview || !person ? null : {
        id: person.id,
        name: person.name,
        phone: person.phone,
        vehicleType: person.vehicleType,
        vehicleNumber: person.vehicleNumber,
      },
      assignments,
      summary: {
        total: assignments.length,
        active: assignments.filter((row) => row.status !== "COMPLETED").length,
        completed: assignments.filter((row) => row.status === "COMPLETED").length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /transport-persons/me error:", error);
    return res.status(500).json({ error: "Failed to load assigned transport work", code: "TRANSPORT_WORK_LOAD_FAILED" });
  }
});

router.patch("/transport-persons/me/assignments/:assignmentKey/schedule", requirePermission("transport_workspace", "update"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const assignedProfileId = adminAssignedProfileId(req);
    const person = await prisma.transportPerson.findFirst({
      where: {
        tenantId,
        ...(assignedProfileId ? { id: assignedProfileId } : { userId: req.user.userId }),
        isActive: true,
      },
    });
    if (!person) {
      return res.status(403).json({ error: "No active transport profile is linked to this login", code: "TRANSPORT_PROFILE_NOT_LINKED" });
    }
    const assignments = buildTransportAssignments(
      person,
      [],
      parseStoredArray(person.plotSiteIdsJson).map((id) => ({ id: Number(id) })),
      parseStoredArray(person.customerIdsJson).map((id) => ({ id: Number(id) })),
    );
    const assignment = assignments.find((row) => row.assignmentKey === req.params.assignmentKey);
    if (!assignment) {
      return res.status(404).json({ error: "Assigned trip not found", code: "TRANSPORT_ASSIGNMENT_NOT_FOUND" });
    }
    if (assignment.status === "COMPLETED") {
      return res.status(409).json({ error: "Completed trip times cannot be rescheduled.", code: "TRANSPORT_TRIP_COMPLETED" });
    }
    const hasPickupTime = req.body?.scheduledPickupAt !== undefined;
    const hasDropOffTime = req.body?.scheduledDropOffAt !== undefined;
    if (!hasPickupTime && !hasDropOffTime) {
      return res.status(400).json({ error: "Choose a pickup or drop-off time.", code: "INVALID_TRANSPORT_SCHEDULE" });
    }
    const pickupDate = hasPickupTime ? new Date(req.body.scheduledPickupAt) : null;
    const dropOffDate = hasDropOffTime ? new Date(req.body.scheduledDropOffAt) : null;
    if ((pickupDate && Number.isNaN(pickupDate.getTime())) || (dropOffDate && Number.isNaN(dropOffDate.getTime()))) {
      return res.status(400).json({ error: "Choose a valid pickup or drop-off time.", code: "INVALID_TRANSPORT_SCHEDULE" });
    }
    const currentMinute = new Date();
    currentMinute.setSeconds(0, 0);
    if ((pickupDate && pickupDate < currentMinute) || (dropOffDate && dropOffDate < currentMinute)) {
      return res.status(400).json({ error: "Pickup and drop-off times must be the present time or a future time.", code: "TRANSPORT_SCHEDULE_IN_PAST" });
    }
    const statuses = parseStoredObject(person.assignmentStatusJson);
    const previousStatus = statuses[assignment.assignmentKey]
      || statuses[`customer-${assignment.customer?.id}`]
      || {};
    // Partial updates must also respect the other time already saved on the trip.
    const effectivePickupDate = pickupDate || (previousStatus.scheduledPickupAt
      ? new Date(previousStatus.scheduledPickupAt) : null);
    const effectiveDropOffDate = dropOffDate || (previousStatus.scheduledDropOffAt
      ? new Date(previousStatus.scheduledDropOffAt) : null);
    if (effectivePickupDate && effectiveDropOffDate && effectiveDropOffDate < effectivePickupDate) {
      return res.status(400).json({ error: "Drop-off time cannot be earlier than pickup time.", code: "INVALID_TRANSPORT_SCHEDULE_ORDER" });
    }
    statuses[assignment.assignmentKey] = {
      ...previousStatus,
      status: assignment.status,
      ...(pickupDate ? { scheduledPickupAt: pickupDate.toISOString() } : {}),
      ...(dropOffDate ? { scheduledDropOffAt: dropOffDate.toISOString() } : {}),
    };
    await saveWorkflowOptimistically(
      prisma.transportPerson,
      person,
      "assignmentStatusJson",
      statuses,
      tenantId,
    );
    await writeAudit("TransportPerson", "SCHEDULE_TRIP", String(person.id), req.user.userId, tenantId, {
      assignmentKey: assignment.assignmentKey,
      scheduledPickupAt: statuses[assignment.assignmentKey].scheduledPickupAt || null,
      scheduledDropOffAt: statuses[assignment.assignmentKey].scheduledDropOffAt || null,
    });
    return res.json({
      assignmentKey: assignment.assignmentKey,
      scheduledPickupAt: statuses[assignment.assignmentKey].scheduledPickupAt || null,
      scheduledDropOffAt: statuses[assignment.assignmentKey].scheduledDropOffAt || null,
      pickupAt: previousStatus.pickupAt || null,
      dropOffAt: previousStatus.dropOffAt || null,
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /transport-persons/me/assignments/:assignmentKey/schedule error:", error);
    return res.status(500).json({ error: "Failed to save pickup and drop-off times", code: "TRANSPORT_SCHEDULE_UPDATE_FAILED" });
  }
});

router.patch("/transport-persons/me/assignments/:assignmentKey/status", requirePermission("transport_workspace", "update"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const assignedProfileId = adminAssignedProfileId(req);
    const person = await prisma.transportPerson.findFirst({
      where: {
        tenantId,
        ...(assignedProfileId ? { id: assignedProfileId } : { userId: req.user.userId }),
        isActive: true,
      },
    });
    if (!person) {
      return res.status(403).json({ error: "No active transport profile is linked to this login", code: "TRANSPORT_PROFILE_NOT_LINKED" });
    }
    const pickupIds = parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
    if (pickupIds.length === 0 && person.pickupLocationId) pickupIds.push(person.pickupLocationId);
    const assignments = buildTransportAssignments(person, pickupIds.map((id) => ({ id })),
      parseStoredArray(person.plotSiteIdsJson).map((id) => ({ id: Number(id) })),
      parseStoredArray(person.customerIdsJson).map((id) => ({ id: Number(id) })));
    const assignment = assignments.find((row) => row.assignmentKey === req.params.assignmentKey);
    if (!assignment) {
      return res.status(404).json({ error: "Assigned trip not found", code: "TRANSPORT_ASSIGNMENT_NOT_FOUND" });
    }
    const currentIndex = TRANSPORT_STATUS_FLOW.indexOf(assignment.status);
    const nextStatus = TRANSPORT_STATUS_FLOW[currentIndex + 1];
    if (!nextStatus || req.body?.status !== nextStatus) {
      return res.status(409).json({
        error: nextStatus ? `The next status must be ${nextStatus}.` : "This trip is already complete.",
        code: "INVALID_TRANSPORT_STATUS_TRANSITION",
        currentStatus: assignment.status,
        nextStatus: nextStatus || null,
      });
    }
    const now = new Date().toISOString();
    const statuses = parseStoredObject(person.assignmentStatusJson);
    const previousStatus = statuses[assignment.assignmentKey]
      || statuses[`customer-${assignment.customer?.id}`]
      || {};
    statuses[assignment.assignmentKey] = {
      ...previousStatus,
      status: nextStatus,
      updatedAt: now,
      ...(nextStatus === "PICKED_UP" ? { pickupAt: now } : {}),
      ...(nextStatus === "COMPLETED" ? { dropOffAt: now } : {}),
    };
    await prisma.$transaction(async (tx) => {
      if (assignment.status === TRANSPORT_STATUS_FLOW[0] && nextStatus === TRANSPORT_STATUS_FLOW[1]) {
        await claimCustomerForPerson(tx, {
          modelName: "transportPerson",
          tenantId,
          claimantId: person.id,
          customerId: assignment.customer?.id,
          roleType: "transport",
          statusField: "assignmentStatusJson",
        });
      }
      await saveWorkflowOptimistically(
        tx.transportPerson,
        person,
        "assignmentStatusJson",
        statuses,
        tenantId,
      );
      await appendWorkflowEvent(tx, req, {
        contactId: assignment.customer?.id,
        plotSiteId: assignment.drop?.id,
        stage: "TRANSPORT",
        fromStatus: assignment.status,
        toStatus: nextStatus,
        occurredAt: now,
        metadata: { transportPersonId: person.id },
      });
    });
    return res.json({
      assignmentKey: assignment.assignmentKey,
      status: nextStatus,
      statusUpdatedAt: now,
      pickupAt: statuses[assignment.assignmentKey].pickupAt || null,
      dropOffAt: statuses[assignment.assignmentKey].dropOffAt || null,
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /transport-persons/me/assignments/:assignmentKey/status error:", error);
    return res.status(500).json({ error: "Failed to update trip status", code: "TRANSPORT_STATUS_UPDATE_FAILED" });
  }
});

router.get("/brokers/me", requirePermission("broker_workspace", "read"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const adminOverview = isAdminWorkspaceOverview(req);
    const brokers = adminOverview
      ? await prisma.plotBroker.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } })
      : [await prisma.plotBroker.findFirst({
          where: { tenantId, userId: req.user.userId, isActive: true },
        })].filter(Boolean);
    if (brokers.length === 0 && !adminOverview) {
      return res.status(403).json({
        error: "No active Sales Executive profile is linked to this login",
        code: "BROKER_PROFILE_NOT_LINKED",
      });
    }
    const brokerPairs = brokers.flatMap(assignmentPairs);
    const brokerPairKeys = new Set(brokerPairs.map((row) => assignmentKey(row.customerId, row.plotSiteId)));
    const transportPeople = (adminOverview || brokerPairs.length) ? await prisma.transportPerson.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true },
    }) : [];
    const completedTrips = completedTransportTrips(transportPeople);
    const tripDetails = transportTripDetails(transportPeople);
    const awaitingBrokerPairs = adminOverview
      ? transportPeople.flatMap(assignmentPairs).filter((pair) => (
          completedTrips.has(assignmentKey(pair.customerId, pair.plotSiteId))
          && !brokerPairKeys.has(assignmentKey(pair.customerId, pair.plotSiteId))
        ))
      : [];
    const pairs = [...brokerPairs, ...awaitingBrokerPairs];
    const customerIds = [...new Set(pairs.map((row) => row.customerId))];
    const plotSiteIds = [...new Set(pairs.map((row) => row.plotSiteId).filter(Number.isInteger))];
    const [customers, plots] = await Promise.all([
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds }, deletedAt: null },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      prisma.plotSite.findMany({
        where: {
          tenantId,
          isActive: true,
          id: { in: plotSiteIds },
        },
        select: { id: true, name: true, plotNumber: true, address: true, referenceCode: true, availability: true },
        orderBy: [{ plotNumber: "asc" }, { name: "asc" }],
      }),
    ]);
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const rows = brokers.flatMap((broker) => {
      const brokerStatuses = parseStoredObject(broker.workflowStatusJson);
      return assignmentPairs(broker).map(({ customerId, plotSiteId }) => {
        const customer = customerMap.get(customerId);
        const key = assignmentKey(customerId, plotSiteId);
        const tripCompleted = completedTrips.has(key);
        const trip = tripDetails.get(key) || {};
        const brokerWorkflow = brokerStatuses[key] || brokerStatuses[`customer-${customerId}`];
        const siteVisitAt = trip.dropOffAt || trip.scheduledDropOffAt || null;
        const brokerStatus = normalizeBrokerWorkflowStatus(brokerWorkflow);
        const effectiveBrokerStatus = brokerStatus === "READY_TO_SCHEDULE" && siteVisitAt
          ? "VISIT_SCHEDULED"
          : brokerStatus;
        const plot = plotMap.get(Number(brokerWorkflow?.plotId || plotSiteId)) || null;
        if (!customer || !plot) return null;
        return {
          ...customer,
          assignmentKey: key,
          assignedStaff: assignedStaff(broker),
          plot,
          plotOptions: [plot],
          tripCompleted,
          tripCompletedAt: tripCompleted ? completedTrips.get(key)?.updatedAt || null : null,
          pickupAt: trip.pickupAt || null,
          dropOffAt: trip.dropOffAt || null,
          scheduledPickupAt: trip.scheduledPickupAt || null,
          scheduledDropOffAt: trip.scheduledDropOffAt || null,
          tripMessage: tripCompleted ? "Trip completed" : "Trip not completed",
          ...(tripCompleted ? {
            brokerWorkflow: {
              status: effectiveBrokerStatus,
              updatedAt: brokerWorkflow?.updatedAt || null,
              visitScheduledAt: brokerWorkflow?.visitScheduledAt || siteVisitAt,
            },
          } : {}),
        };
      }).filter(Boolean);
    });
    for (const { customerId, plotSiteId } of awaitingBrokerPairs) {
      const customer = customerMap.get(customerId);
      const plot = plotMap.get(plotSiteId) || null;
      if (!customer || !plot) continue;
      const key = assignmentKey(customerId, plotSiteId);
      rows.push({
        ...customer,
        assignmentKey: `awaiting-broker-${key}`,
        assignedStaff: null,
        awaitingAssignment: true,
        plot,
        tripCompleted: true,
        tripCompletedAt: completedTrips.get(key)?.updatedAt || null,
        pickupAt: completedTrips.get(key)?.pickupAt || null,
        dropOffAt: completedTrips.get(key)?.dropOffAt || null,
        scheduledPickupAt: completedTrips.get(key)?.scheduledPickupAt || null,
        scheduledDropOffAt: completedTrips.get(key)?.scheduledDropOffAt || null,
        tripMessage: "Trip completed",
      });
    }
    const broker = brokers[0] || null;
    return res.json({
      isAdminOverview: adminOverview,
      broker: adminOverview || !broker ? null : {
        id: broker.id,
        name: broker.name,
        phone: broker.phone,
        email: broker.email,
        agency: broker.agency,
        commissionPercent: broker.commissionPercent,
      },
      customers: rows,
      assignmentOptions: brokers.filter((row) => row.userId).map(assignedStaff),
      summary: {
        total: rows.length,
        completed: rows.filter((row) => row.tripCompleted).length,
        waiting: rows.filter((row) => !row.tripCompleted).length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /brokers/me error:", error);
    return res.status(500).json({ error: "Failed to load assigned Sales Executive customers", code: "BROKER_WORK_LOAD_FAILED" });
  }
});

router.patch("/brokers/me/assignments/:assignmentKey/assign", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const match = String(req.params.assignmentKey).match(/^awaiting-broker-customer-(\d+)-plot-(\d+)$/);
    const customerId = Number(match?.[1]);
    const plotSiteId = Number(match?.[2]);
    const targetProfileId = Number(req.body?.targetProfileId);
    if (![customerId, plotSiteId, targetProfileId].every((value) => Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: "Choose a valid Sales Executive.", code: "INVALID_BROKER_ASSIGNMENT" });
    }
    const [target, transportPeople, brokers] = await Promise.all([
      prisma.plotBroker.findFirst({ where: { id: targetProfileId, tenantId, isActive: true, userId: { not: null } } }),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true },
      }),
      prisma.plotBroker.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, workflowStatusJson: true },
      }),
    ]);
    if (!target) {
      return res.status(404).json({ error: "Sales Executive not found.", code: "BROKER_PROFILE_NOT_FOUND" });
    }
    if (!completedTransportTrips(transportPeople).has(assignmentKey(customerId, plotSiteId))) {
      return res.status(409).json({ error: "Complete the transport trip before assigning a Sales Executive.", code: "TRIP_NOT_COMPLETED" });
    }
    if (brokers.some((broker) => assignmentPairs(broker).some((pair) => pair.customerId === customerId))) {
      return res.status(409).json({ error: "This customer already has a Sales Executive.", code: "BROKER_ALREADY_ASSIGNED" });
    }
    await prisma.$transaction(async (tx) => {
      await claimCustomerForPerson(tx, {
        modelName: "plotBroker", tenantId, claimantId: target.id, customerId,
        roleType: "broker", statusField: "workflowStatusJson",
      });
      await tx.plotBroker.update({
        where: { id: target.id },
        data: appendPersonAssignment(target, customerId, plotSiteId),
      });
    });
    return res.json({
      assignmentKey: assignmentKey(customerId, plotSiteId),
      assignedStaff: assignedStaff(target),
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /brokers/me/assignments/:assignmentKey/assign error:", error);
    return res.status(500).json({ error: "Failed to assign Sales Executive", code: "BROKER_ASSIGNMENT_FAILED" });
  }
});

router.patch(["/brokers/me/customers/:customerId/workflow", "/brokers/me/assignments/:assignmentKey/workflow"], requirePermission("broker_workspace", "update"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const keyMatch = req.params.assignmentKey?.match(/^customer-(\d+)-plot-(\d+)$/);
    const customerId = Number(keyMatch?.[1] || req.params.customerId);
    const requestedPlotId = keyMatch ? Number(keyMatch[2]) : null;
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }
    const assignedProfileId = adminAssignedProfileId(req);
    const broker = await prisma.plotBroker.findFirst({
      where: {
        tenantId,
        ...(assignedProfileId ? { id: assignedProfileId } : { userId: req.user.userId }),
        isActive: true,
      },
    });
    if (!broker) {
      return res.status(403).json({ error: "No active Sales Executive profile is linked to this login", code: "BROKER_PROFILE_NOT_LINKED" });
    }
    const pair = assignmentPairs(broker).find((row) => (
      row.customerId === customerId && (requestedPlotId === null || row.plotSiteId === requestedPlotId)
    ));
    if (!pair) {
      return res.status(404).json({ error: "Assigned customer not found", code: "BROKER_CUSTOMER_NOT_FOUND" });
    }
    const transportPeople = await prisma.transportPerson.findMany({
      where: { tenantId, isActive: true },
      select: { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true },
    });
    const key = assignmentKey(customerId, pair.plotSiteId);
    const completedTrip = completedTransportTrips(transportPeople).get(key);
    if (!completedTrip) {
      return res.status(409).json({
        error: "The site visit workflow can start only after the customer's trip is completed.",
        code: "TRIP_NOT_COMPLETED",
      });
    }
    const statuses = parseStoredObject(broker.workflowStatusJson);
    const savedWorkflow = statuses[key] || statuses[`customer-${customerId}`];
    const transportSiteVisitAt = completedTrip.dropOffAt || completedTrip.scheduledDropOffAt || null;
    const normalizedCurrentStatus = normalizeBrokerWorkflowStatus(savedWorkflow);
    const currentStatus = normalizedCurrentStatus === "READY_TO_SCHEDULE" && transportSiteVisitAt
      ? "VISIT_SCHEDULED"
      : normalizedCurrentStatus;
    const requestedStatus = req.body?.status;
    const allowedStatuses = {
      READY_TO_SCHEDULE: ["VISIT_SCHEDULED"],
      VISIT_SCHEDULED: ["VISIT_CONFIRMED"],
      VISIT_CONFIRMED: ["REMINDER_SENT"],
      REMINDER_SENT: ["ATTENDED", "NO_SHOW"],
      NO_SHOW: ["VISIT_RESCHEDULED"],
      VISIT_RESCHEDULED: ["VISIT_CONFIRMED"],
      ATTENDED: ["PLOT_SHOWN"],
      PLOT_SHOWN: ["PLOT_SELECTED"],
      PLOT_SELECTED: [],
    }[currentStatus] || [];
    const canMarkPlotShownFromTransport = requestedStatus === "PLOT_SHOWN"
      && Boolean(transportSiteVisitAt)
      && ["READY_TO_SCHEDULE", "VISIT_SCHEDULED", "VISIT_CONFIRMED", "REMINDER_SENT"].includes(currentStatus);
    if (!allowedStatuses.includes(requestedStatus) && !canMarkPlotShownFromTransport) {
      return res.status(409).json({
        error: allowedStatuses.length ? `Choose the next site visit step: ${allowedStatuses.join(" or ")}.` : "The site visit workflow is already complete.",
        code: "INVALID_BROKER_WORKFLOW_TRANSITION",
        currentStatus,
        nextStatuses: allowedStatuses,
      });
    }
    const now = new Date().toISOString();
    let visitScheduledAt = statuses[key]?.visitScheduledAt
      || statuses[`customer-${customerId}`]?.visitScheduledAt
      || transportSiteVisitAt;
    if (["VISIT_SCHEDULED", "VISIT_RESCHEDULED"].includes(requestedStatus)) {
      const requestedVisitDate = text(req.body?.visitScheduledAt, 80);
      const parsedVisitDate = requestedVisitDate ? new Date(requestedVisitDate) : null;
      if (!parsedVisitDate || Number.isNaN(parsedVisitDate.getTime())) {
        return res.status(400).json({
          error: "Choose a valid date and time for the site visit.",
          code: "VISIT_SCHEDULE_REQUIRED",
        });
      }
      visitScheduledAt = parsedVisitDate.toISOString();
    }
    let reservedPlot = null;
    let booking = null;
    if (requestedStatus === "PLOT_SELECTED") {
      const submittedPlotId = req.body?.plotId;
      const plotId = submittedPlotId === undefined || submittedPlotId === null || submittedPlotId === ""
        ? pair.plotSiteId
        : Number(submittedPlotId);
      if (!Number.isInteger(plotId) || plotId <= 0) {
        return res.status(400).json({ error: "Choose a valid plot.", code: "INVALID_PLOT_ID" });
      }
      if (!plotId) {
        return res.status(409).json({
          error: "Assign a plot to this customer before marking it selected.",
          code: "PLOT_REQUIRED_FOR_BOOKING",
        });
      }
      if (plotId !== Number(pair.plotSiteId)) {
        return res.status(409).json({
          error: "Choose the plot assigned to this customer.",
          code: "PLOT_NOT_ASSIGNED_TO_CUSTOMER",
        });
      }
      const plot = await prisma.plotSite.findFirst({ where: { id: plotId, tenantId, isActive: true } });
      if (!plot) {
        return res.status(409).json({ error: "The assigned plot is not active.", code: "PLOT_NOT_AVAILABLE" });
      }
      if (plot.availability !== "AVAILABLE") {
        return res.status(409).json({
          error: `The assigned plot is already ${String(plot.availability || "unavailable").toLowerCase()}.`,
          code: "PLOT_NOT_AVAILABLE",
        });
      }
      await prisma.$transaction(async (tx) => {
        const reservation = await tx.plotSite.updateMany({
          where: { id: plotId, tenantId, isActive: true, availability: "AVAILABLE" },
          data: { availability: "RESERVED" },
        });
        if (reservation.count !== 1) {
          const error = new Error("The plot has already been reserved. Refresh and choose another plot.");
          error.statusCode = 409;
          error.code = "PLOT_NOT_AVAILABLE";
          throw error;
        }
        reservedPlot = { ...plot, availability: "RESERVED" };
        const customerPickup = await tx.customerPickup.findFirst({
          where: { tenantId, contactId: customerId },
          select: { id: true },
        });
        booking = await tx.plotBooking.create({
          data: {
            bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
            tenantId,
            contactId: customerId,
            customerPickupId: customerPickup?.id || null,
            plotSiteId: plotId,
            transportPersonId: completedTrip.transportPersonId,
            plotBrokerId: broker.id,
            status: "PLOT_RESERVED",
            paymentStatus: "UNPAID",
            totalAmount: Number(plot.price || 0),
            balance: Number(plot.price || 0),
          },
        });
        statuses[key] = {
          ...statuses[key],
          status: requestedStatus,
          updatedAt: now,
          visitScheduledAt,
          billingStatus: "PLOT_RESERVED",
          billingUpdatedAt: now,
          plotId,
          bookingId: booking.id,
          bookingNumber: booking.bookingNumber,
          reservedAt: now,
        };
        await saveWorkflowOptimistically(
          tx.plotBroker,
          broker,
          "workflowStatusJson",
          statuses,
          tenantId,
        );
        await appendWorkflowEvent(tx, req, {
          bookingId: booking.id, contactId: customerId, plotSiteId: plotId,
          stage: "BROKER", fromStatus: currentStatus, toStatus: requestedStatus, occurredAt: now,
          metadata: { plotBrokerId: broker.id },
        });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking.id, contactId: customerId, plotSiteId: plotId,
          stage: "PLOT", fromStatus: "AVAILABLE", toStatus: "PLOT_RESERVED", occurredAt: now,
        });
      });
    } else {
      statuses[key] = { ...statuses[key], status: requestedStatus, updatedAt: now, visitScheduledAt };
      await prisma.$transaction(async (tx) => {
        if (currentStatus === BROKER_WORKFLOW[0] && requestedStatus === BROKER_WORKFLOW[1]) {
          await claimCustomerForPerson(tx, {
            modelName: "plotBroker",
            tenantId,
            claimantId: broker.id,
            customerId,
            roleType: "broker",
            statusField: "workflowStatusJson",
          });
        }
        await saveWorkflowOptimistically(
          tx.plotBroker,
          broker,
          "workflowStatusJson",
          statuses,
          tenantId,
        );
        await appendWorkflowEvent(tx, req, {
          contactId: customerId, plotSiteId: pair.plotSiteId,
          stage: "BROKER", fromStatus: currentStatus, toStatus: requestedStatus, occurredAt: now,
          metadata: { plotBrokerId: broker.id },
        });
      });
    }
    return res.json({
      customerId,
      status: requestedStatus,
      statusUpdatedAt: now,
      visitScheduledAt,
      handedToBilling: requestedStatus === "PLOT_SELECTED",
      bookingStatus: requestedStatus === "PLOT_SELECTED" ? "PLOT_RESERVED" : null,
      booking: booking ? { id: booking.id, bookingNumber: booking.bookingNumber, status: booking.status } : null,
      plot: reservedPlot,
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /brokers/me/customers/:customerId/workflow error:", error);
    return res.status(500).json({ error: "Failed to update site visit workflow", code: "BROKER_WORKFLOW_UPDATE_FAILED" });
  }
});

router.get("/billing/me", requirePermission("billing_workspace", "read"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const adminOverview = isAdminWorkspaceOverview(req);
    const billingPeople = adminOverview
      ? await prisma.billingPerson.findMany({ where: { tenantId, isActive: true }, orderBy: { name: "asc" } })
      : [await prisma.billingPerson.findFirst({
          where: { tenantId, userId: req.user.userId, isActive: true },
        })].filter(Boolean);
    if (billingPeople.length === 0 && !adminOverview) {
      return res.status(403).json({
        error: "No active billing person profile is linked to this login",
        code: "BILLING_PROFILE_NOT_LINKED",
      });
    }
    const brokers = await prisma.plotBroker.findMany({ where: { tenantId, isActive: true } });
    const queue = [];
    const brokerAssignments = new Map();
    for (const broker of brokers) {
      const statuses = parseStoredObject(broker.workflowStatusJson);
      assignmentPairs(broker).forEach(({ customerId, plotSiteId }) => {
        const key = assignmentKey(customerId, plotSiteId);
        const saved = statuses[key] || statuses[`customer-${customerId}`];
        brokerAssignments.set(key, {
          broker: { id: broker.id, name: broker.name },
          status: normalizeBrokerWorkflowStatus(saved),
        });
        if (normalizeBrokerWorkflowStatus(saved) !== "PLOT_SELECTED") return;
        queue.push({
          brokerId: broker.id,
          brokerName: broker.name,
          customerId,
          plotId: Number(saved?.plotId || plotSiteId),
          billingStatus: normalizeBillingWorkflowStatus(saved),
          billingUpdatedAt: saved?.billingUpdatedAt || null,
          invoiceId: saved?.invoiceId || null,
          invoiceNum: saved?.invoiceNum || null,
          bookingId: saved?.bookingId || null,
          bookingNumber: saved?.bookingNumber || null,
          invoiceAmount: saved?.invoiceAmount ?? null,
          amountPaid: saved?.amountPaid ?? 0,
          balance: saved?.balance ?? saved?.invoiceAmount ?? null,
          paymentId: saved?.paymentId || null,
          paymentMethod: saved?.paymentMethod || null,
          transactionRef: saved?.transactionRef || null,
        });
      });
    }
    const visibleQueue = billingPeople.flatMap((billingPerson) => queue
      .filter((row) => billingCanAccess(billingPerson, row.customerId, row.plotId))
      .map((row) => ({ ...row, billingPerson })));
    if (adminOverview) {
      const assignedQueueKeys = new Set(visibleQueue.map((row) => assignmentKey(row.customerId, row.plotId)));
      visibleQueue.push(...queue
        .filter((row) => !assignedQueueKeys.has(assignmentKey(row.customerId, row.plotId)))
        .map((row) => ({ ...row, billingPerson: null })));
    }
    const readyPairKeys = new Set(visibleQueue.filter((row) => row.billingPerson).map((row) => (
      `${row.billingPerson.id}:${assignmentKey(row.customerId, row.plotId)}`
    )));
    const waitingQueue = billingPeople.flatMap((billingPerson) => assignmentPairs(billingPerson)
      .filter((row) => !readyPairKeys.has(`${billingPerson.id}:${assignmentKey(row.customerId, row.plotSiteId)}`))
      .map((row) => ({ ...row, billingPerson })));
    const customerIds = [...new Set([
      ...visibleQueue.map((row) => row.customerId),
      ...waitingQueue.map((row) => row.customerId),
    ])];
    const plotIds = [...new Set([
      ...visibleQueue.map((row) => row.plotId),
      ...waitingQueue.map((row) => row.plotSiteId),
    ].filter(Boolean))];
    const [customers, plots, plotBookings] = await Promise.all([
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds }, deletedAt: null },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      plotIds.length ? prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotIds }, isActive: true },
        select: { id: true, name: true, plotNumber: true, address: true, referenceCode: true, price: true },
      }) : [],
      customerIds.length && plotIds.length ? prisma.plotBooking.findMany({
        where: {
          tenantId,
          contactId: { in: customerIds },
          plotSiteId: { in: plotIds },
          status: { not: "CANCELLED" },
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true, bookingNumber: true, contactId: true, plotSiteId: true,
          invoiceId: true, status: true, paymentStatus: true, totalAmount: true,
          amountPaid: true, balance: true,
        },
      }) : [],
    ]);
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const bookingById = new Map(plotBookings.map((row) => [Number(row.id), row]));
    const bookingByPair = new Map();
    for (const booking of plotBookings) {
      const key = assignmentKey(booking.contactId, booking.plotSiteId);
      if (!bookingByPair.has(key)) bookingByPair.set(key, booking);
    }
    const assignments = visibleQueue.map((row) => {
      const booking = bookingById.get(Number(row.bookingId))
        || bookingByPair.get(assignmentKey(row.customerId, row.plotId))
        || null;
      return {
        assignmentKey: `${row.brokerId}-${row.customerId}-${row.plotId}`,
        assignedStaff: row.billingPerson ? assignedStaff(row.billingPerson) : null,
        awaitingAssignment: !row.billingPerson,
        broker: { id: row.brokerId, name: row.brokerName },
        customer: customerMap.get(row.customerId) || null,
        plot: row.plotId ? plotMap.get(row.plotId) || null : null,
        status: billingStatusWithBooking(row.billingStatus, booking),
        statusUpdatedAt: row.billingUpdatedAt,
        bookingId: booking?.id || row.bookingId,
        bookingNumber: booking?.bookingNumber || row.bookingNumber,
        invoiceId: booking?.invoiceId || row.invoiceId,
        invoiceNum: row.invoiceNum,
        invoiceAmount: booking ? Number(booking.totalAmount) : row.invoiceAmount,
        amountPaid: booking ? Number(booking.amountPaid) : row.amountPaid,
        balance: booking ? Number(booking.balance) : row.balance,
        paymentStatus: booking?.paymentStatus || null,
        paymentId: row.paymentId,
        paymentMethod: row.paymentMethod,
        transactionRef: row.transactionRef,
      };
    }).filter((row) => row.customer && row.plot);
    const waitingAssignments = waitingQueue.map((row) => {
      const brokerAssignment = brokerAssignments.get(assignmentKey(row.customerId, row.plotSiteId));
      return {
        assignmentKey: adminOverview
          ? `waiting-${row.billingPerson.id}-${row.customerId}-${row.plotSiteId || 0}`
          : `waiting-${row.customerId}-${row.plotSiteId || 0}`,
        assignedStaff: assignedStaff(row.billingPerson),
        broker: brokerAssignment?.broker || null,
        customer: customerMap.get(row.customerId) || null,
        plot: row.plotSiteId ? plotMap.get(row.plotSiteId) || null : null,
        status: "AWAITING_SALES_EXECUTIVE_HANDOFF",
        salesStatus: brokerAssignment?.status || null,
        statusUpdatedAt: null,
      };
    }).filter((row) => row.customer && row.plot);
    return res.json({
      isAdminOverview: adminOverview,
      billingUser: adminOverview || !billingPeople[0]
        ? null
        : assignedStaff(billingPeople[0]),
      assignments,
      waitingAssignments,
      assignmentOptions: billingPeople.filter((row) => row.userId).map(assignedStaff),
      summary: {
        total: assignments.length + waitingAssignments.length,
        waiting: waitingAssignments.length,
        active: assignments.filter((row) => row.status !== "TRANSACTION_COMPLETED").length,
        completed: assignments.filter((row) => row.status === "TRANSACTION_COMPLETED").length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /billing/me error:", error);
    return res.status(500).json({ error: "Failed to load billing work", code: "BILLING_WORK_LOAD_FAILED" });
  }
});

router.patch("/billing/me/assignments/:assignmentKey/assign", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [brokerId, customerId, plotSiteId] = String(req.params.assignmentKey).split("-").map(Number);
    const targetProfileId = Number(req.body?.targetProfileId);
    if (![brokerId, customerId, plotSiteId, targetProfileId].every((value) => Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: "Choose valid Billing staff.", code: "INVALID_BILLING_ASSIGNMENT" });
    }
    const [target, broker, billingPeople] = await Promise.all([
      prisma.billingPerson.findFirst({ where: { id: targetProfileId, tenantId, isActive: true, userId: { not: null } } }),
      prisma.plotBroker.findFirst({ where: { id: brokerId, tenantId, isActive: true } }),
      prisma.billingPerson.findMany({ where: { tenantId, isActive: true } }),
    ]);
    if (!target) {
      return res.status(404).json({ error: "Billing staff not found.", code: "BILLING_PROFILE_NOT_FOUND" });
    }
    const pair = broker && assignmentPairs(broker).find((row) => row.customerId === customerId);
    const statuses = parseStoredObject(broker?.workflowStatusJson);
    const saved = pair && (statuses[assignmentKey(customerId, pair.plotSiteId)] || statuses[`customer-${customerId}`]);
    if (!pair || normalizeBrokerWorkflowStatus(saved) !== "PLOT_SELECTED" || Number(saved?.plotId || pair.plotSiteId) !== plotSiteId) {
      return res.status(409).json({ error: "Customer has not been handed to Billing.", code: "CUSTOMER_NOT_READY_FOR_BILLING" });
    }
    if (billingPeople.some((person) => billingCanAccess(person, customerId, plotSiteId))) {
      return res.status(409).json({ error: "This customer already has Billing staff.", code: "BILLING_ALREADY_ASSIGNED" });
    }
    const claimError = await validateRoleClaims(tenantId, [customerId], "billing", target.id);
    if (claimError) return res.status(claimError.status || 409).json(claimError);
    await prisma.$transaction(async (tx) => {
      await claimCustomerForPerson(tx, {
        modelName: "billingPerson", tenantId, claimantId: target.id, customerId, roleType: "billing",
      });
      await tx.billingPerson.update({
        where: { id: target.id },
        data: appendPersonAssignment(target, customerId, plotSiteId),
      });
    });
    return res.json({
      assignmentKey: `${brokerId}-${customerId}-${plotSiteId}`,
      assignedStaff: assignedStaff(target),
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /billing/me/assignments/:assignmentKey/assign error:", error);
    return res.status(500).json({ error: "Failed to assign Billing staff", code: "BILLING_ASSIGNMENT_FAILED" });
  }
});

router.patch("/billing/me/assignments/:assignmentKey/status", requirePermission("billing_workspace", "update"), async (req, res) => {
  try {
    const billingUser = await requireBillingProfile(req, res);
    if (!billingUser) return undefined;
    const [brokerId, customerId, requestedPlotId] = String(req.params.assignmentKey).split("-").map(Number);
    if (![brokerId, customerId, requestedPlotId].every((value) => Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: "Invalid billing assignment", code: "INVALID_ID" });
    }
    if (!billingCanAccess(billingUser.billingPerson, customerId, requestedPlotId)) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    const broker = await prisma.plotBroker.findFirst({ where: { id: brokerId, tenantId: req.user.tenantId, isActive: true } });
    const pair = broker && assignmentPairs(broker).find((row) => row.customerId === customerId);
    if (!broker || !pair) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    const statuses = parseStoredObject(broker.workflowStatusJson);
    const legacyKey = `customer-${customerId}`;
    const key = assignmentKey(customerId, pair.plotSiteId);
    if (!statuses[key] && statuses[legacyKey]) statuses[key] = { ...statuses[legacyKey] };
    if (Number(statuses[key]?.plotId || pair.plotSiteId) !== requestedPlotId) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    if (normalizeBrokerWorkflowStatus(statuses[key]) !== "PLOT_SELECTED") {
      return res.status(409).json({ error: "Customer has not been handed to Billing", code: "CUSTOMER_NOT_READY_FOR_BILLING" });
    }
    const saved = { ...statuses[key] };
    const plotId = requestedPlotId;
    let booking = saved.bookingId
      ? await prisma.plotBooking.findFirst({ where: { id: Number(saved.bookingId), tenantId: req.user.tenantId } })
      : await findActivePlotBooking(prisma, req.user.tenantId, customerId, plotId);
    const currentStatus = billingStatusWithBooking(
      normalizeBillingWorkflowStatus(statuses[key]),
      booking,
    );
    const nextStatus = BILLING_WORKFLOW[BILLING_WORKFLOW.indexOf(currentStatus) + 1];
    if (!nextStatus || req.body?.status !== nextStatus) {
      return res.status(409).json({
        error: nextStatus ? `The next billing step must be ${nextStatus}.` : "Billing is already complete.",
        code: "INVALID_BILLING_STATUS_TRANSITION",
        currentStatus,
        nextStatus: nextStatus || null,
      });
    }
    const now = new Date().toISOString();
    if (
      currentStatus === BILLING_WORKFLOW[0]
      && nextStatus === BILLING_WORKFLOW[1]
      && booking?.billingPersonId
      && Number(booking.billingPersonId) !== Number(billingUser.billingPerson.id)
    ) {
      return res.status(409).json({
        error: "This customer was already started by another person.",
        code: "CUSTOMER_ALREADY_CLAIMED",
      });
    }
    const saveWorkflow = (client, extra = {}, status = nextStatus) => {
      statuses[key] = { ...saved, ...extra, billingStatus: status, billingUpdatedAt: now };
      return saveWorkflowOptimistically(
        client.plotBroker,
        broker,
        "workflowStatusJson",
        statuses,
        req.user.tenantId,
      );
    };

    // The booking was read before entering the transaction. Revalidate it
    // after taking the same customer lock as deselection, and the booking row
    // lock used by payment reconciliation, before making financial writes.
    const guardBillingBooking = async (tx) => {
      await lockPlotAssignmentCustomers(tx, req.user.tenantId, [{ customerId, plotSiteId: plotId }]);
      if (!booking) return;
      await require("../lib/plotBookingPayments").lockBooking(tx, req.user.tenantId, booking.id);
      const current = await tx.plotBooking.findFirst({ where: { id: booking.id, tenantId: req.user.tenantId, contactId: customerId, plotSiteId: plotId, status: { not: "CANCELLED" } }, select: { id: true } });
      if (!current) {
        const error = new Error("The plot assignment was removed. Refresh before continuing billing.");
        error.code = "PLOT_ASSIGNMENT_REMOVED";
        throw error;
      }
    };

    let invoice = null;
    let payment = null;
    if (nextStatus === "INVOICE_CREATED") {
      const [customer, plot] = await Promise.all([
        prisma.contact.findFirst({ where: { id: customerId, tenantId: req.user.tenantId, deletedAt: null } }),
        plotId ? prisma.plotSite.findFirst({ where: { id: plotId, tenantId: req.user.tenantId, isActive: true } }) : null,
      ]);
      if (!customer || !plot) {
        return res.status(409).json({ error: "Customer and an active reserved plot are required.", code: "BOOKING_DETAILS_MISSING" });
      }
      if (plot.availability !== "RESERVED") {
        return res.status(409).json({ error: "The plot must be reserved before invoicing.", code: "PLOT_NOT_RESERVED" });
      }
      const amount = Number(plot.price);
      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(409).json({ error: "Set a valid plot price before creating the invoice.", code: "PLOT_PRICE_REQUIRED" });
      }
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + 7);
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        if (!booking) {
          booking = await tx.plotBooking.create({
            data: {
              bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
              tenantId: req.user.tenantId,
              contactId: customerId,
              plotSiteId: plotId,
              plotBrokerId: broker.id,
              billingPersonId: billingUser.billingPerson.id,
              status: "PLOT_RESERVED",
              paymentStatus: "UNPAID",
              totalAmount: amount,
              balance: amount,
            },
          });
        }
        invoice = await tx.invoice.create({
          data: {
            invoiceNum: `PLOT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
            amount: Math.round(amount * 100) / 100,
            dueDate,
            contactId: customerId,
            customerName: customer.name || null,
            customerPhone: customer.phone || null,
            customerEmail: customer.email || null,
            lineItemsJson: sanitizeJsonForStringColumn([{
              type: "plot", itemId: plot.id, name: plot.name, quantity: 1, unitPrice: amount, amount,
            }]),
            amountPaid: 0,
            balance: amount,
            tenantId: req.user.tenantId,
          },
        });
        await tx.plotInvoiceItem.create({
          data: {
            tenantId: req.user.tenantId,
            invoiceId: invoice.id,
            plotBookingId: booking.id,
            itemType: "PLOT",
            itemId: plot.id,
            description: plot.name,
            quantity: 1,
            unitPrice: amount,
            amount,
          },
        });
        await tx.plotBooking.update({
          where: { id: booking.id },
          data: {
            invoiceId: invoice.id,
            billingPersonId: billingUser.billingPerson.id,
            status: "INVOICE_CREATED",
            totalAmount: amount,
            amountPaid: 0,
            balance: amount,
          },
        });
        await saveWorkflow(tx, {
          bookingId: booking.id, bookingNumber: booking.bookingNumber,
          invoiceId: invoice.id, invoiceNum: invoice.invoiceNum, invoiceAmount: amount,
          amountPaid: 0, balance: amount, invoiceCreatedAt: now, plotId,
        });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking.id, contactId: customerId, plotSiteId: plotId,
          stage: "BILLING", fromStatus: currentStatus, toStatus: nextStatus, occurredAt: now,
          metadata: { invoiceId: invoice.id, invoiceNum: invoice.invoiceNum, amount },
        });
      });
    } else if (nextStatus === "INVOICE_SENT") {
      const customer = await prisma.contact.findFirst({ where: { id: customerId, tenantId: req.user.tenantId, deletedAt: null } });
      if (!customer?.email) {
        return res.status(409).json({ error: "Add a customer email before sending the invoice.", code: "CUSTOMER_EMAIL_REQUIRED" });
      }
      if (!saved.invoiceId) {
        return res.status(409).json({ error: "Create the invoice before sending it.", code: "INVOICE_REQUIRED" });
      }
      const delivery = await sendEmail({
        tenantId: req.user.tenantId,
        to: customer.email,
        subject: `Plot booking invoice ${saved.invoiceNum || saved.invoiceId}`,
        text: `Your invoice ${saved.invoiceNum || saved.invoiceId} for the reserved plot is ready. Please complete payment by the due date.`,
      });
      if (delivery?.sent === false) {
        return res.status(502).json({ error: "The invoice email could not be sent.", code: "INVOICE_SEND_FAILED" });
      }
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        if (booking) await tx.plotBooking.update({ where: { id: booking.id }, data: { status: nextStatus } });
        await saveWorkflow(tx, { invoiceSentAt: now });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking?.id, contactId: customerId, plotSiteId: plotId,
          stage: "BILLING", fromStatus: currentStatus, toStatus: nextStatus, occurredAt: now,
          metadata: { invoiceId: saved.invoiceId },
        });
      });
    } else if (nextStatus === "PAYMENT_RECEIVED") {
      const paymentMethod = text(req.body?.paymentMethod, 64);
      const transactionRef = text(req.body?.transactionRef, 128);
      if (!paymentMethod || !transactionRef) {
        return res.status(400).json({
          error: "Payment method and transaction reference are required.",
          code: "PAYMENT_DETAILS_REQUIRED",
        });
      }
      if (!saved.invoiceId) {
        return res.status(409).json({ error: "An invoice is required before recording payment.", code: "INVOICE_REQUIRED" });
      }
      const sourceInvoice = await prisma.invoice.findFirst({ where: { id: Number(saved.invoiceId), tenantId: req.user.tenantId } });
      if (!sourceInvoice) return res.status(409).json({ error: "The booking invoice was not found.", code: "INVOICE_REQUIRED" });
      const currentBalance = Number(sourceInvoice.balance ?? saved.balance ?? sourceInvoice.amount);
      const receivedAmount = req.body?.amount === undefined || req.body?.amount === ""
        ? currentBalance
        : Number(req.body.amount);
      if (!Number.isFinite(receivedAmount) || receivedAmount <= 0 || receivedAmount !== currentBalance) {
        return res.status(400).json({
          error: "The full outstanding invoice balance must be received before verification.",
          code: "INVALID_PAYMENT_AMOUNT",
          balance: currentBalance,
        });
      }
      const duplicatePayment = await prisma.payment.findFirst({
        where: { tenantId: req.user.tenantId, gatewayId: transactionRef },
      });
      if (duplicatePayment) {
        return res.status(409).json({ error: "That transaction reference has already been recorded.", code: "DUPLICATE_TRANSACTION_REFERENCE" });
      }
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        payment = await tx.payment.create({
          data: {
            invoiceId: sourceInvoice.id,
            contactId: customerId,
            description: `Payment received for plot booking ${saved.invoiceNum || sourceInvoice.invoiceNum}`,
            amount: receivedAmount,
            gateway: paymentMethod,
            gatewayId: transactionRef,
            plotPaymentReference: transactionRef,
            status: "PENDING",
            tenantId: req.user.tenantId,
          },
        });
        if (booking) {
          await tx.plotBooking.update({
            where: { id: booking.id },
            data: { status: "PAYMENT_RECEIVED", paymentStatus: "RECEIVED" },
          });
        }
        await saveWorkflow(tx, {
          paymentId: payment.id, paymentMethod, transactionRef,
          paymentReceivedAmount: receivedAmount, paymentReceivedAt: now,
        });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking?.id, contactId: customerId, plotSiteId: plotId,
          stage: "PAYMENT", fromStatus: currentStatus, toStatus: "PAYMENT_RECEIVED", occurredAt: now,
          metadata: { paymentId: payment.id, transactionRef, receivedAmount },
        });
      });
    } else if (nextStatus === "PAYMENT_VERIFIED") {
      if (!plotId || !saved.invoiceId || !saved.paymentId) {
        return res.status(409).json({ error: "A recorded payment and plot are required before verification.", code: "PAYMENT_REQUIRED" });
      }
      const paidAt = new Date();
      const paidAmount = Number(saved.paymentReceivedAmount || saved.invoiceAmount || 0);
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        payment = await tx.payment.update({
          where: { id: Number(saved.paymentId) },
          data: { status: "SUCCESS", paidAt },
        });
        invoice = await tx.invoice.update({
          where: { id: Number(saved.invoiceId) },
          data: { status: "PAID", paidAt, paymentMode: saved.paymentMethod || "manual", amountPaid: paidAmount, balance: 0 },
        });
        if (booking) {
          await tx.plotBooking.update({
            where: { id: booking.id },
            data: { status: "PAYMENT_VERIFIED", paymentStatus: "PAID", amountPaid: paidAmount, balance: 0 },
          });
        }
        await saveWorkflow(tx, { paymentVerifiedAt: now, amountPaid: paidAmount, balance: 0 });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking?.id, contactId: customerId, plotSiteId: plotId,
          stage: "PAYMENT", fromStatus: currentStatus, toStatus: "PAYMENT_VERIFIED", occurredAt: now,
          metadata: { paymentId: saved.paymentId, invoiceId: saved.invoiceId, amount: paidAmount },
        });
      });
    } else if (nextStatus === "PLOT_SOLD") {
      if (!plotId) return res.status(409).json({ error: "The booking has no plot.", code: "PLOT_REQUIRED_FOR_BOOKING" });
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        await tx.plotSite.update({ where: { id: plotId }, data: { availability: "SOLD" } });
        if (booking) await tx.plotBooking.update({ where: { id: booking.id }, data: { status: "PLOT_SOLD", soldAt: new Date() } });
        await saveWorkflow(tx, { plotSoldAt: now });
        await appendWorkflowEvent(tx, req, {
          bookingId: booking?.id, contactId: customerId, plotSiteId: plotId,
          stage: "PLOT", fromStatus: "RESERVED", toStatus: nextStatus, occurredAt: now,
        });
      });
    } else {
      const timestampFields = {
        BILLING: { billingStartedAt: now },
        PAYMENT_PENDING: { paymentPendingAt: now },
        BOOKING_CONFIRMED: { bookingConfirmedAt: now },
        TRANSACTION_COMPLETED: { transactionCompletedAt: now },
      };
      await prisma.$transaction(async (tx) => {
        await guardBillingBooking(tx);
        if (currentStatus === BILLING_WORKFLOW[0] && nextStatus === BILLING_WORKFLOW[1]) {
          await claimCustomerForPerson(tx, {
            modelName: "billingPerson",
            tenantId: req.user.tenantId,
            claimantId: billingUser.billingPerson.id,
            customerId,
            roleType: "billing",
          });
        }
        if (booking) {
          await tx.plotBooking.update({
            where: { id: booking.id },
            data: nextStatus === "TRANSACTION_COMPLETED"
              ? { status: nextStatus, completedAt: new Date() }
              : {
                  status: nextStatus,
                  ...(nextStatus === BILLING_WORKFLOW[1]
                    ? { billingPersonId: billingUser.billingPerson.id }
                    : {}),
                },
          });
        }
        await saveWorkflow(tx, timestampFields[nextStatus] || {});
        await appendWorkflowEvent(tx, req, {
          bookingId: booking?.id, contactId: customerId, plotSiteId: plotId,
          stage: "BILLING", fromStatus: currentStatus, toStatus: nextStatus, occurredAt: now,
        });
      });
    }
    if (nextStatus === "PAYMENT_VERIFIED" && payment?.id) {
      await require("../lib/eventBus").emitEvent(
        "payment.collected",
        { paymentId: payment.id, invoiceId: invoice?.id || saved.invoiceId, contactId: customerId, bookingId: booking?.id },
        req.user.tenantId,
        req.io,
      ).catch((eventError) => console.error("[GenericCampaign] plot payment event failed:", eventError.message));
    }
    if (nextStatus === "BOOKING_CONFIRMED") {
      require("../lib/eventBus").emitEvent(
        "plot.confirmed",
        { contactId: customerId, plotSiteId: plotId, bookingId: booking?.id },
        req.user.tenantId,
        req.io,
      ).catch((eventError) => console.error("[GenericCampaign] plot confirmation event failed:", eventError.message));
    }
    const responseStatus = payment?.workflowStatus || nextStatus;
    return res.json({
      assignmentKey: req.params.assignmentKey,
      status: responseStatus,
      statusUpdatedAt: now,
      invoice: invoice ? { id: invoice.id, invoiceNum: invoice.invoiceNum, status: invoice.status } : null,
      payment: payment ? { id: payment.id, status: payment.status, amount: payment.amount, transactionRef: payment.gatewayId } : null,
      amountPaid: invoice ? Number(invoice.amountPaid || 0) : undefined,
      balance: invoice ? Number(invoice.balance ?? invoice.amount ?? 0) : undefined,
      plotAvailability: responseStatus === "PLOT_SOLD" ? "SOLD" : undefined,
    });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /billing/me/assignments/:assignmentKey/status error:", error);
    if (error.code === "P2002" && String(error.meta?.target || "").includes("plotPaymentReference")) {
      return res.status(409).json({ error: "That transaction reference has already been recorded.", code: "DUPLICATE_TRANSACTION_REFERENCE" });
    }
    return res.status(500).json({ error: "Failed to update billing status", code: "BILLING_STATUS_UPDATE_FAILED" });
  }
});

// Read-only workflow projection for the Generic CRM Leads table. Unlike the
// admin Customer Status screen, USER callers may read only leads assigned to
// them; ADMIN and MANAGER retain the same full-tenant visibility as /contacts.
router.get("/lead-status", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const rawContactIds = typeof req.query.contactIds === "string"
      ? req.query.contactIds.split(",").filter(Boolean)
      : [];
    const contactIds = [...new Set(rawContactIds.map(Number))];
    if (
      contactIds.length < 1
      || contactIds.length > 100
      || contactIds.some((id) => !Number.isInteger(id) || id <= 0)
    ) {
      return res.status(400).json({
        error: "contactIds must contain 1 to 100 positive integers",
        code: "INVALID_CONTACT_IDS",
      });
    }

    const contactWhere = {
      tenantId,
      id: { in: contactIds },
      deletedAt: null,
    };
    if (!["ADMIN", "MANAGER"].includes(req.user.role)) {
      contactWhere.assignedToId = req.user.userId;
    }
    const [visibleContacts, pickupLocations] = await Promise.all([
      prisma.contact.findMany({
        where: contactWhere,
        select: { id: true },
      }),
      prisma.pickupLocation.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, googleMapsLink: true },
      }),
    ]);
    const visibleContactIds = visibleContacts.map((contact) => contact.id);
    if (!visibleContactIds.length) return res.json({ customers: [], pickupLocations });

    const historyPage = Math.max(1, Math.min(100000, parseInt(req.query.historyPage, 10) || 1));
    // Filter JSON assignments in the database, not after downloading every
    // employee. Tables are fixed server-side; IDs remain bound parameters.
    const assignedIds = async (table) => {
      const matches = visibleContactIds.map((id) => Prisma.sql`JSON_CONTAINS(
        CASE WHEN JSON_VALID(customerIdsJson) THEN customerIdsJson ELSE '[]' END,
        ${String(id)}, '$')`);
      const rows = await prisma.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(table)}
        WHERE tenantId = ${tenantId} AND isActive = true AND (${Prisma.join(matches, ' OR ')}) LIMIT 201`);
      if (rows.length > 200) {
        const error = new Error("Too many assignments. Request fewer contacts.");
        error.code = "WORKFLOW_PROJECTION_TOO_LARGE";
        throw error;
      }
      return rows.map((row) => row.id);
    };
    const [transportIds, brokerIds] = await Promise.all([assignedIds('TransportPerson'), assignedIds('PlotBroker')]);
    const [pickups, transportPeople, brokers, eventPages, plotBookings] = await Promise.all([
      prisma.customerPickup.findMany({
        where: { tenantId, contactId: { in: visibleContactIds } },
        orderBy: { updatedAt: "desc" },
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true, company: true, status: true, interestedPlotArea: true } },
        },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true, id: { in: transportIds } },
        select: { id: true, name: true, phone: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true, updatedAt: true },
      }),
      prisma.plotBroker.findMany({
        where: { tenantId, isActive: true, id: { in: brokerIds } },
        select: { id: true, name: true, phone: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, workflowStatusJson: true },
      }),
      Promise.all(visibleContactIds.map(async (contactId) => {
        const events = await prisma.plotWorkflowEvent.findMany({
          where: { tenantId, contactId },
          orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
          skip: (historyPage - 1) * 50, take: 51,
        });
        return { contactId, events: events.slice(0, 50).reverse(), hasMore: events.length > 50 };
      })),
      prisma.plotBooking.findMany({
        where: {
          tenantId,
          contactId: { in: visibleContactIds },
          status: { not: "CANCELLED" },
        },
        orderBy: { updatedAt: "desc" },
        select: { id: true, contactId: true, plotSiteId: true, status: true, updatedAt: true },
      }),
    ]);
    const selectedPlotIds = brokers.flatMap((broker) => {
      const statuses = parseStoredObject(broker.workflowStatusJson);
      return assignmentPairs(broker)
        .filter((pair) => visibleContactIds.includes(pair.customerId))
        .map((pair) => Number((statuses[assignmentKey(pair.customerId, pair.plotSiteId)]
          || statuses[`customer-${pair.customerId}`])?.plotId));
    });
    const plotIds = [...new Set([
      ...[...transportPeople, ...brokers].flatMap((person) =>
        assignmentPairs(person).filter((pair) => visibleContactIds.includes(pair.customerId))
          .map((pair) => pair.plotSiteId)),
      ...selectedPlotIds,
      ...plotBookings.map((booking) => Number(booking.plotSiteId)),
    ].filter((id) => Number.isInteger(id) && id > 0))];
    if (plotIds.length > 200) {
      const error = new Error("Too many plot assignments. Request fewer contacts.");
      error.code = "WORKFLOW_PROJECTION_TOO_LARGE";
      throw error;
    }
    const plots = plotIds.length ? await prisma.plotSite.findMany({
      where: { tenantId, id: { in: plotIds } },
      select: { id: true, name: true, plotNumber: true, referenceCode: true, address: true, area: true, availability: true },
    }) : [];
    const workflowEvents = eventPages.flatMap((page) => page.events);
    const plotMap = new Map(plots.map((plot) => [Number(plot.id), plot]));
    const historyByCustomer = new Map();
    for (const event of workflowEvents) {
      const history = historyByCustomer.get(event.contactId) || [];
      history.push({
        id: event.id,
        bookingId: event.plotBookingId,
        plotSiteId: event.plotSiteId,
        stage: event.stage,
        eventType: event.eventType,
        label: event.label,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        occurredAt: event.occurredAt,
      });
      historyByCustomer.set(event.contactId, history);
    }
    const bookingsByContact = new Map();
    for (const booking of plotBookings) {
      const rows = bookingsByContact.get(Number(booking.contactId)) || [];
      rows.push(booking);
      bookingsByContact.set(Number(booking.contactId), rows);
    }
    const pickupContactIds = new Set(pickups.map((pickup) => Number(pickup.contactId)));
    const customers = pickups.map((pickup) => {
      const workflowStatus = findCustomerWorkflowStatus(pickup.contactId, transportPeople, brokers, plotMap);
      const bookingPlots = (bookingsByContact.get(Number(pickup.contactId)) || [])
        .map((booking) => plotMap.get(Number(booking.plotSiteId)))
        .filter(Boolean);
      const assignedPlots = [...new Map([
        workflowStatus.assignedPlot,
        ...bookingPlots,
      ].filter(Boolean).map((plot) => [Number(plot.id), plot])).values()];
      return {
        ...pickup,
        pickupAddress: cleanPickupAddress(pickup.pickupAddress) || pickup.pickupAddress,
        ...workflowStatus,
        assignedPlot: workflowStatus.assignedPlot || assignedPlots[0] || null,
        assignedPlots,
        workflowHistory: historyByCustomer.get(pickup.contactId) || [],
        workflowHistoryPagination: { page: historyPage, pageSize: 50, hasMore: eventPages.find((page) => page.contactId === pickup.contactId)?.hasMore || false },
      };
    });
    for (const [contactId, bookings] of bookingsByContact) {
      if (pickupContactIds.has(contactId)) continue;
      const assignedPlots = [...new Map(bookings
        .map((booking) => plotMap.get(Number(booking.plotSiteId)))
        .filter(Boolean)
        .map((plot) => [Number(plot.id), plot])).values()];
      const latestBooking = bookings[0];
      customers.push({
        contactId,
        pickupAddress: null,
        assignedPlot: assignedPlots[0] || null,
        assignedPlots,
        currentStage: "plot",
        currentStatus: latestBooking?.status || "PLOT_ASSIGNED",
        currentStatusUpdatedAt: latestBooking?.updatedAt || null,
        workflowHistory: historyByCustomer.get(contactId) || [],
        workflowHistoryPagination: { page: historyPage, pageSize: 50, hasMore: eventPages.find((page) => page.contactId === contactId)?.hasMore || false },
      });
    }
    return res.json({ customers, pickupLocations });
  } catch (error) {
    console.error("pickup-plot-inventory GET /lead-status error:", error);
    if (error.code === "WORKFLOW_PROJECTION_TOO_LARGE") return res.status(413).json({ error: error.message, code: error.code });
    return res.status(500).json({ error: "Failed to load lead workflow status", code: "LEAD_STATUS_LOAD_FAILED" });
  }
});

router.post("/customer-pickups/:contactId/plots", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }
    if (!Array.isArray(req.body?.plotSiteIds)) {
      return res.status(400).json({ error: "plotSiteIds must be an array.", code: "INVALID_PLOT_IDS" });
    }
    const plotSiteIds = [...new Set(req.body.plotSiteIds.map(Number))];
    if (plotSiteIds.length < 1 || plotSiteIds.length > 50 || plotSiteIds.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({ error: "Select between 1 and 50 valid plots.", code: "INVALID_PLOT_IDS" });
    }
    const replacePlotSiteId = req.body?.replacePlotSiteId === undefined
      ? null
      : Number(req.body.replacePlotSiteId);
    if (replacePlotSiteId !== null && (!Number.isInteger(replacePlotSiteId) || replacePlotSiteId <= 0 || plotSiteIds.length !== 1)) {
      return res.status(400).json({
        error: "Choose one valid assigned plot and one replacement plot number.",
        code: "INVALID_PLOT_REPLACEMENT",
      });
    }

    const [contact, customerPickup, plots, existingBookings, transportPeople] = await Promise.all([
      prisma.contact.findFirst({
        where: { id: contactId, tenantId, deletedAt: null },
        select: { id: true },
      }),
      prisma.customerPickup.findUnique({
        where: { tenantId_contactId: { tenantId, contactId } },
        select: { id: true },
      }),
      prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotSiteIds }, isActive: true },
        select: { id: true, name: true, plotNumber: true, price: true, availability: true },
      }),
      prisma.plotBooking.findMany({
        where: { tenantId, contactId, status: { not: "CANCELLED" } },
        select: { id: true, plotSiteId: true, bookingNumber: true, status: true },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId },
        select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
      }),
    ]);
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
    if (customerTransportStarted(transportPeople, contactId)) {
      return res.status(409).json({
        error: "Pickup location and plot assignments cannot be changed after transport has started.",
        code: "TRANSPORT_WORKFLOW_LOCKED",
      });
    }
    if (plots.length !== plotSiteIds.length) {
      return res.status(400).json({ error: "One or more selected plots are not active.", code: "INVALID_PLOT_IDS" });
    }

    const existingPlotIds = new Set(existingBookings.map((booking) => Number(booking.plotSiteId)));
    const newPlots = plots.filter((plot) => !existingPlotIds.has(Number(plot.id)));
    const unavailablePlot = newPlots.find((plot) => (
      String(plot.availability || "").trim().toUpperCase() !== "AVAILABLE"
    ));
    if (unavailablePlot) {
      return res.status(409).json({
        error: `${unavailablePlot.plotNumber || unavailablePlot.name} is already ${String(unavailablePlot.availability || "unavailable").toLowerCase()}.`,
        code: "PLOT_NOT_AVAILABLE",
      });
    }
    const normalizePlotName = (value) => String(value || "").trim().toLowerCase();
    const normalizePlotNumber = (value) => String(value || "").trim().toLowerCase();
    const selectedPlotNames = new Set(newPlots.map((plot) => normalizePlotName(plot.name)).filter(Boolean));
    const selectedPlotNumbers = newPlots.map((plot) => normalizePlotNumber(plot.plotNumber));
    if (newPlots.length && selectedPlotNames.size !== 1) {
      return res.status(400).json({
        error: "Select plot numbers from the same Plot / Site name.",
        code: "PLOT_NAME_MISMATCH",
      });
    }
    if (selectedPlotNumbers.some((number) => !number) || new Set(selectedPlotNumbers).size !== selectedPlotNumbers.length) {
      return res.status(400).json({
        error: "Each selected plot must have a different plot number.",
        code: "DUPLICATE_PLOT_NUMBER",
      });
    }
    const existingPlots = existingPlotIds.size ? await prisma.plotSite.findMany({
      where: { tenantId, id: { in: [...existingPlotIds] } },
      select: { id: true, name: true, plotNumber: true, availability: true },
    }) : [];

    if (replacePlotSiteId !== null) {
      const sourceBooking = existingBookings.find((booking) => Number(booking.plotSiteId) === replacePlotSiteId);
      const sourcePlot = existingPlots.find((plot) => Number(plot.id) === replacePlotSiteId);
      const replacementPlot = plots[0];
      if (!sourceBooking || !sourcePlot) {
        return res.status(404).json({ error: "The assigned plot was not found.", code: "ASSIGNED_PLOT_NOT_FOUND" });
      }
      const sourceBookingStatus = String(sourceBooking.status || "").trim().toUpperCase();
      const sourceAvailability = String(sourcePlot.availability || "").trim().toUpperCase();
      if (
        sourceAvailability === "SOLD" ||
        ["PLOT_SOLD", "TRANSACTION_COMPLETED"].includes(sourceBookingStatus)
      ) {
        return res.status(409).json({
          error: "A purchased plot cannot be changed. View the selected plot instead.",
          code: "PURCHASED_PLOT_IMMUTABLE",
        });
      }
      if (Number(replacementPlot.id) === replacePlotSiteId || existingPlotIds.has(Number(replacementPlot.id))) {
        return res.status(409).json({
          error: "Choose a different plot number that is not already assigned to this customer.",
          code: "PLOT_ALREADY_ASSIGNED",
        });
      }
      if (normalizePlotName(sourcePlot.name) !== normalizePlotName(replacementPlot.name)) {
        return res.status(400).json({
          error: "Choose a replacement number from the same Plot / Site name.",
          code: "PLOT_NAME_MISMATCH",
        });
      }

      const [transportPeople, brokers, billingPeople] = await Promise.all([
        prisma.transportPerson.findMany({ where: { tenantId } }),
        prisma.plotBroker.findMany({ where: { tenantId } }),
        prisma.billingPerson.findMany({ where: { tenantId } }),
      ]);
      await prisma.$transaction(async (tx) => {
        if (["RESERVED", "SOLD"].includes(sourceAvailability)) {
          const reserved = await tx.plotSite.updateMany({
            where: { id: replacementPlot.id, tenantId, isActive: true, availability: "AVAILABLE" },
            data: { availability: sourceAvailability },
          });
          if (reserved.count !== 1) {
            const error = new Error("The replacement plot is no longer available. Refresh and choose another plot.");
            error.statusCode = 409;
            error.code = "PLOT_NOT_AVAILABLE";
            throw error;
          }
          await tx.plotSite.updateMany({
            where: { id: replacePlotSiteId, tenantId, availability: sourceAvailability },
            data: { availability: "AVAILABLE" },
          });
        }
        await tx.plotBooking.update({
          where: { id: sourceBooking.id },
          data: { plotSiteId: replacementPlot.id },
        });
        if (sourceBooking.invoiceId) {
          await tx.plotInvoiceItem.updateMany({
            where: { tenantId, plotBookingId: sourceBooking.id },
            data: { itemId: replacementPlot.id, description: replacementPlot.name },
          });
        }
        for (const person of transportPeople) {
          const data = replacePersonPlotAssignment(
            person, contactId, replacePlotSiteId, replacementPlot.id, "assignmentStatusJson",
          );
          if (data) await tx.transportPerson.update({ where: { id: person.id }, data });
        }
        for (const person of brokers) {
          const data = replacePersonPlotAssignment(
            person, contactId, replacePlotSiteId, replacementPlot.id, "workflowStatusJson",
          );
          if (data) await tx.plotBroker.update({ where: { id: person.id }, data });
        }
        for (const person of billingPeople) {
          const data = replacePersonPlotAssignment(
            person, contactId, replacePlotSiteId, replacementPlot.id,
          );
          if (data) await tx.billingPerson.update({ where: { id: person.id }, data });
        }
        await appendWorkflowEvent(tx, req, {
          bookingId: sourceBooking.id,
          contactId,
          plotSiteId: replacementPlot.id,
          stage: "PLOT",
          fromStatus: sourceBooking.status,
          toStatus: "PLOT_CHANGED",
          metadata: {
            previousPlotSiteId: replacePlotSiteId,
            replacementPlotSiteId: replacementPlot.id,
          },
        });
      });

      return res.json({
        contactId,
        replacedPlotSiteId: replacePlotSiteId,
        replacementPlotSiteId: Number(replacementPlot.id),
        assignedPlotIds: existingBookings.map((booking) => (
          Number(booking.plotSiteId) === replacePlotSiteId
            ? Number(replacementPlot.id)
            : Number(booking.plotSiteId)
        )),
        bookingsUpdated: 1,
      });
    }

    const selectedPlotName = [...selectedPlotNames][0] || "";
    const existingNumbers = new Set(existingPlots
      .filter((plot) => normalizePlotName(plot.name) === selectedPlotName)
      .map((plot) => normalizePlotNumber(plot.plotNumber))
      .filter(Boolean));
    if (selectedPlotNumbers.some((number) => existingNumbers.has(number))) {
      return res.status(400).json({
        error: "Choose a different plot number from those already assigned.",
        code: "DUPLICATE_PLOT_NUMBER",
      });
    }

    const createdBookings = [];
    await prisma.$transaction(async (tx) => {
      for (const plot of newPlots) {
        const booking = await tx.plotBooking.create({
          data: {
            bookingNumber: `BOOK-${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
            tenantId,
            contactId,
            customerPickupId: customerPickup?.id || null,
            plotSiteId: plot.id,
            status: "PLOT_ASSIGNED",
            paymentStatus: "UNPAID",
            totalAmount: Number(plot.price || 0),
            balance: Number(plot.price || 0),
          },
        });
        createdBookings.push(booking);
        await appendWorkflowEvent(tx, req, {
          bookingId: booking.id,
          contactId,
          plotSiteId: plot.id,
          stage: "PLOT",
          eventType: "PLOT_ASSIGNED",
          label: "Plot assigned",
          fromStatus: "AVAILABLE",
          toStatus: "PLOT_ASSIGNED",
          metadata: { assignedByAdmin: true },
        });
      }
    });

    return res.status(createdBookings.length ? 201 : 200).json({
      contactId,
      assignedPlotIds: [...new Set([...existingBookings.map((row) => Number(row.plotSiteId)), ...plotSiteIds])],
      bookingsCreated: createdBookings.length,
      bookings: createdBookings,
    });
  } catch (error) {
    console.error("pickup-plot-inventory POST /customer-pickups/:contactId/plots error:", error);
    if (error.code === "PLOT_NOT_AVAILABLE") {
      return res.status(error.statusCode || 409).json({ error: error.message, code: error.code });
    }
    return res.status(500).json({ error: "Failed to assign plots", code: "PLOT_ASSIGNMENT_FAILED" });
  }
});

router.delete("/customer-pickups/:contactId/plots/:plotSiteId", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    const plotSiteId = Number(req.params.plotSiteId);
    if (![contactId, plotSiteId].every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ error: "Invalid customer or plot id", code: "INVALID_ID" });
    }
    const [contact, booking, transportPeople] = await Promise.all([
      prisma.contact.findFirst({ where: { id: contactId, tenantId, deletedAt: null }, select: { id: true } }),
      prisma.plotBooking.findFirst({
        where: { tenantId, contactId, plotSiteId, status: { not: "CANCELLED" } },
        select: { id: true, status: true, paymentStatus: true, amountPaid: true, invoiceId: true },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId },
        select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
      }),
    ]);
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
    if (!booking) return res.status(404).json({ error: "Assigned plot not found", code: "ASSIGNED_PLOT_NOT_FOUND" });
    if (customerTransportStarted(transportPeople, contactId)) {
      return res.status(409).json({
        error: "Plot assignments cannot be changed after transport has started.",
        code: "TRANSPORT_WORKFLOW_LOCKED",
      });
    }
    if (
      String(booking.status || "").trim().toUpperCase() !== "PLOT_ASSIGNED"
      || Number(booking.amountPaid || 0) > 0
      || booking.invoiceId
      || !["", "UNPAID"].includes(String(booking.paymentStatus || "").trim().toUpperCase())
    ) {
      return res.status(409).json({
        error: "This plot can no longer be deselected because its booking or payment workflow has started.",
        code: "PLOT_UNASSIGNMENT_LOCKED",
      });
    }
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM Contact WHERE id = ${contactId} AND tenantId = ${tenantId} FOR UPDATE`;
      const currentTransport = await tx.transportPerson.findMany({
        where: { tenantId },
        select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
      });
      if (customerTransportStarted(currentTransport, contactId)) {
        const error = new Error("Plot assignments cannot be changed after transport has started.");
        error.code = "TRANSPORT_WORKFLOW_LOCKED";
        throw error;
      }
      const activeBookings = await tx.plotBooking.findMany({
        where: { tenantId, plotSiteId, status: { not: "CANCELLED" } },
        select: { id: true, contactId: true, status: true, paymentStatus: true, amountPaid: true, invoiceId: true },
      });
      const customerBookings = activeBookings.filter((row) => row.contactId === contactId);
      if (customerBookings.some((row) => row.status !== "PLOT_ASSIGNED" || Number(row.amountPaid) > 0 || row.invoiceId || !["", "UNPAID"].includes(row.paymentStatus))) {
        const error = new Error("Another booking for this plot has already entered its booking or payment workflow.");
        error.code = "PLOT_UNASSIGNMENT_LOCKED";
        throw error;
      }
      const bookingIds = [...new Set([booking.id, ...customerBookings.map((row) => row.id)])];
      const cancelled = await tx.plotBooking.updateMany({
        where: { id: { in: bookingIds }, tenantId, contactId, plotSiteId, status: "PLOT_ASSIGNED", paymentStatus: { in: ["", "UNPAID"] }, amountPaid: 0, invoiceId: null },
        data: { status: "CANCELLED" },
      });
      if (cancelled.count !== bookingIds.length) {
        const error = new Error("This plot can no longer be deselected because its booking or payment workflow has started.");
        error.code = "PLOT_UNASSIGNMENT_LOCKED";
        throw error;
      }
      if (!activeBookings.some((row) => row.contactId !== contactId)) await tx.plotSite.updateMany({
        where: { id: plotSiteId, tenantId, availability: "RESERVED" },
        data: { availability: "AVAILABLE" },
      });
      await appendWorkflowEvent(tx, req, {
        bookingId: booking.id,
        contactId,
        plotSiteId,
        stage: "PLOT",
        eventType: "PLOT_UNASSIGNED",
        label: "Plot unassigned",
        fromStatus: "PLOT_ASSIGNED",
        toStatus: "CANCELLED",
        metadata: { unassignedByAdmin: true },
      });
    }, { isolationLevel: "Serializable" });
    return res.json({ contactId, plotSiteId, unassigned: true });
  } catch (error) {
    console.error("pickup-plot-inventory DELETE /customer-pickups/:contactId/plots/:plotSiteId error:", error);
    if (["TRANSPORT_WORKFLOW_LOCKED", "PLOT_UNASSIGNMENT_LOCKED"].includes(error.code)) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    if (error.code === "P2034") return res.status(409).json({ error: "The assignment changed concurrently. Refresh and try again.", code: "PLOT_UNASSIGNMENT_CONFLICT" });
    return res.status(500).json({ error: "Failed to unassign plot", code: "PLOT_UNASSIGNMENT_FAILED" });
  }
});

router.post("/customer-pickups/:contactId/installments", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    const plotBookingId = Number(req.body?.plotBookingId);
    const frequency = String(req.body?.frequency || "").trim().toUpperCase();
    const paymentCount = Number(req.body?.paymentCount);
    const amount = Math.round((Number(req.body?.amount) + Number.EPSILON) * 100) / 100;
    const firstPaymentDate = text(req.body?.firstPaymentDate, 10);
    const firstMonth = Number(req.body?.firstMonth);
    const firstYear = Number(req.body?.firstYear);
    if (!Number.isInteger(contactId) || contactId <= 0 || !Number.isInteger(plotBookingId) || plotBookingId <= 0) {
      return res.status(400).json({ error: "Choose a valid customer and plot booking.", code: "INVALID_INSTALLMENT_BOOKING" });
    }
    const frequencyMonths = { MONTHLY: 1, QUARTERLY: 3, HALF_YEARLY: 6, YEARLY: 12 };
    if (!frequencyMonths[frequency]) {
      return res.status(400).json({ error: "Choose Monthly, Quarterly, Half-Yearly, or Yearly payment frequency.", code: "INVALID_INSTALLMENT_FREQUENCY" });
    }
    if (!Number.isInteger(paymentCount) || paymentCount < 1 || paymentCount > 120) {
      return res.status(400).json({ error: "Number of payments must be between 1 and 120.", code: "INVALID_INSTALLMENT_COUNT" });
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter a valid amount for each installment.", code: "INVALID_INSTALLMENT_AMOUNT" });
    }
    const firstDueDate = firstPaymentDate
      ? new Date(`${firstPaymentDate}T12:00:00.000Z`)
      : new Date(Date.UTC(firstYear, firstMonth - 1, 1, 12));
    const validLegacyDate = Number.isInteger(firstMonth) && firstMonth >= 1 && firstMonth <= 12
      && Number.isInteger(firstYear) && firstYear >= new Date().getFullYear();
    if (Number.isNaN(firstDueDate.getTime()) || (!firstPaymentDate && !validLegacyDate)) {
      return res.status(400).json({ error: "Choose a valid first payment date.", code: "INVALID_INSTALLMENT_START" });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    if (String(tenant?.vertical || "").toLowerCase() !== "generic") {
      return res.status(404).json({ error: "Installment plans are available only for Generic CRM.", code: "GENERIC_CRM_ONLY" });
    }
    const booking = await prisma.plotBooking.findFirst({
      where: { id: plotBookingId, tenantId, contactId, status: { notIn: ["CANCELLED", "PLOT_ASSIGNED"] } },
    });
    if (!booking) return res.status(404).json({ error: "Active plot booking not found.", code: "PLOT_BOOKING_NOT_FOUND" });
    const existing = await prisma.plotInstallment.findMany({
      where: { tenantId, plotBookingId },
      orderBy: { sequenceNumber: "asc" },
    });
    const reservedAmount = existing
      .filter((row) => !["PAID", "CANCELLED"].includes(String(row.status || "").toUpperCase()))
      .reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const requestedTotal = amount * paymentCount;
    const availableBalance = Math.max(0, Number(booking.balance || 0) - reservedAmount);
    if (requestedTotal > availableBalance + 0.001) {
      return res.status(400).json({
        error: `The schedule total cannot exceed the unplanned balance of ${availableBalance.toFixed(2)}.`,
        code: "INSTALLMENT_SCHEDULE_EXCEEDS_BALANCE",
      });
    }
    const nextSequence = existing.reduce((max, row) => Math.max(max, Number(row.sequenceNumber || 0)), 0) + 1;
    const installments = await prisma.$transaction(Array.from({ length: paymentCount }, (_, index) => {
      const dueDate = addUtcMonthsClamped(firstDueDate, frequencyMonths[frequency] * index);
      return prisma.plotInstallment.create({
        data: {
          tenantId,
          plotBookingId,
          contactId,
          sequenceNumber: nextSequence + index,
          frequency,
          dueDate,
          amount,
          status: "PLANNED",
        },
      });
    }));
    return res.status(201).json({ installments: installments.map((row) => ({ ...row, amount: Number(row.amount || 0) })) });
  } catch (error) {
    console.error("pickup-plot-inventory POST /customer-pickups/:contactId/installments error:", error);
    return res.status(500).json({ error: "Failed to create installment schedule", code: "INSTALLMENT_SCHEDULE_CREATE_FAILED" });
  }
});

router.post("/customer-pickups/:contactId/initial-payment", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }

    const method = text(req.body?.method, 40)?.toLowerCase();
    const allowedMethods = new Set(["payment_link", "upi", "cash", "card", "bank_transfer", "cheque"]);
    if (!allowedMethods.has(method)) {
      return res.status(400).json({ error: "Choose a valid payment method.", code: "INVALID_PAYMENT_METHOD" });
    }
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter a valid payment amount.", code: "INVALID_PAYMENT_AMOUNT" });
    }
    const submittedBookingId = req.body?.plotBookingId;
    const plotBookingId = submittedBookingId === undefined || submittedBookingId === null || submittedBookingId === ""
      ? null
      : Number(submittedBookingId);
    if (plotBookingId !== null && (!Number.isInteger(plotBookingId) || plotBookingId <= 0)) {
      return res.status(400).json({ error: "Choose a valid plot booking.", code: "INVALID_PLOT_BOOKING_ID" });
    }
    const submittedInstallmentId = req.body?.installmentId;
    const installmentId = submittedInstallmentId === undefined || submittedInstallmentId === null || submittedInstallmentId === ""
      ? null
      : Number(submittedInstallmentId);
    if (installmentId !== null && (!Number.isInteger(installmentId) || installmentId <= 0)) {
      return res.status(400).json({ error: "Choose a valid installment.", code: "INVALID_INSTALLMENT_ID" });
    }

    const [contact, booking] = await Promise.all([
      prisma.contact.findFirst({
        where: { id: contactId, tenantId, deletedAt: null },
        select: { id: true, name: true, email: true, phone: true },
      }),
      prisma.plotBooking.findFirst({
        where: {
          tenantId,
          contactId,
          ...(plotBookingId === null ? {} : { id: plotBookingId }),
          status: { notIn: ["CANCELLED", "PLOT_ASSIGNED"] },
        },
        orderBy: { updatedAt: "desc" },
      }),
    ]);
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });
    if (!booking) {
      return res.status(409).json({ error: "Select a plot before generating an initial payment.", code: "PLOT_BOOKING_REQUIRED" });
    }
    const balance = Number(booking.balance ?? booking.totalAmount ?? 0);
    if (amount > balance) {
      return res.status(400).json({
        error: "Payment amount cannot exceed the outstanding booking balance.",
        code: "PAYMENT_EXCEEDS_BALANCE",
        balance,
      });
    }
    const installment = installmentId === null ? null : await prisma.plotInstallment.findFirst({
      where: { id: installmentId, tenantId, plotBookingId: booking.id, contactId },
    });
    if (installmentId !== null && (!installment || !["PLANNED", "FAILED"].includes(String(installment.status || "").toUpperCase()) || installment.paymentId)) {
      return res.status(409).json({ error: "This installment is no longer available for payment.", code: "INSTALLMENT_NOT_PAYABLE" });
    }
    if (installment && Math.abs(Number(installment.amount || 0) - amount) > 0.001) {
      return res.status(400).json({ error: "Payment amount must match the scheduled installment.", code: "INSTALLMENT_AMOUNT_MISMATCH" });
    }

    if (method === "payment_link") {
      if (installment) {
        // Claim before contacting the gateway: concurrent requests and manual
        // payments must not issue multiple independently payable links.
        const claim = await prisma.plotInstallment.updateMany({
          where: { id: installment.id, tenantId, plotBookingId: booking.id, paymentId: null, status: { in: ['PLANNED', 'FAILED'] } },
          data: { status: 'LINK_CREATING' },
        });
        if (!claim.count) return res.status(409).json({ error: 'This installment already has a payment in progress.', code: 'INSTALLMENT_NOT_PAYABLE' });
      }
      const { createInvoicePaymentLink } = require("../lib/paymentLink");
      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
      const paymentDescription = installment
        ? `Installment ${installment.sequenceNumber} for plot booking ${booking.bookingNumber}`
        : `Initial payment for plot booking ${booking.bookingNumber}`;
      const result = await createInvoicePaymentLink({
        tenantId,
        invoice: { id: booking.id, invoiceNum: booking.bookingNumber, amount },
        contact,
        contactId,
        currency: "INR",
        gatewayPref: "razorpay",
        tenantName: tenant?.name || undefined,
        baseUrl: getFrontendUrlFromRequest(req),
        travelContext: { kind: "plot-booking-payment", plotBookingId: booking.id, ...(installment ? { installmentId: installment.id } : {}) },
        description: paymentDescription,
      });
      if (result.error) {
        const gatewayStatus = Number(result.status);
        const responseStatus = gatewayStatus >= 400 && gatewayStatus < 600 ? gatewayStatus : 502;
        return res.status(responseStatus).json({ error: result.error, code: result.code || "PAYMENT_LINK_FAILED" });
      }
      if (!result.url) {
        return res.status(502).json({
          error: "Razorpay did not return a hosted payment link. Please verify the payment gateway configuration.",
          code: "PAYMENT_LINK_URL_MISSING",
        });
      }
      if (installment) {
        await prisma.plotInstallment.update({
          where: { id: installment.id },
          data: { status: "PAYMENT_INITIATED", paymentId: result.paymentId },
        });
      }
      return res.json({
        mode: "payment_link",
        url: result.url,
        gateway: result.gateway,
        payment: { id: result.paymentId, amount, status: "PENDING", createdAt: new Date().toISOString() },
      });
    }

    const transactionRef = method === "cash" ? null : text(req.body?.transactionRef, 128);
    if (method !== "cash" && !transactionRef) {
      return res.status(400).json({ error: "Transaction reference is required.", code: "PAYMENT_REFERENCE_REQUIRED" });
    }
    const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) {
      return res.status(400).json({ error: "Choose a valid payment date.", code: "INVALID_PAYMENT_DATE" });
    }
    const duplicatePayment = transactionRef ? await prisma.payment.findFirst({
      where: { tenantId, plotPaymentReference: transactionRef },
      select: { id: true },
    }) : null;
    if (duplicatePayment) {
      return res.status(409).json({ error: "That transaction reference has already been recorded.", code: "DUPLICATE_TRANSACTION_REFERENCE" });
    }

    let payment;
    let nextAmountPaid;
    let nextBalance;
    await prisma.$transaction(async (tx) => {
      await require("../lib/plotBookingPayments").lockBooking(tx, tenantId, booking.id);
      const current = await tx.plotBooking.findFirst({
        where: { id: booking.id, tenantId, contactId, status: { notIn: ["CANCELLED", "PLOT_ASSIGNED"] } },
      });
      // A gateway may have committed a SUCCESS payment while its booking
      // reconciliation is still waiting for this lock. Include that ledger
      // amount as well as legacy booked totals before accepting more cash.
      const ledgerPaid = current
        ? await require("../lib/plotBookingPayments").successfulPaymentTotal(tx, tenantId, booking.id)
        : 0;
      const accountedPaid = Math.max(Number(current?.amountPaid || 0), ledgerPaid);
      const remaining = Math.min(
        Number(current?.balance ?? current?.totalAmount ?? 0),
        Math.max(0, Number(current?.totalAmount || 0) - accountedPaid),
      );
      if (!current || amount > remaining) {
        const error = new Error("Payment amount exceeds the current outstanding booking balance.");
        error.code = "PAYMENT_EXCEEDS_BALANCE";
        throw error;
      }
      if (installment) {
        const claim = await tx.plotInstallment.updateMany({ where: { id: installment.id, tenantId, plotBookingId: booking.id, paymentId: null, status: { in: ['PLANNED', 'FAILED'] } }, data: { status: 'PAID' } });
        if (!claim.count) {
          const error = new Error("This installment has already been paid.");
          error.code = "INSTALLMENT_NOT_PAYABLE";
          throw error;
        }
      }
      nextAmountPaid = accountedPaid + amount;
      nextBalance = Math.max(0, Number(current.totalAmount || 0) - nextAmountPaid);
      payment = await tx.payment.create({
        data: {
          contactId,
          description: `Initial payment for plot booking ${booking.bookingNumber}`,
          amount,
          currency: "INR",
          gateway: method,
          gatewayId: transactionRef,
          plotPaymentReference: transactionRef,
          status: "SUCCESS",
          paidAt,
          tenantId,
          metadata: JSON.stringify({ kind: "plot-booking-payment", plotBookingId: booking.id, mode: "manual", ...(installment ? { installmentId: installment.id } : {}) }),
        },
      });
      if (installment) {
        await tx.plotInstallment.update({
          where: { id: installment.id },
          data: { status: "PAID", paymentId: payment.id },
        });
      }
      await syncPlotCommission(tx, payment, current);
      await tx.plotBooking.update({
        where: { id: booking.id },
        data: {
          amountPaid: nextAmountPaid,
          balance: nextBalance,
          paymentStatus: nextBalance === 0 ? "PAID" : "PARTIAL",
        },
      });
      await syncPlotBookingInvoice(tx, {
        tenantId,
        booking,
        contact,
        paymentId: payment.id,
        amountPaid: nextAmountPaid,
        balance: nextBalance,
        paymentMode: method,
        paidAt,
      });
      await appendWorkflowEvent(tx, req, {
        bookingId: booking.id,
        contactId,
        plotSiteId: booking.plotSiteId,
        stage: "PAYMENT",
        eventType: "INITIAL_PAYMENT_RECORDED",
        label: "Initial payment recorded",
        toStatus: nextBalance === 0 ? "PAID" : "PARTIAL",
        occurredAt: paidAt.toISOString(),
        metadata: { paymentId: payment.id, amount, method, transactionRef },
      });
    });
    return res.json({
      mode: "recorded",
      payment: {
        id: payment.id,
        amount: payment.amount,
        currency: payment.currency,
        gateway: payment.gateway,
        gatewayId: payment.gatewayId,
        status: payment.status,
        paidAt: payment.paidAt,
        createdAt: payment.createdAt,
      },
      booking: { id: booking.id, amountPaid: nextAmountPaid, balance: nextBalance },
    });
  } catch (error) {
    if (error.code === "INSTALLMENT_NOT_PAYABLE") return res.status(409).json({ error: error.message, code: error.code });
    if (error.code === "PAYMENT_EXCEEDS_BALANCE") {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    console.error("pickup-plot-inventory POST /customer-pickups/:contactId/initial-payment error:", error);
    if (error.code === "P2002" && String(error.meta?.target || "").includes("plotPaymentReference")) {
      return res.status(409).json({ error: "That transaction reference has already been recorded.", code: "DUPLICATE_TRANSACTION_REFERENCE" });
    }
    return res.status(500).json({ error: "Failed to generate initial payment", code: "INITIAL_PAYMENT_FAILED" });
  }
});

router.patch("/commissions/:id/rate", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const commissionId = Number(req.params.id);
    const commissionPercent = Math.round((Number(req.body?.commissionPercent) + Number.EPSILON) * 100) / 100;
    if (!Number.isInteger(commissionId) || commissionId <= 0) {
      return res.status(400).json({ error: "Choose a valid commission entry.", code: "INVALID_COMMISSION_ID" });
    }
    if (!Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
      return res.status(400).json({ error: "Commission percentage must be between 0 and 100.", code: "INVALID_COMMISSION_PERCENT" });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    if (String(tenant?.vertical || "").toLowerCase() !== "generic") {
      return res.status(404).json({ error: "Commission tracking is available only for Generic CRM.", code: "GENERIC_CRM_ONLY" });
    }
    const commission = await prisma.plotCommission.findFirst({ where: { id: commissionId, tenantId } });
    if (!commission) return res.status(404).json({ error: "Commission entry not found.", code: "COMMISSION_NOT_FOUND" });
    if (String(commission.status || "EARNED").toUpperCase() !== "EARNED") {
      return res.status(409).json({ error: "Only an earned commission can be edited.", code: "COMMISSION_NOT_EDITABLE" });
    }
    const commissionAmount = Math.round((Number(commission.eligibleAmount || 0) * commissionPercent / 100 + Number.EPSILON) * 100) / 100;
    const updated = await prisma.plotCommission.update({
      where: { id: commission.id },
      data: { commissionPercent, commissionAmount },
    });
    await appendWorkflowEvent(prisma, req, {
      bookingId: commission.plotBookingId,
      contactId: commission.contactId,
      stage: "COMMISSION",
      fromStatus: commission.status,
      toStatus: "RATE_UPDATED",
      metadata: { commissionId: commission.id, previousPercent: Number(commission.commissionPercent || 0), commissionPercent, commissionAmount },
    });
    return res.json({
      ...updated,
      commissionPercent: Number(updated.commissionPercent || 0),
      eligibleAmount: Number(updated.eligibleAmount || 0),
      commissionAmount: Number(updated.commissionAmount || 0),
    });
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /commissions/:id/rate error:", error);
    return res.status(500).json({ error: "Failed to update commission percentage", code: "COMMISSION_RATE_UPDATE_FAILED" });
  }
});

router.patch("/commissions/:id/amount", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const commissionId = Number(req.params.id);
    const commissionAmount = Number(req.body?.commissionAmount);
    if (!Number.isInteger(commissionId) || commissionId <= 0) {
      return res.status(400).json({ error: "Choose a valid commission entry.", code: "INVALID_COMMISSION_ID" });
    }
    if (!Number.isFinite(commissionAmount) || commissionAmount < 0) {
      return res.status(400).json({ error: "Enter a valid commission amount.", code: "INVALID_COMMISSION_AMOUNT" });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    if (String(tenant?.vertical || "").toLowerCase() !== "generic") {
      return res.status(404).json({ error: "Commission tracking is available only for Generic CRM.", code: "GENERIC_CRM_ONLY" });
    }
    const commission = await prisma.plotCommission.findFirst({ where: { id: commissionId, tenantId } });
    if (!commission) {
      return res.status(404).json({ error: "Commission entry not found.", code: "COMMISSION_NOT_FOUND" });
    }
    if (String(commission.status || "EARNED").toUpperCase() !== "EARNED") {
      return res.status(409).json({ error: "Only an earned commission can be edited.", code: "COMMISSION_NOT_EDITABLE" });
    }
    const eligibleAmount = Number(commission.eligibleAmount || 0);
    if (commissionAmount > eligibleAmount) {
      return res.status(400).json({ error: "Commission cannot be greater than the customer payment.", code: "COMMISSION_EXCEEDS_PAYMENT" });
    }
    const roundedAmount = Math.round((commissionAmount + Number.EPSILON) * 100) / 100;
    const commissionPercent = eligibleAmount > 0
      ? Math.round(((roundedAmount / eligibleAmount) * 100 + Number.EPSILON) * 100) / 100
      : 0;
    const updated = await prisma.plotCommission.update({
      where: { id: commission.id },
      data: { commissionAmount: roundedAmount, commissionPercent },
    });
    await appendWorkflowEvent(prisma, req, {
      bookingId: commission.plotBookingId,
      contactId: commission.contactId,
      stage: "COMMISSION",
      fromStatus: commission.status,
      toStatus: "AMOUNT_UPDATED",
      metadata: { commissionId: commission.id, previousAmount: Number(commission.commissionAmount || 0), commissionAmount: roundedAmount },
    });
    return res.json({
      ...updated,
      commissionPercent: Number(updated.commissionPercent || 0),
      eligibleAmount: Number(updated.eligibleAmount || 0),
      commissionAmount: Number(updated.commissionAmount || 0),
      netPaymentAmount: Math.max(0, Number(updated.eligibleAmount || 0) - Number(updated.commissionAmount || 0)),
    });
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /commissions/:id/amount error:", error);
    return res.status(500).json({ error: "Failed to update commission amount", code: "COMMISSION_AMOUNT_UPDATE_FAILED" });
  }
});

router.patch("/commissions/:id/status", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const commissionId = Number(req.params.id);
    const requestedStatus = String(req.body?.status || "").trim().toUpperCase();
    if (!Number.isInteger(commissionId) || commissionId <= 0) {
      return res.status(400).json({ error: "Choose a valid commission entry.", code: "INVALID_COMMISSION_ID" });
    }
    if (!new Set(["APPROVED", "PAID"]).has(requestedStatus)) {
      return res.status(400).json({ error: "Commission status must be Approved or Paid.", code: "INVALID_COMMISSION_STATUS" });
    }
    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { vertical: true } });
    if (String(tenant?.vertical || "").toLowerCase() !== "generic") {
      return res.status(404).json({ error: "Commission tracking is available only for Generic CRM.", code: "GENERIC_CRM_ONLY" });
    }
    let updated;
    await prisma.$transaction(async (tx) => {
      const initial = await tx.plotCommission.findFirst({ where: { id: commissionId, tenantId } });
      if (!initial) { const error = new Error("Commission entry not found."); error.code = "COMMISSION_NOT_FOUND"; throw error; }
      await require("../lib/plotBookingPayments").lockBooking(tx, tenantId, initial.plotBookingId);
      const commission = await tx.plotCommission.findFirst({ where: { id: commissionId, tenantId } });
      if (!commission) {
        const error = new Error("Commission entry not found."); error.code = "COMMISSION_NOT_FOUND"; throw error;
      }
      const currentStatus = String(commission.status || "EARNED").toUpperCase();
      const validTransition = (currentStatus === "EARNED" && requestedStatus === "APPROVED")
        || (currentStatus === "APPROVED" && requestedStatus === "PAID")
        || currentStatus === requestedStatus;
      if (!validTransition) {
        const error = new Error(`Commission cannot move from ${currentStatus} to ${requestedStatus}.`);
        error.code = "INVALID_COMMISSION_TRANSITION";
        throw error;
      }
      const funded = await require("../lib/plotBookingPayments").successfulPaymentTotal(tx, tenantId, commission.plotBookingId);
      if (funded + 0.001 < Number(commission.commissionAmount)) {
        const error = new Error("Commission must be fully deducted from successful payments before approval or payout.");
        error.code = "COMMISSION_NOT_FUNDED";
        throw error;
      }
      const now = new Date();
      updated = currentStatus === requestedStatus
        ? commission
        : await tx.plotCommission.update({
          where: { id: commission.id },
          data: requestedStatus === "APPROVED"
            ? { status: "APPROVED", approvedAt: now, approvedByUserId: req.user.userId }
            : { status: "PAID", paidAt: now, paidByUserId: req.user.userId },
        });
      if (currentStatus !== requestedStatus) {
        await appendWorkflowEvent(tx, req, {
          bookingId: commission.plotBookingId,
          contactId: commission.contactId,
          stage: "COMMISSION",
          eventType: `COMMISSION_${requestedStatus}`,
          label: requestedStatus === "APPROVED" ? "Commission approved" : "Commission marked paid",
          fromStatus: currentStatus,
          toStatus: requestedStatus,
          occurredAt: now.toISOString(),
          metadata: { commissionId: commission.id, paymentId: commission.paymentId, amount: Number(commission.commissionAmount || 0) },
        });
      }
    });
    return res.json({
      ...updated,
      commissionPercent: Number(updated.commissionPercent || 0),
      eligibleAmount: Number(updated.eligibleAmount || 0),
      commissionAmount: Number(updated.commissionAmount || 0),
    });
  } catch (error) {
    if (["COMMISSION_NOT_FUNDED", "INVALID_COMMISSION_TRANSITION", "COMMISSION_NOT_FOUND"].includes(error.code)) return res.status(error.code === "COMMISSION_NOT_FOUND" ? 404 : 409).json({ error: error.message, code: error.code });
    console.error("pickup-plot-inventory PATCH /commissions/:id/status error:", error);
    return res.status(500).json({ error: "Failed to update commission status", code: "COMMISSION_STATUS_UPDATE_FAILED" });
  }
});

router.get("/customer-pickups", requirePermission("billing_workspace", "read"), async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const adminOverview = isAdminWorkspaceOverview(req);
    const profile = adminOverview ? null : await requireBillingProfile(req, res);
    if (!adminOverview && !profile) return;
    const pairs = profile ? assignmentPairs(profile.billingPerson).filter((pair) => (
      Number.isInteger(pair.customerId) && pair.customerId > 0
      && Number.isInteger(pair.plotSiteId) && pair.plotSiteId > 0
    )) : [];
    const allowedPairKeys = new Set(pairs.map((pair) => assignmentKey(pair.customerId, pair.plotSiteId)));
    const contactIds = [...new Set(pairs.map((pair) => pair.customerId))];
    const plotIds = [...new Set(pairs.map((pair) => pair.plotSiteId))];
    const pairWhere = pairs.map((pair) => ({ contactId: pair.customerId, plotSiteId: pair.plotSiteId }));
    const customerScope = adminOverview ? {} : { contactId: { in: contactIds } };
    const assignmentScope = adminOverview ? {} : { OR: pairWhere.length ? pairWhere : [{ id: -1 }] };
    const [pickups, transportPeople, brokers, workflowEvents, plots, bookings, plotPayments, pickupLocations] = await Promise.all([
      prisma.customerPickup.findMany({
        where: { tenantId, ...customerScope, contact: { deletedAt: null } },
        orderBy: { updatedAt: "desc" },
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true, company: true, status: true, interestedPlotArea: true } },
        },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, phone: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true, updatedAt: true },
      }),
      prisma.plotBroker.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, phone: true, commissionPercent: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, workflowStatusJson: true },
      }),
      prisma.plotWorkflowEvent.findMany({
        where: { tenantId, ...assignmentScope },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      }),
      prisma.plotSite.findMany({
        where: { tenantId, ...(!adminOverview ? { id: { in: plotIds } } : {}) },
        select: {
          id: true, name: true, plotNumber: true, block: true, address: true,
          referenceCode: true, area: true, areaUnit: true, roadWidth: true,
          facing: true, propertyType: true, price: true, availability: true, isActive: true,
        },
      }),
      prisma.plotBooking.findMany({
        where: { tenantId, ...assignmentScope },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true, bookingNumber: true, contactId: true, plotSiteId: true,
          plotBrokerId: true, invoiceId: true, status: true, paymentStatus: true, totalAmount: true,
          amountPaid: true, balance: true, reservedAt: true, soldAt: true,
          completedAt: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.payment.findMany({
        where: {
          tenantId,
          ...customerScope,
          OR: [
            { invoiceId: { not: null } },
            { metadata: { contains: '"kind":"plot-booking-payment"' } },
          ],
        },
        orderBy: [{ paidAt: "asc" }, { createdAt: "asc" }],
        select: {
          id: true, tenantId: true, invoiceId: true, contactId: true, description: true,
          amount: true, currency: true, gateway: true, gatewayId: true,
          status: true, paidAt: true, createdAt: true, metadata: true,
        },
      }),
      prisma.pickupLocation.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, googleMapsLink: true },
      }),
    ]);
    // Legacy person records contain tenant-wide assignment JSON. Trim it
    // before deriving workflow state so another plot for the same customer
    // cannot leak through a shared transport/broker profile.
    if (!adminOverview) {
      for (const person of [...transportPeople, ...brokers]) {
        const allowed = assignmentPairs(person).filter((pair) => allowedPairKeys.has(assignmentKey(pair.customerId, pair.plotSiteId)));
        person.assignmentPairsJson = JSON.stringify(allowed);
        person.customerIdsJson = JSON.stringify([...new Set(allowed.map((pair) => pair.customerId))]);
        person.plotSiteIdsJson = JSON.stringify([...new Set(allowed.map((pair) => pair.plotSiteId))]);
        for (const field of ["assignmentStatusJson", "workflowStatusJson"]) {
          const statuses = parseStoredObject(person[field]);
          person[field] = JSON.stringify(Object.fromEntries(allowed.map((pair) => {
            const key = assignmentKey(pair.customerId, pair.plotSiteId);
            return [key, statuses[key] || statuses[`customer-${pair.customerId}`]];
          }).filter(([, value]) => value)));
        }
      }
    }
    let plotCommissions = [];
    if (req.user.role === "ADMIN") {
      const bookingMap = new Map(bookings.map((booking) => [Number(booking.id), booking]));
      for (const payment of plotPayments) {
        if (String(payment.status || "").toUpperCase() !== "SUCCESS") continue;
        let metadata = {};
        try { metadata = JSON.parse(payment.metadata || "{}"); } catch { continue; }
        const booking = bookingMap.get(Number(metadata.plotBookingId));
        if (metadata.kind === "plot-booking-payment" && booking) {
          await syncPlotCommission(prisma, payment, booking);
        }
      }
      plotCommissions = await prisma.plotCommission.findMany({
        where: { tenantId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    }
    const plotInstallments = await prisma.plotInstallment.findMany({
      where: { tenantId },
      orderBy: [{ plotBookingId: "asc" }, { sequenceNumber: "asc" }],
    });
    const plotMap = new Map(plots.map((plot) => [Number(plot.id), plot]));
    const brokerMap = new Map(brokers.map((broker) => [Number(broker.id), broker]));
    const commissionsByBooking = new Map();
    for (const commission of plotCommissions) {
      const rows = commissionsByBooking.get(Number(commission.plotBookingId)) || [];
      const broker = brokerMap.get(Number(commission.plotBrokerId));
      rows.push({
        ...commission,
        commissionPercent: Number(commission.commissionPercent || 0),
        eligibleAmount: Number(commission.eligibleAmount || 0),
        commissionAmount: Number(commission.commissionAmount || 0),
        brokerName: broker?.name || "Sales Executive",
      });
      commissionsByBooking.set(Number(commission.plotBookingId), rows);
    }
    const installmentsByBooking = new Map();
    const plotPaymentById = new Map(plotPayments.map((payment) => [Number(payment.id), payment]));
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    for (const installment of plotInstallments) {
      const rows = installmentsByBooking.get(Number(installment.plotBookingId)) || [];
      const payment = plotPaymentById.get(Number(installment.paymentId));
      let paymentMetadata = {};
      try { paymentMetadata = JSON.parse(payment?.metadata || "{}"); } catch (_error) {}
      const storedStatus = String(installment.status || "PLANNED").toUpperCase();
      const paymentStatus = String(payment?.status || "").toUpperCase();
      let effectiveStatus = storedStatus === "LINK_CREATED" ? "PAYMENT_INITIATED" : storedStatus;
      if (paymentStatus === "SUCCESS" || storedStatus === "PAID") effectiveStatus = "PAID";
      else if (paymentStatus === "FAILED") effectiveStatus = "FAILED";
      else if (paymentStatus === "PROCESSING") effectiveStatus = "PROCESSING";
      else if (effectiveStatus === "PLANNED" && new Date(installment.dueDate) < todayStart) effectiveStatus = "OVERDUE";
      rows.push({
        ...installment,
        amount: Number(installment.amount || 0),
        status: effectiveStatus,
        paymentLinkUrl: ["PAYMENT_INITIATED", "PROCESSING"].includes(effectiveStatus) ? paymentMetadata.url || null : null,
        receiptUrl: effectiveStatus === "PAID" && paymentMetadata.plinkId
          ? `/api/billing/public/receipt?plinkId=${encodeURIComponent(paymentMetadata.plinkId)}`
          : null,
      });
      installmentsByBooking.set(Number(installment.plotBookingId), rows);
    }
    const historyByCustomer = new Map();
    for (const event of workflowEvents) {
      const history = historyByCustomer.get(event.contactId) || [];
      history.push({
        id: event.id,
        bookingId: event.plotBookingId,
        plotSiteId: event.plotSiteId,
        stage: event.stage,
        eventType: event.eventType,
        label: event.label,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        occurredAt: event.occurredAt,
      });
      historyByCustomer.set(event.contactId, history);
    }
    const customers = pickups.map((pickup) => {
      const workflowStatus = findCustomerWorkflowStatus(pickup.contactId, transportPeople, brokers, plotMap);
      const customerBookings = bookings.filter((row) => (
        Number(row.contactId) === Number(pickup.contactId) && row.status !== "CANCELLED"
      ));
      const financialBookings = customerBookings.filter((row) => row.status !== "PLOT_ASSIGNED");
      const assignedPlotIds = [...new Set([
        workflowStatus.assignedPlot?.id,
        ...customerBookings.map((row) => Number(row.plotSiteId)),
      ].filter((id) => Number.isInteger(Number(id)) && Number(id) > 0).map(Number))];
      const assignedPlots = assignedPlotIds.map((id) => plotMap.get(id)).filter(Boolean);
      const assignedPlot = workflowStatus.assignedPlot || assignedPlots[0] || null;
      const booking = financialBookings.find((row) => (
        Number(row.contactId) === Number(pickup.contactId)
        && (!assignedPlot?.id || Number(row.plotSiteId) === Number(assignedPlot.id))
      )) || financialBookings[0] || null;
      const effectiveBillingStatus = workflowStatus.currentStage === "billing"
        ? billingStatusWithBooking(workflowStatus.currentStatus, booking)
        : workflowStatus.currentStatus;
      const effectiveWorkflowStatus = effectiveBillingStatus === workflowStatus.currentStatus
        ? workflowStatus
        : {
            ...workflowStatus,
            currentStatus: effectiveBillingStatus,
            workflow: {
              ...workflowStatus.workflow,
              billing: {
                ...workflowStatus.workflow.billing,
                status: effectiveBillingStatus,
              },
            },
          };
      const selectedPlot = booking ? plotMap.get(Number(booking.plotSiteId)) || null : null;
      const payments = plotPayments.filter((payment) => {
        let metadata = {};
        try { metadata = JSON.parse(payment.metadata || "{}"); } catch (_error) {}
        const matchesBooking = booking && Number(metadata.plotBookingId) === Number(booking.id);
        const matchesInvoice = booking?.invoiceId && Number(payment.invoiceId) === Number(booking.invoiceId);
        return Number(payment.contactId) === Number(pickup.contactId) && (matchesBooking || matchesInvoice);
      }).map(({ metadata, ...payment }) => {
        let paymentMetadata = {};
        try { paymentMetadata = JSON.parse(metadata || "{}"); } catch (_error) {}
        const paymentStatus = String(payment.status || "").toUpperCase();
        const paymentLinkUrl = ["PENDING", "PAYMENT_INITIATED", "LINK_CREATED", "PROCESSING"].includes(paymentStatus)
          ? paymentMetadata.url || paymentMetadata.sessionUrl || null
          : null;
        const receiptUrl = paymentStatus === "SUCCESS" && paymentMetadata.plinkId
          ? `/api/billing/public/receipt?plinkId=${encodeURIComponent(paymentMetadata.plinkId)}`
          : null;
        return { ...payment, paymentLinkUrl, receiptUrl };
      });
      const commissions = booking ? commissionsByBooking.get(Number(booking.id)) || [] : [];
      const commissionRows = commissions.map((commission) => {
        return {
          ...commission,
          ...allocateCommissionAcrossPayments(payments, commission.commissionAmount),
        };
      });
      return {
        ...pickup,
        pickupAddress: cleanPickupAddress(pickup.pickupAddress) || pickup.pickupAddress,
        ...effectiveWorkflowStatus,
        assignedPlot,
        assignedPlots,
        selectedPlot,
        customerAssignedPlotIds: customerBookings.map((row) => Number(row.plotSiteId)).filter((id) => Number.isInteger(id) && id > 0),
        booking,
        payments,
        commissions: commissionRows,
        installments: booking ? installmentsByBooking.get(Number(booking.id)) || [] : [],
        workflowHistory: historyByCustomer.get(pickup.contactId) || [],
      };
    });
    const pickupContactIds = new Set(pickups.map((pickup) => Number(pickup.contactId)));
    const plotOnlyContactIds = [...new Set(bookings
      .filter((booking) => booking.status !== "CANCELLED")
      .map((booking) => Number(booking.contactId))
      .filter((contactId) => Number.isInteger(contactId) && contactId > 0 && !pickupContactIds.has(contactId)))];
    const plotOnlyContacts = plotOnlyContactIds.length
      ? await prisma.contact.findMany({
          where: { tenantId, id: { in: plotOnlyContactIds }, deletedAt: null },
          select: { id: true, name: true, phone: true, email: true, company: true, status: true, interestedPlotArea: true },
        })
      : [];
    const plotAssignments = plotOnlyContacts.map((contact) => {
      const customerBookings = bookings.filter((booking) => (
        Number(booking.contactId) === Number(contact.id) && booking.status !== "CANCELLED"
      ));
      const assignedPlots = [...new Set(customerBookings.map((booking) => Number(booking.plotSiteId)))]
        .map((plotId) => plotMap.get(plotId))
        .filter(Boolean);
      return {
        contactId: contact.id,
        contact,
        assignedPlot: assignedPlots[0] || null,
        assignedPlots,
        customerAssignedPlotIds: customerBookings.map((booking) => Number(booking.plotSiteId)),
        booking: customerBookings.find((booking) => booking.status !== "PLOT_ASSIGNED") || null,
      };
    });
    return res.json({
      customers,
      plotAssignments,
      pickupLocations,
      allPlots: plots.filter((plot) => plot.isActive),
      plots: plots.filter((plot) => (
        plot.isActive && String(plot.availability || "").trim().toUpperCase() === "AVAILABLE"
      )),
      summary: {
        total: customers.length,
        awaitingAssignment: customers.filter((row) => customerJourneyBucket(row) === "waiting").length,
        activeTrips: customers.filter((row) => customerJourneyBucket(row) === "active").length,
        completed: customers.filter((row) => customerJourneyBucket(row) === "completed").length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /customer-pickups error:", error);
    return res.status(500).json({ error: "Failed to load customer pickup status", code: "CUSTOMER_PICKUPS_LOAD_FAILED" });
  }
});

router.put("/customer-pickups/:contactId", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const contactId = Number(req.params.contactId);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }
    const pickupAddress = cleanPickupAddress(req.body?.pickupAddress);
    const validationError = firstError(
      validateRequiredText(pickupAddress, "Pickup location", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.sourceTranscriptId, "Transcript id", 191),
      validateOptionalText(req.body?.sourceExcerpt, "Transcript excerpt", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    const contactWhere = { id: contactId, tenantId, deletedAt: null };
    if (!["ADMIN", "MANAGER"].includes(req.user.role)) {
      contactWhere.assignedToId = req.user.userId;
    }
    const contact = await prisma.contact.findFirst({
      where: contactWhere,
      select: { id: true },
    });
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });

    const [existingPickup, transportPeople] = await Promise.all([
      prisma.customerPickup.findUnique({
        where: { tenantId_contactId: { tenantId, contactId } },
        select: { id: true },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId },
        select: { customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true },
      }),
    ]);
    if (customerTransportStarted(transportPeople, contactId)) {
      return res.status(409).json({
        error: "Pickup location and plot assignments cannot be changed after transport has started.",
        code: "TRANSPORT_WORKFLOW_LOCKED",
      });
    }

    const sourceTranscriptId = text(req.body.sourceTranscriptId, 191);
    const sourceExcerpt = text(req.body.sourceExcerpt, 4000);
    let pickup;
    await prisma.$transaction(async (tx) => {
      pickup = await tx.customerPickup.upsert({
        where: { tenantId_contactId: { tenantId, contactId } },
        create: {
          tenantId, contactId, pickupAddress, sourceTranscriptId, sourceExcerpt,
          capturedByUserId: req.user.userId,
        },
        update: {
          pickupAddress, sourceTranscriptId, sourceExcerpt,
          capturedByUserId: req.user.userId,
        },
        include: { contact: { select: { id: true, name: true, phone: true, email: true, company: true } } },
      });
      await appendWorkflowEvent(tx, req, {
        contactId,
        stage: "PICKUP",
        toStatus: "PICKUP_LOCATION_CAPTURED",
        metadata: { customerPickupId: pickup.id },
      });
    });
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: true },
    }).catch(() => null);
    if (tenant?.vertical === "generic") {
      require("../lib/eventBus").emitEvent(
        existingPickup ? "pickup_point.updated" : "pickup_point.created",
        {
          pickupPointId: pickup.id,
          contactId: pickup.contactId,
          eventId: `${pickup.id}-${new Date(pickup.updatedAt || Date.now()).getTime()}`,
          pickup,
        },
        tenantId,
        req.io,
      ).catch((error) => console.error("[GenericCampaign] pickup point event failed:", error.message));
    }
    await safeNotifyCustomerPickupPlotAssignments({ tenantId, contactId });
    return res.json({ ...pickup, status: "PICKUP_LOCATION_CAPTURED" });
  } catch (error) {
    console.error("pickup-plot-inventory PUT /customer-pickups/:contactId error:", error);
    return res.status(500).json({ error: "Failed to save customer pickup location", code: "CUSTOMER_PICKUP_SAVE_FAILED" });
  }
});

router.get("/", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [pickupLocations, plots, customerPickups, plotBookings] = await Promise.all([
      prisma.pickupLocation.findMany({
        where: { tenantId },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: { _count: { select: { plots: true } } },
      }),
      prisma.plotSite.findMany({
        where: { tenantId },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: { pickupLocation: { select: { id: true, name: true, isActive: true } } },
      }),
      prisma.customerPickup.findMany({
        where: { tenantId, contact: { deletedAt: null } },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          contactId: true,
          contact: { select: { id: true, name: true, phone: true, email: true } },
        },
      }),
      prisma.plotBooking.findMany({
        where: { tenantId, status: { not: "CANCELLED" } },
        select: { contactId: true, plotSiteId: true },
      }),
    ]);

    const pickupByContactId = new Map(customerPickups.map((pickup) => [Number(pickup.contactId), pickup]));
    const assignedPlotIdsByContact = new Map();
    const assignedContactsByPlot = new Map();
    for (const booking of plotBookings) {
      const contactId = Number(booking.contactId);
      const plotSiteId = Number(booking.plotSiteId);
      const pickup = pickupByContactId.get(contactId);
      if (!pickup || !Number.isInteger(plotSiteId)) continue;

      const contactPlotIds = assignedPlotIdsByContact.get(contactId) || new Set();
      contactPlotIds.add(plotSiteId);
      assignedPlotIdsByContact.set(contactId, contactPlotIds);

      const plotContacts = assignedContactsByPlot.get(plotSiteId) || new Map();
      plotContacts.set(contactId, pickup.contact);
      assignedContactsByPlot.set(plotSiteId, plotContacts);
    }

    const locationPlotCounts = new Map(pickupLocations.map((location) => [location.id, 0]));
    const serializedPlots = plots.map((plot) => {
      const serialized = serializePlot(plot);
      for (const locationId of serialized.pickupLocationIds) {
        locationPlotCounts.set(locationId, (locationPlotCounts.get(locationId) || 0) + 1);
      }
      return {
        ...serialized,
        assignedCustomers: [...(assignedContactsByPlot.get(Number(plot.id))?.values() || [])],
        pickupLocations: serialized.pickupLocationIds
          .map((locationId) => pickupLocations.find((location) => location.id === locationId))
          .filter(Boolean)
          .map(({ id, name, address, googleMapsLink, isActive }) => ({ id, name, address, googleMapsLink, isActive })),
      };
    });
    const locationRows = pickupLocations.map(({ _count, ...location }) => ({
      ...location,
      plotCount: locationPlotCounts.get(location.id) || _count.plots,
      assignedCount: locationPlotCounts.get(location.id) || _count.plots,
    }));
    const activePlots = serializedPlots.filter((plot) => plot.isActive);
    return res.json({
      pickupLocations: locationRows,
      plots: serializedPlots,
      customers: customerPickups.map((pickup) => ({
        id: pickup.id,
        contact: pickup.contact,
        assignedPlotIds: [...(assignedPlotIdsByContact.get(Number(pickup.contactId)) || [])],
      })),
      summary: {
        activeLocations: locationRows.filter((location) => location.isActive).length,
        totalPlots: activePlots.length,
        availablePlots: activePlots.filter((plot) => plot.availability === "AVAILABLE").length,
        reservedPlots: activePlots.filter((plot) => plot.availability === "RESERVED").length,
        soldPlots: activePlots.filter((plot) => plot.availability === "SOLD").length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET / error:", error);
    return res.status(500).json({ error: "Failed to load pickup and plot inventory", code: "INVENTORY_LOAD_FAILED" });
  }
});

router.post("/locations/import", adminOnly, async (req, res) => {
  try {
    const parsed = importRows(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: "INVALID_IMPORT" });

    const prepared = [];
    const errors = [];
    const seenNames = new Set();
    parsed.rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const name = text(row.name, 150);
      const address = text(row.address, 2000);
      const googleMapsLink = text(row.googleMapsLink, 2000);
      const maxAssignments = parseMaxAssignments(row.maxAssignments);
      const isActive = importBoolean(row.isActive);
      const validationError = firstError(
        validateName(row.name, "Location name"),
        validateRequiredText(row.address, "Address", { min: 5, max: 2000 }),
        validateOptionalText(row.googleMapsLink, "Google Maps link", 2000),
        validateOptionalText(row.notes, "Notes", 4000),
        Number.isNaN(maxAssignments) ? "Maximum assignments must be a positive whole number." : null,
        isActive === INVALID_IMPORT_BOOLEAN ? "Active must be TRUE or FALSE." : null,
        !isGoogleMapsLink(googleMapsLink) ? "Enter a valid HTTPS Google Maps link." : null,
      );
      const key = importKey(name);
      if (validationError) errors.push({ row: rowNumber, error: validationError });
      else if (seenNames.has(key)) errors.push({ row: rowNumber, error: "Location name is duplicated in this file." });
      else {
        seenNames.add(key);
        prepared.push({
          name,
          address,
          googleMapsLink,
          maxAssignments,
          notes: text(row.notes, 4000),
          isActive,
        });
      }
    });
    if (errors.length) {
      return res.status(400).json({ error: "Fix the invalid spreadsheet rows and import again.", code: "IMPORT_VALIDATION_ERROR", errors });
    }

    const existingRows = await prisma.pickupLocation.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true },
    });
    const existingByName = new Map(existingRows.map((row) => [importKey(row.name), row]));
    let created = 0;
    let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const row of prepared) {
        const existing = existingByName.get(importKey(row.name));
        if (existing) {
          await tx.pickupLocation.update({ where: { id: existing.id }, data: row });
          updated += 1;
        } else {
          const added = await tx.pickupLocation.create({ data: { ...row, tenantId: req.user.tenantId } });
          existingByName.set(importKey(row.name), added);
          created += 1;
        }
      }
    });
    return res.json({ total: prepared.length, created, updated });
  } catch (error) {
    console.error("pickup-plot-inventory POST /locations/import error:", error);
    return res.status(500).json({ error: "Failed to import pickup locations", code: "LOCATION_IMPORT_FAILED" });
  }
});

router.post("/locations", adminOnly, async (req, res) => {
  try {
    const name = text(req.body?.name, 150);
    const address = text(req.body?.address, 2000);
    const googleMapsLink = text(req.body?.googleMapsLink, 2000);
    const maxAssignments = parseMaxAssignments(req.body?.maxAssignments);
    const validationError = firstError(
      validateName(req.body?.name, "Location name"),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.googleMapsLink, "Google Maps link", 2000),
      validateOptionalText(req.body?.notes, "Notes", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    if (Number.isNaN(maxAssignments)) {
      return res.status(400).json({ error: "Maximum assignments must be a positive whole number", code: "VALIDATION_ERROR" });
    }
    if (!isGoogleMapsLink(googleMapsLink)) {
      return res.status(400).json({ error: "Enter a valid HTTPS Google Maps link", code: "INVALID_MAPS_LINK" });
    }
    const location = await prisma.pickupLocation.create({
      data: {
        name,
        address,
        googleMapsLink,
        maxAssignments,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive),
        tenantId: req.user.tenantId,
      },
    });
    return res.status(201).json({ ...location, plotCount: 0, assignedCount: 0 });
  } catch (error) {
    console.error("pickup-plot-inventory POST /locations error:", error);
    return res.status(500).json({ error: "Failed to create pickup location", code: "LOCATION_CREATE_FAILED" });
  }
});

router.put("/locations/:id", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid location id", code: "INVALID_ID" });
    const existing = await prisma.pickupLocation.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Pickup location not found", code: "LOCATION_NOT_FOUND" });

    const name = text(req.body?.name, 150);
    const address = text(req.body?.address, 2000);
    const googleMapsLink = text(req.body?.googleMapsLink, 2000);
    const maxAssignments = parseMaxAssignments(req.body?.maxAssignments);
    const validationError = firstError(
      validateName(req.body?.name, "Location name"),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.googleMapsLink, "Google Maps link", 2000),
      validateOptionalText(req.body?.notes, "Notes", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    if (Number.isNaN(maxAssignments)) {
      return res.status(400).json({ error: "Maximum assignments must be a positive whole number", code: "VALIDATION_ERROR" });
    }
    if (!isGoogleMapsLink(googleMapsLink)) {
      return res.status(400).json({ error: "Enter a valid HTTPS Google Maps link", code: "INVALID_MAPS_LINK" });
    }
    const location = await prisma.pickupLocation.update({
      where: { id },
      data: {
        name,
        address,
        googleMapsLink,
        maxAssignments,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive, existing.isActive),
      },
    });
    return res.json(location);
  } catch (error) {
    console.error("pickup-plot-inventory PUT /locations/:id error:", error);
    return res.status(500).json({ error: "Failed to update pickup location", code: "LOCATION_UPDATE_FAILED" });
  }
});

router.patch("/locations/:id/status", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || typeof req.body?.isActive !== "boolean") {
      return res.status(400).json({ error: "A valid location id and isActive value are required", code: "VALIDATION_ERROR" });
    }
    const existing = await prisma.pickupLocation.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Pickup location not found", code: "LOCATION_NOT_FOUND" });
    const location = await prisma.pickupLocation.update({ where: { id }, data: { isActive: req.body.isActive } });
    return res.json(location);
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /locations/:id/status error:", error);
    return res.status(500).json({ error: "Failed to change pickup location status", code: "LOCATION_STATUS_FAILED" });
  }
});

async function validatePickupLocationIds(tenantId, input) {
  if (input === undefined) return null;
  const rawIds = Array.isArray(input) ? input : input === null || input === "" ? [] : [input];
  const ids = await validateTenantIds(prisma.pickupLocation, tenantId, rawIds, "Pickup locations");
  return Array.isArray(ids) ? ids : false;
}

router.post("/plots/import", adminOnly, async (req, res) => {
  try {
    const parsed = importRows(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error, code: "INVALID_IMPORT" });

    const pickupLocations = await prisma.pickupLocation.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true },
    });
    const locationsByName = new Map();
    for (const location of pickupLocations) {
      const key = importKey(location.name);
      locationsByName.set(key, [...(locationsByName.get(key) || []), location]);
    }

    const prepared = [];
    const errors = [];
    const seenPlots = new Set();
    parsed.rows.forEach((row, index) => {
      const rowNumber = index + 2;
      const name = text(row.name, 150);
      const plotNumber = text(row.plotNumber, 100);
      const availability = String(row.availability || "AVAILABLE").trim().toUpperCase();
      const areaUnit = String(row.areaUnit || "").trim().toUpperCase().replace(/[ .-]+/g, "_");
      const facing = String(row.facing || "").trim().toUpperCase().replace(/[ .-]+/g, "_");
      const propertyType = String(row.propertyType || "").trim().toUpperCase().replace(/[ .-]+/g, "_");
      const price = parsePrice(row.price);
      const isActive = importBoolean(row.isActive);
      const pickupNames = String(row.pickupLocationNames || "")
        .split(/[|;]/)
        .map((value) => value.trim())
        .filter(Boolean);
      const pickupLocationIds = [];
      let locationError = null;
      for (const pickupName of pickupNames) {
        const matches = locationsByName.get(importKey(pickupName)) || [];
        if (matches.length === 0) {
          locationError = `Pickup location "${pickupName}" was not found.`;
          break;
        }
        if (matches.length > 1) {
          locationError = `Pickup location name "${pickupName}" is ambiguous.`;
          break;
        }
        pickupLocationIds.push(matches[0].id);
      }
      const validationError = firstError(
        validateName(row.name, "Plot or site name"),
        validateRequiredText(row.plotNumber, "Plot number", { max: 100 }),
        validateRequiredText(row.block, "Block", { max: 100 }),
        validateRequiredText(row.address, "Address", { min: 5, max: 2000 }),
        validateRequiredText(row.area, "Area or size", { max: 100 }),
        !PLOT_AREA_UNITS.has(areaUnit) ? "Area unit must be SQ_FT or KATHA." : null,
        validateRequiredText(row.price, "Price", { max: 30 }),
        validateMoney(row.price),
        Number.isNaN(price) ? "Enter a valid price." : null,
        validateRequiredText(row.roadWidth, "Road width", { max: 100 }),
        facing && !PLOT_FACINGS.has(facing) ? "Select a valid facing." : null,
        validateRequiredText(row.propertyType, "Residential / Commercial", { max: 30 }),
        !PLOT_PROPERTY_TYPES.has(propertyType) ? "Property type must be RESIDENTIAL or COMMERCIAL." : null,
        !AVAILABILITY.has(availability) ? "Select a valid availability." : null,
        validateOptionalText(row.notes, "Notes", 4000),
        isActive === INVALID_IMPORT_BOOLEAN ? "Active must be TRUE or FALSE." : null,
        locationError,
      );
      const key = importKey(name, plotNumber);
      if (validationError) errors.push({ row: rowNumber, error: validationError });
      else if (seenPlots.has(key)) errors.push({ row: rowNumber, error: "Plot number is duplicated for this plot or site name in the file." });
      else {
        seenPlots.add(key);
        prepared.push({
          name,
          plotNumber,
          block: text(row.block, 100),
          address: text(row.address, 2000),
          area: text(row.area, 100),
          areaUnit,
          price,
          availability,
          roadWidth: text(row.roadWidth, 100),
          facing: facing || null,
          propertyType,
          notes: text(row.notes, 4000),
          isActive,
          pickupLocationIdsJson: pickupLocationIds.length ? sanitizeJsonForStringColumn([...new Set(pickupLocationIds)]) : null,
          pickupLocationId: pickupLocationIds[0] || null,
        });
      }
    });
    if (errors.length) {
      return res.status(400).json({ error: "Fix the invalid spreadsheet rows and import again.", code: "IMPORT_VALIDATION_ERROR", errors });
    }

    const existingRows = await prisma.plotSite.findMany({
      where: { tenantId: req.user.tenantId },
      select: { id: true, name: true, plotNumber: true },
    });
    const existingByKey = new Map(existingRows.map((row) => [importKey(row.name, row.plotNumber), row]));
    let created = 0;
    let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const row of prepared) {
        const key = importKey(row.name, row.plotNumber);
        const existing = existingByKey.get(key);
        if (existing) {
          await tx.plotSite.update({ where: { id: existing.id }, data: row });
          updated += 1;
        } else {
          const added = await tx.plotSite.create({ data: { ...row, tenantId: req.user.tenantId } });
          existingByKey.set(key, added);
          created += 1;
        }
      }
    });
    return res.json({ total: prepared.length, created, updated });
  } catch (error) {
    console.error("pickup-plot-inventory POST /plots/import error:", error);
    return res.status(500).json({ error: "Failed to import plots or sites", code: "PLOT_IMPORT_FAILED" });
  }
});

router.post("/plots", adminOnly, async (req, res) => {
  try {
    const name = text(req.body?.name, 150);
    const availability = text(req.body?.availability, 20);
    const areaUnit = text(req.body?.areaUnit, 20);
    const facing = text(req.body?.facing, 30);
    const propertyType = text(req.body?.propertyType, 30);
    const price = parsePrice(req.body?.price);
    const pickupLocationIds = await validatePickupLocationIds(
      req.user.tenantId,
      req.body?.pickupLocationIds !== undefined ? req.body.pickupLocationIds : req.body?.pickupLocationId,
    );
    let boundary;
    try {
      boundary = boundaryData(req.body?.boundary);
    } catch (error) {
      return res.status(400).json({ error: error.message, code: error.code || "INVALID_BOUNDARY" });
    }
    const validationError = firstError(
      validateName(req.body?.name, "Plot or site name"),
      validateRequiredText(req.body?.plotNumber, "Plot number", { max: 100 }),
      validateRequiredText(req.body?.block, "Block", { max: 100 }),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateRequiredText(req.body?.area, "Area or size", { max: 100 }),
      validateRequiredText(req.body?.areaUnit, "Area unit", { max: 20 }),
      PLOT_AREA_UNITS.has(areaUnit) ? null : "Select a valid area unit.",
      validateRequiredText(req.body?.price, "Price", { max: 30 }),
      validateRequiredText(req.body?.roadWidth, "Road width", { max: 100 }),
      facing && !PLOT_FACINGS.has(facing) ? "Select a valid facing." : null,
      validateRequiredText(req.body?.propertyType, "Residential / Commercial", { max: 30 }),
      PLOT_PROPERTY_TYPES.has(propertyType) ? null : "Select a valid property type.",
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      validateRequiredText(req.body?.availability, "Availability", { max: 20 }),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationIds === false) {
      return res.status(400).json({ error: "Pickup location was not found", code: "INVALID_PICKUP_LOCATION" });
    }
    const duplicatePlot = await prisma.plotSite.findFirst({
      where: {
        tenantId: req.user.tenantId,
        name,
        plotNumber: text(req.body?.plotNumber, 100),
      },
      select: { id: true },
    });
    if (duplicatePlot) {
      return res.status(409).json({
        error: "This plot number already exists for the same plot or site name. Enter a different plot number.",
        code: "DUPLICATE_PLOT_NUMBER",
      });
    }
    const plot = await prisma.plotSite.create({
      data: {
        name,
        plotNumber: text(req.body?.plotNumber, 100),
        block: text(req.body?.block, 100),
        // Plot/site address is independent from the optional legacy pickup
        // location relation and is the location shown in the generic UI.
        address: text(req.body?.address, 2000),
        referenceCode: text(req.body?.referenceCode, 100),
        area: text(req.body?.area, 100),
        areaUnit,
        roadWidth: text(req.body?.roadWidth, 100),
        facing,
        propertyType,
        ...boundary,
        price,
        availability,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive),
        pickupLocationIdsJson: pickupLocationIds?.length ? sanitizeJsonForStringColumn(pickupLocationIds) : null,
        pickupLocationId: pickupLocationIds?.[0] || null,
        tenantId: req.user.tenantId,
      },
    });
    return res.status(201).json(serializePlot(plot));
  } catch (error) {
    console.error("pickup-plot-inventory POST /plots error:", error);
    return res.status(500).json({
      error: "Failed to create plot or site",
      code: "PLOT_CREATE_FAILED",
    });
  }
});

router.put("/plots/:id", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid plot id", code: "INVALID_ID" });
    const existing = await prisma.plotSite.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Plot or site not found", code: "PLOT_NOT_FOUND" });

    const name = text(req.body?.name, 150);
    const availability = text(req.body?.availability, 20);
    const areaUnit = text(req.body?.areaUnit, 20);
    const facing = text(req.body?.facing, 30);
    const propertyType = text(req.body?.propertyType, 30);
    const price = parsePrice(req.body?.price);
    const pickupLocationIds = await validatePickupLocationIds(
      req.user.tenantId,
      req.body?.pickupLocationIds !== undefined ? req.body.pickupLocationIds : req.body?.pickupLocationId,
    );
    const validationError = firstError(
      validateName(req.body?.name, "Plot or site name"),
      validateRequiredText(req.body?.plotNumber, "Plot number", { max: 100 }),
      validateRequiredText(req.body?.block, "Block", { max: 100 }),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateRequiredText(req.body?.area, "Area or size", { max: 100 }),
      validateRequiredText(req.body?.areaUnit, "Area unit", { max: 20 }),
      PLOT_AREA_UNITS.has(areaUnit) ? null : "Select a valid area unit.",
      validateRequiredText(req.body?.price, "Price", { max: 30 }),
      validateRequiredText(req.body?.roadWidth, "Road width", { max: 100 }),
      facing && !PLOT_FACINGS.has(facing) ? "Select a valid facing." : null,
      validateRequiredText(req.body?.propertyType, "Residential / Commercial", { max: 30 }),
      PLOT_PROPERTY_TYPES.has(propertyType) ? null : "Select a valid property type.",
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      validateRequiredText(req.body?.availability, "Availability", { max: 20 }),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationIds === false) {
      return res.status(400).json({ error: "Pickup location was not found", code: "INVALID_PICKUP_LOCATION" });
    }
    const duplicatePlot = await prisma.plotSite.findFirst({
      where: {
        tenantId: req.user.tenantId,
        name,
        plotNumber: text(req.body?.plotNumber, 100),
        id: { not: id },
      },
      select: { id: true },
    });
    if (duplicatePlot) {
      return res.status(409).json({
        error: "This plot number already exists for the same plot or site name. Enter a different plot number.",
        code: "DUPLICATE_PLOT_NUMBER",
      });
    }
    let boundary = {};
    if (req.body?.boundary !== undefined) {
      try {
        boundary = boundaryData(req.body.boundary);
      } catch (error) {
        return res.status(400).json({ error: error.message, code: error.code || "INVALID_BOUNDARY" });
      }
    }
    const plot = await prisma.plotSite.update({
      where: { id },
      data: {
        name,
        plotNumber: text(req.body?.plotNumber, 100),
        block: text(req.body?.block, 100),
        address: text(req.body?.address, 2000),
        referenceCode: text(req.body?.referenceCode, 100),
        area: text(req.body?.area, 100),
        areaUnit,
        roadWidth: text(req.body?.roadWidth, 100),
        facing,
        propertyType,
        ...boundary,
        price,
        availability,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive, existing.isActive),
        pickupLocationIdsJson: pickupLocationIds === null
          ? existing.pickupLocationIdsJson || (existing.pickupLocationId ? sanitizeJsonForStringColumn([existing.pickupLocationId]) : null)
          : pickupLocationIds.length ? sanitizeJsonForStringColumn(pickupLocationIds) : null,
        pickupLocationId: pickupLocationIds === null
          ? existing.pickupLocationId
          : pickupLocationIds[0] || null,
      },
    });
    return res.json(serializePlot(plot));
  } catch (error) {
    console.error("pickup-plot-inventory PUT /plots/:id error:", error);
    return res.status(500).json({ error: "Failed to update plot or site", code: "PLOT_UPDATE_FAILED" });
  }
});

router.patch("/plots/:id/status", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || typeof req.body?.isActive !== "boolean") {
      return res.status(400).json({ error: "A valid plot id and isActive value are required", code: "VALIDATION_ERROR" });
    }
    const existing = await prisma.plotSite.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Plot or site not found", code: "PLOT_NOT_FOUND" });
    const plot = await prisma.plotSite.update({ where: { id }, data: { isActive: req.body.isActive } });
    return res.json(plot);
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /plots/:id/status error:", error);
    return res.status(500).json({ error: "Failed to change plot status", code: "PLOT_STATUS_FAILED" });
  }
});

router.get("/transport-persons", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [transportPersons, pickupLocations, plots, confirmedPickups, transportRole, customerPlotAssignments] = await Promise.all([
      prisma.transportPerson.findMany({
        where: { tenantId, OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }] },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: {
          pickupLocation: { select: { id: true, name: true, isActive: true } },
          user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
        },
      }),
      prisma.pickupLocation.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, isActive: true },
      }),
      prisma.plotSite.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, plotNumber: true, address: true, availability: true, isActive: true },
      }),
      findConfirmedPickupCustomers(tenantId),
      findTransportRole(tenantId),
      prisma.plotBooking.findMany({
        where: { tenantId, status: "PLOT_ASSIGNED" },
        orderBy: { createdAt: "asc" },
        select: { contactId: true, plotSiteId: true },
      }),
    ]);
    const claimOwners = startedCustomerOwners(transportPersons, "transport", "assignmentStatusJson");
    const normalizeLocation = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const plotSiteMap = new Map(plots.map((row) => [row.id, row]));
    const assignedPlotIdsByCustomer = new Map();
    for (const assignment of customerPlotAssignments) {
      const ids = assignedPlotIdsByCustomer.get(Number(assignment.contactId)) || [];
      if (!ids.includes(Number(assignment.plotSiteId))) ids.push(Number(assignment.plotSiteId));
      assignedPlotIdsByCustomer.set(Number(assignment.contactId), ids);
    }
    const customers = markClaimedCustomers(confirmedPickups.map((customer) => {
      const pickupAddress = normalizeLocation(customer.pickupAddress);
      const pickupLocationIds = pickupLocations.filter((location) => {
        const address = normalizeLocation(location.address);
        const name = normalizeLocation(location.name);
        return Boolean(pickupAddress) && (
          (address && (pickupAddress === address || pickupAddress.includes(address) || address.includes(pickupAddress)))
          || (name.length >= 5 && pickupAddress.includes(name))
        );
      }).map((location) => location.id);
      const assignedPlotIds = assignedPlotIdsByCustomer.get(Number(customer.id)) || [];
      const assignedPlots = assignedPlotIds.map((id) => plotSiteMap.get(id)).filter(Boolean);
      return {
        ...customer,
        pickupLocationIds,
        assignedPlots,
        assignedPlotSiteId: assignedPlots[0]?.id || null,
        assignedPlotName: assignedPlots[0]?.name || null,
      };
    }), claimOwners);
    const linkedUserIds = new Set(transportPersons.map((person) => Number(person.userId)).filter(Number.isInteger));
    const staffUsers = transportRole ? await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        userType: { in: ["STAFF", "OWNER"] },
        userRoles: { some: { role: { permissions: { some: { module: "transport_workspace", action: "read" } } } } },
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, phone: true },
    }) : [];
    const pickupLocationMap = new Map(pickupLocations.map((row) => [row.id, row]));
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const rows = transportPersons.map((person) => keepOnlyOwnedClaims(serializeTransportPerson(
      person, pickupLocationMap, plotSiteMap, customerMap, true,
    ), claimOwners));
    return res.json({
      transportPersons: rows,
      pickupLocations: pickupLocations.filter((row) => row.isActive),
      plots: plots.filter((row) => row.isActive),
      customers,
      staffUsers: staffUsers.filter((user) => !linkedUserIds.has(Number(user.id))),
      transportRole,
      summary: {
        total: rows.length,
        active: rows.filter((person) => person.isActive).length,
        assigned: rows.filter((person) => person.plotSiteIds.length > 0).length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /transport-persons error:", error);
    return res.status(500).json({ error: "Failed to load transport persons", code: "TRANSPORT_PERSONS_LOAD_FAILED" });
  }
});

async function transportPersonData(req, existing = null) {
  const completedPairs = completedTransportAssignmentPairs(existing);
  const completedCustomerIds = new Set(completedPairs.map((pair) => pair.customerId));
  const requestedCustomerIds = Array.isArray(req.body?.customerIds)
    ? req.body.customerIds.filter((customerId) => !completedCustomerIds.has(Number(customerId)))
    : req.body?.customerIds || [];
  const requestedAssignments = Array.isArray(req.body?.assignments)
    ? req.body.assignments.filter((assignment) => !completedCustomerIds.has(Number(assignment?.customerId)))
    : req.body?.assignments;
  const pickupLocationInput = req.body?.pickupLocationIds !== undefined
    ? req.body.pickupLocationIds
    : req.body?.pickupLocationId === null || req.body?.pickupLocationId === undefined || req.body?.pickupLocationId === ""
      ? []
      : [req.body.pickupLocationId];
  const pickupLocationIds = await validateTenantIds(
    prisma.pickupLocation, req.user.tenantId, pickupLocationInput, "Pickup locations",
  );
  if (!Array.isArray(pickupLocationIds)) return { error: pickupLocationIds.error, code: "INVALID_PICKUP_LOCATION" };
  const requestedPlotSiteIds = await validateTenantIds(
    prisma.plotSite, req.user.tenantId, req.body?.plotSiteIds || [], "Plots or sites",
  );
  if (!Array.isArray(requestedPlotSiteIds)) return { error: requestedPlotSiteIds.error, code: "INVALID_PLOT_SITE" };
  const requestedCustomerIdList = await validateAssignableCustomerIds(req.user.tenantId, requestedCustomerIds);
  if (!Array.isArray(requestedCustomerIdList)) return { error: requestedCustomerIdList.error, code: "INVALID_CUSTOMER" };
  const claimError = await validateRoleClaims(req.user.tenantId, requestedCustomerIdList, "transport", existing?.id);
  if (claimError) return claimError;
  const requestedPairs = validateSelectedAssignmentPairs(
    requestedAssignments, requestedCustomerIdList, requestedPlotSiteIds,
  );
  if (!Array.isArray(requestedPairs)) return { error: requestedPairs.error, code: "INVALID_ASSIGNMENT" };
  const pairs = [...requestedPairs, ...completedPairs];
  const customerIds = [...new Set([...requestedCustomerIdList, ...completedPairs.map((pair) => pair.customerId)])];
  const plotSiteIds = [...new Set([...requestedPlotSiteIds, ...completedPairs.map((pair) => pair.plotSiteId)])];
  const lockedAssignmentError = validateStartedTransportAssignments(existing, pairs);
  if (lockedAssignmentError) return lockedAssignmentError;
  const serviceAreas = normalizeServiceAreas(req.body?.serviceAreas || []);
  if (!Array.isArray(serviceAreas)) return { error: serviceAreas.error, code: "VALIDATION_ERROR" };
  if (serviceAreas.some((area) => area.plotSiteId && !plotSiteIds.includes(area.plotSiteId))) {
    return { error: "Service areas must belong to selected plots or sites.", code: "INVALID_PLOT_SITE" };
  }
  const validationError = firstError(
    validatePersonName(req.body?.name),
    validatePhone(req.body?.phone),
    validatePhone(req.body?.alternatePhone, "Alternate phone", { required: false }),
    validateRequiredText(req.body?.vehicleType, "Vehicle type", { max: 100 }),
    validateRequiredText(req.body?.vehicleNumber, "Vehicle number", { min: 3, max: 30 }),
    validateVehicleNumber(req.body?.vehicleNumber),
    validateOptionalText(req.body?.notes, "Notes", 4000),
  );
  if (validationError) return { error: validationError, code: "VALIDATION_ERROR" };
  const name = text(req.body?.name, 150);
  const phone = text(req.body?.phone, 25);
  return {
    data: {
      name,
      phone,
      alternatePhone: text(req.body?.alternatePhone, 25),
      vehicleType: text(req.body?.vehicleType, 100),
      vehicleNumber: text(req.body?.vehicleNumber, 100),
      serviceArea: serviceAreas.length
        ? serviceAreas.map((row) => `${row.area}, ${row.state} - ${row.pincode}`).join("; ").slice(0, 2000)
        : text(req.body?.serviceArea, 2000),
      pickupLocationIdsJson: pickupLocationIds.length ? sanitizeJsonForStringColumn(pickupLocationIds) : null,
      plotSiteIdsJson: plotSiteIds.length ? sanitizeJsonForStringColumn(plotSiteIds) : null,
      serviceAreasJson: serviceAreas.length ? sanitizeJsonForStringColumn(serviceAreas) : null,
      customerIdsJson: customerIds.length ? sanitizeJsonForStringColumn(customerIds) : null,
      assignmentPairsJson: pairs.length ? sanitizeJsonForStringColumn(pairs) : null,
      notes: text(req.body?.notes, 4000),
      isActive: parseBoolean(req.body?.isActive, existing?.isActive ?? true),
      pickupLocationId: pickupLocationIds[0] || null,
    },
  };
}

router.post("/transport-persons", adminOnly, async (req, res) => {
  try {
    const parsed = await transportPersonData(req);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const staffUserId = req.body?.staffUserId;
    const email = text(req.body?.email, 320)?.toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    let person;

    if (staffUserId !== undefined && staffUserId !== null && staffUserId !== "") {
      const assignment = await validateAssignableTransportUser(req.user.tenantId, staffUserId);
      if (assignment.error) return res.status(400).json(assignment);
      person = await prisma.$transaction(async (tx) => {
        await lockPlotAssignmentCustomers(tx, req.user.tenantId, assignmentPairs(parsed.data));
        return tx.transportPerson.create({
          data: { ...parsed.data, tenantId: req.user.tenantId, userId: assignment.user.id },
          include: {
            pickupLocation: { select: { id: true, name: true, isActive: true } },
            user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
          },
        });
      });
    } else if (email || password) {
      const emailError = !email ? "Work email is required." : validateEmail(email);
      if (emailError) return res.status(400).json({ error: emailError, code: "VALIDATION_ERROR" });
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters.", code: "VALIDATION_ERROR" });
      }
      const [role, existingUser] = await Promise.all([
        findTransportRole(req.user.tenantId),
        prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } }),
      ]);
      if (!role) {
        return res.status(409).json({
          error: "Grant Transport Workspace access to an active staff role before adding a transport login.",
          code: "TRANSPORT_ROLE_NOT_CONFIGURED",
        });
      }
      if (existingUser) {
        return res.status(409).json({ error: "A staff user with that email already exists.", code: "EMAIL_ALREADY_EXISTS" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      person = await prisma.$transaction(async (tx) => {
        await lockPlotAssignmentCustomers(tx, req.user.tenantId, assignmentPairs(parsed.data));
        const user = await tx.user.create({
          data: {
            name: parsed.data.name,
            email,
            password: passwordHash,
            role: "USER",
            userType: "STAFF",
            phone: parsed.data.phone,
            tenantId: req.user.tenantId,
          },
          select: { id: true },
        });
        await tx.userRole.create({
          data: { userId: user.id, roleId: role.id, assignedById: req.user.userId },
        });
        return tx.transportPerson.create({
          data: { ...parsed.data, tenantId: req.user.tenantId, userId: user.id },
          include: {
            pickupLocation: { select: { id: true, name: true, isActive: true } },
            user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
          },
        });
      });
    } else {
      // Backward-compatible profile-only path for existing API consumers and
      // legacy data imports. The UI always chooses a staff-account path.
      person = await prisma.$transaction(async (tx) => {
        await lockPlotAssignmentCustomers(tx, req.user.tenantId, assignmentPairs(parsed.data));
        return tx.transportPerson.create({
          data: { ...parsed.data, tenantId: req.user.tenantId },
          include: { pickupLocation: { select: { id: true, name: true, isActive: true } } },
        });
      });
    }
    await safeNotifyCustomerPickupPlotAssignments({
      tenantId: req.user.tenantId,
      person,
    });
    return res.status(201).json(serializeTransportPerson(person));
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory POST /transport-persons error:", error);
    return res.status(500).json({ error: "Failed to create transport person", code: "TRANSPORT_PERSON_CREATE_FAILED" });
  }
});

router.put("/transport-persons/:id", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid transport person id", code: "INVALID_ID" });
    const existing = await prisma.transportPerson.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Transport person not found", code: "TRANSPORT_PERSON_NOT_FOUND" });
    const parsed = await transportPersonData(req, existing);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const updateTransportPerson = (client) => client.transportPerson.update({
      where: { id },
      data: parsed.data,
      include: {
        pickupLocation: { select: { id: true, name: true, isActive: true } },
        user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
      },
    });
    const person = await prisma.$transaction(async (tx) => {
      await lockPlotAssignmentCustomers(tx, req.user.tenantId, assignmentPairs(parsed.data), assignmentPairs(existing));
      if (existing.userId) await tx.user.update({
        where: { id: existing.userId },
        data: { name: parsed.data.name, phone: parsed.data.phone },
      });
      return updateTransportPerson(tx);
    });
    await safeNotifyCustomerPickupPlotAssignments({
      tenantId: req.user.tenantId,
      person,
      previousPerson: existing,
    });
    return res.json(serializeTransportPerson(person));
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PUT /transport-persons/:id error:", error);
    return res.status(500).json({ error: "Failed to update transport person", code: "TRANSPORT_PERSON_UPDATE_FAILED" });
  }
});

router.patch("/transport-persons/:id/status", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || typeof req.body?.isActive !== "boolean") {
      return res.status(400).json({ error: "A valid transport person id and isActive value are required", code: "VALIDATION_ERROR" });
    }
    const existing = await prisma.transportPerson.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Transport person not found", code: "TRANSPORT_PERSON_NOT_FOUND" });
    const person = await prisma.transportPerson.update({ where: { id }, data: { isActive: req.body.isActive } });
    return res.json(person);
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /transport-persons/:id/status error:", error);
    return res.status(500).json({ error: "Failed to change transport person status", code: "TRANSPORT_PERSON_STATUS_FAILED" });
  }
});

router.get("/brokers", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [brokers, plots, pickupLocations, rawCustomers, brokerRole, transportPeople] = await Promise.all([
      prisma.plotBroker.findMany({
        where: { tenantId, OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }] },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: {
          plotSite: { select: { id: true, name: true, availability: true, isActive: true } },
          user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
        },
      }),
      prisma.plotSite.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, availability: true, isActive: true },
      }),
      prisma.pickupLocation.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, isActive: true },
      }),
      findConfirmedPickupCustomers(tenantId),
      findBrokerRole(tenantId),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true, user: { is: { deactivatedAt: null } } },
        orderBy: { updatedAt: "desc" },
        select: { assignmentPairsJson: true, customerIdsJson: true, plotSiteIdsJson: true },
      }),
    ]);
    const claimOwners = startedCustomerOwners(brokers, "broker", "workflowStatusJson");
    const customers = markClaimedCustomers(attachTransportPlots(rawCustomers, transportPeople), claimOwners);
    const linkedUserIds = new Set(brokers.map((broker) => Number(broker.userId)).filter(Number.isInteger));
    const staffUsers = brokerRole ? await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        userType: { in: ["STAFF", "OWNER"] },
        userRoles: { some: { role: { permissions: { some: { module: "broker_workspace", action: "read" } } } } },
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, phone: true },
    }) : [];
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotSiteMap = new Map(plots.map((row) => [row.id, row]));
    const pickupLocationMap = new Map(pickupLocations.map((row) => [row.id, row]));
    const rows = brokers.map((broker) => keepOnlyOwnedClaims(
      serializePlotBroker(broker, customerMap, plotSiteMap, pickupLocationMap, true), claimOwners,
    ));
    return res.json({
      brokers: rows,
      plots,
      pickupLocations,
      customers,
      staffUsers: staffUsers.filter((user) => !linkedUserIds.has(Number(user.id))),
      staffRole: brokerRole,
      summary: {
        total: rows.length,
        active: rows.filter((broker) => broker.isActive).length,
        assigned: rows.filter((broker) => broker.plotSiteIds.length > 0).length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /brokers error:", error);
    return res.status(500).json({ error: "Failed to load plot brokers", code: "BROKERS_LOAD_FAILED" });
  }
});

async function brokerData(req, existing = null) {
  const plotSiteInput = req.body?.plotSiteIds !== undefined
    ? req.body.plotSiteIds
    : req.body?.plotSiteId === null || req.body?.plotSiteId === undefined || req.body?.plotSiteId === ""
      ? []
      : [req.body.plotSiteId];
  const plotSiteIds = await validateTenantIds(
    prisma.plotSite, req.user.tenantId, plotSiteInput, "Plots or sites",
  );
  if (!Array.isArray(plotSiteIds)) return { error: plotSiteIds.error, code: "INVALID_PLOT_SITE" };
  const pickupLocationIds = await validateTenantIds(
    prisma.pickupLocation, req.user.tenantId, req.body?.pickupLocationIds || [], "Pickup locations",
  );
  if (!Array.isArray(pickupLocationIds)) return { error: pickupLocationIds.error, code: "INVALID_PICKUP_LOCATION" };
  const customerIds = await validateAssignableCustomerIds(req.user.tenantId, req.body?.customerIds || []);
  if (!Array.isArray(customerIds)) return { error: customerIds.error, code: "INVALID_CUSTOMER" };
  const claimError = await validateRoleClaims(req.user.tenantId, customerIds, "broker", existing?.id);
  if (claimError) return claimError;
  const pairs = await transportLockedAssignmentPairs(req.user.tenantId, customerIds, plotSiteIds);
  if (!Array.isArray(pairs)) return { error: pairs.error, code: "INVALID_ASSIGNMENT" };
  const commissionPercent = parseCommission(req.body?.commissionPercent);
  const validationError = firstError(
    validatePersonName(req.body?.name),
    validatePhone(req.body?.phone),
    validateEmail(req.body?.email),
    validateOptionalText(req.body?.agency, "Agency", 150),
    validateMoney(req.body?.commissionPercent, "Commission"),
    Number.isNaN(commissionPercent) ? "Commission must be between 0 and 100." : null,
    validateOptionalText(req.body?.notes, "Notes", 4000),
  );
  if (validationError) return { error: validationError, code: "VALIDATION_ERROR" };
  const name = text(req.body?.name, 150);
  const phone = text(req.body?.phone, 25);
  return {
    data: {
      name,
      phone,
      email: text(req.body?.email, 320),
      agency: text(req.body?.agency, 150),
      commissionPercent,
      customerIdsJson: customerIds.length ? sanitizeJsonForStringColumn(customerIds) : null,
      plotSiteIdsJson: plotSiteIds.length ? sanitizeJsonForStringColumn(plotSiteIds) : null,
      pickupLocationIdsJson: pickupLocationIds.length ? sanitizeJsonForStringColumn(pickupLocationIds) : null,
      assignmentPairsJson: pairs.length ? sanitizeJsonForStringColumn(pairs) : null,
      notes: text(req.body?.notes, 4000),
      isActive: parseBoolean(req.body?.isActive, existing?.isActive ?? true),
      plotSiteId: plotSiteIds[0] || null,
    },
  };
}

router.post("/brokers", adminOnly, async (req, res) => {
  try {
    const parsed = await brokerData(req);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const staffUserId = req.body?.staffUserId;
    const email = text(req.body?.email, 320)?.toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    let broker;

    if (staffUserId !== undefined && staffUserId !== null && staffUserId !== "") {
      const assignment = await validateAssignableBrokerUser(req.user.tenantId, staffUserId);
      if (assignment.error) return res.status(400).json(assignment);
      broker = await prisma.plotBroker.create({
        data: {
          ...parsed.data,
          email: assignment.user.email || parsed.data.email,
          tenantId: req.user.tenantId,
          userId: assignment.user.id,
        },
        include: {
          plotSite: { select: { id: true, name: true, availability: true, isActive: true } },
          user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
        },
      });
    } else if (email || password) {
      const emailError = !email ? "Work email is required." : validateEmail(email);
      if (emailError) return res.status(400).json({ error: emailError, code: "VALIDATION_ERROR" });
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters.", code: "VALIDATION_ERROR" });
      }
      const [role, existingUser] = await Promise.all([
        findBrokerRole(req.user.tenantId),
        prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } }),
      ]);
      if (!role) {
        return res.status(409).json({
          error: "Grant Site Visits Workspace access to an active staff role before adding a sales login.",
          code: "BROKER_ROLE_NOT_CONFIGURED",
        });
      }
      if (existingUser) {
        return res.status(409).json({ error: "A staff user with that email already exists.", code: "EMAIL_ALREADY_EXISTS" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      broker = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: parsed.data.name,
            email,
            password: passwordHash,
            role: "USER",
            userType: "STAFF",
            phone: parsed.data.phone,
            tenantId: req.user.tenantId,
          },
          select: { id: true },
        });
        await tx.userRole.create({
          data: { userId: user.id, roleId: role.id, assignedById: req.user.userId },
        });
        return tx.plotBroker.create({
          data: { ...parsed.data, email, tenantId: req.user.tenantId, userId: user.id },
          include: {
            plotSite: { select: { id: true, name: true, availability: true, isActive: true } },
            user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
          },
        });
      });
    } else {
      // Backward-compatible profile-only path for existing API consumers and imports.
      broker = await prisma.plotBroker.create({
        data: { ...parsed.data, tenantId: req.user.tenantId },
        include: { plotSite: { select: { id: true, name: true, availability: true, isActive: true } } },
      });
    }
    return res.status(201).json(serializePlotBroker(broker));
  } catch (error) {
    console.error("pickup-plot-inventory POST /brokers error:", error);
    return res.status(500).json({ error: "Failed to create plot broker", code: "BROKER_CREATE_FAILED" });
  }
});

router.put("/brokers/:id", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid broker id", code: "INVALID_ID" });
    const existing = await prisma.plotBroker.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Plot broker not found", code: "BROKER_NOT_FOUND" });
    const parsed = await brokerData(req, existing);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const broker = await prisma.plotBroker.update({
      where: { id },
      data: parsed.data,
      include: {
        plotSite: { select: { id: true, name: true, availability: true, isActive: true } },
        user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } },
      },
    });
    return res.json(serializePlotBroker(broker));
  } catch (error) {
    console.error("pickup-plot-inventory PUT /brokers/:id error:", error);
    return res.status(500).json({ error: "Failed to update plot broker", code: "BROKER_UPDATE_FAILED" });
  }
});

router.patch("/brokers/:id/status", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || typeof req.body?.isActive !== "boolean") {
      return res.status(400).json({ error: "A valid broker id and isActive value are required", code: "VALIDATION_ERROR" });
    }
    const existing = await prisma.plotBroker.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Plot broker not found", code: "BROKER_NOT_FOUND" });
    const broker = await prisma.plotBroker.update({ where: { id }, data: { isActive: req.body.isActive } });
    return res.json(broker);
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /brokers/:id/status error:", error);
    return res.status(500).json({ error: "Failed to change plot broker status", code: "BROKER_STATUS_FAILED" });
  }
});

router.get("/billing-persons", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [billingPersons, billingRole, plots, pickupLocations, rawCustomers, transportPeople, claimedBookings] = await Promise.all([
      prisma.billingPerson.findMany({
        where: { tenantId, OR: [{ userId: null }, { user: { is: { deactivatedAt: null } } }] },
        orderBy: [{ isActive: "desc" }, { name: "asc" }],
        include: { user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } } },
      }),
      findBillingRole(tenantId),
      prisma.plotSite.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, availability: true, isActive: true },
      }),
      prisma.pickupLocation.findMany({
        where: { tenantId, isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, isActive: true },
      }),
      findConfirmedPickupCustomers(tenantId),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true, user: { is: { deactivatedAt: null } } },
        orderBy: { updatedAt: "desc" },
        select: { assignmentPairsJson: true, customerIdsJson: true, plotSiteIdsJson: true },
      }),
      prisma.plotBooking.findMany({
        where: { tenantId, billingPersonId: { not: null }, status: { not: BILLING_WORKFLOW[0] } },
        select: { contactId: true, billingPersonId: true },
      }),
    ]);
    const visibleBillingPersonIds = new Set(billingPersons.map((person) => Number(person.id)));
    const claimOwners = billingCustomerOwners(
      claimedBookings.filter((booking) => visibleBillingPersonIds.has(Number(booking.billingPersonId))),
    );
    const customers = markClaimedCustomers(attachTransportPlots(rawCustomers, transportPeople), claimOwners);
    const linkedUserIds = new Set(billingPersons.map((person) => Number(person.userId)).filter(Number.isInteger));
    const staffUsers = billingRole ? await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        userType: { in: ["STAFF", "OWNER"] },
        userRoles: { some: { role: { permissions: { some: { module: "billing_workspace", action: "read" } } } } },
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, phone: true },
    }) : [];
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const pickupLocationMap = new Map(pickupLocations.map((row) => [row.id, row]));
    const rows = billingPersons.map((person) => {
      const { customerIdsJson, plotSiteIdsJson, pickupLocationIdsJson, assignmentPairsJson, ...rest } = person;
      const customerIds = parseStoredArray(customerIdsJson)
        .map(Number)
        .filter((id) => Number.isInteger(id) && customerMap.has(id));
      const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
      const pickupLocationIds = parseStoredArray(pickupLocationIdsJson).map(Number).filter(Number.isInteger);
      return keepOnlyOwnedClaims({
        ...rest,
        customerIds,
        plotSiteIds,
        pickupLocationIds,
        assignments: assignmentPairs({ assignmentPairsJson, customerIdsJson, plotSiteIdsJson })
          .filter((pair) => customerIds.includes(pair.customerId)),
        customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
        plots: plotSiteIds.map((id) => plotMap.get(id)).filter(Boolean),
        pickupLocations: pickupLocationIds.map((id) => pickupLocationMap.get(id)).filter(Boolean),
      }, claimOwners);
    });
    return res.json({
      billingPersons: rows,
      plots,
      pickupLocations,
      customers,
      staffUsers: staffUsers.filter((user) => !linkedUserIds.has(Number(user.id))),
      staffRole: billingRole,
      summary: {
        total: rows.length,
        active: rows.filter((person) => person.isActive).length,
        linked: rows.filter((person) => person.userId).length,
      },
    });
  } catch (error) {
    console.error("pickup-plot-inventory GET /billing-persons error:", error);
    return res.status(500).json({ error: "Failed to load billing persons", code: "BILLING_PERSONS_LOAD_FAILED" });
  }
});

async function billingPersonData(req, existing = null) {
  const plotSiteIds = await validateTenantIds(
    prisma.plotSite, req.user.tenantId, req.body?.plotSiteIds || [], "Plots or sites",
  );
  if (!Array.isArray(plotSiteIds)) return { error: plotSiteIds.error, code: "INVALID_PLOT_SITE" };
  const pickupLocationIds = await validateTenantIds(
    prisma.pickupLocation, req.user.tenantId, req.body?.pickupLocationIds || [], "Pickup locations",
  );
  if (!Array.isArray(pickupLocationIds)) return { error: pickupLocationIds.error, code: "INVALID_PICKUP_LOCATION" };
  const customerIds = await validateAssignableCustomerIds(req.user.tenantId, req.body?.customerIds || []);
  if (!Array.isArray(customerIds)) return { error: customerIds.error, code: "INVALID_CUSTOMER" };
  const claimError = await validateRoleClaims(req.user.tenantId, customerIds, "billing", existing?.id);
  if (claimError) return claimError;
  const pairs = await transportLockedAssignmentPairs(req.user.tenantId, customerIds, plotSiteIds);
  if (!Array.isArray(pairs)) return { error: pairs.error, code: "INVALID_ASSIGNMENT" };
  const validationError = firstError(
    validatePersonName(req.body?.name),
    validatePhone(req.body?.phone),
    validateEmail(req.body?.email),
    validateOptionalText(req.body?.notes, "Notes", 4000),
  );
  if (validationError) return { error: validationError, code: "VALIDATION_ERROR" };
  return {
    data: {
      name: text(req.body?.name, 150),
      phone: text(req.body?.phone, 25),
      email: text(req.body?.email, 320),
      customerIdsJson: customerIds.length ? sanitizeJsonForStringColumn(customerIds) : null,
      plotSiteIdsJson: plotSiteIds.length ? sanitizeJsonForStringColumn(plotSiteIds) : null,
      pickupLocationIdsJson: pickupLocationIds.length ? sanitizeJsonForStringColumn(pickupLocationIds) : null,
      assignmentPairsJson: pairs.length ? sanitizeJsonForStringColumn(pairs) : null,
      notes: text(req.body?.notes, 4000),
      isActive: parseBoolean(req.body?.isActive, existing?.isActive ?? true),
    },
  };
}

router.post("/billing-persons", adminOnly, async (req, res) => {
  try {
    const parsed = await billingPersonData(req);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const staffUserId = req.body?.staffUserId;
    const email = text(req.body?.email, 320)?.toLowerCase();
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    let billingPerson;
    if (staffUserId !== undefined && staffUserId !== null && staffUserId !== "") {
      const assignment = await validateAssignableBillingUser(req.user.tenantId, staffUserId);
      if (assignment.error) return res.status(400).json(assignment);
      billingPerson = await prisma.billingPerson.create({
        data: {
          ...parsed.data,
          email: assignment.user.email || parsed.data.email,
          tenantId: req.user.tenantId,
          userId: assignment.user.id,
        },
        include: { user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } } },
      });
    } else {
      const emailError = !email ? "Work email is required." : validateEmail(email);
      if (emailError) return res.status(400).json({ error: emailError, code: "VALIDATION_ERROR" });
      if (password.length < 6) {
        return res.status(400).json({ error: "Password must be at least 6 characters.", code: "VALIDATION_ERROR" });
      }
      const [role, existingUser] = await Promise.all([
        findBillingRole(req.user.tenantId),
        prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } }),
      ]);
      if (!role) {
        return res.status(409).json({ error: "Grant Billing Workspace access to an active staff role before adding a billing login.", code: "BILLING_ROLE_NOT_CONFIGURED" });
      }
      if (existingUser) {
        return res.status(409).json({ error: "A staff user with that email already exists.", code: "EMAIL_ALREADY_EXISTS" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      billingPerson = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: parsed.data.name,
            email,
            password: passwordHash,
            role: "USER",
            userType: "STAFF",
            phone: parsed.data.phone,
            tenantId: req.user.tenantId,
          },
          select: { id: true },
        });
        await tx.userRole.create({ data: { userId: user.id, roleId: role.id, assignedById: req.user.userId } });
        return tx.billingPerson.create({
          data: { ...parsed.data, email, tenantId: req.user.tenantId, userId: user.id },
          include: { user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } } },
        });
      });
    }
    return res.status(201).json(billingPerson);
  } catch (error) {
    console.error("pickup-plot-inventory POST /billing-persons error:", error);
    return res.status(500).json({ error: "Failed to create billing person", code: "BILLING_PERSON_CREATE_FAILED" });
  }
});

router.put("/billing-persons/:id", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid billing person id", code: "INVALID_ID" });
    const existing = await prisma.billingPerson.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Billing person not found", code: "BILLING_PERSON_NOT_FOUND" });
    const parsed = await billingPersonData(req, existing);
    if (parsed.error) {
      const { status = 400, ...body } = parsed;
      return res.status(status).json(body);
    }
    const updateBillingPerson = (client) => client.billingPerson.update({
      where: { id },
      data: parsed.data,
      include: { user: { select: { id: true, name: true, email: true, phone: true, deactivatedAt: true } } },
    });
    const billingPerson = existing.userId ? await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: existing.userId }, data: { name: parsed.data.name, phone: parsed.data.phone } });
      return updateBillingPerson(tx);
    }) : await updateBillingPerson(prisma);
    return res.json(billingPerson);
  } catch (error) {
    console.error("pickup-plot-inventory PUT /billing-persons/:id error:", error);
    return res.status(500).json({ error: "Failed to update billing person", code: "BILLING_PERSON_UPDATE_FAILED" });
  }
});

router.patch("/billing-persons/:id/status", adminOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || typeof req.body?.isActive !== "boolean") {
      return res.status(400).json({ error: "A valid billing person id and isActive value are required", code: "VALIDATION_ERROR" });
    }
    const existing = await prisma.billingPerson.findFirst({ where: { id, tenantId: req.user.tenantId } });
    if (!existing) return res.status(404).json({ error: "Billing person not found", code: "BILLING_PERSON_NOT_FOUND" });
    const billingPerson = await prisma.billingPerson.update({ where: { id }, data: { isActive: req.body.isActive } });
    return res.json(billingPerson);
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /billing-persons/:id/status error:", error);
    return res.status(500).json({ error: "Failed to change billing person status", code: "BILLING_PERSON_STATUS_FAILED" });
  }
});

module.exports = router;
