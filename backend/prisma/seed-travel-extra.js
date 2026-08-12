/**
 * Travel CRM extra fixtures.
 *
 * Adds supporting dummy data for the travel tenant without wiping the DB:
 * contacts, itineraries, quotes, invoices, suppliers, payables, commissions,
 * brochures, brand profiles, notifications, reviews, and RFU profiles.
 *
 * Run: cd backend && node prisma/seed-travel-extra.js
 */
const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const { PrismaClient, Prisma } = require("@prisma/client");
const bcrypt = require("bcryptjs");

if (!process.env.DATABASE_URL) {
  console.error("Error: DATABASE_URL not set in .env file");
  process.exit(1);
}

const prisma = new PrismaClient();

const now = new Date();
const daysFromNow = (n) => new Date(Date.now() + n * 86400000);
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const dec = (v) => new Prisma.Decimal(String(v));
const json = (v) => JSON.stringify(v);

async function ensureContact(tenantId, spec) {
  const existing = await prisma.contact.findFirst({
    where: { tenantId, email: spec.email },
  });
  if (existing) {
    return existing;
  }
  return prisma.contact.create({
    data: {
      tenantId,
      name: spec.name,
      email: spec.email,
      phone: spec.phone ?? null,
      company: spec.company ?? null,
      title: spec.title ?? null,
      status: spec.status ?? "Lead",
      source: spec.source ?? "Organic",
      subBrand: spec.subBrand ?? null,
      aiScore: spec.aiScore ?? 50,
      firstTouchSource: spec.firstTouchSource ?? spec.source ?? "Organic",
      lastTouchSource: spec.lastTouchSource ?? spec.source ?? "Organic",
      portalPasswordHash: spec.portalPasswordHash ?? null,
    },
  });
}

async function ensureByFindFirst(model, where, data) {
  const existing = await prisma[model].findFirst({ where });
  if (existing) {
    return existing;
  }
  return prisma[model].create({ data });
}

