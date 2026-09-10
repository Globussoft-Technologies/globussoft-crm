const express = require("express");
const jwt = require("jsonwebtoken");
const router = express.Router();
const prisma = require("../lib/prisma");
const { JWT_SECRET } = require("../config/secrets");
const { verifyToken } = require("../middleware/auth");
const { requireAnyPermission } = require("../middleware/requirePermission");
const { requireTravelTenant } = require("../middleware/travelGuards");
const { getFrontendUrlFromRequest } = require("../lib/requestOrigin");
const {
  buildTmcParentRegistrationUrl,
  verifyTmcRegistrationToken,
  setTmcRegistrationContext,
} = require("../lib/tmcRegistrationContext");

function verifyPortalToken(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Portal token required", code: "PORTAL_TOKEN_REQUIRED" });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    if (claims.type !== "PORTAL") {
      return res.status(401).json({ error: "Invalid portal token", code: "INVALID_PORTAL_TOKEN" });
    }
    req.portal = claims;
    next();
  } catch (_err) {
    return res.status(401).json({ error: "Invalid or expired portal token", code: "INVALID_PORTAL_TOKEN" });
  }
}

async function requireTmcTenant(req, res, next) {
  try {
    const tenant = await prisma.tenant.findUnique({
      where: { id: Number(req.portal?.tenantId) },
      select: { id: true, vertical: true, slug: true },
    });
    if (!tenant) return res.status(404).json({ error: "Tenant not found", code: "TENANT_NOT_FOUND" });
    if (tenant.vertical !== "travel") {
      return res.status(403).json({ error: "TMC portal requires a travel tenant", code: "NOT_TRAVEL_TENANT" });
    }
    req.tmcTenant = tenant;
    next();
  } catch (err) {
    console.error("[tmc-portal][tenant-guard]", err);
    res.status(500).json({ error: "Tenant lookup failed" });
  }
}

async function requirePortalPersona(persona, req, res, next) {
  try {
    const contact = await prisma.contact.findFirst({
      where: { id: Number(req.portal.contactId), tenantId: Number(req.portal.tenantId), deletedAt: null },
      select: { id: true, name: true, email: true, phone: true, subBrand: true, portalRole: true },
    });
    if (!contact) return res.status(404).json({ error: "Portal profile not found", code: "PORTAL_CONTACT_NOT_FOUND" });
    if (contact.subBrand !== "tmc" || contact.portalRole !== persona) {
      return res.status(403).json({ error: "This TMC portal is not available for this account", code: "TMC_PORTAL_PERSONA_REQUIRED" });
    }
    req.tmcContact = contact;
    next();
  } catch (err) {
    console.error("[tmc-portal][persona-guard]", err);
    res.status(500).json({ error: "Portal profile lookup failed" });
  }
}

function requireTeacher(req, res, next) {
  return requirePortalPersona("TEACHER", req, res, next);
}

function requireParent(req, res, next) {
  return requirePortalPersona("PARENT", req, res, next);
}

function buildPublishedTripUrl(landingPage) {
  if (landingPage?.status !== "PUBLISHED" || landingPage.id == null) return null;
  return `/trips/${encodeURIComponent(String(landingPage.id))}`;
}

// Staff-only lookup used by the trip admin surface when assigning a TMC trip
// to a teacher. Teachers are Contacts, not CRM staff Users, so this is kept
// separate from the portal-token endpoints below.
router.get(
  "/staff/teachers",
  verifyToken,
  requireTravelTenant,
  requireAnyPermission([
    { module: "trips", action: "update" },
    { module: "roles", action: "read" },
  ]),
  async (req, res) => {
    try {
      const teachers = await prisma.contact.findMany({
        where: { tenantId: req.travelTenant.id, subBrand: "tmc", portalRole: "TEACHER", deletedAt: null },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        select: { id: true, name: true, email: true, phone: true },
      });
      res.json({ teachers });
    } catch (err) {
      console.error("[tmc-portal][staff/teachers]", err);
      res.status(500).json({ error: "Failed to load TMC teachers" });
    }
  },
);

