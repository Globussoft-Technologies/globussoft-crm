const express = require("express");
const bcrypt = require("bcryptjs");
const prisma = require("../lib/prisma");
const { sendEmail } = require("../lib/emailSender");
const { resolveProviderConfig, sendSms } = require("../services/smsProvider");
const { verifyToken, verifyRole } = require("../middleware/auth");
const { sanitizeJsonForStringColumn } = require("../lib/sanitizeJson");
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
const AVAILABILITY = new Set(["AVAILABLE", "RESERVED", "SOLD"]);
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
  "READY_TO_EXPLAIN",
  "EXPLANATION_STARTED",
  "EXPLANATION_COMPLETED",
  "INTEREST_CONFIRMED",
  "NOT_INTERESTED",
];
const BILLING_WORKFLOW = [
  "READY_FOR_BILLING",
  "DETAILS_VERIFIED",
  "INVOICE_PREPARED",
  "INVOICE_SENT",
  "PAYMENT_RECEIVED",
  "BILLING_COMPLETED",
];

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
  const { boundaryJson, ...rest } = plot;
  return { ...rest, boundary: parseStoredBoundary(boundaryJson) };
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

function billingOwnsAssignment(profile, customerId, plotId) {
  const customers = parseStoredArray(profile.customerIdsJson).map(Number);
  const plots = parseStoredArray(profile.plotSiteIdsJson).map(Number);
  return customers.includes(customerId) && (!plots.length || plots.includes(plotId));
}

async function saveWorkflow(model, record, field, statuses, tenantId) {
  const result = await model.updateMany({
    where: { id: record.id, tenantId, [field]: record[field] ?? null, updatedAt: record.updatedAt },
    data: { [field]: sanitizeJsonForStringColumn(statuses) },
  });
  return result.count === 1;
}

function completedTransportTrips(transportPeople) {
  const completedTrips = new Map();
  for (const person of transportPeople) {
    const assignedCustomerIds = parseStoredArray(person.customerIdsJson).map(Number).filter(Number.isInteger);
    const statuses = parseStoredObject(person.assignmentStatusJson);
    for (const customerId of assignedCustomerIds) {
      const saved = statuses[`customer-${customerId}`];
      if (saved?.status === "COMPLETED") completedTrips.set(customerId, saved.updatedAt || null);
    }
  }
  return completedTrips;
}

function normalizeBrokerWorkflowStatus(saved) {
  if (BROKER_WORKFLOW.includes(saved?.status)) return saved.status;
  if (["DOCUMENTATION", "BILLING", "BILLED"].includes(saved?.status)) return "INTEREST_CONFIRMED";
  return BROKER_WORKFLOW[0];
}

