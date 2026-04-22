/**
 * Seed script for the Enhanced Wellness demo tenant.
 *
 * Idempotent — safe to re-run. Will:
 *   - upsert Tenant slug "enhanced-wellness" with vertical="wellness"
 *   - upsert Rishu (admin), 3 doctors, 12 professionals, 2 helpers, 1 telecaller
 *   - upsert service catalog (hair transplant, Botox, fillers, haircut, slimming, Ayurveda, ...)
 *   - generate ~50 patients, ~200 visits over the last 90 days
 *   - generate ~30 active leads (as Contact rows scoped to this tenant)
 *   - generate 3 hand-crafted AgentRecommendation cards for the demo
 *
 * Run: cd backend && node prisma/seed-wellness.js
 */
const { PrismaClient } = require("@prisma/client");
const bcrypt = require("bcryptjs");

const prisma = new PrismaClient();

const TENANT_SLUG = "enhanced-wellness";
const PASSWORD = "password123";

// ── Helpers ────────────────────────────────────────────────────────

const indianFirstNames = [
  "Aarav", "Vivaan", "Aditya", "Vihaan", "Arjun", "Sai", "Reyansh", "Krishna",
  "Ishaan", "Shaurya", "Atharv", "Advik", "Pranav", "Dhruv", "Kabir", "Rohan",
  "Ananya", "Aadhya", "Aaradhya", "Diya", "Sara", "Pari", "Anika", "Navya",
  "Ira", "Myra", "Aanya", "Riya", "Avni", "Saanvi", "Kiara", "Mira",
  "Rishabh", "Kunal", "Manish", "Suresh", "Ramesh", "Mahesh", "Rajesh", "Sandeep",
  "Pooja", "Priya", "Sneha", "Neha", "Kavita", "Sunita", "Anita", "Geeta",
];

const indianLastNames = [
  "Sharma", "Verma", "Singh", "Kumar", "Gupta", "Patel", "Shah", "Jain",
  "Mehta", "Agarwal", "Bansal", "Mishra", "Tiwari", "Yadav", "Reddy", "Nair",
  "Iyer", "Menon", "Das", "Bose", "Chatterjee", "Banerjee", "Mukherjee", "Sen",
];

const services = [
  { name: "Hair Transplant (FUE)", category: "hair", ticketTier: "high", basePrice: 100000, durationMin: 480, targetRadiusKm: null, description: "Follicular Unit Extraction hair transplant — full-day procedure" },
  { name: "Hair PRP Therapy", category: "hair", ticketTier: "medium", basePrice: 5500, durationMin: 60, targetRadiusKm: 50, description: "Platelet-rich plasma scalp injection for hair regrowth" },
  { name: "Botox Treatment", category: "aesthetics", ticketTier: "high", basePrice: 25000, durationMin: 45, targetRadiusKm: 30, description: "Botulinum toxin injection for facial wrinkle reduction" },
  { name: "Dermal Fillers", category: "aesthetics", ticketTier: "high", basePrice: 28000, durationMin: 60, targetRadiusKm: 30, description: "Hyaluronic acid fillers for facial volumization" },
  { name: "Laser Hair Removal", category: "aesthetics", ticketTier: "medium", basePrice: 8500, durationMin: 60, targetRadiusKm: 30, description: "Diode laser permanent hair reduction" },
  { name: "Chemical Peel", category: "skin", ticketTier: "medium", basePrice: 4500, durationMin: 45, targetRadiusKm: 20, description: "Glycolic acid peel for skin brightening" },
  { name: "HydraFacial", category: "skin", ticketTier: "medium", basePrice: 6500, durationMin: 60, targetRadiusKm: 20, description: "Multi-step facial cleanse + hydration treatment" },
  { name: "Slimming Session", category: "slimming", ticketTier: "medium", basePrice: 3500, durationMin: 60, targetRadiusKm: 15, description: "Inch-loss slimming with ultrasonic cavitation" },
  { name: "Ayurveda Consultation", category: "ayurveda", ticketTier: "low", basePrice: 1500, durationMin: 45, targetRadiusKm: 10, description: "Initial Ayurveda doshic assessment + plan" },
  { name: "Shirodhara", category: "ayurveda", ticketTier: "medium", basePrice: 2500, durationMin: 75, targetRadiusKm: 10, description: "Continuous warm-oil forehead therapy for stress relief" },
  { name: "Haircut & Styling", category: "salon", ticketTier: "low", basePrice: 500, durationMin: 30, targetRadiusKm: 3, description: "Salon haircut + blow-dry styling" },
  { name: "Hair Color", category: "salon", ticketTier: "low", basePrice: 2500, durationMin: 90, targetRadiusKm: 3, description: "Full-head professional hair coloring" },
];

