const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const prisma = require("../lib/prisma");
const { sendEmail } = require("../lib/emailSender");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
const { cleanPickupAddress } = require("../lib/callifiedPickup");
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
  if (!["CUSTOMER_ALREADY_CLAIMED", "WORKFLOW_CONFLICT", "PLOT_NOT_AVAILABLE"].includes(error?.code)) return false;
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
  return assignmentPairs(person).some((pair) => (
    pair.customerId === Number(customerId)
    && (pair.plotSiteId === null || pair.plotSiteId === Number(plotSiteId))
  ));
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
      status: { not: "CANCELLED" },
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
        completedTrips.set(key, { updatedAt: saved.updatedAt || null, transportPersonId: person.id || null });
        completedTrips.set(pair.customerId, saved.updatedAt || null);
      }
    }
  }
  return completedTrips;
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

function hasBillingRole(user) {
  return (user?.userRoles || []).some(({ role }) => isBillingRole(role));
}

async function requireBillingProfile(req, res) {
  const user = await prisma.user.findFirst({
    where: { id: req.user.userId, tenantId: req.user.tenantId, deactivatedAt: null },
    include: { userRoles: { include: { role: true } } },
  });
  if (!user || !hasBillingRole(user)) {
    res.status(403).json({ error: "A Billing role is required for this workspace", code: "BILLING_ROLE_REQUIRED" });
    return null;
  }
  const billingPerson = await prisma.billingPerson.findFirst({
    where: { tenantId: req.user.tenantId, userId: req.user.userId, isActive: true },
  });
  if (!billingPerson) {
    res.status(403).json({ error: "No active billing person profile is linked to this login", code: "BILLING_PROFILE_NOT_LINKED" });
    return null;
  }
  return { ...user, billingPerson };
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

function buildTransportAssignments(person, pickupLocations, plots, customers, customerPickupMap = new Map()) {
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
      customer: customerId ? customerMap.get(customerId) || null : null,
      pickup: customerPickup ? {
        id: customerPickup.id,
        name: "Customer pickup",
        address: cleanPickupAddress(customerPickup.pickupAddress) || customerPickup.pickupAddress,
        source: "CALLIFIED_TRANSCRIPT",
      } : pickupLocationId ? pickupMap.get(pickupLocationId) || null : null,
      drop: plotSiteId ? plotMap.get(plotSiteId) || null : null,
    };
  });
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
    assignedPlot: plotMap.get(Number(transportPair?.plotSiteId || brokerPair?.plotSiteId)) || null,
    currentStage,
    currentStatus,
    currentStatusUpdatedAt,
    workflow: {
      transport: {
        status: transport.status,
        updatedAt: transport.statusUpdatedAt,
        assignee: transport.transportPerson,
      },
      broker: {
        status: brokerStatus,
        updatedAt: saved?.updatedAt || null,
        assignee: broker ? { id: broker.id, name: broker.name, phone: broker.phone } : null,
      },
      billing: {
        status: billingStatus,
        updatedAt: saved?.billingUpdatedAt || null,
      },
    },
  };
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