function normalizeBillingWorkflowStatus(saved) {
  if (BILLING_WORKFLOW.includes(saved?.billingStatus)) return saved.billingStatus;
  return saved?.status === "BILLED" ? "BILLING_COMPLETED" : BILLING_WORKFLOW[0];
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

async function sendNotInterestedThankYou(tenantId, customer) {
  const body = `Thank you for your interest, ${customer.name || "valued customer"}. We appreciate your time and will be happy to connect with you again whenever you are ready.`;
  if (customer.email) {
    try {
      const result = await sendEmail({ tenantId, to: customer.email, subject: "Thank you for your interest", text: body });
      if (result?.sent !== false) return { sent: true, channel: "email" };
    } catch (error) {
      console.error("pickup-plot-inventory broker thank-you email failed:", error.message);
    }
  }
  if (customer.phone) {
    try {
      const config = await resolveProviderConfig(prisma, tenantId);
      if (config) {
        const result = await sendSms({ ...config, to: customer.phone, body });
        if (result?.success !== false) return { sent: true, channel: "sms" };
      }
    } catch (error) {
      console.error("pickup-plot-inventory broker thank-you SMS failed:", error.message);
    }
  }
  return { sent: false, channel: null, code: "CUSTOMER_MESSAGE_NOT_CONFIGURED" };
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

function serializeTransportPerson(person, pickupLocationMap = new Map(), plotSiteMap = new Map(), customerMap = new Map()) {
  const {
    pickupLocationIdsJson, plotSiteIdsJson, serviceAreasJson, customerIdsJson,
    assignmentStatusJson: _assignmentStatusJson, pickupLocation,
    ...rest
  } = person;
  const pickupLocationIds = parseStoredArray(pickupLocationIdsJson)
    .map(Number)
    .filter(Number.isInteger);
  if (pickupLocationIds.length === 0 && rest.pickupLocationId) pickupLocationIds.push(rest.pickupLocationId);
  const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
  const customerIds = parseStoredArray(customerIdsJson).map(Number).filter(Number.isInteger);
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
    pickupLocations: pickupLocationIds.map((id) => pickupLocationMap.get(id)).filter(Boolean),
    plots: plotSiteIds.map((id) => plotSiteMap.get(id)).filter(Boolean),
    customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
    serviceAreas,
  };
}

function buildTransportAssignments(person, pickupLocations, plots, customers, customerPickupMap = new Map()) {
  const pickupLocationIds = parseStoredArray(person.pickupLocationIdsJson).map(Number).filter(Number.isInteger);
  if (pickupLocationIds.length === 0 && person.pickupLocationId) pickupLocationIds.push(person.pickupLocationId);
  const plotSiteIds = parseStoredArray(person.plotSiteIdsJson).map(Number).filter(Number.isInteger);
  const customerIds = parseStoredArray(person.customerIdsJson).map(Number).filter(Number.isInteger);
  const statuses = parseStoredObject(person.assignmentStatusJson);
  const pickupMap = new Map(pickupLocations.map((row) => [row.id, row]));
  const plotMap = new Map(plots.map((row) => [row.id, row]));
  const customerMap = new Map(customers.map((row) => [row.id, row]));
  const count = Math.max(customerIds.length, plotSiteIds.length, pickupLocationIds.length);

  return Array.from({ length: count }, (_, index) => {
    const customerId = customerIds[index] || null;
    const plotSiteId = plotSiteIds[index] || plotSiteIds[0] || null;
    const pickupLocationId = pickupLocationIds[index] || pickupLocationIds[0] || null;
    const assignmentKey = customerId
      ? `customer-${customerId}`
      : plotSiteId
        ? `plot-${plotSiteId}`
        : `pickup-${pickupLocationId}`;
    const saved = statuses[assignmentKey] || {};
    const status = TRANSPORT_STATUS_FLOW.includes(saved.status) ? saved.status : "ASSIGNED";
    const customerPickup = customerId ? customerPickupMap.get(customerId) : null;
    return {
      assignmentKey,
      status,
      statusUpdatedAt: saved.updatedAt || null,
      customer: customerId ? customerMap.get(customerId) || null : null,
      pickup: customerPickup ? {
        id: customerPickup.id,
        name: "Customer pickup",
        address: customerPickup.pickupAddress,
        source: "CALLIFIED_TRANSCRIPT",
      } : pickupLocationId ? pickupMap.get(pickupLocationId) || null : null,
      drop: plotSiteId ? plotMap.get(plotSiteId) || null : null,
    };
  });
}

function findCustomerTransportStatus(customerId, transportPeople) {
  for (const person of transportPeople) {
    if (!parseStoredArray(person.customerIdsJson).map(Number).includes(customerId)) continue;
    const saved = parseStoredObject(person.assignmentStatusJson)[`customer-${customerId}`] || {};
    return {
      status: TRANSPORT_STATUS_FLOW.includes(saved.status) ? saved.status : "ASSIGNED",
      statusUpdatedAt: saved.updatedAt || person.updatedAt || null,
      transportPerson: { id: person.id, name: person.name, phone: person.phone },
    };
  }
  return { status: "PICKUP_LOCATION_CAPTURED", statusUpdatedAt: null, transportPerson: null };
}

function findCustomerWorkflowStatus(customerId, transportPeople, brokers) {
  const transport = findCustomerTransportStatus(customerId, transportPeople);
  const broker = brokers.find((row) => parseStoredArray(row.customerIdsJson).map(Number).includes(customerId)) || null;
  const saved = broker ? parseStoredObject(broker.workflowStatusJson)[`customer-${customerId}`] : null;
  const brokerStatus = broker
    ? normalizeBrokerWorkflowStatus(saved)
    : transport.status === "COMPLETED" ? "AWAITING_BROKER_ASSIGNMENT" : "PENDING";
  const billingStatus = brokerStatus === "INTEREST_CONFIRMED"
    ? normalizeBillingWorkflowStatus(saved)
    : "PENDING";

  let currentStage = "transport";
  let currentStatus = transport.status;
  let currentStatusUpdatedAt = transport.statusUpdatedAt;
  if (transport.status === "COMPLETED") {
    currentStage = "broker";
    currentStatus = brokerStatus;
    currentStatusUpdatedAt = saved?.updatedAt || transport.statusUpdatedAt;
    if (brokerStatus === "INTEREST_CONFIRMED") {
      currentStage = "billing";
      currentStatus = billingStatus;
      currentStatusUpdatedAt = saved?.billingUpdatedAt || saved?.updatedAt || transport.statusUpdatedAt;
    }
  }

  return {
    ...transport,
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

function serializePlotBroker(broker, customerMap = new Map(), plotSiteMap = new Map()) {
  const { customerIdsJson, plotSiteIdsJson, workflowStatusJson: _workflowStatusJson, ...rest } = broker;
  const customerIds = parseStoredArray(customerIdsJson).map(Number).filter(Number.isInteger);
  const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
  if (plotSiteIds.length === 0 && rest.plotSiteId) plotSiteIds.push(rest.plotSiteId);
  return {
    ...rest,
    customerIds,
    plotSiteIds,
    customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
    plots: plotSiteIds.map((id) => plotSiteMap.get(id)).filter(Boolean),
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
  const pickups = await prisma.customerPickup.findMany({
    where: { tenantId, contact: { deletedAt: null } },
    orderBy: { updatedAt: "desc" },
    select: {
      contact: { select: { id: true, name: true, phone: true, email: true, company: true } },
    },
  });
  return pickups
    .map((pickup) => pickup.contact)
    .filter(Boolean)
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
    const plotSiteIds = parseStoredArray(person.plotSiteIdsJson).map(Number).filter(Number.isInteger);
    const customerIds = parseStoredArray(person.customerIdsJson).map(Number).filter(Number.isInteger);
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
    if (!await saveWorkflow(prisma.transportPerson, person, "assignmentStatusJson", statuses, tenantId)) {
      return res.status(409).json({ error: "Assignments changed. Refresh and retry.", code: "WORKFLOW_CONFLICT" });
    }
    return res.json({ assignmentKey: assignment.assignmentKey, status: nextStatus, statusUpdatedAt: now });
  } catch (error) {
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
        error: "No active broker profile is linked to this login",
        code: "BROKER_PROFILE_NOT_LINKED",
      });
    }
    const customerIds = parseStoredArray(broker.customerIdsJson).map(Number).filter(Number.isInteger);
    const plotSiteIds = parseStoredArray(broker.plotSiteIdsJson).map(Number).filter(Number.isInteger);
    if (plotSiteIds.length === 0 && broker.plotSiteId) plotSiteIds.push(broker.plotSiteId);
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
        select: { customerIdsJson: true, assignmentStatusJson: true },
      }) : [],
    ]);
    const customerMap = new Map(customers.map((row) => [row.id, row]));
    const plotMap = new Map(plots.map((row) => [row.id, row]));
    const completedTrips = completedTransportTrips(transportPeople);
    const brokerStatuses = parseStoredObject(broker.workflowStatusJson);
    const rows = customerIds.map((customerId, index) => {
      const customer = customerMap.get(customerId);
      if (!customer) return null;
      const plotId = plotSiteIds[index] || plotSiteIds[0] || null;
      const tripCompleted = completedTrips.has(customerId);
      const brokerWorkflow = brokerStatuses[`customer-${customerId}`];
      return {
        ...customer,
        plot: plotId ? plotMap.get(plotId) || null : null,
        tripCompleted,
        tripCompletedAt: tripCompleted ? completedTrips.get(customerId) : null,
        tripMessage: tripCompleted ? "Trip completed" : "Trip not completed",
        ...(tripCompleted ? {
          brokerWorkflow: {
            status: normalizeBrokerWorkflowStatus(brokerWorkflow),
            updatedAt: brokerWorkflow?.updatedAt || null,
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
    return res.status(500).json({ error: "Failed to load assigned broker customers", code: "BROKER_WORK_LOAD_FAILED" });
  }
});

router.patch("/brokers/me/customers/:customerId/workflow", async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const customerId = Number(req.params.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ error: "Invalid customer id", code: "INVALID_ID" });
    }
    const broker = await prisma.plotBroker.findFirst({
      where: { tenantId, userId: req.user.userId, isActive: true },
    });
    if (!broker) {
      return res.status(403).json({ error: "No active broker profile is linked to this login", code: "BROKER_PROFILE_NOT_LINKED" });
    }
    const customerIds = parseStoredArray(broker.customerIdsJson).map(Number).filter(Number.isInteger);
    if (!customerIds.includes(customerId)) {
      return res.status(404).json({ error: "Assigned customer not found", code: "BROKER_CUSTOMER_NOT_FOUND" });
    }
    const transportPeople = await prisma.transportPerson.findMany({
      where: { tenantId, isActive: true },
      select: { customerIdsJson: true, assignmentStatusJson: true },
    });
    if (!completedTransportTrips(transportPeople).has(customerId)) {
      return res.status(409).json({
        error: "The broker workflow can start only after the customer's trip is completed.",
        code: "TRIP_NOT_COMPLETED",
      });
    }
    const key = `customer-${customerId}`;
    const statuses = parseStoredObject(broker.workflowStatusJson);
    const currentStatus = normalizeBrokerWorkflowStatus(statuses[key]);
    const requestedStatus = req.body?.status;
    const allowedStatuses = currentStatus === "EXPLANATION_COMPLETED"
      ? ["INTEREST_CONFIRMED", "NOT_INTERESTED"]
      : currentStatus === "READY_TO_EXPLAIN"
        ? ["EXPLANATION_STARTED"]
        : currentStatus === "EXPLANATION_STARTED"
          ? ["EXPLANATION_COMPLETED"]
          : [];
    if (!allowedStatuses.includes(requestedStatus)) {
      return res.status(409).json({
        error: allowedStatuses.length ? `Choose the next broker step: ${allowedStatuses.join(" or ")}.` : "The broker decision is already complete.",
        code: "INVALID_BROKER_WORKFLOW_TRANSITION",
        currentStatus,
        nextStatuses: allowedStatuses,
      });
    }
    const now = new Date().toISOString();
    statuses[key] = { ...statuses[key], status: requestedStatus, updatedAt: now };
    if (!await saveWorkflow(prisma.plotBroker, broker, "workflowStatusJson", statuses, tenantId)) {
      return res.status(409).json({ error: "Assignments changed. Refresh and retry.", code: "WORKFLOW_CONFLICT" });
    }
    let messageDelivery = null;
    if (requestedStatus === "NOT_INTERESTED") {
      const customer = await prisma.contact.findFirst({ where: { id: customerId, tenantId } });
      if (customer) messageDelivery = await sendNotInterestedThankYou(tenantId, customer);
    }
    return res.json({
      customerId,
      status: requestedStatus,
      statusUpdatedAt: now,
      handedToBilling: requestedStatus === "INTEREST_CONFIRMED",
      messageDelivery,
    });
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /brokers/me/customers/:customerId/workflow error:", error);
    return res.status(500).json({ error: "Failed to update broker workflow", code: "BROKER_WORKFLOW_UPDATE_FAILED" });
  }
});