const staffSeed = [
  // Doctors
  { email: "rishu@enhancedwellness.in", name: "Rishu Agarwal (Owner)", role: "ADMIN", wellnessRole: null },
  { email: "drharsh@enhancedwellness.in", name: "Dr. Harsh Kumar", role: "USER", wellnessRole: "doctor" },
  { email: "drmeena@enhancedwellness.in", name: "Dr. Meena Sharma", role: "USER", wellnessRole: "doctor" },
  { email: "drvikas@enhancedwellness.in", name: "Dr. Vikas Singh", role: "USER", wellnessRole: "doctor" },
  // Manager
  { email: "manager@enhancedwellness.in", name: "Pooja Mehta (Clinic Manager)", role: "MANAGER", wellnessRole: null },
  // Telecaller
  { email: "telecaller@enhancedwellness.in", name: "Ankita Verma", role: "USER", wellnessRole: "telecaller" },
  // Professionals — 12
  { email: "stylist1@enhancedwellness.in", name: "Ravi Pandey", role: "USER", wellnessRole: "professional" },
  { email: "stylist2@enhancedwellness.in", name: "Sneha Gupta", role: "USER", wellnessRole: "professional" },
  { email: "aestheticn1@enhancedwellness.in", name: "Priya Yadav", role: "USER", wellnessRole: "professional" },
  { email: "aestheticn2@enhancedwellness.in", name: "Kavita Iyer", role: "USER", wellnessRole: "professional" },
  { email: "slimming1@enhancedwellness.in", name: "Ramesh Patel", role: "USER", wellnessRole: "professional" },
  { email: "slimming2@enhancedwellness.in", name: "Suresh Nair", role: "USER", wellnessRole: "professional" },
  { email: "ayurveda1@enhancedwellness.in", name: "Sunita Mishra", role: "USER", wellnessRole: "professional" },
  { email: "ayurveda2@enhancedwellness.in", name: "Geeta Tiwari", role: "USER", wellnessRole: "professional" },
  { email: "laser1@enhancedwellness.in", name: "Manish Bansal", role: "USER", wellnessRole: "professional" },
  { email: "laser2@enhancedwellness.in", name: "Anita Das", role: "USER", wellnessRole: "professional" },
  { email: "skincare1@enhancedwellness.in", name: "Sandeep Bose", role: "USER", wellnessRole: "professional" },
  { email: "skincare2@enhancedwellness.in", name: "Neha Reddy", role: "USER", wellnessRole: "professional" },
  // Helpers
  { email: "helper1@enhancedwellness.in", name: "Mahesh Yadav", role: "USER", wellnessRole: "helper" },
  { email: "helper2@enhancedwellness.in", name: "Rajesh Singh", role: "USER", wellnessRole: "helper" },
];

const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const randomName = () => `${rand(indianFirstNames)} ${rand(indianLastNames)}`;
const randomPhone = () => `+9198${randInt(10000000, 99999999)}`;