// Staff-only teacher workspace data. This powers the admin onboarding
// drill-down without exposing portal tokens or requiring a teacher portal
// session. The response includes the teacher's assigned trips, a fresh
// parent-registration link for each trip, the canonical participant list,
// and completed parent portal accounts.
router.get(
  "/staff/teachers/:teacherId/overview",
  verifyToken,
  requireTravelTenant,
  requireAnyPermission([
    { module: "trips", action: "update" },
    { module: "roles", action: "read" },
  ]),
  async (req, res) => {
    try {
      const teacherId = Number(req.params.teacherId);
      if (!Number.isInteger(teacherId) || teacherId <= 0) {
        return res.status(400).json({ error: "teacherId must be a positive integer", code: "INVALID_TEACHER_ID" });
      }

      const teacher = await prisma.contact.findFirst({
        where: {
          id: teacherId,
          tenantId: req.travelTenant.id,
          subBrand: "tmc",
          portalRole: "TEACHER",
          deletedAt: null,
        },
        select: { id: true, name: true, email: true, phone: true },
      });
      if (!teacher) {
        return res.status(404).json({ error: "TMC teacher not found", code: "TEACHER_NOT_FOUND" });
      }

      const trips = await prisma.tmcTrip.findMany({
        where: {
          tenantId: req.travelTenant.id,
          teacherContactId: teacher.id,
          status: { not: "cancelled" },
        },
        orderBy: [{ departDate: "asc" }, { id: "asc" }],
        select: {
          id: true,
          tripCode: true,
          destination: true,
          tripType: true,
          departDate: true,
          returnDate: true,
          status: true,
          landingPage: { select: { id: true, title: true, status: true } },
        },
      });

      const tripIds = trips.map((trip) => trip.id);
      if (tripIds.length === 0) {
        return res.json({ teacher, trips: [] });
      }

      // A parent portal registration is recorded in TmcParentTrip after the
      // parent completes sign-up through the trip-specific portal link. Keep
      // this count independent from TripParticipant rows: one parent can
      // register multiple students, and a participant can exist before the
      // parent creates portal credentials.
      const [participants, parentLinks] = await Promise.all([
        prisma.tripParticipant.findMany({
        // The parent TmcTrip query is tenant-scoped above; TripParticipant
        // carries tripId but has no tenantId column of its own.
        // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic
        where: { tripId: { in: tripIds } },
        orderBy: { id: "asc" },
        select: {
          id: true,
          tripId: true,
          fullName: true,
          applicationStatus: true,
          parentName: true,
          parentEmail: true,
          parentPhone: true,
          consentCapturedAt: true,
          createdAt: true,
          pendingRegistration: {
            select: {
              studentName: true,
              studentDob: true,
              studentSchool: true,
              studentClass: true,
              studentGender: true,
              parentName: true,
              parentEmail: true,
              parentPhone: true,
              parentRelation: true,
            },
          },
        },
        }),
        prisma.tmcParentTrip.findMany({
          where: {
            tenantId: req.travelTenant.id,
            teacherContactId: teacher.id,
            tripId: { in: tripIds },
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tripId: true,
            createdAt: true,
            parent: { select: { id: true, name: true, email: true, phone: true } },
          },
        }),
      ]);

      const participantsByTrip = new Map();
      participants.forEach((participant) => {
        const current = participantsByTrip.get(participant.tripId) || [];
        const registration = participant.pendingRegistration || {};
        const normalizedParticipant = {
          ...participant,
          fullName: participant.fullName || registration.studentName || null,
          parentName: participant.parentName || registration.parentName || null,
          parentEmail: participant.parentEmail || registration.parentEmail || null,
          parentPhone: participant.parentPhone || registration.parentPhone || null,
          studentDob: registration.studentDob || null,
          studentSchool: registration.studentSchool || null,
          studentClass: registration.studentClass || null,
          studentGender: registration.studentGender || null,
          parentRelation: registration.parentRelation || null,
        };
        current.push(normalizedParticipant);
        participantsByTrip.set(participant.tripId, current);
      });
      const parentLinksByTrip = new Map();
      parentLinks.forEach((link) => {
        const current = parentLinksByTrip.get(link.tripId) || [];
        current.push(link);
        parentLinksByTrip.set(link.tripId, current);
      });

      const baseUrl = getFrontendUrlFromRequest(req);
      const tripDetails = trips.map((trip) => {
        const tripParticipants = participantsByTrip.get(trip.id) || [];
        const tripParentRegistrations = (parentLinksByTrip.get(trip.id) || []).map((link) => ({
          id: link.id,
          name: link.parent?.name || "Unnamed parent",
          email: link.parent?.email || null,
          phone: link.parent?.phone || null,
          createdAt: link.createdAt,
        }));
        return {
          ...trip,
          parentPortalLink: buildTmcParentRegistrationUrl({
            baseUrl,
            tenantId: req.travelTenant.id,
            teacherContactId: teacher.id,
            tripId: trip.id,
          }),
          participants: tripParticipants,
          parentRegistrations: tripParentRegistrations,
          participantCount: tripParticipants.length,
          parentCount: tripParentRegistrations.length,
        };
      });

      return res.json({ teacher, trips: tripDetails });
    } catch (err) {
      console.error("[tmc-portal][staff/teacher-overview]", err);
      return res.status(500).json({ error: "Failed to load teacher trip details" });
    }
  },
);