router.get("/billing/me", async (req, res) => {
  try {
    const billingUser = await requireBillingProfile(req, res);
    if (!billingUser) return undefined;
    const tenantId = req.user.tenantId;
    const brokers = await prisma.plotBroker.findMany({ where: { tenantId, isActive: true } });
    const queue = [];
    for (const broker of brokers) {
      const customerIds = parseStoredArray(broker.customerIdsJson).map(Number).filter(Number.isInteger);
      const plotIds = parseStoredArray(broker.plotSiteIdsJson).map(Number).filter(Number.isInteger);
      if (plotIds.length === 0 && broker.plotSiteId) plotIds.push(broker.plotSiteId);
      const statuses = parseStoredObject(broker.workflowStatusJson);
      customerIds.forEach((customerId, index) => {
        const saved = statuses[`customer-${customerId}`];
        if (normalizeBrokerWorkflowStatus(saved) !== "INTEREST_CONFIRMED") return;
        const plotId = plotIds[index] || plotIds[0] || null;
        if (!billingOwnsAssignment(billingUser.billingPerson, customerId, plotId)) return;
        queue.push({
          brokerId: broker.id,
          brokerName: broker.name,
          customerId,
          plotId,
          billingStatus: normalizeBillingWorkflowStatus(saved),
          billingUpdatedAt: saved?.billingUpdatedAt || null,
        });
      });
    }
    const customerIds = [...new Set(queue.map((row) => row.customerId))];
    const plotIds = [...new Set(queue.map((row) => row.plotId).filter(Boolean))];
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
    const assignments = queue.map((row) => ({
      assignmentKey: `${row.brokerId}-${row.customerId}`,
      broker: { id: row.brokerId, name: row.brokerName },
      customer: customerMap.get(row.customerId) || null,
      plot: row.plotId ? plotMap.get(row.plotId) || null : null,
      status: row.billingStatus,
      statusUpdatedAt: row.billingUpdatedAt,
    })).filter((row) => row.customer);
    return res.json({
      billingUser: { id: billingUser.id, name: billingUser.name, email: billingUser.email },
      assignments,
      summary: {
        total: assignments.length,
        active: assignments.filter((row) => row.status !== "BILLING_COMPLETED").length,
        completed: assignments.filter((row) => row.status === "BILLING_COMPLETED").length,
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
    const [brokerId, customerId] = String(req.params.assignmentKey).split("-").map(Number);
    if (![brokerId, customerId].every((value) => Number.isInteger(value) && value > 0)) {
      return res.status(400).json({ error: "Invalid billing assignment", code: "INVALID_ID" });
    }
    const broker = await prisma.plotBroker.findFirst({ where: { id: brokerId, tenantId: req.user.tenantId, isActive: true } });
    if (!broker || !parseStoredArray(broker.customerIdsJson).map(Number).includes(customerId)) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    const customerIndex = parseStoredArray(broker.customerIdsJson).map(Number).indexOf(customerId);
    const plotIds = parseStoredArray(broker.plotSiteIdsJson).map(Number);
    const plotId = plotIds[customerIndex] || plotIds[0] || broker.plotSiteId || null;
    if (!billingOwnsAssignment(billingUser.billingPerson, customerId, plotId)) {
      return res.status(404).json({ error: "Billing assignment not found", code: "BILLING_ASSIGNMENT_NOT_FOUND" });
    }
    const key = `customer-${customerId}`;
    const statuses = parseStoredObject(broker.workflowStatusJson);
    if (normalizeBrokerWorkflowStatus(statuses[key]) !== "INTEREST_CONFIRMED") {
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
    statuses[key] = { ...statuses[key], billingStatus: nextStatus, billingUpdatedAt: now };
    if (!await saveWorkflow(prisma.plotBroker, broker, "workflowStatusJson", statuses, req.user.tenantId)) {
      return res.status(409).json({ error: "Assignments changed. Refresh and retry.", code: "WORKFLOW_CONFLICT" });
    }
    return res.json({ assignmentKey: req.params.assignmentKey, status: nextStatus, statusUpdatedAt: now });
  } catch (error) {
    console.error("pickup-plot-inventory PATCH /billing/me/assignments/:assignmentKey/status error:", error);
    return res.status(500).json({ error: "Failed to update billing status", code: "BILLING_STATUS_UPDATE_FAILED" });
  }
});

router.get("/customer-pickups", adminOnly, async (req, res) => {
  try {
    const tenantId = req.user.tenantId;
    const [pickups, transportPeople, brokers] = await Promise.all([
      prisma.customerPickup.findMany({
        where: { tenantId },
        orderBy: { updatedAt: "desc" },
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true, company: true, status: true } },
        },
      }),
      prisma.transportPerson.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, phone: true, customerIdsJson: true, assignmentStatusJson: true, updatedAt: true },
      }),
      prisma.plotBroker.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, name: true, phone: true, customerIdsJson: true, workflowStatusJson: true },
      }),
    ]);
    const customers = pickups.map((pickup) => {
      const workflowStatus = findCustomerWorkflowStatus(pickup.contactId, transportPeople, brokers);
      return { ...pickup, ...workflowStatus };
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
    const validationError = firstError(
      validateRequiredText(req.body?.pickupAddress, "Pickup location", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.sourceTranscriptId, "Transcript id", 191),
      validateOptionalText(req.body?.sourceExcerpt, "Transcript excerpt", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    const contact = await prisma.contact.findFirst({
      where: { id: contactId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!contact) return res.status(404).json({ error: "Customer not found", code: "CUSTOMER_NOT_FOUND" });

    const pickupAddress = text(req.body.pickupAddress, 2000);
    const sourceTranscriptId = text(req.body.sourceTranscriptId, 191);
    const sourceExcerpt = text(req.body.sourceExcerpt, 4000);
    const pickup = await prisma.customerPickup.upsert({
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

    const locationRows = pickupLocations.map(({ _count, ...location }) => ({
      ...location,
      plotCount: _count.plots,
    }));
    const activePlots = plots.filter((plot) => plot.isActive);
    return res.json({
      pickupLocations: locationRows,
      plots: plots.map(serializePlot),
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
    const validationError = firstError(
      validateName(req.body?.name, "Location name"),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.googleMapsLink, "Google Maps link", 2000),
      validateOptionalText(req.body?.notes, "Notes", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    if (!isGoogleMapsLink(googleMapsLink)) {
      return res.status(400).json({ error: "Enter a valid HTTPS Google Maps link", code: "INVALID_MAPS_LINK" });
    }
    const location = await prisma.pickupLocation.create({
      data: {
        name,
        address,
        googleMapsLink,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive),
        tenantId: req.user.tenantId,
      },
    });
    return res.status(201).json({ ...location, plotCount: 0 });
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
    const validationError = firstError(
      validateName(req.body?.name, "Location name"),
      validateRequiredText(req.body?.address, "Address", { min: 5, max: 2000 }),
      validateOptionalText(req.body?.googleMapsLink, "Google Maps link", 2000),
      validateOptionalText(req.body?.notes, "Notes", 4000),
    );
    if (validationError) return res.status(400).json({ error: validationError, code: "VALIDATION_ERROR" });
    if (!isGoogleMapsLink(googleMapsLink)) {
      return res.status(400).json({ error: "Enter a valid HTTPS Google Maps link", code: "INVALID_MAPS_LINK" });
    }
    const location = await prisma.pickupLocation.update({
      where: { id },
      data: {
        name,
        address,
        googleMapsLink,
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

async function validatePickupLocation(tenantId, pickupLocationId) {
  if (pickupLocationId === null || pickupLocationId === undefined || pickupLocationId === "") return null;
  const id = Number(pickupLocationId);
  if (!Number.isInteger(id)) return false;
  const location = await prisma.pickupLocation.findFirst({ where: { id, tenantId }, select: { id: true } });
  return location ? id : false;
}

router.post("/plots", adminOnly, async (req, res) => {
  try {
    const name = text(req.body?.name, 150);
    const availability = text(req.body?.availability, 20) || "AVAILABLE";
    const price = parsePrice(req.body?.price);
    const pickupLocationId = await validatePickupLocation(req.user.tenantId, req.body?.pickupLocationId);
    let boundary;
    try {
      boundary = boundaryData(req.body?.boundary);
    } catch (error) {
      return res.status(400).json({ error: error.message, code: error.code || "INVALID_BOUNDARY" });
    }
    const validationError = firstError(
      validateName(req.body?.name, "Plot or site name"),
      req.body?.address ? validateRequiredText(req.body.address, "Address", { min: 5, max: 2000 }) : null,
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateOptionalText(req.body?.area, "Area or size", 100),
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationId === false) {
      return res.status(400).json({ error: "Pickup location was not found", code: "INVALID_PICKUP_LOCATION" });
    }
    const plot = await prisma.plotSite.create({
      data: {
        name,
        // Plot/site address is independent from the optional legacy pickup
        // location relation and is the location shown in the generic UI.
        address: text(req.body?.address, 2000),
        referenceCode: text(req.body?.referenceCode, 100),
        area: text(req.body?.area, 100),
        ...boundary,
        price,
        availability,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive),
        pickupLocationId,
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
    const price = parsePrice(req.body?.price);
    const pickupLocationId = await validatePickupLocation(req.user.tenantId, req.body?.pickupLocationId);
    const validationError = firstError(
      validateName(req.body?.name, "Plot or site name"),
      req.body?.address ? validateRequiredText(req.body.address, "Address", { min: 5, max: 2000 }) : null,
      validateOptionalText(req.body?.referenceCode, "Reference code", 100),
      validateOptionalText(req.body?.area, "Area or size", 100),
      validateMoney(req.body?.price),
      validateOptionalText(req.body?.notes, "Notes", 4000),
      AVAILABILITY.has(availability) ? null : "Select a valid availability.",
    );
    if (validationError || Number.isNaN(price)) {
      return res.status(400).json({ error: validationError || "Enter a valid price.", code: "VALIDATION_ERROR" });
    }
    if (pickupLocationId === false) {
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
        address: text(req.body?.address, 2000),
        referenceCode: text(req.body?.referenceCode, 100),
        area: text(req.body?.area, 100),
        ...boundary,
        price,
        availability,
        notes: text(req.body?.notes, 4000),
        isActive: parseBoolean(req.body?.isActive, existing.isActive),
        pickupLocationId,
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
        select: { id: true, name: true, isActive: true },
      }),
      prisma.plotSite.findMany({
        where: { tenantId },
        orderBy: { name: "asc" },
        select: { id: true, name: true, address: true, availability: true, isActive: true },
      }),
      findConfirmedPickupCustomers(tenantId),
      findTransportRole(tenantId),
    ]);
    const customers = confirmedPickups;
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
    const rows = transportPersons.map((person) => serializeTransportPerson(person, pickupLocationMap, plotSiteMap, customerMap));
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
  const pickupLocationInput = req.body?.pickupLocationIds !== undefined
    ? req.body.pickupLocationIds
    : req.body?.pickupLocationId === null || req.body?.pickupLocationId === undefined || req.body?.pickupLocationId === ""
      ? []
      : [req.body.pickupLocationId];
  const pickupLocationIds = await validateTenantIds(
    prisma.pickupLocation, req.user.tenantId, pickupLocationInput, "Pickup locations",
  );
  if (!Array.isArray(pickupLocationIds)) return { error: pickupLocationIds.error, code: "INVALID_PICKUP_LOCATION" };
  const plotSiteIds = await validateTenantIds(
    prisma.plotSite, req.user.tenantId, req.body?.plotSiteIds || [], "Plots or sites",
  );
  if (!Array.isArray(plotSiteIds)) return { error: plotSiteIds.error, code: "INVALID_PLOT_SITE" };
  const customerIds = await validateTenantIds(
    prisma.contact, req.user.tenantId, req.body?.customerIds || [], "Customers",
  );
  if (!Array.isArray(customerIds)) return { error: customerIds.error, code: "INVALID_CUSTOMER" };
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
    const [brokers, plots, customers, brokerRole] = await Promise.all([
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
      findConfirmedPickupCustomers(tenantId),
      findBrokerRole(tenantId),
    ]);
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
    const rows = brokers.map((broker) => serializePlotBroker(broker, customerMap, plotSiteMap));
    return res.json({
      brokers: rows,
      plots,
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
  const customerIds = await validateTenantIds(
    prisma.contact, req.user.tenantId, req.body?.customerIds || [], "Customers",
  );
  if (!Array.isArray(customerIds)) return { error: customerIds.error, code: "INVALID_CUSTOMER" };
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
      notes: text(req.body?.notes, 4000),
      isActive: parseBoolean(req.body?.isActive, existing?.isActive ?? true),
      plotSiteId: plotSiteIds[0] || null,
    },
  };
}

router.post("/brokers", adminOnly, async (req, res) => {
  try {
    const parsed = await brokerData(req);
    if (parsed.error) return res.status(400).json(parsed);
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
    if (parsed.error) return res.status(400).json(parsed);
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
    const [billingPersons, billingRole, plots, customers] = await Promise.all([
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
      findConfirmedPickupCustomers(tenantId),
    ]);
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
    const rows = billingPersons.map((person) => {
      const { customerIdsJson, plotSiteIdsJson, ...rest } = person;
      const customerIds = parseStoredArray(customerIdsJson).map(Number).filter(Number.isInteger);
      const plotSiteIds = parseStoredArray(plotSiteIdsJson).map(Number).filter(Number.isInteger);
      return {
        ...rest,
        customerIds,
        plotSiteIds,
        customers: customerIds.map((id) => customerMap.get(id)).filter(Boolean),
        plots: plotSiteIds.map((id) => plotMap.get(id)).filter(Boolean),
      };
    });
    return res.json({
      billingPersons: rows,
      plots,
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
  const customerIds = await validateTenantIds(
    prisma.contact, req.user.tenantId, req.body?.customerIds || [], "Customers",
  );
  if (!Array.isArray(customerIds)) return { error: customerIds.error, code: "INVALID_CUSTOMER" };
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
      notes: text(req.body?.notes, 4000),
      isActive: parseBoolean(req.body?.isActive, existing?.isActive ?? true),
    },
  };
}

router.post("/billing-persons", adminOnly, async (req, res) => {
  try {
    const parsed = await billingPersonData(req);
    if (parsed.error) return res.status(400).json(parsed);
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
    if (parsed.error) return res.status(400).json(parsed);
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