// Tilt the random gen toward weekdays + clinic hours
const randomVisitDate = (daysAgoMax = 90) => {
  const d = new Date();
  d.setDate(d.getDate() - randInt(0, daysAgoMax));
  d.setHours(randInt(10, 19), [0, 15, 30, 45][randInt(0, 3)], 0, 0);
  return d;
};

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log("[seed-wellness] starting…");

  // 1. Tenant
  const tenant = await prisma.tenant.upsert({
    where: { slug: TENANT_SLUG },
    update: { vertical: "wellness", name: "Enhanced Wellness", ownerEmail: "rishu@enhancedwellness.in" },
    create: {
      slug: TENANT_SLUG,
      name: "Enhanced Wellness",
      vertical: "wellness",
      plan: "professional",
      ownerEmail: "rishu@enhancedwellness.in",
    },
  });
  console.log(`[seed-wellness] tenant id=${tenant.id} slug=${tenant.slug}`);

  // 2. Staff
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const userMap = {};
  for (const s of staffSeed) {
    const u = await prisma.user.upsert({
      where: { email: s.email },
      update: {
        name: s.name,
        role: s.role,
        wellnessRole: s.wellnessRole,
        tenantId: tenant.id,
      },
      create: {
        email: s.email,
        password: passwordHash,
        name: s.name,
        role: s.role,
        wellnessRole: s.wellnessRole,
        tenantId: tenant.id,
      },
    });
    userMap[s.email] = u;
  }
  console.log(`[seed-wellness] staff seeded: ${Object.keys(userMap).length}`);

  const doctors = Object.values(userMap).filter((u) => u.wellnessRole === "doctor");

  // 3. Services
  const serviceMap = {};
  for (const s of services) {
    const existing = await prisma.service.findFirst({
      where: { tenantId: tenant.id, name: s.name },
    });
    const svc = existing
      ? await prisma.service.update({ where: { id: existing.id }, data: { ...s, tenantId: tenant.id } })
      : await prisma.service.create({ data: { ...s, tenantId: tenant.id } });
    serviceMap[s.name] = svc;
  }
  console.log(`[seed-wellness] services seeded: ${Object.keys(serviceMap).length}`);

  // 4. Patients (50) — only seed if we have fewer than 10 already (idempotency)
  const existingPatientCount = await prisma.patient.count({ where: { tenantId: tenant.id } });
  if (existingPatientCount < 10) {
    const patients = [];
    for (let i = 0; i < 50; i++) {
      const p = await prisma.patient.create({
        data: {
          name: randomName(),
          email: `patient${i}@example.in`,
          phone: randomPhone(),
          dob: new Date(1970 + randInt(0, 40), randInt(0, 11), randInt(1, 28)),
          gender: rand(["M", "F"]),
          bloodGroup: rand(["A+", "B+", "O+", "AB+", "A-", "B-", "O-", "AB-"]),
          source: rand(["meta-ad", "google-ad", "walk-in", "referral", "whatsapp", "indiamart"]),
          tenantId: tenant.id,
        },
      });
      patients.push(p);
    }
    console.log(`[seed-wellness] patients created: ${patients.length}`);

    // 5. Visits (200) over last 90 days
    const allServices = Object.values(serviceMap);
    let visitsCreated = 0;
    for (let i = 0; i < 200; i++) {
      const patient = rand(patients);
      const service = rand(allServices);
      const doctor = rand(doctors);
      await prisma.visit.create({
        data: {
          visitDate: randomVisitDate(90),
          status: "completed",
          notes: rand([
            "Patient responded well to treatment. Recommended follow-up in 4 weeks.",
            "Mild redness post-procedure, expected to subside in 24h.",
            "Discussed maintenance regime. Patient happy with progress.",
            "Recommended additional sessions for optimal results.",
            "Initial consultation. Plan agreed: 3 sessions, 2 weeks apart.",
          ]),
          amountCharged: service.basePrice * (0.9 + Math.random() * 0.2),
          patientId: patient.id,
          doctorId: doctor.id,
          serviceId: service.id,
          tenantId: tenant.id,
        },
      });
      visitsCreated++;
    }
    console.log(`[seed-wellness] visits created: ${visitsCreated}`);

    // 6. Treatment plans (10 active multi-session)
    const planServices = [
      serviceMap["Hair PRP Therapy"],
      serviceMap["Laser Hair Removal"],
      serviceMap["Slimming Session"],
      serviceMap["Chemical Peel"],
    ].filter(Boolean);
    for (let i = 0; i < 10; i++) {
      const patient = rand(patients);
      const svc = rand(planServices);
      if (!svc) continue;
      const total = randInt(4, 8);
      await prisma.treatmentPlan.create({
        data: {
          name: `${svc.name} — ${total}-session package`,
          totalSessions: total,
          completedSessions: randInt(1, total - 1),
          totalPrice: svc.basePrice * total * 0.85, // 15% bundle discount
          nextDueAt: new Date(Date.now() + randInt(1, 14) * 86400000),
          patientId: patient.id,
          serviceId: svc.id,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] treatment plans: 10");

    // 7. A few prescriptions + consent forms for clinical demo realism
    const recentVisits = await prisma.visit.findMany({
      where: { tenantId: tenant.id },
      take: 20,
      orderBy: { visitDate: "desc" },
    });
    for (const v of recentVisits.slice(0, 10)) {
      await prisma.prescription.create({
        data: {
          drugs: JSON.stringify([
            { name: "Minoxidil 5%", dosage: "1ml", frequency: "twice daily", duration: "12 weeks" },
            { name: "Finasteride 1mg", dosage: "1 tablet", frequency: "once daily", duration: "12 weeks" },
          ]),
          instructions: "Apply minoxidil only to dry scalp. Take finasteride after meals. Avoid harsh shampoos.",
          visitId: v.id,
          patientId: v.patientId,
          doctorId: v.doctorId,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] prescriptions: 10");

    for (const v of recentVisits.slice(0, 5)) {
      const svc = await prisma.service.findUnique({ where: { id: v.serviceId } });
      await prisma.consentForm.create({
        data: {
          templateName: svc && svc.category === "hair" ? "hair-transplant" : svc && svc.category === "aesthetics" ? "botox-fillers" : "general",
          patientId: v.patientId,
          serviceId: v.serviceId,
          tenantId: tenant.id,
        },
      });
    }
    console.log("[seed-wellness] consent forms: 5");
  } else {
    console.log(`[seed-wellness] patients already seeded (${existingPatientCount}), skipping clinical data`);
  }

  // 8. Active leads (Contacts) — 30 — create only if absent
  const existingLeadCount = await prisma.contact.count({
    where: { tenantId: tenant.id, status: "Lead" },
  });
  if (existingLeadCount < 5) {
    const sources = ["meta-ad", "google-ad", "whatsapp", "indiamart", "justdial", "walk-in"];
    for (let i = 0; i < 30; i++) {
      const name = randomName();
      try {
        await prisma.contact.create({
          data: {
            name,
            email: `lead${Date.now()}-${i}@example.in`,
            phone: randomPhone(),
            status: "Lead",
            source: rand(sources),
            firstTouchSource: rand(sources),
            tenantId: tenant.id,
          },
        });
      } catch (e) {
        // unique-violation → skip
      }
    }
    console.log("[seed-wellness] leads created: 30");
  }

  // 9. Hand-crafted agent recommendations (always re-seeded for the demo)
  await prisma.agentRecommendation.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.agentRecommendation.createMany({
    data: [
      {
        type: "campaign_boost",
        title: "Boost Hair Transplant campaign by ₹500/day",
        body: "Hair Transplant campaign hit 5.2x ROAS over the last 7 days — well above your 3x target. Adding ₹500/day budget should yield ~3 more high-ticket bookings per week without diluting CPL.",
        expectedImpact: "+3 hair transplant bookings/week, projected revenue +₹3L/week, ROAS holds at ~5x",
        priority: "high",
        goalContext: "Maximize ROAS on high-ticket services",
        tenantId: tenant.id,
      },
      {
        type: "occupancy_alert",
        title: "Tomorrow's slim-room utilisation only 30%",
        body: "Three of the four slimming slots tomorrow afternoon are empty. Suggest sending a 15% off WhatsApp blast to the 47 leads who enquired about slimming in the last 30 days.",
        expectedImpact: "Likely fills 2 of the 3 open slots (~₹7,000 same-day revenue)",
        priority: "medium",
        goalContext: "100% occupancy",
        tenantId: tenant.id,
      },
      {
        type: "lead_followup",
        title: "12 hot leads aging > 24h without first-call",
        body: "12 leads from yesterday's Meta ads haven't been called yet. Industry data says first-call within 5 minutes lifts conversion 9x. Reassign to telecaller Ankita who is currently free.",
        expectedImpact: "Recovers ~3-4 conversions worth ₹40k+ that would otherwise drop off",
        priority: "high",
        goalContext: "Zero missed leads",
        tenantId: tenant.id,
      },
    ],
  });
  console.log("[seed-wellness] agent recommendations: 3");

  console.log("\n[seed-wellness] DONE");
  console.log("\nLogin to Enhanced Wellness with:");
  console.log("  Owner:        rishu@enhancedwellness.in / password123");
  console.log("  Doctor:       drharsh@enhancedwellness.in / password123");
  console.log("  Manager:      manager@enhancedwellness.in / password123");
  console.log("  Telecaller:   telecaller@enhancedwellness.in / password123");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