async function main() {
  console.log("[seed-travel-extra] starting...");

  const tenant = await prisma.tenant.findUnique({ where: { slug: "travel-stall" } });
  if (!tenant) {
    throw new Error('Travel tenant "travel-stall" not found. Run seed-travel.js first.');
  }

  const admin = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: "yasin@travelstall.in" } });
  const admin2 = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: "admin@travelstall.demo" } });
  const tmcOps = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: "tmc-ops@travelstall.demo" } });
  const rfuAdvisor = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: "rfu-advisor@travelstall.demo" } });
  const telecaller = await prisma.user.findFirst({ where: { tenantId: tenant.id, email: "telecaller@travelstall.demo" } });

  const contactSpecs = [
    { name: "Maya Fernandez", email: "maya.fernandez@travelstall.demo", status: "Customer", source: "Referral", subBrand: "travelstall", aiScore: 94, title: "Operations Director" },
    { name: "Samir Jain", email: "samir.jain@travelstall.demo", status: "Lead", source: "LinkedIn", subBrand: "tmc", aiScore: 72, title: "School Admin" },
    { name: "Farah Ali", email: "farah.ali@travelstall.demo", status: "Prospect", source: "Conference", subBrand: "rfu", aiScore: 81, title: "Group Coordinator" },
    { name: "Kevin Lee", email: "kevin.lee@travelstall.demo", status: "Lead", source: "Webinar", subBrand: "visasure", aiScore: 68, title: "Consultant" },
    { name: "Nour Hassan", email: "nour.hassan@travelstall.demo", status: "Customer", source: "Referral", subBrand: "travelstall", aiScore: 90, title: "Marketing Lead" },
    { name: "Elaine Nguyen", email: "elaine.nguyen@travelstall.demo", status: "Prospect", source: "Organic", subBrand: "travelstall", aiScore: 77, title: "Product Manager" },
    { name: "Omar Sheikh", email: "omar.sheikh@travelstall.demo", status: "Lead", source: "WhatsApp", subBrand: "rfu", aiScore: 64, title: "Pilgrim Coordinator" },
    { name: "Rita Dsouza", email: "rita.dsouza@travelstall.demo", status: "Customer", source: "Partner", subBrand: "visasure", aiScore: 85, title: "HR Lead" },
    { name: "Imran Chaudhary", email: "imran.chaudhary@travelstall.demo", status: "Lead", source: "Organic", subBrand: "tmc", aiScore: 61, title: "Principal" },
    { name: "Zara Khan", email: "zara.khan@travelstall.demo", status: "Prospect", source: "Instagram", subBrand: "travelstall", aiScore: 74, title: "Founder" },
  ];

  const contacts = [];
  for (const spec of contactSpecs) {
    contacts.push(await ensureContact(tenant.id, spec));
  }

  const contactByEmail = Object.fromEntries(contacts.map((c) => [c.email, c]));

  const rfuContact = contactByEmail["farah.ali@travelstall.demo"];
  const visaContact = contactByEmail["rita.dsouza@travelstall.demo"];
  const tmcContact = contactByEmail["samir.jain@travelstall.demo"];
  const travelContact = contactByEmail["maya.fernandez@travelstall.demo"];
  const travelContact2 = contactByEmail["nour.hassan@travelstall.demo"];

  const sightseeingSpecs = [
    { destinationName: "Bali", name: "Tegalalang Rice Terraces", category: "nature", subBrand: "travelstall", durationMinutes: 90, priceReferenceMinor: 1200, notes: "Good at sunrise for families and honeymooners." },
    { destinationName: "Dubai", name: "Burj Khalifa At The Top", category: "monument", subBrand: "travelstall", durationMinutes: 120, priceReferenceMinor: 4500, notes: "Use a sunset slot when possible." },
    { destinationName: "Makkah", name: "Masjid al-Haram Ziyarat", category: "religious", subBrand: "rfu", durationMinutes: 180, priceReferenceMinor: 0, notes: "Usually paired with Umrah logistics." },
    { destinationName: "Madinah", name: "Al-Baqi and Ziyarat Circuit", category: "religious", subBrand: "rfu", durationMinutes: 150, priceReferenceMinor: 0, notes: "Best scheduled after Dhuhr." },
    { destinationName: "Paris", name: "Eiffel Tower Summit", category: "monument", subBrand: "travelstall", durationMinutes: 120, priceReferenceMinor: 3200, notes: "Works well for Europe-family bundles." },
    { destinationName: "Jaipur", name: "Amber Fort Evening Experience", category: "historical", subBrand: "tmc", durationMinutes: 150, priceReferenceMinor: 900, notes: "Good add-on for school tours." },
  ];

  for (const spec of sightseeingSpecs) {
    await ensureByFindFirst(
      "travelSightseeing",
      { tenantId: tenant.id, destinationName: spec.destinationName, name: spec.name },
      {
        tenantId: tenant.id,
        destinationName: spec.destinationName,
        name: spec.name,
        description: `${spec.name} for ${spec.destinationName} demo itinerary planning.`,
        imageUrl: null,
        durationMinutes: spec.durationMinutes,
        priceReferenceMinor: spec.priceReferenceMinor,
        currency: "INR",
        category: spec.category,
        subBrand: spec.subBrand,
        notes: spec.notes,
        isActive: true,
      },
    );
  }

  const quoteTemplates = [
    {
      name: "Bali Honeymoon 6D Template",
      subBrand: "travelstall",
      category: "Honeymoon",
      linesJson: json([
        { lineType: "flight", description: "Delhi to Denpasar return flights", quantity: 2, unitPrice: 55000, currency: "INR", sortOrder: 0 },
        { lineType: "hotel", description: "Ubud pool villa and Seminyak suite", quantity: 5, unitPrice: 18000, currency: "INR", sortOrder: 1 },
        { lineType: "service", description: "Couples spa, sunset cruise, and transfers", quantity: 1, unitPrice: 22000, currency: "INR", sortOrder: 2 },
      ]),
    },
    {
      name: "RFU Umrah 7D Template",
      subBrand: "rfu",
      category: "Religious",
      linesJson: json([
        { lineType: "flight", description: "Delhi to Jeddah return flights", quantity: 1, unitPrice: 42000, currency: "INR", sortOrder: 0 },
        { lineType: "hotel", description: "Makkah hotel stay", quantity: 6, unitPrice: 15500, currency: "INR", sortOrder: 1 },
        { lineType: "service", description: "Ziyarat tours and ground transfers", quantity: 1, unitPrice: 18000, currency: "INR", sortOrder: 2 },
      ]),
    },
    {
      name: "Visa Sure B1/B2 Template",
      subBrand: "visasure",
      category: "Visa",
      linesJson: json([
        { lineType: "service", description: "Eligibility review and DS-160 support", quantity: 1, unitPrice: 7500, currency: "INR", sortOrder: 0 },
        { lineType: "service", description: "Mock interview and document review", quantity: 1, unitPrice: 5000, currency: "INR", sortOrder: 1 },
      ]),
    },
  ];

  for (const spec of quoteTemplates) {
    await ensureByFindFirst(
      "travelQuoteTemplate",
      { tenantId: tenant.id, name: spec.name },
      {
        tenantId: tenant.id,
        name: spec.name,
        description: `${spec.name} demo template`,
        subBrand: spec.subBrand,
        category: spec.category,
        currency: "INR",
        linesJson: spec.linesJson,
        isActive: true,
      },
    );
  }

  const itineraries = [];
  const itinerarySpecs = [
    {
      subBrand: "travelstall",
      contact: travelContact,
      status: "accepted",
      destination: "Bali",
      productTier: "premium",
      totalAmount: dec("238000.00"),
      pax: 2,
      startDate: daysFromNow(28),
      endDate: daysFromNow(33),
      shareToken: "travelstall-bali-accepted",
      clonedFromTemplateId: null,
    },
    {
      subBrand: "travelstall",
      contact: travelContact2,
      status: "advance_paid",
      destination: "Dubai",
      productTier: "primary",
      totalAmount: dec("128000.00"),
      pax: 4,
      startDate: daysFromNow(18),
      endDate: daysFromNow(22),
      shareToken: "travelstall-dubai-advance",
      clonedFromTemplateId: null,
    },
    {
      subBrand: "rfu",
      contact: rfuContact,
      status: "sent",
      destination: "Makkah",
      productTier: "premium",
      totalAmount: dec("185000.00"),
      pax: 3,
      startDate: daysFromNow(40),
      endDate: daysFromNow(47),
      shareToken: "rfu-makkah-sent",
      clonedFromTemplateId: null,
    },
    {
      subBrand: "tmc",
      contact: tmcContact,
      status: "draft",
      destination: "Jaipur + Agra",
      productTier: null,
      totalAmount: dec("96000.00"),
      pax: 40,
      startDate: daysFromNow(14),
      endDate: daysFromNow(18),
      shareToken: "tmc-jaipur-draft",
      clonedFromTemplateId: null,
    },
    {
      subBrand: "visasure",
      contact: visaContact,
      status: "revised",
      destination: "United States",
      productTier: "primary",
      totalAmount: dec("18500.00"),
      pax: 1,
      startDate: daysFromNow(9),
      endDate: daysFromNow(12),
      shareToken: "visasure-us-revised",
      clonedFromTemplateId: null,
    },
  ];

  for (const spec of itinerarySpecs) {
    const existing = await prisma.itinerary.findFirst({
      where: {
        tenantId: tenant.id,
        subBrand: spec.subBrand,
        destination: spec.destination,
        contactId: spec.contact.id,
      },
    });
    if (existing) {
      itineraries.push(existing);
      continue;
    }
    const row = await prisma.itinerary.create({
      data: {
        tenantId: tenant.id,
        subBrand: spec.subBrand,
        contactId: spec.contact.id,
        status: spec.status,
        version: 1,
        productTier: spec.productTier,
        destination: spec.destination,
        startDate: spec.startDate,
        endDate: spec.endDate,
        pricingJson: json({ hero: spec.destination, demo: true }),
        totalAmount: spec.totalAmount,
        currency: "INR",
        pax: spec.pax,
        shareToken: spec.shareToken,
        draftSummary: `${spec.destination} demo itinerary for ${spec.subBrand}`,
        clonedFromTemplateId: spec.clonedFromTemplateId,
      },
    });
    itineraries.push(row);
  }

  const supplierSpecs = [
    {
      subBrand: "travelstall",
      name: "SkyHigh Airways",
      supplierCategory: "flight",
      contactPerson: "Arjun Mehta",
      email: "ops@skyhighairways.demo",
      phone: "+91-90000-10001",
      commissionPercent: dec("5.50"),
      paymentTermsKind: "net",
      paymentTermsDays: 15,
      creditLimit: dec("1500000.00"),
      notes: "Preferred airline for outbound leisure itineraries.",
    },
    {
      subBrand: "travelstall",
      name: "Grand Ubud Villas",
      supplierCategory: "hotel",
      contactPerson: "Wayan Sari",
      email: "reservations@grandubud.demo",
      phone: "+62-800-0002",
      commissionPercent: dec("12.00"),
      paymentTermsKind: "net",
      paymentTermsDays: 30,
      creditLimit: dec("900000.00"),
      notes: "Villa inventory for family and honeymoon trips.",
    },
    {
      subBrand: "travelstall",
      name: "Desert Wheels Transport",
      supplierCategory: "transport",
      contactPerson: "Adeel Khan",
      email: "bookings@desertwheels.demo",
      phone: "+971-500-0003",
      commissionPercent: dec("8.00"),
      paymentTermsKind: "on_arrival",
      paymentTermsDays: null,
      creditLimit: dec("350000.00"),
      notes: "Dubai transfers and desert safari fleet.",
    },
    {
      subBrand: "rfu",
      name: "Makkah Care Services",
      supplierCategory: "other",
      contactPerson: "Faisal Rahman",
      email: "hello@makkahcare.demo",
      phone: "+966-500-0004",
      commissionPercent: dec("10.00"),
      paymentTermsKind: "prepay",
      paymentTermsDays: null,
      creditLimit: dec("500000.00"),
      notes: "Umrah ground handling and pilgrimage coordination.",
    },
    {
      subBrand: "visasure",
      name: "VisaSphere Consulting",
      supplierCategory: "visa-consul",
      contactPerson: "Neha Kapoor",
      email: "support@visasphere.demo",
      phone: "+91-90000-10005",
      commissionPercent: dec("18.00"),
      paymentTermsKind: "net",
      paymentTermsDays: 10,
      creditLimit: dec("250000.00"),
      notes: "Document processing and interview prep partner.",
    },
  ];

  const suppliers = [];
  for (const spec of supplierSpecs) {
    const existing = await prisma.travelSupplier.findFirst({
      where: { tenantId: tenant.id, subBrand: spec.subBrand, name: spec.name },
    });
    if (existing) {
      suppliers.push(existing);
      continue;
    }
    const row = await prisma.travelSupplier.create({
      data: {
        tenantId: tenant.id,
        subBrand: spec.subBrand,
        name: spec.name,
        contactPerson: spec.contactPerson,
        phone: spec.phone,
        email: spec.email,
        supplierCategory: spec.supplierCategory,
        status: "active",
        paymentTermsKind: spec.paymentTermsKind,
        paymentTermsDays: spec.paymentTermsDays,
        creditLimit: spec.creditLimit,
        creditCurrency: "INR",
        commissionPercent: spec.commissionPercent,
        notes: spec.notes,
      },
    });
    suppliers.push(row);
  }

  const supplierByName = Object.fromEntries(suppliers.map((s) => [s.name, s]));

  for (const supplier of suppliers) {
    const kyc = await prisma.travelSupplierKyc.findUnique({ where: { supplierId: supplier.id } }).catch(() => null);
    if (!kyc) {
      const createdKyc = await prisma.travelSupplierKyc.create({
        data: {
          tenantId: tenant.id,
          supplierId: supplier.id,
          status: supplier.supplierCategory === "visa-consul" ? "submitted" : "verified",
          panNumber: `PAN-${supplier.id.toString().padStart(4, "0")}`,
          gstinVerified: true,
          bankAccountVerified: true,
          iataNumber: supplier.supplierCategory === "flight" ? `IATA-${supplier.id}` : null,
          iataExpiry: supplier.supplierCategory === "flight" ? daysFromNow(365) : null,
          tafiNumber: supplier.supplierCategory === "visa-consul" ? `TAFI-${supplier.id}` : null,
          contractSigned: true,
          contractSignedAt: daysAgo(30),
          contractDocumentUrl: `/travel-fixtures/contracts/${supplier.id}.pdf`,
          submittedAt: daysAgo(32),
          verifiedAt: supplier.supplierCategory === "visa-consul" ? null : daysAgo(28),
          verifiedBy: admin?.id ?? null,
          notes: `${supplier.name} demo KYC record`,
        },
      });

      const checklistItems = [
        { itemKey: "pan_card", itemLabel: "PAN Card", required: true, status: "verified", sortOrder: 0 },
        { itemKey: "gstin_cert", itemLabel: "GST Registration", required: true, status: "verified", sortOrder: 1 },
        { itemKey: "bank_proof", itemLabel: "Bank Proof", required: true, status: "verified", sortOrder: 2 },
        { itemKey: "contract", itemLabel: "Signed Contract", required: true, status: "verified", sortOrder: 3 },
        { itemKey: "insurance", itemLabel: "Insurance", required: supplier.supplierCategory !== "visa-consul", status: supplier.supplierCategory === "visa-consul" ? "pending" : "verified", sortOrder: 4 },
      ];
      if (supplier.supplierCategory === "flight") {
        checklistItems.push({ itemKey: "iata_cert", itemLabel: "IATA Certificate", required: true, status: "verified", sortOrder: 5 });
      }
      for (const item of checklistItems) {
        await prisma.travelSupplierKycChecklistItem.create({
          data: {
            tenantId: tenant.id,
            kycId: createdKyc.id,
            itemKey: item.itemKey,
            itemLabel: item.itemLabel,
            required: item.required,
            status: item.status,
            documentUrl: `/travel-fixtures/kyc/${supplier.id}/${item.itemKey}.pdf`,
            submittedAt: daysAgo(31),
            verifiedAt: item.status === "verified" ? daysAgo(28) : null,
            verifiedBy: item.status === "verified" ? admin?.id ?? null : null,
            sortOrder: item.sortOrder,
          },
        });
      }
    }
  }

  const poSpecs = [
    {
      supplier: supplierByName["SkyHigh Airways"],
      poNumber: "TPO-2026-0001",
      status: "acknowledged",
      subtotal: dec("98000.00"),
      taxAmount: dec("17640.00"),
      totalAmount: dec("115640.00"),
      lines: [
        { lineType: "service", description: "Bali honeymoon return fare", quantity: dec("2"), unitPrice: dec("49000.00"), lineTotal: dec("98000.00"), pnr: "BALI01", bookingRef: "SKY-BALI-001" },
      ],
    },
    {
      supplier: supplierByName["Grand Ubud Villas"],
      poNumber: "TPO-2026-0002",
      status: "fulfilled",
      subtotal: dec("72000.00"),
      taxAmount: dec("12960.00"),
      totalAmount: dec("84960.00"),
      lines: [
        { lineType: "service", description: "Ubud villa block", quantity: dec("4"), unitPrice: dec("18000.00"), lineTotal: dec("72000.00"), pnr: "UBUD02", bookingRef: "UBUD-VILLA-02" },
      ],
    },
    {
      supplier: supplierByName["Desert Wheels Transport"],
      poNumber: "TPO-2026-0003",
      status: "sent",
      subtotal: dec("34000.00"),
      taxAmount: dec("6120.00"),
      totalAmount: dec("40120.00"),
      lines: [
        { lineType: "service", description: "Dubai airport transfers and safari vans", quantity: dec("1"), unitPrice: dec("34000.00"), lineTotal: dec("34000.00"), pnr: "DXB03", bookingRef: "DESERT-003" },
      ],
    },
  ];

  const purchaseOrders = [];
  for (const spec of poSpecs) {
    let po = await prisma.travelPurchaseOrder.findFirst({ where: { tenantId: tenant.id, poNumber: spec.poNumber } });
    if (!po) {
      po = await prisma.travelPurchaseOrder.create({
        data: {
          tenantId: tenant.id,
          supplierId: spec.supplier.id,
          poNumber: spec.poNumber,
          status: spec.status,
          currency: "INR",
          subtotal: spec.subtotal,
          taxAmount: spec.taxAmount,
          totalAmount: spec.totalAmount,
          notes: `${spec.poNumber} demo purchase order`,
          sentAt: daysAgo(14),
          acknowledgedAt: spec.status === "acknowledged" || spec.status === "fulfilled" ? daysAgo(13) : null,
          fulfilledAt: spec.status === "fulfilled" ? daysAgo(10) : null,
          createdBy: admin?.id ?? null,
        },
      });
      for (const [idx, line] of spec.lines.entries()) {
        await prisma.travelPurchaseOrderLine.create({
          data: {
            tenantId: tenant.id,
            purchaseOrderId: po.id,
            lineType: line.lineType,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
            pnr: line.pnr,
            bookingRef: line.bookingRef,
            sortOrder: idx,
          },
        });
      }
    }
    purchaseOrders.push(po);
  }

  const quoteSpecs = [
    {
      contact: travelContact,
      subBrand: "travelstall",
      status: "Sent",
      totalAmount: dec("238000.00"),
      validUntil: daysFromNow(20),
      tripDate: daysFromNow(28),
      assignedToUserId: tmcOps?.id ?? admin2?.id ?? null,
      lines: [
        { lineType: "flight", description: "Return flights for 2 adults", quantity: 2, unitPrice: dec("54000.00"), amount: dec("108000.00"), sortOrder: 0, supplierId: supplierByName["SkyHigh Airways"].id, hsnSac: "998552", taxPercent: dec("18.00"), dimension: "perPax" },
        { lineType: "hotel", description: "5 nights at Ubud villas", quantity: 5, unitPrice: dec("17600.00"), amount: dec("88000.00"), sortOrder: 1, supplierId: supplierByName["Grand Ubud Villas"].id, hsnSac: "996311", taxPercent: dec("12.00"), dimension: "perRoomPerNight" },
        { lineType: "service", description: "Transfers and honeymoon experiences", quantity: 1, unitPrice: dec("42000.00"), amount: dec("42000.00"), sortOrder: 2, supplierId: supplierByName["Desert Wheels Transport"].id, hsnSac: "998599", taxPercent: dec("18.00"), dimension: "flatRate" },
      ],
    },
    {
      contact: travelContact2,
      subBrand: "travelstall",
      status: "Draft",
      totalAmount: dec("128000.00"),
      validUntil: daysFromNow(12),
      tripDate: daysFromNow(18),
      assignedToUserId: telecaller?.id ?? admin2?.id ?? null,
      lines: [
        { lineType: "hotel", description: "Dubai family hotel package", quantity: 4, unitPrice: dec("19000.00"), amount: dec("76000.00"), sortOrder: 0, supplierId: supplierByName["Grand Ubud Villas"].id, hsnSac: "996311", taxPercent: dec("12.00"), dimension: "perRoomPerNight" },
        { lineType: "service", description: "Safari, transfers, and attraction tickets", quantity: 1, unitPrice: dec("52000.00"), amount: dec("52000.00"), sortOrder: 1, supplierId: supplierByName["Desert Wheels Transport"].id, hsnSac: "998599", taxPercent: dec("18.00"), dimension: "flatRate" },
      ],
    },
    {
      contact: rfuContact,
      subBrand: "rfu",
      status: "Accepted",
      totalAmount: dec("185000.00"),
      validUntil: daysFromNow(40),
      tripDate: daysFromNow(47),
      assignedToUserId: rfuAdvisor?.id ?? admin2?.id ?? null,
      lines: [
        { lineType: "flight", description: "Return flight for pilgrims", quantity: 3, unitPrice: dec("42000.00"), amount: dec("126000.00"), sortOrder: 0, supplierId: supplierByName["SkyHigh Airways"].id, hsnSac: "998552", taxPercent: dec("5.00"), dimension: "perPax" },
        { lineType: "service", description: "Ziyarat, visas, and ground handling", quantity: 1, unitPrice: dec("59000.00"), amount: dec("59000.00"), sortOrder: 1, supplierId: supplierByName["Makkah Care Services"].id, hsnSac: "998599", taxPercent: dec("18.00"), dimension: "flatRate" },
      ],
    },
    {
      contact: visaContact,
      subBrand: "visasure",
      status: "Rejected",
      totalAmount: dec("18500.00"),
      validUntil: daysFromNow(9),
      tripDate: daysFromNow(12),
      assignedToUserId: admin2?.id ?? null,
      lines: [
        { lineType: "service", description: "Document review and mock interview", quantity: 1, unitPrice: dec("18500.00"), amount: dec("18500.00"), sortOrder: 0, supplierId: supplierByName["VisaSphere Consulting"].id, hsnSac: "998599", taxPercent: dec("18.00"), dimension: "flatRate" },
      ],
    },
  ];

  const quotes = [];
  for (const spec of quoteSpecs) {
    let quote = await prisma.travelQuote.findFirst({
      where: { tenantId: tenant.id, subBrand: spec.subBrand, contactId: spec.contact.id },
    });
    if (!quote) {
      quote = await prisma.travelQuote.create({
        data: {
          tenantId: tenant.id,
          subBrand: spec.subBrand,
          contactId: spec.contact.id,
          status: spec.status,
          totalAmount: spec.totalAmount,
          currency: "INR",
          validUntil: spec.validUntil,
          tripDate: spec.tripDate,
          assignedToUserId: spec.assignedToUserId,
          clonedFromQuoteId: null,
          appliedMarkupPercent: spec.subBrand === "travelstall" ? dec("15.00") : dec("10.00"),
          advancePlinkId: null,
          advancePaymentId: null,
        },
      });
      for (const [idx, line] of spec.lines.entries()) {
        await prisma.travelQuoteLine.create({
          data: {
            tenantId: tenant.id,
            quoteId: quote.id,
            lineType: line.lineType,
            description: line.description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            amount: line.amount,
            currency: "INR",
            supplierId: line.supplierId,
            sortOrder: idx,
            hsnSac: line.hsnSac,
            taxPercent: line.taxPercent,
            dimension: line.dimension,
            isAddOn: false,
          },
        });
      }
    }
    quotes.push(quote);
  }

  const invoiceSpecs = [
    {
      contact: travelContact,
      quote: quotes[0],
      itinerary: itineraries[0],
      subBrand: "travelstall",
      invoiceNum: "TINV-2026-1001",
      status: "Issued",
      totalAmount: dec("238000.00"),
      dueDate: daysFromNow(10),
      lines: [
        { lineType: "per_trip", description: "Bali holiday package", quantity: 1, unitPrice: dec("238000.00"), amount: dec("238000.00"), supplierId: supplierByName["Grand Ubud Villas"].id, pnr: "BALI-INV-1", bookingRef: "INV-BALI-001" },
      ],
    },
    {
      contact: travelContact2,
      quote: quotes[1],
      itinerary: itineraries[1],
      subBrand: "travelstall",
      invoiceNum: "TINV-2026-1002",
      status: "Partial",
      totalAmount: dec("128000.00"),
      dueDate: daysFromNow(6),
      paidAt: daysAgo(1),
      lines: [
        { lineType: "per_trip", description: "Dubai family booking", quantity: 1, unitPrice: dec("128000.00"), amount: dec("128000.00"), supplierId: supplierByName["Desert Wheels Transport"].id, pnr: "DXB-INV-2", bookingRef: "INV-DXB-002" },
      ],
    },
    {
      contact: rfuContact,
      quote: quotes[2],
      itinerary: itineraries[2],
      subBrand: "rfu",
      invoiceNum: "TINV-2026-2001",
      status: "Paid",
      totalAmount: dec("185000.00"),
      dueDate: daysAgo(8),
      paidAt: daysAgo(2),
      lines: [
        { lineType: "per_trip", description: "RFU Umrah package", quantity: 1, unitPrice: dec("185000.00"), amount: dec("185000.00"), supplierId: supplierByName["Makkah Care Services"].id, pnr: "RFU-INV-1", bookingRef: "INV-RFU-001" },
      ],
    },
    {
      contact: visaContact,
      quote: quotes[3],
      itinerary: itineraries[4],
      subBrand: "visasure",
      invoiceNum: "TINV-2026-3001",
      status: "Voided",
      totalAmount: dec("18500.00"),
      dueDate: daysAgo(3),
      lines: [
        { lineType: "service", description: "Visa consulting fee", quantity: 1, unitPrice: dec("18500.00"), amount: dec("18500.00"), supplierId: supplierByName["VisaSphere Consulting"].id, pnr: "VISA-INV-1", bookingRef: "INV-VISA-001" },
      ],
    },
  ];

  const invoices = [];
  for (const spec of invoiceSpecs) {
    let invoice = await prisma.travelInvoice.findFirst({
      where: { tenantId: tenant.id, invoiceNum: spec.invoiceNum },
    });
    if (!invoice) {
      invoice = await prisma.travelInvoice.create({
        data: {
          tenantId: tenant.id,
          subBrand: spec.subBrand,
          contactId: spec.contact.id,
          quoteId: spec.quote?.id ?? null,
          itineraryId: spec.itinerary?.id ?? null,
          invoiceNum: spec.invoiceNum,
          status: spec.status,
          totalAmount: spec.totalAmount,
          currency: "INR",
          dueDate: spec.dueDate,
          paidAt: spec.paidAt ?? null,
          tcsAmount: null,
          tcsRate: null,
          tcsExceedingAmount: null,
          tcsAppliedAt: null,
          placeOfSupply: "IN-MH",
          cgstAmount: dec("0"),
          sgstAmount: dec("0"),
          igstAmount: dec("0"),
          cgstPercent: dec("0"),
          sgstPercent: dec("0"),
          igstPercent: dec("0"),
          totalTaxAmount: dec("0"),
          gstComputedAt: daysAgo(1),
          docType: "TaxInvoice",
          cancellationPolicyId: null,
        },
      });
      for (const [idx, line] of spec.lines.entries()) {
        await prisma.travelInvoiceLine.create({
          data: {
            tenantId: tenant.id,
            invoiceId: invoice.id,
            lineType: line.lineType,
            description: line.description,
            quantity: 1,
            unitPrice: line.unitPrice,
            amount: line.amount,
            currency: "INR",
            sortOrder: idx,
            pnr: line.pnr,
            bookingRef: line.bookingRef,
            serviceStartDate: spec.itinerary?.startDate ?? null,
            serviceEndDate: spec.itinerary?.endDate ?? null,
            supplierId: line.supplierId,
            isAddon: false,
            lineCost: line.amount,
            lineSell: line.amount,
            hsnSac: "998552",
            cgstPercent: dec("0"),
            cgstAmount: dec("0"),
            sgstPercent: dec("0"),
            sgstAmount: dec("0"),
            igstPercent: dec("18"),
            igstAmount: dec("0"),
          },
        });
      }
    }
    invoices.push(invoice);
  }

  const payableSpecs = [
    {
      supplier: supplierByName["SkyHigh Airways"],
      poNumber: "TPO-2026-0001",
      description: "Bali return fare settlement",
      amount: dec("98000.00"),
      status: "scheduled",
      dueDate: daysFromNow(12),
      purchaseOrderId: purchaseOrders[0].id,
    },
    {
      supplier: supplierByName["Grand Ubud Villas"],
      poNumber: "TPO-2026-0002",
      description: "Ubud villa block settlement",
      amount: dec("72000.00"),
      status: "paid",
      dueDate: daysAgo(5),
      paidAt: daysAgo(3),
      purchaseOrderId: purchaseOrders[1].id,
      paymentReference: "TRF-UBUD-2026-01",
    },
    {
      supplier: supplierByName["Desert Wheels Transport"],
      poNumber: "TPO-2026-0003",
      description: "Dubai transfers and safari",
      amount: dec("34000.00"),
      status: "pending",
      dueDate: daysFromNow(8),
      purchaseOrderId: purchaseOrders[2].id,
    },
    {
      supplier: supplierByName["Makkah Care Services"],
      poNumber: null,
      description: "Umrah ground handling retainer",
      amount: dec("59000.00"),
      status: "pending",
      dueDate: daysFromNow(18),
      purchaseOrderId: null,
    },
  ];

  const payables = [];
  for (const spec of payableSpecs) {
    let payable = await prisma.travelSupplierPayable.findFirst({
      where: {
        tenantId: tenant.id,
        supplierId: spec.supplier.id,
        description: spec.description,
      },
    });
    if (!payable) {
      payable = await prisma.travelSupplierPayable.create({
        data: {
          tenantId: tenant.id,
          supplierId: spec.supplier.id,
          poNumber: spec.poNumber,
          description: spec.description,
          amount: spec.amount,
          currency: "INR",
          dueDate: spec.dueDate,
          status: spec.status,
          paidAt: spec.paidAt ?? null,
          paymentReference: spec.paymentReference ?? null,
          notes: "Travel demo payable",
          purchaseOrderId: spec.purchaseOrderId,
        },
      });
    }
    payables.push(payable);
  }

  const batch = await ensureByFindFirst(
    "travelSupplierPayableBatch",
    { tenantId: tenant.id, batchNumber: "TPB-2026-0001" },
    {
      tenantId: tenant.id,
      batchNumber: "TPB-2026-0001",
      status: "approved",
      paymentMethod: "bank_transfer",
      bankAccount: "HDFC ****1234",
      totalAmount: dec("170000.00"),
      payableCount: 3,
      scheduledFor: daysFromNow(7),
      approvedBy: admin?.id ?? null,
      approvedAt: daysAgo(2),
      notes: "Demo supplier batch for the travel dashboard.",
      createdBy: admin?.id ?? null,
    },
  );
  for (const payable of payables.slice(0, 3)) {
    await prisma.travelSupplierPayable.update({
      where: { id: payable.id },
      data: { payableBatchId: batch.id },
    }).catch(() => {});
  }

  const rfuProfiles = [
    {
      contact: rfuContact,
      passportNumber: "P1234567",
      passportExpiry: daysFromNow(820),
      visaHistoryJson: json([{ country: "SA", year: 2024, status: "approved" }]),
      frequentFlyerJson: json({ airline: "Saudia", number: "SV-448899" }),
      seatPref: "aisle",
      mealPref: "vegetarian",
      travelStyle: "premium",
      budgetMin: dec("140000.00"),
      budgetMax: dec("220000.00"),
      emergencyContactName: "Ayesha Ali",
      emergencyContactPhone: "+91-90000-20001",
      medicalNotes: "Prefers wheelchair support for long walks.",
      specialAssistance: "Wheelchair on arrival and departure",
      pastComplaintsJson: json([]),
      productTier: "premium",
    },
    {
      contact: contactByEmail["omar.sheikh@travelstall.demo"],
      passportNumber: "P7654321",
      passportExpiry: daysFromNow(640),
      visaHistoryJson: json([{ country: "SA", year: 2023, status: "pending" }]),
      frequentFlyerJson: null,
      seatPref: "window",
      mealPref: "halal",
      travelStyle: "primary",
      budgetMin: dec("90000.00"),
      budgetMax: dec("145000.00"),
      emergencyContactName: "Noor Sheikh",
      emergencyContactPhone: "+91-90000-20002",
      medicalNotes: null,
      specialAssistance: "Family rooming",
      pastComplaintsJson: json([{ issue: "late hotel check-in", year: 2022 }]),
      productTier: "primary",
    },
  ];

  for (const spec of rfuProfiles) {
    await ensureByFindFirst(
      "rfuLeadProfile",
      { contactId: spec.contact.id },
      {
        tenantId: tenant.id,
        contactId: spec.contact.id,
        passportNumber: spec.passportNumber,
        passportExpiry: spec.passportExpiry,
        visaHistoryJson: spec.visaHistoryJson,
        frequentFlyerJson: spec.frequentFlyerJson,
        seatPref: spec.seatPref,
        mealPref: spec.mealPref,
        travelStyle: spec.travelStyle,
        budgetMin: spec.budgetMin,
        budgetMax: spec.budgetMax,
        emergencyContactName: spec.emergencyContactName,
        emergencyContactPhone: spec.emergencyContactPhone,
        medicalNotes: spec.medicalNotes,
        specialAssistance: spec.specialAssistance,
        pastComplaintsJson: spec.pastComplaintsJson,
        productTier: spec.productTier,
      },
    );
  }

  const supplierInvoiceUploadSpecs = [
    {
      supplier: supplierByName["SkyHigh Airways"],
      payable: payables[0],
      filename: "skyhigh-airways-bali-invoice.pdf",
      fileUrl: "/travel-fixtures/supplier-invoices/skyhigh-bali-001.pdf",
      fileMimeType: "application/pdf",
      fileSize: 842113,
      supplierInvoiceNumber: "SHA-INV-2026-0091",
      invoiceDate: daysAgo(4),
      invoiceAmount: dec("98000.00"),
      matchStatus: "matched",
      uploadedBy: admin?.id ?? null,
      matchedBy: admin2?.id ?? null,
      notes: "Matched to Bali payable for the honeymoon package.",
    },
    {
      supplier: supplierByName["Makkah Care Services"],
      payable: payables[3],
      filename: "makkah-care-ground-handling.pdf",
      fileUrl: "/travel-fixtures/supplier-invoices/makkah-care-001.pdf",
      fileMimeType: "application/pdf",
      fileSize: 612248,
      supplierInvoiceNumber: "MCS-INV-2026-0034",
      invoiceDate: daysAgo(3),
      invoiceAmount: dec("59000.00"),
      matchStatus: "unmatched",
      uploadedBy: rfuAdvisor?.id ?? null,
      matchedBy: null,
      notes: "Awaiting settlement confirmation.",
    },
  ];

  for (const spec of supplierInvoiceUploadSpecs) {
    await ensureByFindFirst(
      "travelSupplierInvoiceUpload",
      { tenantId: tenant.id, supplierId: spec.supplier.id, supplierInvoiceNumber: spec.supplierInvoiceNumber },
      {
        tenantId: tenant.id,
        supplierId: spec.supplier.id,
        payableId: spec.payable.id,
        filename: spec.filename,
        fileUrl: spec.fileUrl,
        fileMimeType: spec.fileMimeType,
        fileSize: spec.fileSize,
        supplierInvoiceNumber: spec.supplierInvoiceNumber,
        invoiceDate: spec.invoiceDate,
        invoiceAmount: spec.invoiceAmount,
        currency: "INR",
        matchStatus: spec.matchStatus,
        uploadedBy: spec.uploadedBy,
        uploadedAt: daysAgo(3),
        matchedBy: spec.matchedBy,
        matchedAt: spec.matchedBy ? daysAgo(2) : null,
        notes: spec.notes,
      },
    );
  }

  const invoiceByNum = Object.fromEntries(invoices.map((invoice) => [invoice.invoiceNum, invoice]));

  const commissionSpecs = [
    {
      supplier: supplierByName["SkyHigh Airways"],
      invoice: invoiceByNum["TINV-2026-1001"],
      fiscalYear: "FY2026-27",
      entryType: "accrued",
      commissionPercent: dec("5.50"),
      baseAmount: dec("98000.00"),
      commissionAmount: dec("5390.00"),
      tdsAmount: dec("269.50"),
      netAmount: dec("5120.50"),
      status: "accrued",
    },
    {
      supplier: supplierByName["Grand Ubud Villas"],
      invoice: invoiceByNum["TINV-2026-1002"],
      fiscalYear: "FY2026-27",
      entryType: "settled",
      commissionPercent: dec("12.00"),
      baseAmount: dec("72000.00"),
      commissionAmount: dec("8640.00"),
      tdsAmount: dec("432.00"),
      netAmount: dec("8208.00"),
      status: "settled",
    },
    {
      supplier: supplierByName["VisaSphere Consulting"],
      invoice: invoiceByNum["TINV-2026-3001"],
      fiscalYear: "FY2026-27",
      entryType: "adjustment",
      commissionPercent: dec("18.00"),
      baseAmount: dec("18500.00"),
      commissionAmount: dec("3330.00"),
      tdsAmount: dec("166.50"),
      netAmount: dec("3163.50"),
      status: "adjustment",
    },
  ];

  for (const spec of commissionSpecs) {
    await ensureByFindFirst(
      "travelSupplierCommissionEntry",
      {
        tenantId: tenant.id,
        supplierId: spec.supplier.id,
        fiscalYear: spec.fiscalYear,
        entryType: spec.entryType,
      },
      {
        tenantId: tenant.id,
        supplierId: spec.supplier.id,
        invoiceId: spec.invoice.id,
        fiscalYear: spec.fiscalYear,
        entryType: spec.entryType,
        commissionPercent: spec.commissionPercent,
        baseAmount: spec.baseAmount,
        commissionAmount: spec.commissionAmount,
        currency: "INR",
        tdsAmount: spec.tdsAmount,
        netAmount: spec.netAmount,
        status: spec.status,
        accruedAt: daysAgo(20),
        settledAt: spec.status === "settled" ? daysAgo(5) : null,
        notes: `${spec.supplier.name} demo commission entry`,
        createdBy: admin?.id ?? null,
      },
    );
  }

  const disputeSpec = {
    supplier: supplierByName["Desert Wheels Transport"],
    payable: payables[2],
    invoice: invoiceByNum["TINV-2026-1002"],
    direction: "outbound",
    type: "rate-variance",
    status: "in_review",
    amount: dec("2500.00"),
    description: "Price difference after seasonal transfer surcharge was applied.",
  };
  await ensureByFindFirst(
    "travelSupplierDispute",
    {
      tenantId: tenant.id,
      supplierId: disputeSpec.supplier.id,
      type: disputeSpec.type,
      description: disputeSpec.description,
    },
    {
      tenantId: tenant.id,
      supplierId: disputeSpec.supplier.id,
      payableId: disputeSpec.payable.id,
      invoiceId: disputeSpec.invoice.id,
      direction: disputeSpec.direction,
      type: disputeSpec.type,
      status: disputeSpec.status,
      amount: disputeSpec.amount,
      currency: "INR",
      description: disputeSpec.description,
      evidenceUrls: json(["/travel-fixtures/evidence/variance-1.pdf"]),
      raisedBy: admin2?.id ?? null,
      raisedAt: daysAgo(6),
    },
  );

  const portalNotifications = [
    { contact: travelContact, title: "Bali itinerary updated", message: "Your Bali honeymoon itinerary has been revised with upgraded villa options.", type: "itinerary", link: "/bookings/bali-demo" },
    { contact: travelContact2, title: "Advance payment received", message: "We have recorded your Dubai advance payment and reserved the hotel block.", type: "payment", link: "/bookings/dubai-demo" },
    { contact: rfuContact, title: "Umrah documents pending", message: "Please upload your passport copy and photo for the RFU application.", type: "system", link: "/bookings/umrah-demo" },
    { contact: visaContact, title: "Visa review ready", message: "Your visa review checklist is ready for the next advisor step.", type: "info", link: "/bookings/visa-demo" },
    { contact: contactByEmail["zara.khan@travelstall.demo"], title: "Family holiday brochure", message: "A new family holiday brochure is available for your trip planning.", type: "info", link: "/brochures" },
  ];
  for (const spec of portalNotifications) {
    await ensureByFindFirst(
      "travelPortalNotification",
      { contactId: spec.contact.id, title: spec.title },
      {
        tenantId: tenant.id,
        contactId: spec.contact.id,
        title: spec.title,
        message: spec.message,
        type: spec.type,
        link: spec.link,
        isRead: false,
      },
    );
  }

  const brochureSpecs = [
    {
      runId: "br_travelstall_bali_001",
      sectorKey: "travel",
      styleKey: "family-luxe",
      goal: "Create a luxury Bali family brochure for a 6-day holiday.",
      status: "completed",
      pdfUrl: "/brochure-assets/br_travelstall_bali_001.pdf",
      billedUsd: dec("18.500000"),
      completedAt: daysAgo(2),
      tripId: null,
      itineraryId: itineraries[0].id,
      userId: admin?.id ?? null,
    },
    {
      runId: "br_rfu_umrah_001",
      sectorKey: "travel",
      styleKey: "religious-premium",
      goal: "Create a premium Umrah brochure with ziyarat highlights.",
      status: "completed",
      pdfUrl: "/brochure-assets/br_rfu_umrah_001.pdf",
      billedUsd: dec("17.000000"),
      completedAt: daysAgo(1),
      tripId: null,
      itineraryId: itineraries[2].id,
      userId: rfuAdvisor?.id ?? null,
    },
    {
      runId: "br_travelstall_dubai_001",
      sectorKey: "travel",
      styleKey: "family-modern",
      goal: "Create a bright Dubai family brochure with attraction highlights.",
      status: "running",
      pdfUrl: null,
      billedUsd: null,
      completedAt: null,
      tripId: null,
      itineraryId: itineraries[1].id,
      userId: admin2?.id ?? null,
    },
  ];
  for (const spec of brochureSpecs) {
    await ensureByFindFirst(
      "travelBrochure",
      { runId: spec.runId },
      {
        tenantId: tenant.id,
        userId: spec.userId,
        runId: spec.runId,
        sectorKey: spec.sectorKey,
        styleKey: spec.styleKey,
        goal: spec.goal,
        status: spec.status,
        pdfUrl: spec.pdfUrl,
        billedUsd: spec.billedUsd,
        errorMessage: null,
        tripId: spec.tripId,
        itineraryId: spec.itineraryId,
        brandJson: json({ tenant: tenant.slug, subBrand: "travel" }),
        completedAt: spec.completedAt,
        archivedAt: null,
      },
    );
  }

  const brandProfiles = [
    {
      name: "Travel Stall Default",
      subBrand: "travelstall",
      payload: json({ colors: ["#0f172a", "#0ea5e9"], font: "Inter", tone: "family-friendly" }),
      userId: admin?.id ?? null,
    },
    {
      name: "RFU Default",
      subBrand: "rfu",
      payload: json({ colors: ["#14532d", "#f59e0b"], font: "Inter", tone: "religious-premium" }),
      userId: rfuAdvisor?.id ?? null,
    },
  ];
  for (const spec of brandProfiles) {
    await ensureByFindFirst(
      "travelBrandProfile",
      { tenantId: tenant.id, name: spec.name },
      {
        tenantId: tenant.id,
        userId: spec.userId,
        name: spec.name,
        payload: spec.payload,
      },
    );
  }

  const tripReviewSpecs = [
    {
      itinerary: itineraries[0],
      contact: travelContact,
      token: "review-bali-001",
      status: "submitted",
      overallRating: 5,
      answersJson: json({
        hospitality: 5,
        transport: 5,
        hotels: 5,
        guide: 5,
        value: 4,
      }),
      requestedAt: daysAgo(1),
      submittedAt: daysAgo(1),
    },
    {
      itinerary: itineraries[2],
      contact: rfuContact,
      token: "review-umrah-001",
      status: "requested",
      overallRating: null,
      answersJson: null,
      requestedAt: daysAgo(2),
      submittedAt: null,
    },
  ];
  for (const spec of tripReviewSpecs) {
    await ensureByFindFirst(
      "travelTripReview",
      { itineraryId: spec.itinerary.id },
      {
        tenantId: tenant.id,
        itineraryId: spec.itinerary.id,
        contactId: spec.contact.id,
        token: spec.token,
        status: spec.status,
        overallRating: spec.overallRating,
        answersJson: spec.answersJson,
        requestedAt: spec.requestedAt,
        submittedAt: spec.submittedAt,
      },
    );
  }

  const commissionProfiles = [
    {
      name: "Travel Stall Standard 8%",
      subBrand: "travelstall",
      category: "Family",
      profileType: "flat_percent",
      profileJson: json({ percent: 8, floor: 0, ceiling: 1000000 }),
      releaseMode: "on_booking",
      notes: "Default family holiday commission profile.",
    },
    {
      name: "RFU Premium Ladder",
      subBrand: "rfu",
      category: "Religious",
      profileType: "tiered",
      profileJson: json({ tiers: [{ min: 0, max: 100000, percent: 6 }, { min: 100001, max: 1000000, percent: 9 }] }),
      releaseMode: "on_trip_completion",
      notes: "Higher commission on larger Umrah bookings.",
    },
    {
      name: "Visa Sure Flat Fee",
      subBrand: "visasure",
      category: "Visa",
      profileType: "per_pax_flat",
      profileJson: json({ amountPerPax: 1500, currency: "INR" }),
      releaseMode: "on_booking",
      notes: "Per-applicant consulting revenue.",
    },
    {
      name: "TMC School Trip Hybrid",
      subBrand: "tmc",
      category: "School",
      profileType: "hybrid",
      profileJson: json({ basePercent: 5, perPaxFlat: 250, bonusPercent: 1 }),
      releaseMode: "on_trip_completion",
      notes: "School trip pricing demo profile.",
    },
  ];
  for (const spec of commissionProfiles) {
    await ensureByFindFirst(
      "travelCommissionProfile",
      { tenantId: tenant.id, name: spec.name },
      {
        tenantId: tenant.id,
        name: spec.name,
        subBrand: spec.subBrand,
        category: spec.category,
        agentUserId: null,
        validFrom: daysAgo(30),
        validTo: null,
        releaseMode: spec.releaseMode,
        profileType: spec.profileType,
        profileJson: spec.profileJson,
        isActive: true,
        notes: spec.notes,
      },
    );
  }

  const bulkLeadNames = [
    "Aarohi Sharma",
    "Nikhil Verma",
    "Pooja Nair",
    "Rakesh Malhotra",
    "Sana Khan",
    "Deepak Iyer",
    "Ananya Bose",
    "Farhan Siddiqui",
    "Meera Pillai",
    "Kabir Singh",
    "Zoya Ahmed",
    "Vivek Thomas",
    "Ishita Rao",
    "Rahul Sethi",
    "Nadia Hussain",
    "Arjun Mehta",
    "Priya Kulkarni",
    "Om Prakash",
    "Riya Chawla",
    "Imran Ali",
  ];
  const bulkDestinations = [
    "Goa",
    "Jaipur",
    "Makkah",
    "Dubai",
    "Bali",
    "Paris",
    "Rome",
    "Istanbul",
    "Kerala",
    "London",
    "Medina",
    "Agra",
    "Singapore",
    "Zurich",
    "Tokyo",
    "Delhi",
    "Cairo",
    "Maldives",
    "Munnar",
    "Seoul",
  ];
  const bulkSubBrands = ["travelstall", "rfu", "visasure", "tmc"];
  const bulkContacts = [];
  const bulkItineraries = [];
  const bulkQuotes = [];
  const bulkInvoices = [];
  const bulkTripReviews = [];

  for (let i = 0; i < bulkLeadNames.length; i++) {
    const subBrand = bulkSubBrands[i % bulkSubBrands.length];
    const name = bulkLeadNames[i];
    const email = `pagination-${String(i + 1).padStart(2, "0")}@travelstall.demo`;
    const contact = await ensureContact(tenant.id, {
      name,
      email,
      phone: `+91-90010-${String(i + 1).padStart(4, "0")}`,
      company: `${name.split(" ")[0]} Group`,
      title: subBrand === "tmc" ? "School Coordinator" : subBrand === "rfu" ? "Pilgrim Lead" : subBrand === "visasure" ? "Visa Lead" : "Holiday Lead",
      status: i % 4 === 0 ? "Customer" : i % 4 === 1 ? "Prospect" : "Lead",
      source: i % 3 === 0 ? "Organic" : i % 3 === 1 ? "Referral" : "WhatsApp",
      subBrand,
      aiScore: 55 + (i % 40),
    });
    bulkContacts.push(contact);

    const diagnosticBank = await prisma.travelDiagnosticQuestionBank.findFirst({
      where: { tenantId: tenant.id, subBrand, version: 1 },
    });
    if (diagnosticBank) {
      await ensureByFindFirst(
        "travelDiagnostic",
        { contactId: contact.id, subBrand },
        {
          tenantId: tenant.id,
          subBrand,
          contactId: contact.id,
          leadId: null,
          questionBankId: diagnosticBank.id,
          questionsJson: diagnosticBank.questionsJson,
          answersJson: json({ q1: "bulk", q2: "bulk", q3: "bulk" }),
          score: dec((58 + (i % 22)).toFixed(4)),
          classification: i % 3 === 0 ? "level_1" : i % 3 === 1 ? "level_2" : "level_3",
          classificationLabel: `${subBrand.toUpperCase()} Bulk Lead`,
          recommendedTier: subBrand === "rfu" ? "premium" : subBrand === "visasure" ? "primary" : "entry",
          reportPdfUrl: null,
          talkingPointsJson: json({ summary: "Bulk pagination fixture" }),
          formVsCallJson: json({ form: "high", call: "medium" }),
          consentCapturedAt: daysAgo(1),
          engineState: subBrand === "tmc" ? "partial_match" : null,
          engineScoresJson: null,
          recommendedTripId: null,
          alternativeTripId: null,
          icpTier: null,
          leadQuality: "clean",
          leadQualityReasonsJson: json([]),
          flagsJson: json([]),
          humanPick: null,
          weightsVersion: "v1",
          curriculumFitJson: json([]),
        },
      );
    }

    const itinerary = await ensureByFindFirst(
      "itinerary",
      { tenantId: tenant.id, shareToken: `bulk-itin-${String(i + 1).padStart(2, "0")}` },
      {
        tenantId: tenant.id,
        subBrand,
        contactId: contact.id,
        status: i % 4 === 0 ? "draft" : i % 4 === 1 ? "sent" : i % 4 === 2 ? "accepted" : "advance_paid",
        version: 1,
        parentItineraryId: null,
        productTier: subBrand === "rfu" ? "premium" : subBrand === "visasure" ? "primary" : "entry",
        destination: bulkDestinations[i],
        startDate: daysFromNow(10 + i),
        endDate: daysFromNow(14 + i),
        pricingJson: json({ bulk: true, seq: i + 1 }),
        totalAmount: dec((90000 + i * 6500).toFixed(2)),
        currency: "INR",
        pax: 1 + (i % 6),
        pdfUrl: null,
        shareToken: `bulk-itin-${String(i + 1).padStart(2, "0")}`,
        shareExpiresAt: daysFromNow(60),
        shareRevokedAt: null,
        advancePaidAmount: i % 4 >= 2 ? dec((45000 + i * 3200).toFixed(2)) : null,
        advancePaidAt: i % 4 >= 2 ? daysAgo(1) : null,
        paymentReference: i % 4 >= 2 ? `ADV-${String(i + 1).padStart(4, "0")}` : null,
        paymentOverdueAt: null,
        declineReason: null,
        cancellationStatus: null,
        cancellationReason: null,
        cancellationRequestedAt: null,
        draftSummary: `${bulkDestinations[i]} bulk itinerary for pagination testing.`,
        clonedFromTemplateId: null,
      },
    );
    bulkItineraries.push(itinerary);

    await ensureByFindFirst(
      "travelQuote",
      { tenantId: tenant.id, subBrand, contactId: contact.id },
      {
        tenantId: tenant.id,
        subBrand,
        contactId: contact.id,
        status: i % 4 === 0 ? "Draft" : i % 4 === 1 ? "Sent" : i % 4 === 2 ? "Accepted" : "Rejected",
        totalAmount: dec((98000 + i * 7100).toFixed(2)),
        currency: "INR",
        validUntil: daysFromNow(18 + i),
        tripDate: daysFromNow(22 + i),
        fxRateSnapshot: null,
        fxRateSourceCurrency: null,
        fxRateTargetCurrency: null,
        fxRateLockedAt: null,
        fxRateExpiresAt: null,
        clonedFromQuoteId: null,
        appliedMarkupPercent: dec((8 + (i % 10)).toFixed(2)),
        assignedToUserId: [admin?.id, admin2?.id, tmcOps?.id, rfuAdvisor?.id, telecaller?.id].filter(Boolean)[i % 5] ?? null,
        advancePlinkId: null,
        advancePaymentId: null,
      },
    );
    const quote = await prisma.travelQuote.findFirst({ where: { tenantId: tenant.id, subBrand, contactId: contact.id } });
    bulkQuotes.push(quote);

    if (quote) {
      const quoteLine = await prisma.travelQuoteLine.findFirst({ where: { quoteId: quote.id } });
      if (!quoteLine) {
        await prisma.travelQuoteLine.create({
          data: {
            tenantId: tenant.id,
            quoteId: quote.id,
            lineType: subBrand === "visasure" ? "service" : subBrand === "rfu" ? "service" : "hotel",
            description: `${bulkDestinations[i]} package for ${name}`,
            quantity: 1,
            unitPrice: dec((98000 + i * 7100).toFixed(2)),
            amount: dec((98000 + i * 7100).toFixed(2)),
            currency: "INR",
            supplierId: null,
            sortOrder: 0,
            notes: null,
            hsnSac: "998599",
            taxPercent: dec("18"),
            discountPercent: null,
            dimension: "flatRate",
            isAddOn: false,
          },
        });
      }
    }

    const invoiceNum = `TINV-2026-4${String(i + 1).padStart(3, "0")}`;
    await ensureByFindFirst(
      "travelInvoice",
      { tenantId: tenant.id, invoiceNum },
      {
        tenantId: tenant.id,
        subBrand,
        contactId: contact.id,
        quoteId: quote?.id ?? null,
        itineraryId: itinerary.id,
        invoiceNum,
        status: i % 4 === 0 ? "Draft" : i % 4 === 1 ? "Issued" : i % 4 === 2 ? "Partial" : "Paid",
        totalAmount: dec((98000 + i * 7100).toFixed(2)),
        currency: "INR",
        dueDate: daysFromNow(8 + i),
        paidAt: i % 4 >= 2 ? daysAgo(1) : null,
        tcsAmount: null,
        tcsRate: null,
        tcsExceedingAmount: null,
        tcsAppliedAt: null,
        placeOfSupply: "IN-MH",
        cgstAmount: dec("0"),
        sgstAmount: dec("0"),
        igstAmount: dec("0"),
        cgstPercent: dec("0"),
        sgstPercent: dec("0"),
        igstPercent: dec("0"),
        totalTaxAmount: dec("0"),
        gstComputedAt: daysAgo(1),
        docType: "TaxInvoice",
        parentInvoiceId: null,
        cancellationPolicyId: null,
      },
    );
    const invoice = await prisma.travelInvoice.findFirst({ where: { tenantId: tenant.id, invoiceNum } });
    bulkInvoices.push(invoice);
    if (invoice) {
      const invoiceLine = await prisma.travelInvoiceLine.findFirst({ where: { invoiceId: invoice.id } });
      if (!invoiceLine) {
        await prisma.travelInvoiceLine.create({
          data: {
            tenantId: tenant.id,
            invoiceId: invoice.id,
            lineType: subBrand === "tmc" ? "per_pax" : "per_trip",
            description: `${bulkDestinations[i]} invoice for ${name}`,
            quantity: 1,
            unitPrice: dec((98000 + i * 7100).toFixed(2)),
            amount: dec((98000 + i * 7100).toFixed(2)),
            currency: "INR",
            sortOrder: 0,
            notes: null,
            pnr: `BULKPNR${String(i + 1).padStart(4, "0")}`,
            bookingRef: `BULKREF${String(i + 1).padStart(4, "0")}`,
            serviceStartDate: itinerary.startDate,
            serviceEndDate: itinerary.endDate,
            fxRateToBase: null,
            baseAmount: dec((98000 + i * 7100).toFixed(2)),
            supplierId: null,
            isAddon: false,
            lineCost: dec((64000 + i * 4800).toFixed(2)),
            lineSell: dec((98000 + i * 7100).toFixed(2)),
            hsnSac: "998599",
            cgstPercent: dec("0"),
            cgstAmount: dec("0"),
            sgstPercent: dec("0"),
            sgstAmount: dec("0"),
            igstPercent: dec("18"),
            igstAmount: dec("0"),
          },
        });
      }
    }

    await ensureByFindFirst(
      "travelPortalNotification",
      { contactId: contact.id, title: `Bulk update ${i + 1}` },
      {
        tenantId: tenant.id,
        contactId: contact.id,
        title: `Bulk update ${i + 1}`,
        message: `${bulkDestinations[i]} demo record created for pagination testing.`,
        type: i % 3 === 0 ? "itinerary" : i % 3 === 1 ? "payment" : "info",
        link: "/travel/itineraries",
        isRead: false,
      },
    );

    await ensureByFindFirst(
      "whatsAppMessage",
      { tenantId: tenant.id, providerMsgId: `bulk-wa-${String(i + 1).padStart(3, "0")}` },
      {
        to: contact.phone ?? `+91-99999-${String(i + 1).padStart(4, "0")}`,
        from: "+91-90000-00000",
        body: `Bulk travel update for ${bulkDestinations[i]}: row ${i + 1}.`,
        mediaUrl: null,
        mediaType: null,
        direction: "OUTBOUND",
        status: "DELIVERED",
        providerMsgId: `bulk-wa-${String(i + 1).padStart(3, "0")}`,
        templateName: "travel_bulk_update",
        errorMessage: null,
        read: i % 2 === 0,
        deletedAt: null,
        reactionsJson: json([]),
        tenantId: tenant.id,
        contactId: contact.id,
        userId: admin?.id ?? null,
        threadId: null,
        metaType: "text",
        interactiveJson: null,
        mediaRefsJson: null,
      },
    );

    await ensureByFindFirst(
      "travelTripReview",
      { itineraryId: itinerary.id },
      {
        tenantId: tenant.id,
        itineraryId: itinerary.id,
        contactId: contact.id,
        token: `bulk-review-${String(i + 1).padStart(3, "0")}`,
        status: i % 2 === 0 ? "requested" : "submitted",
        overallRating: i % 2 === 0 ? null : 4,
        answersJson: i % 2 === 0 ? null : json({ hospitality: 4, transport: 4, value: 4 }),
        requestedAt: daysAgo(1),
        submittedAt: i % 2 === 0 ? null : daysAgo(1),
      },
    );
    bulkTripReviews.push(itinerary.id);

    if (subBrand === "visasure") {
      await ensureByFindFirst(
        "visaApplication",
        { tenantId: tenant.id, contactId: contact.id, destinationCountry: bulkDestinations[i] },
        {
          tenantId: tenant.id,
          contactId: contact.id,
          applicationType: i % 2 === 0 ? "tourist" : "business",
          destinationCountry: bulkDestinations[i],
          status: i % 4 === 0 ? "intake" : i % 4 === 1 ? "docs-pending" : i % 4 === 2 ? "filed" : "approved",
          readinessLevel: 1 + (i % 4),
          complexCase: i % 3 === 0,
          rejectionHistoryJson: i % 3 === 0 ? json([{ country: bulkDestinations[i], reason: "bulk demo", date: "2026-07-01" }]) : null,
          familySize: 1 + (i % 5),
          advisorRiskFlag: i % 3 === 0 ? "medium" : "low",
          filedAt: i % 4 >= 2 ? daysAgo(2) : null,
          decidedAt: i % 4 === 3 ? daysAgo(1) : null,
          outcome: i % 4 === 3 ? "approved" : null,
          outcomeReason: null,
          recoveryProgramId: null,
          priorApplicationId: null,
          passportIdentityId: null,
        },
      );
    }

    if (subBrand === "rfu") {
      await ensureByFindFirst(
        "rfuLeadProfile",
        { contactId: contact.id },
        {
          tenantId: tenant.id,
          contactId: contact.id,
          passportNumber: `RFU-${String(i + 1).padStart(6, "0")}`,
          passportExpiry: daysFromNow(700 + i),
          visaHistoryJson: json([{ country: "SA", year: 2024, status: "approved" }]),
          frequentFlyerJson: null,
          seatPref: i % 2 === 0 ? "aisle" : "window",
          mealPref: "halal",
          travelStyle: i % 2 === 0 ? "premium" : "primary",
          budgetMin: dec((90000 + i * 2500).toFixed(2)),
          budgetMax: dec((150000 + i * 2500).toFixed(2)),
          emergencyContactName: `${name.split(" ")[0]} Family`,
          emergencyContactPhone: `+91-90020-${String(i + 1).padStart(4, "0")}`,
          medicalNotes: null,
          specialAssistance: "Wheelchair / luggage assistance",
          pastComplaintsJson: json([]),
          productTier: i % 2 === 0 ? "premium" : "primary",
        },
      );
    }

    if (subBrand === "tmc") {
      const tripCode = `bulk-school-${String(i + 1).padStart(2, "0")}`;
      await ensureByFindFirst(
        "tmcTrip",
        { tenantId: tenant.id, tripCode },
        {
          tenantId: tenant.id,
          tripCode,
          schoolContactId: contact.id,
          destination: bulkDestinations[i],
          departDate: daysFromNow(45 + i),
          returnDate: daysFromNow(50 + i),
          legalEntity: "tmc_nexus",
          micrositeUrl: null,
          micrositeUuid: null,
          pricePerStudent: dec((18000 + i * 450).toFixed(2)),
          status: i % 3 === 0 ? "confirmed" : i % 3 === 1 ? "in-trip" : "completed",
          driveFolderId: null,
        },
      );
    }

    if (i < 10) {
      await ensureByFindFirst(
        "travelBrochure",
        { runId: `bulk-br-${String(i + 1).padStart(3, "0")}` },
        {
          tenantId: tenant.id,
          userId: admin?.id ?? null,
          runId: `bulk-br-${String(i + 1).padStart(3, "0")}`,
          sectorKey: "travel",
          styleKey: subBrand,
          goal: `Bulk brochure for ${bulkDestinations[i]} (${name})`,
          status: i % 2 === 0 ? "completed" : "running",
          pdfUrl: i % 2 === 0 ? `/brochure-assets/bulk-br-${String(i + 1).padStart(3, "0")}.pdf` : null,
          billedUsd: i % 2 === 0 ? dec((12.5 + i * 0.4).toFixed(6)) : null,
          errorMessage: null,
          tripId: null,
          itineraryId: itinerary.id,
          brandJson: json({ tenant: tenant.slug, subBrand }),
          completedAt: i % 2 === 0 ? daysAgo(1) : null,
          archivedAt: null,
        },
      );
    }
  }

  const extraQuestionBanks = [];
  for (const subBrand of bulkSubBrands) {
    for (const version of [2, 3]) {
      const bank = await ensureByFindFirst(
        "travelDiagnosticQuestionBank",
        { tenantId: tenant.id, subBrand, version },
        {
          tenantId: tenant.id,
          subBrand,
          version,
          questionsJson: json({
            questions: [
              { id: "q1", text: `${subBrand.toUpperCase()} bulk question ${version}`, type: "single-choice", options: [{ value: "a", label: "Option A", weight: 1 }, { value: "b", label: "Option B", weight: 3 }] },
              { id: "q2", text: "Budget comfort?", type: "single-choice", options: [{ value: "low", label: "Low", weight: 1 }, { value: "high", label: "High", weight: 4 }] },
            ],
          }),
          scoringRulesJson: json({
            method: "weighted-sum",
            bands: [
              { minScore: 0, maxScore: 4, classification: "level_1", label: "Starter", recommendedTier: "entry" },
              { minScore: 5, maxScore: 8, classification: "level_2", label: "Growing", recommendedTier: "primary" },
              { minScore: 9, maxScore: 99, classification: "level_3", label: "Premium", recommendedTier: "premium" },
            ],
          }),
          isActive: version === 3,
        },
      );
      extraQuestionBanks.push(bank);
    }
  }

  const extraSchoolTerms = [
    ["Spring Break", daysFromNow(20), daysFromNow(27)],
    ["Mid Term Exams", daysFromNow(40), daysFromNow(47)],
    ["Summer Vacation", daysFromNow(55), daysFromNow(76)],
    ["Sports Week", daysFromNow(88), daysFromNow(92)],
    ["Diwali Break", daysFromNow(110), daysFromNow(116)],
    ["Winter Break", daysFromNow(150), daysFromNow(164)],
    ["Annual Exams", daysFromNow(180), daysFromNow(190)],
    ["PTM Week", daysFromNow(210), daysFromNow(214)],
  ];
  for (const [idx, [label, startDate, endDate]] of extraSchoolTerms.entries()) {
    await ensureByFindFirst(
      "travelSchoolTerm",
      { tenantId: tenant.id, label },
      {
        tenantId: tenant.id,
        subBrand: "tmc",
        schoolName: idx % 2 === 0 ? `Bulk School ${idx + 1}` : null,
        board: idx % 3 === 0 ? "CBSE" : idx % 3 === 1 ? "ICSE" : "State",
        kind: idx % 2 === 0 ? "holiday" : "exam-blackout",
        label,
        startDate,
        endDate,
        source: "seed",
        isActive: true,
      },
    );
  }

  const extraSightseeing = [
    ["Goa", "Basilica of Bom Jesus", "religious"],
    ["Goa", "Dudhsagar Falls", "nature"],
    ["Jaipur", "Jal Mahal Lakeside", "monument"],
    ["Makkah", "Jabal al-Nour", "religious"],
    ["Madinah", "Quba Mosque", "religious"],
    ["Paris", "Louvre Museum", "museum"],
    ["Rome", "Colosseum", "historical"],
    ["Dubai", "Palm Jumeirah Boardwalk", "urban"],
    ["Kerala", "Alleppey Backwater Cruise", "nature"],
    ["London", "Tower Bridge Walk", "monument"],
  ];
  for (const [idx, [destinationName, name, category]] of extraSightseeing.entries()) {
    await ensureByFindFirst(
      "travelSightseeing",
      { tenantId: tenant.id, destinationName, name },
      {
        tenantId: tenant.id,
        destinationName,
        name,
        description: `${name} for ${destinationName} pagination testing.`,
        imageUrl: null,
        durationMinutes: 60 + idx * 10,
        priceReferenceMinor: 500 + idx * 250,
        currency: "INR",
        category,
        subBrand: idx % 2 === 0 ? "travelstall" : "rfu",
        notes: "Bulk sightseeing fixture.",
        isActive: true,
      },
    );
  }

  const extraTemplates = [
    ["Bali Family 5D", "travelstall", "Family"],
    ["Dubai Luxe 4D", "travelstall", "Honeymoon"],
    ["Makkah Express 6D", "rfu", "Religious"],
    ["Medina Peace 5D", "rfu", "Religious"],
    ["Schengen Starter", "visasure", "Visa"],
    ["US Business Assist", "visasure", "Visa"],
    ["Golden Triangle 4D", "tmc", "School"],
    ["Kerala Explorer 5D", "travelstall", "Family"],
  ];
  for (const [idx, [name, subBrand, category]] of extraTemplates.entries()) {
    await ensureByFindFirst(
      "itineraryTemplate",
      { tenantId: tenant.id, name },
      {
        tenantId: tenant.id,
        name,
        destinationName: name.split(" ")[0],
        durationDays: 4 + (idx % 3),
        description: `${name} bulk template for pagination testing.`,
        thumbnailUrl: null,
        category,
        subBrand,
        defaultMarkupPercent: 10 + idx,
        basePriceMinor: 5000000 + idx * 750000,
        currency: "INR",
        templateJson: json({ items: [{ day: 1, items: [{ itemType: "activity", description: "Bulk seeded day" }] }] }),
        llmGeneratedBy: null,
        isActive: true,
      },
    );
  }

  const extraSuppliers = [
    ["travelstall", "Coastal Air Links", "flight"],
    ["travelstall", "Azure Beach Resorts", "hotel"],
    ["travelstall", "CityCab Tours", "transport"],
    ["rfu", "Makkah Support Hub", "other"],
    ["rfu", "Madinah Comfort Suites", "hotel"],
    ["visasure", "Global Visa Desk", "visa-consul"],
    ["tmc", "SchoolCoach Travels", "transport"],
    ["tmc", "EduWorld Flights", "flight"],
  ];
  const extraSupplierRows = [];
  for (const [idx, [subBrand, name, supplierCategory]] of extraSuppliers.entries()) {
    const supplier = await ensureByFindFirst(
      "travelSupplier",
      { tenantId: tenant.id, subBrand, name },
      {
        tenantId: tenant.id,
        subBrand,
        name,
        contactPerson: `${name.split(" ")[0]} Ops`,
        phone: `+91-99100-${String(idx + 1).padStart(4, "0")}`,
        email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@demo.test`,
        supplierCategory,
        status: "active",
        paymentTermsKind: idx % 3 === 0 ? "net" : idx % 3 === 1 ? "prepay" : "on_arrival",
        paymentTermsDays: idx % 3 === 0 ? 15 + idx : null,
        creditLimit: dec((400000 + idx * 50000).toFixed(2)),
        creditCurrency: "INR",
        commissionPercent: dec((6 + idx).toFixed(2)),
        notes: "Bulk supplier pagination fixture.",
      },
    );
    extraSupplierRows.push(supplier);

    const kyc = await ensureByFindFirst(
      "travelSupplierKyc",
      { supplierId: supplier.id },
      {
        tenantId: tenant.id,
        supplierId: supplier.id,
        status: idx % 4 === 0 ? "pending" : idx % 4 === 1 ? "submitted" : "verified",
        panNumber: `PAN-BULK-${String(idx + 1).padStart(4, "0")}`,
        gstinVerified: idx % 4 !== 0,
        bankAccountVerified: idx % 3 !== 0,
        iataNumber: supplierCategory === "flight" ? `IATA-BULK-${String(idx + 1).padStart(4, "0")}` : null,
        iataExpiry: supplierCategory === "flight" ? daysFromNow(365 + idx) : null,
        tafiNumber: supplierCategory === "visa-consul" ? `TAFI-BULK-${String(idx + 1).padStart(4, "0")}` : null,
        contractSigned: idx % 2 === 0,
        contractSignedAt: idx % 2 === 0 ? daysAgo(15) : null,
        contractDocumentUrl: `/travel-fixtures/kyc/${supplier.id}/contract.pdf`,
        submittedAt: daysAgo(18),
        verifiedAt: idx % 4 === 2 ? daysAgo(10) : null,
        verifiedBy: admin?.id ?? null,
        notes: "Bulk supplier KYC row.",
      },
    );
    if (kyc) {
      const checklistSeed = [
        ["pan_card", "PAN Card", true],
        ["gstin_cert", "GST Certificate", true],
        ["bank_proof", "Bank Proof", true],
      ];
      for (const [itemKey, itemLabel, required] of checklistSeed) {
        await ensureByFindFirst(
          "travelSupplierKycChecklistItem",
          { kycId: kyc.id, itemKey },
          {
            tenantId: tenant.id,
            kycId: kyc.id,
            itemKey,
            itemLabel,
            required,
            status: "verified",
            documentUrl: `/travel-fixtures/kyc/${supplier.id}/${itemKey}.pdf`,
            notes: null,
            submittedAt: daysAgo(15),
            verifiedAt: daysAgo(10),
            verifiedBy: admin?.id ?? null,
            sortOrder: itemKey === "pan_card" ? 0 : itemKey === "gstin_cert" ? 1 : 2,
          },
        );
      }
    }

    const poNumber = `TPO-2026-B${String(idx + 1).padStart(3, "0")}`;
    const po = await ensureByFindFirst(
      "travelPurchaseOrder",
      { tenantId: tenant.id, poNumber },
      {
        tenantId: tenant.id,
        supplierId: supplier.id,
        bookingId: null,
        poNumber,
        status: idx % 4 === 0 ? "draft" : idx % 4 === 1 ? "sent" : idx % 4 === 2 ? "acknowledged" : "fulfilled",
        currency: "INR",
        subtotal: dec((45000 + idx * 4000).toFixed(2)),
        taxAmount: dec((8100 + idx * 720).toFixed(2)),
        totalAmount: dec((53100 + idx * 4720).toFixed(2)),
        notes: "Bulk PO fixture.",
        sentAt: daysAgo(12),
        acknowledgedAt: idx % 4 >= 2 ? daysAgo(11) : null,
        fulfilledAt: idx % 4 === 3 ? daysAgo(9) : null,
        cancelledAt: null,
        cancelReason: null,
        createdBy: admin?.id ?? null,
      },
    );
    const poLine = await prisma.travelPurchaseOrderLine.findFirst({ where: { purchaseOrderId: po.id } });
    if (!poLine) {
      await prisma.travelPurchaseOrderLine.create({
        data: {
          tenantId: tenant.id,
          purchaseOrderId: po.id,
          lineType: "service",
          description: `${name} booking services`,
          quantity: dec("1"),
          unitPrice: dec((45000 + idx * 4000).toFixed(2)),
          lineTotal: dec((45000 + idx * 4000).toFixed(2)),
          pnr: `POPNR${String(idx + 1).padStart(4, "0")}`,
          bookingRef: `POREF${String(idx + 1).padStart(4, "0")}`,
          sortOrder: 0,
        },
      });
    }

    const payable = await ensureByFindFirst(
      "travelSupplierPayable",
      { tenantId: tenant.id, supplierId: supplier.id, description: `${name} settlement` },
      {
        tenantId: tenant.id,
        supplierId: supplier.id,
        poNumber,
        description: `${name} settlement`,
        amount: dec((53100 + idx * 4720).toFixed(2)),
        currency: "INR",
        dueDate: daysFromNow(12 + idx),
        status: idx % 3 === 0 ? "pending" : idx % 3 === 1 ? "scheduled" : "paid",
        paidAt: idx % 3 === 2 ? daysAgo(5) : null,
        paymentReference: idx % 3 === 2 ? `BULKPAY-${String(idx + 1).padStart(4, "0")}` : null,
        notes: "Bulk payable fixture.",
        purchaseOrderId: po.id,
        invoiceLineId: null,
        payableBatchId: batch?.id ?? null,
      },
    );
    extraSupplierRows.push(payable);

    await ensureByFindFirst(
      "travelSupplierCommissionEntry",
      { tenantId: tenant.id, supplierId: supplier.id, fiscalYear: "FY2026-27", entryType: "accrued" },
      {
        tenantId: tenant.id,
        supplierId: supplier.id,
        bookingId: null,
        purchaseOrderId: po.id,
        invoiceId: invoices[0]?.id ?? null,
        fiscalYear: "FY2026-27",
        entryType: "accrued",
        commissionPercent: dec((6 + idx).toFixed(2)),
        baseAmount: dec((45000 + idx * 4000).toFixed(2)),
        commissionAmount: dec((2700 + idx * 280).toFixed(2)),
        currency: "INR",
        tdsAmount: dec((135 + idx * 14).toFixed(2)),
        netAmount: dec((2565 + idx * 266).toFixed(2)),
        status: "accrued",
        accruedAt: daysAgo(8),
        settledAt: null,
        reversedAt: null,
        reversalReason: null,
        notes: "Bulk commission fixture.",
        createdBy: admin?.id ?? null,
      },
    );

    await ensureByFindFirst(
      "travelSupplierInvoiceUpload",
      { tenantId: tenant.id, supplierId: supplier.id, supplierInvoiceNumber: `BULK-INV-${String(idx + 1).padStart(3, "0")}` },
      {
        tenantId: tenant.id,
        supplierId: supplier.id,
        payableId: payable.id,
        filename: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`,
        fileUrl: `/travel-fixtures/supplier-invoices/${idx + 1}.pdf`,
        fileMimeType: "application/pdf",
        fileSize: 500000 + idx * 25000,
        supplierInvoiceNumber: `BULK-INV-${String(idx + 1).padStart(3, "0")}`,
        invoiceDate: daysAgo(6),
        invoiceAmount: dec((53100 + idx * 4720).toFixed(2)),
        currency: "INR",
        matchStatus: idx % 3 === 0 ? "matched" : "unmatched",
        uploadedBy: admin?.id ?? null,
        uploadedAt: daysAgo(6),
        matchedBy: idx % 3 === 0 ? admin2?.id ?? null : null,
        matchedAt: idx % 3 === 0 ? daysAgo(4) : null,
        notes: "Bulk supplier upload fixture.",
      },
    );
  }

  if (process.env.WELLNESS_FIELD_KEY) {
    const loginId = await bcrypt.hash("travel-credential-demo", 10);
    await ensureByFindFirst(
      "supplierCredential",
      { tenantId: tenant.id, supplierName: "SkyHigh Airways" },
      {
        tenantId: tenant.id,
        category: "airline",
        supplierName: "SkyHigh Airways",
        loginIdEncrypted: loginId,
        passwordEncrypted: await bcrypt.hash("password123", 10),
        metadataJson: json({ mfa: "totp", note: "Demo vault row" }),
        ownerUserId: admin?.id ?? null,
        lastUsedAt: null,
      },
    );
  }

  console.log(`[seed-travel-extra] contacts added/confirmed: ${contacts.length}`);
  console.log(`[seed-travel-extra] itineraries: ${itineraries.length}`);
  console.log(`[seed-travel-extra] suppliers: ${suppliers.length}`);
  console.log(`[seed-travel-extra] quotes: ${quotes.length}`);
  console.log(`[seed-travel-extra] invoices: ${invoices.length}`);
  console.log(`[seed-travel-extra] payables: ${payables.length}`);
  console.log(`[seed-travel-extra] done.`);
}

main()
  .catch((e) => {
    console.error("[seed-travel-extra] error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