async function loadTeacherTrip(req, res) {
  const tripId = Number(req.params.tripId);
  if (!Number.isInteger(tripId) || tripId <= 0) {
    res.status(400).json({ error: "tripId must be a positive integer", code: "INVALID_TRIP_ID" });
    return null;
  }
  const trip = await prisma.tmcTrip.findFirst({
    where: {
      id: tripId,
      tenantId: Number(req.portal.tenantId),
      teacherContactId: Number(req.tmcContact.id),
    },
    select: {
      id: true, tripCode: true, destination: true, tripType: true,
      departDate: true, returnDate: true, status: true, teacherContactId: true,
      _count: {
        select: {
          participants: true,
          // Converted/rejected registration drafts are historical records.
          // Their students are either already in TripParticipant or were not
          // accepted, so they must not inflate the teacher-facing count.
          pendingRegistrations: {
            where: {
              status: { not: "REJECTED" },
              convertedToParticipantId: null,
            },
          },
        },
      },
    },
  });
  if (!trip) {
    res.status(404).json({ error: "Trip not found for this teacher", code: "TRIP_NOT_ASSIGNED" });
    return null;
  }
  return trip;
}

// GET /api/portal/tmc/registration-context?token=...
// Public entry point for the TMC registration links. It stores only the
// signed token in an HttpOnly cookie, then the shared registration form can
// submit normally without adding TMC-specific fields.
router.get("/registration-context", async (req, res) => {
  let context = verifyTmcRegistrationToken(req.query?.token);
  if (!context && req.query?.registrationType === "TEACHER" && !req.query?.token) {
    // The teacher URL is permanent and shared by all TMC teachers. The short
    // lived signed cookie only carries the route context while the user fills
    // out the shared registration form; it is not an expiring URL/invitation.
    const token = jwt.sign(
      { type: "TMC_REGISTRATION", registrationType: "TEACHER", subBrand: "tmc" },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    context = verifyTmcRegistrationToken(token);
    setTmcRegistrationContext(res, token, 60 * 60 * 1000);
    return res.json({ ok: true, registrationType: "TEACHER", next: "/tmc/teacher-portal" });
  }
  if (!context) return res.status(400).json({ error: "Invalid or expired TMC registration link", code: "INVALID_REGISTRATION_LINK" });
  const tenant = context.tenantId
    ? await prisma.tenant.findUnique({ where: { id: context.tenantId }, select: { id: true, vertical: true, slug: true } })
    : null;
  if (context.tenantId && (!tenant || tenant.vertical !== "travel")) {
    return res.status(400).json({ error: "This registration link is not available", code: "INVALID_REGISTRATION_TENANT" });
  }
  if (context.registrationType === "PARENT") {
    const teacher = await prisma.contact.findFirst({
      where: { id: context.teacherContactId, tenantId: context.tenantId, subBrand: "tmc", portalRole: "TEACHER", deletedAt: null },
      select: { id: true },
    });
    const trip = await prisma.tmcTrip.findFirst({
      where: { id: context.tripId, tenantId: context.tenantId, teacherContactId: context.teacherContactId },
      select: { id: true },
    });
    if (!teacher || !trip) return res.status(400).json({ error: "This parent registration link is no longer valid", code: "REGISTRATION_LINK_REVOKED" });
  }
  setTmcRegistrationContext(res, String(req.query.token));
  res.json({ ok: true, registrationType: context.registrationType, tenantSlug: tenant?.slug || null, next: context.registrationType === "TEACHER" ? "/tmc/teacher-portal" : "/tmc/parent-portal" });
});

router.get("/teacher/me", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  res.json({
    contact: req.tmcContact,
    tenant: req.tmcTenant,
    portalRole: "TEACHER",
    subBrand: "tmc",
  });
});