function isTransportRole(role) {
  const tokens = [role?.key, role?.name]
    .map((value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  return tokens.includes("transportperson") || tokens.includes("transport");
}

function isBrokerRole(role) {
  const tokens = [role?.key, role?.name]
    .map((value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, ""));
  return tokens.some((token) => ["broker", "brooker", "plotbroker", "plotbrooker"].includes(token));
}

function isBillingRole(role) {
  const token = String(role?.key || role?.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return token === "billing" || token === "billingdepartment";
}

async function findTransportRole(tenantId, client = prisma) {
  const roles = await client.role.findMany({
    where: { tenantId, userType: "STAFF", isActive: true },
    select: { id: true, key: true, name: true },
  });
  return roles.find(isTransportRole) || null;
}

async function findBrokerRole(tenantId, client = prisma) {
  const roles = await client.role.findMany({
    where: { tenantId, userType: "STAFF", isActive: true },
    select: { id: true, key: true, name: true },
  });
  return roles.find(isBrokerRole) || null;
}

async function findBillingRole(tenantId, client = prisma) {
  const roles = await client.role.findMany({
    where: { tenantId, userType: "STAFF", isActive: true },
    select: { id: true, key: true, name: true },
  });
  return roles.find(isBillingRole) || null;
}

async function findConfirmedPickupCustomers(tenantId) {
  const [pickups, completedCustomerIds] = await Promise.all([
    prisma.customerPickup.findMany({
      where: { tenantId, contact: { deletedAt: null } },
      orderBy: { updatedAt: "desc" },
      select: {
        contact: { select: { id: true, name: true, phone: true, email: true, company: true } },
      },
    }),
    findCompletedCustomerIds(tenantId),
  ]);
  return pickups
    .map((pickup) => pickup.contact)
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
    include: { userRoles: { include: { role: true } } },
  });
  if (!user || !(user.userRoles || []).some(({ role }) => isTransportRole(role))) {
    return { error: "The selected staff member does not have the Transport Person role.", code: "INVALID_TRANSPORT_USER" };
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
    include: { userRoles: { include: { role: true } } },
  });
  if (!user || !(user.userRoles || []).some(({ role }) => isBrokerRole(role))) {
    return { error: "The selected staff member does not have the Broker role.", code: "INVALID_BROKER_USER" };
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
    include: { userRoles: { include: { role: true } } },
  });
  if (!user || !hasBillingRole(user)) {
    return { error: "The selected staff member does not have the Billing role.", code: "INVALID_BILLING_USER" };
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

router.use(verifyToken, requireGenericTenant);

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

router.get("/transport-persons/me", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const person = await prisma.transportPerson.findFirst({
      where: { tenantId, userId: req.user.userId, isActive: true },
    });
    if (!person) {
      return res.status(403).json({
        error: "No active transport profile is linked to this login",
        code: "TRANSPORT_PROFILE_NOT_LINKED",
      });
    }
    const pickupLocationIds = parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
    if (pickupLocationIds.length === 0 && person.pickupLocationId) pickupLocationIds.push(person.pickupLocationId);
    const pairs = assignmentPairs(person);
    const plotSiteIds = [...new Set(pairs.map((row) => row.plotSiteId))];
    const customerIds = [...new Set(pairs.map((row) => row.customerId))];
    const [pickupLocations, plots, customers, customerPickups] = await Promise.all([
      pickupLocationIds.length ? prisma.pickupLocation.findMany({
        where: { tenantId, id: { in: pickupLocationIds } },
        select: { id: true, name: true, address: true, googleMapsLink: true },
      }) : [],
      plotSiteIds.length ? prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotSiteIds } },
        select: { id: true, name: true, address: true, referenceCode: true },
      }) : [],
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds } },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      customerIds.length ? prisma.customerPickup.findMany({
        where: { tenantId, contactId: { in: customerIds } },
        select: { id: true, contactId: true, pickupAddress: true },
      }) : [],
    ]);
    const customerPickupMap = new Map(customerPickups.map((row) => [row.contactId, row]));
    const assignments = buildTransportAssignments(person, pickupLocations, plots, customers, customerPickupMap);
    return res.json({
      transportPerson: {
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

router.patch("/transport-persons/me/assignments/:assignmentKey/status", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const person = await prisma.transportPerson.findFirst({
      where: { tenantId, userId: req.user.userId, isActive: true },
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
    statuses[assignment.assignmentKey] = { status: nextStatus, updatedAt: now };
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
    return res.json({ assignmentKey: assignment.assignmentKey, status: nextStatus, statusUpdatedAt: now });
  } catch (error) {
    if (handleClaimError(error, res)) return undefined;
    console.error("pickup-plot-inventory PATCH /transport-persons/me/assignments/:assignmentKey/status error:", error);
    return res.status(500).json({ error: "Failed to update trip status", code: "TRANSPORT_STATUS_UPDATE_FAILED" });
  }
});

router.get("/brokers/me", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const broker = await prisma.plotBroker.findFirst({
      where: { tenantId, userId: req.user.userId, isActive: true },
    });
    if (!broker) {
      return res.status(403).json({
        error: "No active Sales Executive profile is linked to this login",
        code: "BROKER_PROFILE_NOT_LINKED",
      });
    }
    const pairs = assignmentPairs(broker);
    const customerIds = [...new Set(pairs.map((row) => row.customerId))];
    const plotSiteIds = [...new Set(pairs.map((row) => row.plotSiteId))];
    const [customers, plots, transportPeople] = await Promise.all([
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds } },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      plotSiteIds.length ? prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotSiteIds } },
        select: { id: true, name: true, address: true, referenceCode: true, availability: true },
      }) : [],
      customerIds.length ? prisma.transportPerson.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, assignmentStatusJson: true },
      }) : [],
    ]);
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const completedTrips = completedTransportTrips(transportPeople);
    const brokerStatuses = parseStoredObject(broker.workflowStatusJson);
    const rows = pairs.map(({ customerId, plotSiteId }) => {
      const customer = customerMap.get(customerId);
      if (!customer) return null;
      const key = assignmentKey(customerId, plotSiteId);
      const tripCompleted = completedTrips.has(key);
      const brokerWorkflow = brokerStatuses[key] || brokerStatuses[`customer-${customerId}`];
      return {
        ...customer,
        assignmentKey: key,
        plot: plotMap.get(plotSiteId) || null,
        tripCompleted,
        tripCompletedAt: tripCompleted ? completedTrips.get(key)?.updatedAt || null : null,
        tripMessage: tripCompleted ? "Trip completed" : "Trip not completed",
        ...(tripCompleted ? {
          brokerWorkflow: {
            status: normalizeBrokerWorkflowStatus(brokerWorkflow),
            updatedAt: brokerWorkflow?.updatedAt || null,
            visitScheduledAt: brokerWorkflow?.visitScheduledAt || null,
          },
        } : {}),
      };
    }).filter(Boolean);
    return res.json({
      broker: {
        id: broker.id,
        name: broker.name,
        phone: broker.phone,
        email: broker.email,
        agency: broker.agency,
        commissionPercent: broker.commissionPercent,
      },
      customers: rows,
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

router.patch(["/brokers/me/customers/:customerId/workflow", "/brokers/me/assignments/:assignmentKey/workflow"], async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const keyMatch = req.params.assignmentKey?.match(/^customer-(\d+)-plot-(\d+)$/);
    const customerId = Number(keyMatch?.[1] || req.params.customerId);
    const requestedPlotId = keyMatch ? Number(keyMatch[2]) : null;
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }
    const broker = await prisma.plotBroker.findFirst({
      where: { tenantId, userId: req.user.userId, isActive: true },
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
    const currentStatus = normalizeBrokerWorkflowStatus(statuses[key] || statuses[`customer-${customerId}`]);
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
    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(409).json({
        error: allowedStatuses.length ? `Choose the next site visit step: ${allowedStatuses.join(" or ")}.` : "The site visit workflow is already complete.",
        code: "INVALID_BROKER_WORKFLOW_TRANSITION",
        currentStatus,
        nextStatuses: allowedStatuses,
      });
    }
    const now = new Date().toISOString();
    let visitScheduledAt = statuses[key]?.visitScheduledAt || statuses[`customer-${customerId}`]?.visitScheduledAt || null;
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
      const plotId = pair.plotSiteId;
      if (!plotId) {
        return res.status(409).json({
          error: "Assign a plot to this customer before marking it selected.",
          code: "PLOT_REQUIRED_FOR_BOOKING",
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

router.get("/billing/me", async (req, res) => {
  try {
    const billingUser = await requireBillingProfile(req, res);
    if (!billingUser) return undefined;
    const tenantId = req.user.tenantId;
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
    const visibleQueue = queue.filter((row) => billingCanAccess(billingUser.billingPerson, row.customerId, row.plotId));
    const readyPairKeys = new Set(visibleQueue.map((row) => assignmentKey(row.customerId, row.plotId)));
    const waitingQueue = assignmentPairs(billingUser.billingPerson)
      .filter((row) => !readyPairKeys.has(assignmentKey(row.customerId, row.plotSiteId)));
    const customerIds = [...new Set([
      ...visibleQueue.map((row) => row.customerId),
      ...waitingQueue.map((row) => row.customerId),
    ])];
    const plotIds = [...new Set([
      ...visibleQueue.map((row) => row.plotId),
      ...waitingQueue.map((row) => row.plotSiteId),
    ].filter(Boolean))];
    const [customers, plots] = await Promise.all([
      customerIds.length ? prisma.contact.findMany({
        where: { tenantId, id: { in: customerIds } },
        select: { id: true, name: true, phone: true, email: true, company: true },
      }) : [],
      plotIds.length ? prisma.plotSite.findMany({
        where: { tenantId, id: { in: plotIds } },
        select: { id: true, name: true, address: true, referenceCode: true, price: true },
      }) : [],
    ]);
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const assignments = visibleQueue.map((row) => ({
      assignmentKey: `${row.brokerId}-${row.customerId}-${row.plotId}`,
      broker: { id: row.brokerId, name: row.brokerName },
      customer: customerMap.get(row.customerId) || null,
      plot: row.plotId ? plotMap.get(row.plotId) || null : null,
      status: row.billingStatus,
      statusUpdatedAt: row.billingUpdatedAt,
      bookingId: row.bookingId,
      bookingNumber: row.bookingNumber,
      invoiceId: row.invoiceId,
      invoiceNum: row.invoiceNum,
      invoiceAmount: row.invoiceAmount,
      amountPaid: row.amountPaid,
      balance: row.balance,
      paymentId: row.paymentId,
      paymentMethod: row.paymentMethod,
      transactionRef: row.transactionRef,
    })).filter((row) => row.customer);
    const waitingAssignments = waitingQueue.map((row) => {
      const brokerAssignment = brokerAssignments.get(assignmentKey(row.customerId, row.plotSiteId));
      return {
        assignmentKey: `waiting-${row.customerId}-${row.plotSiteId || 0}`,
        broker: brokerAssignment?.broker || null,
        customer: customerMap.get(row.customerId) || null,
        plot: row.plotSiteId ? plotMap.get(row.plotSiteId) || null : null,
        status: "AWAITING_SALES_EXECUTIVE_HANDOFF",
        salesStatus: brokerAssignment?.status || null,
        statusUpdatedAt: null,
      };
    }).filter((row) => row.customer);
    return res.json({
      billingUser: { id: billingUser.id, name: billingUser.name, email: billingUser.email },
      assignments,
      waitingAssignments,
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

router.patch("/billing/me/assignments/:assignmentKey/status", async (req, res) => {
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
    const pair = broker && assignmentPairs(broker).find((row) => row.customerId === customerId && row.plotSiteId === requestedPlotId);
    if (!broker || !pair) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    const key = assignmentKey(customerId, requestedPlotId);
    const statuses = parseStoredObject(broker.workflowStatusJson);
    const legacyKey = `customer-${customerId}`;
    if (!statuses[key] && statuses[legacyKey]) statuses[key] = { ...statuses[legacyKey], plotId: requestedPlotId };
    if (normalizeBrokerWorkflowStatus(statuses[key]) !== "PLOT_SELECTED") {
      return res.status(409).json({ error: "Customer has not been handed to Billing", code: "CUSTOMER_NOT_READY_FOR_BILLING" });
    }
    const currentStatus = normalizeBillingWorkflowStatus(statuses[key]);
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
    const saved = { ...statuses[key] };
    const plotId = requestedPlotId;
    let booking = saved.bookingId
      ? await prisma.plotBooking.findFirst({ where: { id: Number(saved.bookingId), tenantId: req.user.tenantId } })
      : await findActivePlotBooking(prisma, req.user.tenantId, customerId, plotId);
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

router.get("/customer-pickups", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [pickups, transportPeople, brokers, workflowEvents, plots] = await Promise.all([
      prisma.customerPickup.findMany({
        where: { tenantId },
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
        select: { id: true, name: true, phone: true, customerIdsJson: true, plotSiteIdsJson: true, assignmentPairsJson: true, workflowStatusJson: true },
      }),
      prisma.plotWorkflowEvent.findMany({
        where: { tenantId },
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      }),
      prisma.plotSite.findMany({
        where: { tenantId },
        select: { id: true, name: true, address: true, area: true, availability: true },
      }),
    ]);
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
    const customers = pickups.map((pickup) => {
      const workflowStatus = findCustomerWorkflowStatus(pickup.contactId, transportPeople, brokers, plotMap);
      return {
        ...pickup,
        pickupAddress: cleanPickupAddress(pickup.pickupAddress) || pickup.pickupAddress,
        ...workflowStatus,
        workflowHistory: historyByCustomer.get(pickup.contactId) || [],
      };
    });
    return res.json({
      customers,
      summary: {
        total: customers.length,
        awaitingAssignment: customers.filter((row) => row.status === "PICKUP_LOCATION_CAPTURED").length,
        activeTrips: customers.filter((row) => !["PICKUP_LOCATION_CAPTURED", "COMPLETED"].includes(row.status)).length,
        completed: customers.filter((row) => row.status === "COMPLETED").length,
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
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });

    const existingPickup = await prisma.customerPickup.findUnique({
      where: { tenantId_contactId: { tenantId, contactId } },
      select: { id: true },
    });

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
        { pickupPointId: pickup.id, contactId: pickup.contactId, pickup },
        tenantId,
        req.io,
      ).catch((error) => console.error("[GenericCampaign] pickup point event failed:", error.message));
    }
    return res.json({ ...pickup, status: "PICKUP_LOCATION_CAPTURED" });
  } catch (error) {
    console.error("pickup-plot-inventory PUT /customer-pickups/:contactId error:", error);
    return res.status(500).json({ error: "Failed to save customer pickup location", code: "CUSTOMER_PICKUP_SAVE_FAILED" });
  }
});

router.get("/", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [pickupLocations, plots] = await Promise.all([
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
    ]);

    const locationPlotCounts = new Map(pickupLocations.map((location) => [location.id, 0]));
    const serializedPlots = plots.map((plot) => {
      const serialized = serializePlot(plot);
      for (const locationId of serialized.pickupLocationIds) {
        locationPlotCounts.set(locationId, (locationPlotCounts.get(locationId) || 0) + 1);
      }
      return {
        ...serialized,
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

router.post("/plots", adminOnly, async (req, res) => {
  try {
    const name = text(req.body?.name, 150);
    const availability = text(req.body?.availability, 20) || "AVAILABLE";
    const areaUnit = text(req.body?.areaUnit, 20) || "SQ_FT";
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
      validateOptionalText(req.body?.plotNumber, "Plot number", 100),
      validateOptionalText(req.body?.block, "Block", 100),
      req.body?.address ? validateRequiredText(req.body.address, "Address", { min: 5, max: 2000 }) : null,
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateOptionalText(req.body?.area, "Area or size", 100),
      PLOT_AREA_UNITS.has(areaUnit) ? null : "Select a valid area unit.",
      validateOptionalText(req.body?.roadWidth, "Road width", 100),
      facing && !PLOT_FACINGS.has(facing) ? "Select a valid facing." : null,
      propertyType && !PLOT_PROPERTY_TYPES.has(propertyType) ? "Select a valid property type." : null,
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationIds === false) {
      return res.status(400).json({ error: "Pickup location was not found", code: "INVALID_PICKUP_LOCATION" });
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
    const availability = text(req.body?.availability, 20) || existing.availability;
    const areaUnit = text(req.body?.areaUnit, 20) || existing.areaUnit || "SQ_FT";
    const facing = text(req.body?.facing, 30);
    const propertyType = text(req.body?.propertyType, 30);
    const price = parsePrice(req.body?.price);
    const pickupLocationIds = await validatePickupLocationIds(
      req.user.tenantId,
      req.body?.pickupLocationIds !== undefined ? req.body.pickupLocationIds : req.body?.pickupLocationId,
    );
    const validationError = firstError(
      validateName(req.body?.name, "Plot or site name"),
      validateOptionalText(req.body?.plotNumber, "Plot number", 100),
      validateOptionalText(req.body?.block, "Block", 100),
      req.body?.address ? validateRequiredText(req.body.address, "Address", { min: 5, max: 2000 }) : null,
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateOptionalText(req.body?.area, "Area or size", 100),
      PLOT_AREA_UNITS.has(areaUnit) ? null : "Select a valid area unit.",
      validateOptionalText(req.body?.roadWidth, "Road width", 100),
      facing && !PLOT_FACINGS.has(facing) ? "Select a valid facing." : null,
      propertyType && !PLOT_PROPERTY_TYPES.has(propertyType) ? "Select a valid property type." : null,
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationIds === false) {
      return res.status(400).json({ error: "Pickup location was not found", code: "INVALID_PICKUP_LOCATION" });
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
    const [transportPersons, pickupLocations, plots, confirmedPickups, transportRole] = await Promise.all([
      prisma.transportPerson.findMany({
        where: { tenantId },
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
        select: { id: true, name: true, address: true, availability: true, isActive: true },
      }),
      findConfirmedPickupCustomers(tenantId),
      findTransportRole(tenantId),
    ]);
    const claimOwners = startedCustomerOwners(transportPersons, "transport", "assignmentStatusJson");
    const customers = markClaimedCustomers(confirmedPickups, claimOwners);
    const linkedUserIds = new Set(transportPersons.map((person) => Number(person.userId)).filter(Number.isInteger));
    const staffUsers = transportRole ? await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        userType: { in: ["STAFF", "OWNER"] },
        userRoles: { some: { roleId: transportRole.id } },
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, email: true, phone: true },
    }) : [];
    const pickupLocationMap = new Map(pickupLocations.map((row) => [row.id, row]));
    const plotSiteMap = new Map(plots.map((row) => [row.id, row]));
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
    validateOptionalText(req.body?.vehicleType, "Vehicle type", 100),
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
      person = await prisma.transportPerson.create({
        data: { ...parsed.data, tenantId: req.user.tenantId, userId: assignment.user.id },
        include: {
          pickupLocation: { select: { id: true, name: true, isActive: true } },
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
        findTransportRole(req.user.tenantId),
        prisma.user.findFirst({ where: { email, tenantId: req.user.tenantId } }),
      ]);
      if (!role) {
        return res.status(409).json({
          error: "Create an active Transport Person role in Team & Access before adding a transport login.",
          code: "TRANSPORT_ROLE_NOT_CONFIGURED",
        });
      }
      if (existingUser) {
        return res.status(409).json({ error: "A staff user with that email already exists.", code: "EMAIL_ALREADY_EXISTS" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      person = await prisma.$transaction(async (tx) => {
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
      person = await prisma.transportPerson.create({
        data: { ...parsed.data, tenantId: req.user.tenantId },
        include: { pickupLocation: { select: { id: true, name: true, isActive: true } } },
      });
    }
    return res.status(201).json(serializeTransportPerson(person));
  } catch (error) {
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
    const person = existing.userId ? await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: existing.userId },
        data: { name: parsed.data.name, phone: parsed.data.phone },
      });
      return updateTransportPerson(tx);
    }) : await updateTransportPerson(prisma);
    return res.json(serializeTransportPerson(person));
  } catch (error) {
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
        where: { tenantId },
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
        where: { tenantId, isActive: true },
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
        userRoles: { some: { roleId: brokerRole.id } },
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
          error: "Create an active Broker role in Team & Access before adding a broker login.",
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
        where: { tenantId },
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
        where: { tenantId, isActive: true },
        orderBy: { updatedAt: "desc" },
        select: { assignmentPairsJson: true, customerIdsJson: true, plotSiteIdsJson: true },
      }),
      prisma.plotBooking.findMany({
        where: { tenantId, billingPersonId: { not: null }, status: { not: BILLING_WORKFLOW[0] } },
        select: { contactId: true, billingPersonId: true },
      }),
    ]);
    const claimOwners = billingCustomerOwners(claimedBookings);
    const customers = markClaimedCustomers(attachTransportPlots(rawCustomers, transportPeople), claimOwners);
    const linkedUserIds = new Set(billingPersons.map((person) => Number(person.userId)).filter(Number.isInteger));
    const staffUsers = billingRole ? await prisma.user.findMany({
      where: {
        tenantId,
        deactivatedAt: null,
        userType: { in: ["STAFF", "OWNER"] },
        userRoles: { some: { roleId: billingRole.id } },
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
        return res.status(409).json({ error: "Create an active Billing role in Team & Access before adding a billing login.", code: "BILLING_ROLE_NOT_CONFIGURED" });
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
