/**
 * One-shot seed: insert the Japan 2026 Educational Immersion landing
 * page as a LandingPage record that renders through the new
 * educational-trip-v1 TEMPLATE (Phase D1).
 *
 * Migration history
 * ─────────────────
 *   PR-A: seed was emitted as a block-array (templateType
 *         "travel_destination"). Block ordering: destinationHero →
 *         highlightsGrid → cityCards → inclusionsGrid →
 *         itineraryTimeline → tierPricing → faqAccordion →
 *         reviewCarousel → form.
 *   D1 (this file): seed is emitted as a SEMANTIC CONTENT PAYLOAD
 *         (templateType "educational-trip-v1"). The renderer owns
 *         the visual hierarchy; the seed only declares content.
 *         Hero / preview / cultural / safety / investment / FAQ /
 *         registration / brochure / details / footer are filled
 *         directly from the operator's TripsLanding.jsx content.
 *
 * Idempotency — re-running rewrites editable fields. visits +
 * submissions counters preserved across re-runs.
 *
 * Usage:
 *   cd backend && node scripts/seed-japan-landing-page.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "..", "..", ".env") });
const prisma = require("../lib/prisma");

const JAPAN_DEADLINE_ISO = "2026-06-30T23:59:59+05:30";

// ── SEMANTIC CONTENT PAYLOAD (Phase D1) ────────────────────────────
// Mirrors frontend/src/pages/public/TripsLanding.jsx slot-for-slot.
// Operator can edit any field via the builder's template editor mode.
const JAPAN_CONTENT = {
  brand: {
    kanji: "日本",
    label: "JAPAN 2026",
    programmeName: "Japan 2026 — Educational Immersion",
    programmeTagline: "Where Precision Fuels Possibility",
    logoUrl: "/tmc-logo.png",
    partnerLogos: [
      { src: "/partner-school.png", alt: "School" },
      { src: "/partner-soi.png", alt: "School of India" },
      { src: "/partner-tmc.png", alt: "The Modern Classroom" },
    ],
  },
  nav: {
    links: [
      { label: "Programme", href: "#programme" },
      { label: "Safety", href: "#safety" },
      { label: "Investment", href: "#investment" },
      { label: "FAQs", href: "#faqs" },
    ],
    ctaText: "Register Now",
    ctaHref: "#register",
  },
  hero: {
    kanjiWatermark: "成長",
    eyebrow: {
      date: "SEPT – OCT 2026",
      audience: "GRADES 6-12",
      batchPill: "Limited to 45 Students per Batch",
    },
    kicker: "09 Days. 04 Cities.",
    headline: "Where Exposure Becomes Perspective",
    lede:
      "Observe how disciplined societies think, organize, and operate. This is not tourism, but structured, guided international immersion.",
    benefitCards: [
      { icon: "◈", title: "Global Confidence", desc: "Composure and adaptability in unfamiliar environments." },
      { icon: "⊕", title: "Global Perspective", desc: "Exposure to structured global systems and perspectives." },
      { icon: "⌂", title: "Cultural Awareness", desc: "Deep appreciation of Japanese tradition and etiquette." },
      { icon: "❖", title: "Guided Independence", desc: "Freedom to explore within a safe, structured framework." },
    ],
    countdown: {
      label: "PARENT ORIENTATION REGISTRATION CLOSES IN",
      deadlineIso: JAPAN_DEADLINE_ISO,
      ctaText: "Attend Parent Orientation",
      ctaHref: "#register",
    },
    visualTitle: "Japan 2026 Educational Immersion Program",
    visualSub: "A Structured Journey into Discipline, Culture, and Independent Thinking",
    posterUrl: "/japan_hero.webp",
    posterAlt: "Mount Fuji with red sun, traditional pagoda, and cherry blossoms",
  },
  marquee: {
    cities: [
      { tag: "ICONIC", title: "Mount Fuji", img: "https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?w=800&q=80" },
      { tag: "HERITAGE", title: "Kyoto", img: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=80" },
      { tag: "CULINARY", title: "Osaka", img: "https://images.unsplash.com/photo-1590559899731-a382839e5549?w=800&q=80" },
      { tag: "METROPOLIS", title: "Tokyo", img: "https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=800&q=80" },
      { tag: "LIVING REVERENCE", title: "Nara", img: "https://images.unsplash.com/photo-1624253321171-1be53e12f5f4?w=800&q=80" },
    ],
  },
  preview: {
    show: true,
    kanjiWatermark: "体験",
    tag: "INTERACTIVE PREVIEW",
    title: "See the Experience Before You Decide.",
    subtitle: "Before reading further, take a moment to see what this journey feels like.",
    quote:
      "Notice the precision. The structure. The quiet discipline. This is not tourism. It is structured exposure.",
    videoEmbedUrl: "https://fast.wistia.net/embed/iframe/zwq5w6rf4r?seo=true&videoFoam=true",
    ctaText: "REGISTER FOR PARENT ORIENTATION",
    ctaHref: "#register",
  },
  programme: {
    show: true,
    kanjiWatermark: "洞察",
    leftHeadline: "Because Academics Alone Are No Longer Enough.",
    leftParagraphs: [
      "Your child lives in a world that rewards more than grades. It rewards adaptability, cultural awareness, and composure under uncertainty.",
      "Yet most exposure today is filtered through screens. Real-world systems thinking is rarely observed firsthand.",
      "Japan offers a rare opportunity to experience a society where heritage and innovation evolve together.",
    ],
    rightHeadline: "What Students Gain",
    rightQuote:
      "Students do not simply see Japan. They observe systems. They experience discipline. They learn through immersion.",
    rightChecks: [
      "Confidence in unfamiliar environments",
      "Exposure to structured global systems",
      "Cultural awareness beyond textbooks",
      "Guided independence within supervision",
    ],
    cta: {
      title: "See the Structure. Ask Your Questions. Decide with Confidence.",
      body:
        "The Parent Orientation walks you through the itinerary, safety protocols, supervision and investment, clearly and transparently.",
      ctaText: "Attend the Orientation Session",
      ctaHref: "#register",
    },
  },
  cultural: {
    show: true,
    kanjiWatermark: "文化",
    tag: "文化   CULTURAL HIGHLIGHTS",
    title: "Cultural Highlights",
    subtitle:
      "Each location is selected not for tourism, but for its specific educational and developmental outcome.",
    items: [
      {
        id: "tokyo",
        icon: "tokyo",
        name: "Tokyo",
        label: "URBAN PRECISION",
        body: [
          "Your child navigates one of the world's most complex cities with growing independence.",
          "From Asakusa Sensoji Temple to Shibuya Crossing, from school exchanges to TeamLab's digital universe, Tokyo teaches adaptability in real time.",
        ],
        benefit: "Exposure to structured complexity builds composure.",
      },
      {
        id: "fuji",
        icon: "fuji",
        name: "Mt. Fuji",
        label: "OBSERVING POWER",
        body: [
          "Standing at Mt. Fuji's 5th Station, students experience quiet strength.",
          "The Hakone Ropeway and Lake Ashi cruise teach something subtle. Profound experiences come from observing, not rushing.",
        ],
        benefit: "Depth over distraction.",
      },
      {
        id: "kyoto",
        icon: "kyoto",
        name: "Kyoto",
        label: "CULTURAL CONTINUITY",
        body: [
          "After boarding the Shinkansen at 320 km/h, students arrive in Japan's ancient capital.",
          "Dressed in kimono, walking temple grounds, they witness how tradition evolves without erasing its roots.",
        ],
        benefit: "Respect for legacy while embracing innovation.",
      },
      {
        id: "nara",
        icon: "nara",
        name: "Nara",
        label: "LIVING REVERENCE",
        body: ["At Todaiji Temple and among Nara's sacred deer, students encounter harmony and discipline."],
        benefit: "Understanding that respect can be institutionalized.",
      },
      {
        id: "osaka",
        icon: "osaka",
        name: "Osaka",
        label: "STRUCTURED INDEPENDENCE",
        body: [
          "From Umeda Sky Observatory to Universal Studios Japan, students explore freely within defined boundaries.",
          "With supervised budgeting systems in place, independence becomes tangible.",
        ],
        benefit: "Confidence under guidance.",
      },
    ],
    cta: {
      title: "Every Location Has a Purpose.",
      body: "See how this 9-day journey is academically structured, supervised, and outcome-driven.",
      ctaText: "Reserve Your Orientation Seat",
      ctaHref: "#register",
    },
  },
  safety: {
    show: true,
    title: "Engineered for Safety. Designed for Growth.",
    subtitle:
      "Your child's safety and well-being are non-negotiable. Every element has been designed with care.",
    features: [
      { icon: "shield", title: "1:20 Teacher Ratio", desc: "Trained Tour Directors with structured oversight" },
      { icon: "briefcase", title: "4-Star Hotels", desc: "Twin sharing rooms ensuring comfort and safety" },
      { icon: "send", title: "All Meals Included", desc: "Mix of Indian, Continental, and Japanese cuisine" },
      {
        icon: "package",
        title: "International Flights",
        desc: "Return international airfare included via Malaysia Airlines or equivalent full-service carriers",
      },
    ],
    included: {
      title: "What's Included",
      items: [
        "Return international airfare & Japan tourist visa processing",
        "4-Star hotels with twin sharing rooms",
        "All meals: Continental breakfast + Indian/Japanese cuisine",
        "All entrance fees and guided tours",
        "Bullet train experience (Tokyo to Kyoto)",
        "Travel insurance & dedicated tour directors",
        "Private coach with regulated driving hours",
        "Luggage courier support (Tokyo to Osaka)",
      ],
    },
    banner: {
      title: "Your Child's Safety is Guaranteed",
      body: "1:20 student-to-teacher ratio, 4-star hotels, comprehensive insurance. Every detail covered.",
      ctaText: "Register for Orientation",
      ctaHref: "#register",
    },
    quote: "Independence within structure. Freedom within supervision.",
  },
  testimonials: {
    show: true,
    title: "They Returned More Independent. More Composed.",
    items: [
      {
        initial: "P",
        name: "PRIYA S.",
        text:
          "Phenomenal work and meticulous planning by the entire team. They offer an incredible experiential learning approach that truly integrates outbound learning and life skills.",
        stars: 5,
        source: "Google Review",
      },
      {
        initial: "R",
        name: "RAHUL M.",
        text:
          "The personal involvement and genuineness of the staff gave us complete peace of mind. Safety was clearly their top priority, and the level of supervision was outstanding.",
        stars: 5,
        source: "Google Review",
      },
      {
        initial: "A",
        name: "ANJALI K.",
        text:
          "A truly unique educational experience. The real-world learning and exposure to structured global cultures they provided was completely exceptional.",
        stars: 5,
        source: "Google Review",
      },
    ],
    cta: {
      title: "Growth Is Designed Not Accidental.",
      body:
        "Join the Parent Orientation to see how supervision, structure, and exposure work together.",
      ctaText: "Reserve Your Orientation Seat",
      ctaHref: "#register",
    },
  },
  investment: {
    show: true,
    tag: "投資   TRANSPARENT PROGRAMME INVESTMENT",
    title: "Transparent Programme Investment",
    subtitle:
      "The complete cost structure, inclusions, and instalment details will be explained during the parent orientation session.",
    currency: "₹",
    tiers: [
      {
        step: 1,
        title: "First Instalment",
        subtitle: "Registration Fee",
        amount: "34,980",
        tag: "Non-refundable",
        date: "30th June 2026",
        vendor: "TMC Nexus Pvt Ltd",
        startHere: true,
      },
      {
        step: 2,
        title: "Second Instalment",
        subtitle: "Mid-term Payment",
        amount: "1,00,000",
        date: "15th July 2026",
        vendor: "Travelstall",
      },
      {
        step: 3,
        title: "Third Instalment",
        subtitle: "Final Payment",
        amount: "1,75,000",
        date: "15th August 2026",
        vendor: "TMC Nexus Pvt Ltd",
      },
    ],
    inclusions: {
      label: "INDICATIVE INCLUSIONS",
      items: [
        "International airfare",
        "Accommodation",
        "Visa processing",
        "Internal transportation",
        "Supervision framework",
        "Cultural access",
      ],
    },
    foot: "All financial details will be shared transparently during orientation.",
    cta: {
      title: "Transparency First. Commitment Later.",
      body:
        "Attend the Parent Orientation to review the complete cost structure and ask your questions directly.",
      ctaText: "Reserve Your Orientation Seat",
      ctaHref: "#register",
    },
  },
  registration: {
    show: true,
    tag: "登録   REGISTRATION",
    title: "Register for the Parent Orientation",
    subtitle:
      "Reserve your seat — we'll cover the itinerary, safety protocols, supervision and investment, transparently.",
    schoolOptions: ["School of India", "DPS North", "DPS South", "DPS East", "DPS West"],
    successTitle: "Registration Submitted!",
    successBody:
      "Our team will contact you within 24 hours to confirm your slot and share next steps.",
    submitText: "Confirm Registration",
    leadSource: "tmc_registration",
    leadSubBrand: "tmc",
    tenantSlug: "travel-stall",
  },
  brochure: {
    show: true,
    infoCards: [
      { title: "COMPLETE ITINERARY", desc: "Review the detailed day-by-day schedule." },
      { title: "SAFETY FRAMEWORK", desc: "Understand our strict 1:20 supervision protocols." },
      { title: "INVESTMENT STRUCTURE", desc: "See the full transparent financial breakdown." },
      { title: "LIVE Q&A", desc: "Get all your specific questions answered directly." },
    ],
    pillText: "STILL EXPLORING?",
    headTitle: "Download the Detailed Programme Overview.",
    infoBody:
      "If you would prefer to review the complete itinerary, inclusions, safety framework, and payment structure before attending the orientation, you may request the official brochure.",
    dividerText: "SELECT YOUR SCHOOL TO RECEIVE THE RESPECTIVE VERSION OF THE ITINERARY",
    schoolOptions: ["DPS", "School of India", "Other"],
    ctaText: "DOWNLOAD PROGRAMME BROCHURE",
    footNote: "No obligation. For informed decision-making.",
    leadSource: "brochure_request",
    leadSubBrand: "tmc",
    tenantSlug: "travel-stall",
  },
  faq: {
    show: true,
    kanjiWatermark: "質問",
    tag: "CLARIFICATIONS",
    title: "Frequently Asked Questions",
    subtitle: "Everything you need to know about the Japan 2026 tour",
    categories: [
      { id: "all", label: "ALL QUESTIONS", icon: "📋" },
      { id: "tour", label: "TOUR DETAILS", icon: "📍" },
      { id: "payments", label: "PAYMENTS & PRICING", icon: "💳" },
      { id: "safety", label: "SAFETY & LOGISTICS", icon: "🛡" },
      { id: "registration", label: "REGISTRATION", icon: "📝" },
    ],
    items: [
      { cat: "tour", q: "How does this tour benefit students?", a: "Students gain global confidence, cultural awareness, systems thinking, and structured independence — outcomes that classroom learning alone cannot deliver. The 9-day immersion across 4 Japanese cities exposes them to one of the most disciplined societies on the planet." },
      { cat: "tour", q: "What cities are covered in this tour?", a: "Tokyo (Metropolis), Mount Fuji (Iconic), Kyoto (Heritage), Osaka (Culinary), and Nara (Living Reverence). Each city is selected for its specific educational and developmental outcome." },
      { cat: "tour", q: "When are the tour dates?", a: "The programme runs September – October 2026. Exact batch dates will be shared during the Parent Orientation session." },
      { cat: "tour", q: "Which grade students will be grouped together?", a: "Students from Grades 6 – 12 are eligible. Grouping is done by age band and school within each batch to ensure peer compatibility." },
      { cat: "tour", q: "What is the maximum group size?", a: "Each batch is limited to 45 students with a 1:20 teacher-to-student ratio, ensuring close supervision and meaningful interaction." },
      { cat: "tour", q: "Will there be shopping opportunities during the tour?", a: "Yes, supervised time in Dotonbori (Osaka) and select districts in Tokyo allows students to make budgeted, independent purchases — part of the structured-independence learning outcome." },
      { cat: "payments", q: "What is included in the tour cost?", a: "Return international airfare (Malaysia Airlines or equivalent), Japan tourist visa processing, 4-star twin-sharing accommodation, all meals, all entrance fees, guided tours, bullet train, travel insurance, dedicated tour directors, private coach, and luggage courier (Tokyo to Osaka)." },
      { cat: "payments", q: "What is NOT included in the cost?", a: "Personal shopping, optional excursions outside the published itinerary, additional travel insurance upgrades, and incidental expenses." },
      { cat: "payments", q: "What is the payment structure?", a: "Three instalments — ₹34,980 (Registration, by 30 June 2026, non-refundable, paid to TMC Nexus Pvt Ltd), ₹1,00,000 (Mid-term, by 15 July 2026, paid to Travelstall), ₹1,75,000 (Final, by 15 August 2026, paid to TMC Nexus Pvt Ltd)." },
      { cat: "payments", q: "What is the cancellation policy?", a: "Cancellations within 90 days of departure forfeit the registration fee. Cancellations within 45 days forfeit the mid-term instalment. Within 21 days, the full amount is non-refundable. Detailed terms shared during orientation." },
      { cat: "payments", q: "Are there any academic criteria for participation?", a: "There are no strict academic cut-offs. School recommendation and behavioural readiness for an international guided programme are considered during enrolment review." },
      { cat: "safety", q: "What are the safety protocols in place?", a: "A 1:20 trained tour director ratio, 24/7 emergency contact, GPS tracking, pre-vetted accommodation, comprehensive travel insurance, daily parent updates, and a documented incident-response framework. Every detail is engineered for safety." },
      { cat: "safety", q: "What documents are required for visa processing?", a: "Valid passport (6 months validity from return date), passport-size photos, school ID, parental consent letter, and bank statement. Our team handles the full visa application end-to-end after registration." },
      { cat: "safety", q: "How will meals be managed?", a: "All meals are included — Continental breakfast at hotels, and a curated mix of Indian, Continental, and Japanese cuisine for lunch and dinner. Dietary restrictions (vegetarian, allergies) are accommodated when shared at registration." },
      { cat: "safety", q: "What kind of hotels and room sharing can be expected?", a: "Pre-vetted 4-star hotels in central, safe locations across all four cities. Twin-sharing rooms with same-school / same-age-band peers. Teachers stay on the same floor." },
      { cat: "safety", q: "What kind of transportation will be used?", a: "Private chartered coaches between sites with regulated driving hours. Bullet train (Shinkansen) between Tokyo and Kyoto as an immersive experience. Internal flights only if itinerary requires it." },
      { cat: "safety", q: "Can parents contact their children during the trip?", a: "Yes. Each student gets a Japan-active SIM/eSIM. Tour directors share daily parent group updates with photos, location, and the day's summary at 8 PM IST." },
      { cat: "safety", q: "What support is offered for children with special needs?", a: "Please notify us at registration. We coordinate accommodations for medical, dietary, mobility, and learning support with our travel partners and tour directors before departure." },
      { cat: "registration", q: "How do I register my child for the tour?", a: "Fill out the Registration form on this page. Our team will reach out within 48 hours to confirm slot availability and guide you through the orientation session and payment process." },
      { cat: "registration", q: "What if my child doesn't have a passport?", a: "Apply for one immediately — the process takes 4 – 6 weeks in India. We provide an information sheet on the passport process and recommend starting as soon as you register." },
      { cat: "registration", q: "Will there be a pre-departure orientation for students and parents?", a: "Yes. A mandatory in-person orientation (Bengaluru) covers the full itinerary, packing list, emergency protocols, and student briefing. A virtual session is available for outstation families." },
      { cat: "registration", q: "How can parents stay updated during the tour?", a: "Daily WhatsApp updates from the tour director group, real-time GPS tracking access, and a 24/7 India-based emergency desk. Direct calls to your child are possible after 7 PM IST any day." },
      { cat: "registration", q: "Will the experience be captured or documented?", a: "Yes. A professional travel videographer documents each batch. Every student receives a personalised highlight reel and a printed Memory Book post-tour." },
      { cat: "registration", q: "Who can I contact for support or more information?", a: "Email mail@themodernclassroom.in or call 9900786677 / 9886753632 / 080 4371 2595 (Mon – Sat, 10 AM – 7 PM IST)." },
    ],
  },
  details: {
    show: true,
    title: "The Details That Matter",
    leftPill: "09 DAYS. 04 CITIES.",
    taglineRight: "One Transformational Educational Journey.",
    steps: [
      { num: 1, label: "Join Parent Orientation" },
      { num: 2, label: "Review the framework" },
      { num: 3, label: "Decide with clarity" },
    ],
    ctaText: "REGISTER FOR THE PARENT ORIENTATION",
    ctaHref: "#register",
  },
  contact: {
    show: true,
    kanji: "日本",
    label: "JAPAN 2026",
    tagline: "Where Precision Fuels Possibility",
    logoUrl: "/tmc-logo.png",
    sections: [
      { label: "EMAIL INQUIRIES", lines: ["mail@themodernclassroom.in"] },
      { label: "DIRECT CONTACT", lines: ["9900786677  |  9886753632", "080 4371 2595"] },
    ],
    copyright: "© 2026 THE MODERN CLASSROOM  •  1:20 SUPERVISION FRAMEWORK  •  JAPAN 2026 EDUCATIONAL IMMERSION",
  },
  floatingCta: { show: true, text: "REGISTER NOW", href: "#register" },
};

async function main() {
  const slug = process.env.TENANT_SLUG || "travel-stall";
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) {
    console.error(`[seed-japan-landing-page] tenant with slug="${slug}" not found.`);
    console.error('  Try `TENANT_SLUG=<existing-slug> node ...` or seed the tenant first.');
    process.exit(1);
  }

  const baseData = {
    title: "Japan 2026 — Educational Immersion",
    slug: "japan-2026",
    description: "9-day educational immersion across Tokyo, Mount Fuji, Kyoto, Osaka, and Nara.",
    // Phase D1: switch from block-array "travel_destination" to the
    // template-driven "educational-trip-v1". The renderer dispatches
    // automatically based on templateType.
    templateType: "educational-trip-v1",
    content: JSON.stringify(JAPAN_CONTENT),
    metaTitle: "Japan 2026 Educational Trip | The Modern Classroom",
    metaDescription:
      "9 days across Tokyo, Mount Fuji, Kyoto, Osaka, and Nara. Designed for Grades 6–12 with a 1:20 supervision ratio. Reserve your slot.",
    destination: "Japan",
    subBrand: "tmc",
    generatedByAi: false,
    tenantId: tenant.id,
  };

  const existing = await prisma.landingPage.findFirst({
    where: { tenantId: tenant.id, slug: "japan-2026" },
    select: { id: true, status: true, visits: true, submissions: true },
  });

  let row;
  if (existing) {
    row = await prisma.landingPage.update({
      where: { id: existing.id },
      data: baseData,
    });
    console.log(`[seed-japan-landing-page] updated existing row id=${row.id} (status=${existing.status}, visits=${existing.visits}, submissions=${existing.submissions} preserved)`);
  } else {
    row = await prisma.landingPage.create({
      data: { ...baseData, status: "DRAFT" },
    });
    console.log(`[seed-japan-landing-page] created new row id=${row.id} (status=DRAFT)`);
  }

  console.log(`[seed-japan-landing-page] preview URL: /p/${row.slug}`);
  console.log(`[seed-japan-landing-page] builder URL: /landing-pages/builder/${row.id}`);
  console.log(`[seed-japan-landing-page] templateType: ${baseData.templateType}`);
  console.log(`[seed-japan-landing-page] DONE.`);
}

main()
  .catch((err) => {
    console.error("[seed-japan-landing-page] FAILED:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