// The TMC diagnostic submit/report engine already exists in the travel
// diagnostic routes. This endpoint gives a teacher an authenticated history
// surface for reports submitted from this portal. New dynamic-form reports
// use the same signed report slug as the customer flow; older rows without a
// public-form token retain their legacy report link.
router.get("/teacher/diagnostics", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const diagnostics = await prisma.travelDiagnostic.findMany({
      where: {
        tenantId: Number(req.portal.tenantId),
        subBrand: "tmc",
        contactId: Number(req.tmcContact.id),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        engineState: true,
        createdAt: true,
        curriculumFitJson: true,
        reportSlugToken: true,
      },
    });
    res.json({
      diagnostics: diagnostics.map((diagnostic) => ({
        id: diagnostic.id,
        engineState: diagnostic.engineState,
        createdAt: diagnostic.createdAt,
        reportUrl: diagnostic.reportSlugToken
          ? `/diagnostic-form/${encodeURIComponent(req.tmcTenant.slug)}/tmc/report/${diagnostic.id}-${diagnostic.reportSlugToken}`
          : `/p/tmc/report/${diagnostic.id}-teacher`,
        reportPdfUrl: `/api/travel/diagnostics/${diagnostic.id}/readiness-report.pdf`,
        hasCurriculumRecommendations: Boolean(diagnostic.curriculumFitJson),
      })),
    });
  } catch (err) {
    console.error("[tmc-portal][teacher/diagnostics]", err);
    res.status(500).json({ error: "Failed to load diagnostic reports" });
  }
});

router.get("/teacher/trips", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const trips = await prisma.tmcTrip.findMany({
      where: { tenantId: Number(req.portal.tenantId), teacherContactId: Number(req.tmcContact.id) },
      orderBy: [{ departDate: "asc" }, { id: "asc" }],
      select: {
        id: true, tripCode: true, destination: true, tripType: true,
        departDate: true, returnDate: true, status: true,
        _count: {
          select: {
            participants: true,
            // A converted draft is retained for audit history and points to
            // its TripParticipant. Count only registrations still awaiting
            // conversion so the same student is not counted twice.
            pendingRegistrations: {
              where: {
                status: { not: "REJECTED" },
                convertedToParticipantId: null,
              },
            },
          },
        },
      },
    });
    res.json({ trips });
  } catch (err) {
    console.error("[tmc-portal][teacher/trips]", err);
    res.status(500).json({ error: "Failed to load assigned trips" });
  }
});

router.get("/teacher/trips/:tripId/registrations", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const trip = await loadTeacherTrip(req, res);
    if (!trip) return;
    const [registrations, parentLinks] = await Promise.all([
      prisma.pendingTripRegistration.findMany({
        where: {
          tenantId: Number(req.portal.tenantId),
          tripId: trip.id,
          status: { not: "REJECTED" },
          convertedToParticipantId: null,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, tripId: true, studentName: true, studentDob: true,
          studentSchool: true, studentClass: true, studentGender: true,
          parentName: true, parentEmail: true, parentPhone: true,
          parentRelation: true, status: true, otpVerified: true,
          convertedToParticipantId: true, createdAt: true, updatedAt: true,
        },
      }),
      prisma.tmcParentTrip.findMany({
        where: {
          tenantId: Number(req.portal.tenantId),
          tripId: trip.id,
          teacherContactId: Number(req.tmcContact.id),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, tripId: true, createdAt: true,
          parent: { select: { id: true, name: true, email: true, phone: true } },
        },
      }),
    ]);
    res.json({ trip, registrations, parentLinks });
  } catch (err) {
    console.error("[tmc-portal][teacher/registrations]", err);
    res.status(500).json({ error: "Failed to load registrations" });
  }
});

router.get("/teacher/trips/:tripId/participants", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const trip = await loadTeacherTrip(req, res);
    if (!trip) return;
    // loadTeacherTrip has already tenant-scoped the parent TmcTrip; the
    // participant model carries tripId rather than its own tenantId.
    const participants = await prisma.tripParticipant.findMany({
      // The parent TmcTrip was tenant-scoped by loadTeacherTrip; TripParticipant
      // has no tenantId column of its own.
      // eslint-disable-next-line gbscrm/tenant-scope-finder-heuristic
      where: { tripId: trip.id },
      orderBy: { id: "asc" },
      select: {
        id: true, tripId: true, fullName: true, applicationStatus: true,
        parentName: true, parentEmail: true, parentPhone: true,
        consentCapturedAt: true, createdAt: true,
      },
    });
    res.json({ trip, participants });
  } catch (err) {
    console.error("[tmc-portal][teacher/participants]", err);
    res.status(500).json({ error: "Failed to load participants" });
  }
});

// Teachers can view the published landing page for trips assigned to them.
// This endpoint intentionally exposes no builder fields or write operation;
// loadTeacherTrip enforces both tenant and teacher ownership first.
router.get("/teacher/trips/:tripId/landing-page", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const trip = await loadTeacherTrip(req, res);
    if (!trip) return;
    const landingPage = await prisma.landingPage.findFirst({
      where: {
        tenantId: Number(req.portal.tenantId),
        tripId: trip.id,
        status: "PUBLISHED",
      },
      select: {
        id: true,
        tripId: true,
        slug: true,
        title: true,
        status: true,
        destination: true,
        publishedAt: true,
        updatedAt: true,
      },
    });
    if (!landingPage) {
      return res.status(404).json({
        error: "No published landing page is linked to this trip",
        code: "NO_PUBLISHED_LANDING_PAGE",
      });
    }
    res.json({
      landingPage,
      publicUrl: buildPublishedTripUrl(landingPage),
    });
  } catch (err) {
    console.error("[tmc-portal][teacher/landing-page]", err);
    res.status(500).json({ error: "Failed to load the trip landing page" });
  }
});

router.post("/teacher/trips/:tripId/parent-link", verifyPortalToken, requireTmcTenant, requireTeacher, async (req, res) => {
  try {
    const trip = await loadTeacherTrip(req, res);
    if (!trip) return;
    const baseUrl = process.env.FRONTEND_URL || process.env.PUBLIC_BASE_URL || "http://localhost:5173";
    res.status(201).json({
      link: buildTmcParentRegistrationUrl({
        baseUrl,
        tenantId: req.portal.tenantId,
        teacherContactId: req.tmcContact.id,
        tripId: trip.id,
      }),
      linkType: "trip-specific",
      trip: { id: trip.id, tripCode: trip.tripCode, destination: trip.destination },
    });
  } catch (err) {
    console.error("[tmc-portal][parent-link]", err);
    res.status(500).json({ error: "Failed to generate parent registration link" });
  }
});

router.get("/parent/me", verifyPortalToken, requireTmcTenant, requireParent, async (req, res) => {
  res.json({ contact: req.tmcContact, portalRole: "PARENT", subBrand: "tmc" });
});

router.get("/parent/trips", verifyPortalToken, requireTmcTenant, requireParent, async (req, res) => {
  try {
    const email = String(req.tmcContact.email || "").trim().toLowerCase();
    const [participants, registrations, parentLinks] = await Promise.all([
      prisma.tripParticipant.findMany({
        where: { parentEmail: email, trip: { tenantId: Number(req.portal.tenantId) } },
        orderBy: { id: "desc" },
        select: { id: true, tripId: true, fullName: true, applicationStatus: true, trip: { select: { id: true, tripCode: true, destination: true, departDate: true, returnDate: true, status: true } } },
      }),
      prisma.pendingTripRegistration.findMany({
        where: { tenantId: Number(req.portal.tenantId), parentEmail: email, status: { not: "REJECTED" } },
        orderBy: { id: "desc" },
        select: { id: true, tripId: true, studentName: true, status: true, createdAt: true, trip: { select: { id: true, tripCode: true, destination: true, departDate: true, returnDate: true, status: true } } },
      }),
      prisma.tmcParentTrip.findMany({
        where: { tenantId: Number(req.portal.tenantId), parentContactId: Number(req.tmcContact.id) },
        orderBy: { createdAt: "desc" },
        select: {
          id: true, tripId: true, createdAt: true,
          teacher: { select: { id: true, name: true, email: true } },
          trip: {
            select: {
              id: true, tripCode: true, destination: true, departDate: true, returnDate: true, status: true,
              landingPage: { select: { id: true, slug: true, title: true, status: true } },
            },
          },
        },
      }),
    ]);
    const linkedTrips = parentLinks.map((row) => ({
      ...row,
      landingUrl: buildPublishedTripUrl(row.trip?.landingPage),
    }));
    const teacherContactIds = [...new Set(parentLinks.map((row) => row.teacher?.id).filter(Boolean))];
    const assignedTrips = teacherContactIds.length
      ? await prisma.tmcTrip.findMany({
          where: {
            tenantId: Number(req.portal.tenantId),
            teacherContactId: { in: teacherContactIds },
            status: { not: "cancelled" },
          },
          orderBy: [{ departDate: "asc" }, { id: "asc" }],
          select: {
            id: true, tripCode: true, destination: true, tripType: true,
            departDate: true, returnDate: true, status: true,
            teacher: { select: { id: true, name: true, email: true } },
            landingPage: { select: { id: true, slug: true, title: true, status: true } },
          },
        })
      : [];
    const trips = assignedTrips.map((trip) => ({
      ...trip,
      tripId: trip.id,
      landingUrl: buildPublishedTripUrl(trip.landingPage),
    }));
    res.json({ participants, registrations, parentLinks: linkedTrips, trips });
  } catch (err) {
    console.error("[tmc-portal][parent/trips]", err);
    res.status(500).json({ error: "Failed to load parent trips" });
  }
});

module.exports = router;
