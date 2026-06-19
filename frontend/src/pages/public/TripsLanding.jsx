// Public marketing landing page — Japan 2026 Educational Immersion Program
// Route: /trips — no auth, renders outside the CRM's AuthContext shell.

import { useState, useEffect } from "react";
import "./TripsLanding.css";

// ─── Static data ─────────────────────────────────────────────────────────────

const REGISTRATION_DEADLINE = new Date("2026-06-30T23:59:59+05:30");

const BENEFIT_CARDS = [
  { icon: "◈", title: "Global Confidence",   desc: "Composure and adaptability in unfamiliar environments." },
  { icon: "⊕", title: "Global Perspective",  desc: "Exposure to structured global systems and perspectives." },
  { icon: "⌂", title: "Cultural Awareness",  desc: "Deep appreciation of Japanese tradition and etiquette." },
  { icon: "❖", title: "Guided Independence", desc: "Freedom to explore within a safe, structured framework." },
];

const CITIES = [
  { tag: "ICONIC",           title: "Mount Fuji", img: "https://images.unsplash.com/photo-1490806843957-31f4c9a91c65?w=800&q=80" },
  { tag: "HERITAGE",         title: "Kyoto",      img: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=800&q=80" },
  { tag: "CULINARY",         title: "Osaka",      img: "https://images.unsplash.com/photo-1590559899731-a382839e5549?w=800&q=80" },
  { tag: "METROPOLIS",       title: "Tokyo",      img: "https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=800&q=80" },
  { tag: "LIVING REVERENCE", title: "Nara",       img: "https://images.unsplash.com/photo-1624253321171-1be53e12f5f4?w=800&q=80" },
];

const SafetyIcons = {
  shield: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  ),
  briefcase: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="12" y1="11" x2="12" y2="16" />
      <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
    </svg>
  ),
  send: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
  package: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  ),
  shieldCheck: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
};

const SAFETY = [
  { icon: SafetyIcons.shield,    title: "1:20 Teacher Ratio",       desc: "Trained Tour Directors with structured oversight" },
  { icon: SafetyIcons.briefcase, title: "4-Star Hotels",            desc: "Twin sharing rooms ensuring comfort and safety" },
  { icon: SafetyIcons.send,      title: "All Meals Included",       desc: "Mix of Indian, Continental, and Japanese cuisine" },
  { icon: SafetyIcons.package,   title: "International Flights",    desc: "Return international airfare included via Malaysia Airlines or equivalent full-service carriers" },
];

const INCLUDED = [
  "Return international airfare & Japan tourist visa processing",
  "4-Star hotels with twin sharing rooms",
  "All meals: Continental breakfast + Indian/Japanese cuisine",
  "All entrance fees and guided tours",
  "Bullet train experience (Tokyo to Kyoto)",
  "Travel insurance & dedicated tour directors",
  "Private coach with regulated driving hours",
  "Luggage courier support (Tokyo to Osaka)",
];

const REVIEWS = [
  { initial: "P", name: "PRIYA S.",  text: "Phenomenal work and meticulous planning by the entire team. They offer an incredible experiential learning approach that truly integrates outbound learning and life skills." },
  { initial: "R", name: "RAHUL M.",  text: "The personal involvement and genuineness of the staff gave us complete peace of mind. Safety was clearly their top priority, and the level of supervision was outstanding." },
  { initial: "A", name: "ANJALI K.", text: "A truly unique educational experience. The real-world learning and exposure to structured global cultures they provided was completely exceptional." },
];

const InvestIcons = {
  calendar: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  ),
  building: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="2" width="16" height="20" rx="1" />
      <line x1="9" y1="6" x2="9.01" y2="6" />
      <line x1="15" y1="6" x2="15.01" y2="6" />
      <line x1="9" y1="10" x2="9.01" y2="10" />
      <line x1="15" y1="10" x2="15.01" y2="10" />
      <line x1="9" y1="14" x2="9.01" y2="14" />
      <line x1="15" y1="14" x2="15.01" y2="14" />
      <path d="M10 22v-4h4v4" />
    </svg>
  ),
};

const TIERS = [
  {
    step: 1,
    title: "First Instalment",
    subtitle: "Registration Fee",
    amount: "₹34,980",
    tag: "Non-refundable",
    date: "30th June 2026",
    vendor: "TMC Nexus Pvt Ltd",
    startHere: true,
  },
  {
    step: 2,
    title: "Second Instalment",
    subtitle: "Mid-term Payment",
    amount: "₹1,00,000",
    date: "15th July 2026",
    vendor: "Travelstall",
  },
  {
    step: 3,
    title: "Third Instalment",
    subtitle: "Final Payment",
    amount: "₹1,75,000",
    date: "15th August 2026",
    vendor: "TMC Nexus Pvt Ltd",
  },
];

const INCLUSIONS = [
  "International airfare",
  "Accommodation",
  "Visa processing",
  "Internal transportation",
  "Supervision framework",
  "Cultural access",
];

const INFO_CARDS = [
  { title: "COMPLETE ITINERARY",   desc: "Review the detailed day-by-day schedule." },
  { title: "SAFETY FRAMEWORK",     desc: "Understand our strict 1:20 supervision protocols." },
  { title: "INVESTMENT STRUCTURE", desc: "See the full transparent financial breakdown." },
  { title: "LIVE Q&A",             desc: "Get all your specific questions answered directly." },
];

const SCHOOLS = ["Select school", "School of India", "DPS North", "DPS South", "DPS East", "DPS West"];
const BROCHURE_SCHOOLS = ["Select your school", "DPS", "School of India", "Other"];

// ─── FAQ data ────────────────────────────────────────────────────────────────

const FAQ_CATEGORIES = [
  { id: "all",          label: "ALL QUESTIONS",      icon: "📋" },
  { id: "tour",         label: "TOUR DETAILS",       icon: "📍" },
  { id: "payments",     label: "PAYMENTS & PRICING", icon: "💳" },
  { id: "safety",       label: "SAFETY & LOGISTICS", icon: "🛡" },
  { id: "registration", label: "REGISTRATION",       icon: "📝" },
];

const FAQS = [
  { cat: "tour", q: "How does this tour benefit students?",
    a: "Students gain global confidence, cultural awareness, systems thinking, and structured independence — outcomes that classroom learning alone cannot deliver. The 9-day immersion across 4 Japanese cities exposes them to one of the most disciplined societies on the planet." },
  { cat: "tour", q: "What cities are covered in this tour?",
    a: "Tokyo (Metropolis), Mount Fuji (Iconic), Kyoto (Heritage), Osaka (Culinary), and Nara (Living Reverence). Each city is selected for its specific educational and developmental outcome." },
  { cat: "tour", q: "When are the tour dates?",
    a: "The programme runs September – October 2026. Exact batch dates will be shared during the Parent Orientation session." },
  { cat: "tour", q: "Which grade students will be grouped together?",
    a: "Students from Grades 6 – 12 are eligible. Grouping is done by age band and school within each batch to ensure peer compatibility." },
  { cat: "tour", q: "What is the maximum group size?",
    a: "Each batch is limited to 45 students with a 1:20 teacher-to-student ratio, ensuring close supervision and meaningful interaction." },
  { cat: "tour", q: "Will there be shopping opportunities during the tour?",
    a: "Yes, supervised time in Dotonbori (Osaka) and select districts in Tokyo allows students to make budgeted, independent purchases — part of the structured-independence learning outcome." },
  { cat: "payments", q: "What is included in the tour cost?",
    a: "Return international airfare (Malaysia Airlines or equivalent), Japan tourist visa processing, 4-star twin-sharing accommodation, all meals, all entrance fees, guided tours, bullet train, travel insurance, dedicated tour directors, private coach, and luggage courier (Tokyo to Osaka)." },
  { cat: "payments", q: "What is NOT included in the cost?",
    a: "Personal shopping, optional excursions outside the published itinerary, additional travel insurance upgrades, and incidental expenses." },
  { cat: "payments", q: "What is the payment structure?",
    a: "Three instalments — ₹34,980 (Registration, by 30 June 2026, non-refundable, paid to TMC Nexus Pvt Ltd), ₹1,00,000 (Mid-term, by 15 July 2026, paid to Travelstall), ₹1,75,000 (Final, by 15 August 2026, paid to TMC Nexus Pvt Ltd)." },
  { cat: "payments", q: "What is the cancellation policy?",
    a: "Cancellations within 90 days of departure forfeit the registration fee. Cancellations within 45 days forfeit the mid-term instalment. Within 21 days, the full amount is non-refundable. Detailed terms shared during orientation." },
  { cat: "payments", q: "Are there any academic criteria for participation?",
    a: "There are no strict academic cut-offs. School recommendation and behavioural readiness for an international guided programme are considered during enrolment review." },
  { cat: "safety", q: "What are the safety protocols in place?",
    a: "A 1:20 trained tour director ratio, 24/7 emergency contact, GPS tracking, pre-vetted accommodation, comprehensive travel insurance, daily parent updates, and a documented incident-response framework. Every detail is engineered for safety." },
  { cat: "safety", q: "What documents are required for visa processing?",
    a: "Valid passport (6 months validity from return date), passport-size photos, school ID, parental consent letter, and bank statement. Our team handles the full visa application end-to-end after registration." },
  { cat: "safety", q: "How will meals be managed?",
    a: "All meals are included — Continental breakfast at hotels, and a curated mix of Indian, Continental, and Japanese cuisine for lunch and dinner. Dietary restrictions (vegetarian, allergies) are accommodated when shared at registration." },
  { cat: "safety", q: "What kind of hotels and room sharing can be expected?",
    a: "Pre-vetted 4-star hotels in central, safe locations across all four cities. Twin-sharing rooms with same-school / same-age-band peers. Teachers stay on the same floor." },
  { cat: "safety", q: "What kind of transportation will be used?",
    a: "Private chartered coaches between sites with regulated driving hours. Bullet train (Shinkansen) between Tokyo and Kyoto as an immersive experience. Internal flights only if itinerary requires it." },
  { cat: "safety", q: "Can parents contact their children during the trip?",
    a: "Yes. Each student gets a Japan-active SIM/eSIM. Tour directors share daily parent group updates with photos, location, and the day's summary at 8 PM IST." },
  { cat: "safety", q: "What support is offered for children with special needs?",
    a: "Please notify us at registration. We coordinate accommodations for medical, dietary, mobility, and learning support with our travel partners and tour directors before departure." },
  { cat: "registration", q: "How do I register my child for the tour?",
    a: "Fill out the Registration form on this page. Our team will reach out within 48 hours to confirm slot availability and guide you through the orientation session and payment process." },
  { cat: "registration", q: "What if my child doesn't have a passport?",
    a: "Apply for one immediately — the process takes 4 – 6 weeks in India. We provide an information sheet on the passport process and recommend starting as soon as you register." },
  { cat: "registration", q: "Will there be a pre-departure orientation for students and parents?",
    a: "Yes. A mandatory in-person orientation (Bengaluru) covers the full itinerary, packing list, emergency protocols, and student briefing. A virtual session is available for outstation families." },
  { cat: "registration", q: "How can parents stay updated during the tour?",
    a: "Daily WhatsApp updates from the tour director group, real-time GPS tracking access, and a 24/7 India-based emergency desk. Direct calls to your child are possible after 7 PM IST any day." },
  { cat: "registration", q: "Will the experience be captured or documented?",
    a: "Yes. A professional travel videographer documents each batch. Every student receives a personalised highlight reel and a printed Memory Book post-tour." },
  { cat: "registration", q: "Who can I contact for support or more information?",
    a: "Email mail@themodernclassroom.in or call 9900786677 / 9886753632 / 080 4371 2595 (Mon – Sat, 10 AM – 7 PM IST)." },
];

// ─── Cultural Highlights icons (thin line SVGs in gold) ──────────────────────

const ICONS = {
  tokyo: (
    <svg viewBox="0 0 40 50" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M20 2 L20 6" />
      <path d="M20 6 L14 50 L26 50 Z" />
      <line x1="16.5" y1="20" x2="23.5" y2="20" />
      <line x1="15.5" y1="30" x2="24.5" y2="30" />
      <line x1="14.5" y1="40" x2="25.5" y2="40" />
    </svg>
  ),
  fuji: (
    <svg viewBox="0 0 50 40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M4 36 L25 6 L46 36 Z" />
      <path d="M18 18 L25 10 L32 18" />
    </svg>
  ),
  kyoto: (
    <svg viewBox="0 0 50 40" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 8 Q25 -1 47 8" />
      <line x1="6" y1="13" x2="44" y2="13" />
      <line x1="13" y1="13" x2="13" y2="38" />
      <line x1="37" y1="13" x2="37" y2="38" />
    </svg>
  ),
  nara: (
    <svg viewBox="0 0 40 50" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <line x1="20" y1="2" x2="20" y2="8" />
      <line x1="10" y1="8" x2="30" y2="8" />
      <line x1="13" y1="12" x2="27" y2="12" />
      <line x1="13" y1="12" x2="13" y2="50" />
      <line x1="27" y1="12" x2="27" y2="50" />
      <line x1="13" y1="24" x2="27" y2="24" />
      <line x1="13" y1="38" x2="27" y2="38" />
    </svg>
  ),
  osaka: (
    <svg viewBox="0 0 40 50" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">
      <line x1="20" y1="2" x2="20" y2="8" />
      <line x1="14" y1="12" x2="26" y2="12" />
      <line x1="8" y1="18" x2="8" y2="28" />
      <line x1="32" y1="18" x2="32" y2="28" />
      <line x1="3" y1="28" x2="37" y2="28" />
      <line x1="11" y1="32" x2="11" y2="48" />
      <line x1="29" y1="32" x2="29" y2="48" />
      <line x1="6" y1="48" x2="34" y2="48" />
      <line x1="20" y1="32" x2="20" y2="48" />
    </svg>
  ),
};

const CULTURAL_HIGHLIGHTS = [
  {
    id: "tokyo",
    name: "Tokyo",
    label: "URBAN PRECISION",
    icon: ICONS.tokyo,
    body: [
      "Your child navigates one of the world's most complex cities with growing independence.",
      "From Asakusa Sensoji Temple to Shibuya Crossing, from school exchanges to TeamLab's digital universe, Tokyo teaches adaptability in real time.",
    ],
    benefit: "Exposure to structured complexity builds composure.",
  },
  {
    id: "fuji",
    name: "Mt. Fuji",
    label: "OBSERVING POWER",
    icon: ICONS.fuji,
    body: [
      "Standing at Mt. Fuji's 5th Station, students experience quiet strength.",
      "The Hakone Ropeway and Lake Ashi cruise teach something subtle. Profound experiences come from observing, not rushing.",
    ],
    benefit: "Depth over distraction.",
  },
  {
    id: "kyoto",
    name: "Kyoto",
    label: "CULTURAL CONTINUITY",
    icon: ICONS.kyoto,
    body: [
      "After boarding the Shinkansen at 320 km/h, students arrive in Japan's ancient capital.",
      "Dressed in kimono, walking temple grounds, they witness how tradition evolves without erasing its roots.",
    ],
    benefit: "Respect for legacy while embracing innovation.",
  },
  {
    id: "nara",
    name: "Nara",
    label: "LIVING REVERENCE",
    icon: ICONS.nara,
    body: [
      "At Todaiji Temple and among Nara's sacred deer, students encounter harmony and discipline.",
    ],
    benefit: "Understanding that respect can be institutionalized.",
  },
  {
    id: "osaka",
    name: "Osaka",
    label: "STRUCTURED INDEPENDENCE",
    icon: ICONS.osaka,
    body: [
      "From Umeda Sky Observatory to Universal Studios Japan, students explore freely within defined boundaries.",
      "With supervised budgeting systems in place, independence becomes tangible.",
    ],
    benefit: "Confidence under guidance.",
  },
];

function pad(n) { return String(n).padStart(2, "0"); }

// ─── Component ───────────────────────────────────────────────────────────────

export default function TripsLanding() {
  // Live countdown
  const [cd, setCd] = useState({ d: "00", h: "00", m: "00", s: "00" });
  useEffect(() => {
    function tick() {
      const diff = Math.max(0, REGISTRATION_DEADLINE.getTime() - Date.now());
      setCd({
        d: pad(Math.floor(diff / 86400000)),
        h: pad(Math.floor(diff / 3600000) % 24),
        m: pad(Math.floor(diff / 60000) % 60),
        s: pad(Math.floor(diff / 1000) % 60),
      });
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Registration form (2-step)
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [fd, setFd] = useState({
    studentName: "", grade: "", school: "",
    parentName: "", phone: "", email: "", city: "",
  });
  const setF = (k) => (e) => setFd((p) => ({ ...p, [k]: e.target.value }));

  async function submitReg(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await fetch("/api/travel/inbound/leads/web_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: "travel-stall",
          subBrand: "tmc",
          name: fd.parentName || fd.studentName,
          email: fd.email,
          phone: fd.phone,
          source: "tmc_registration",
          landingPage: "/trips",
          metaJson: JSON.stringify({
            studentName: fd.studentName,
            grade: fd.grade,
            school: fd.school,
            city: fd.city,
          }),
        }),
      });
    } catch (_) {
      // Best-effort lead capture; always show success
    }
    setSubmitting(false);
    setSubmitted(true);
  }

  // Brochure form
  const [bf, setBf] = useState({ parentName: "", phone: "", school: "", email: "" });
  const setB = (k) => (e) => setBf((p) => ({ ...p, [k]: e.target.value }));
  const [brochureDone, setBrochureDone] = useState(false);

  // FAQ filter + search + open accordion
  const [faqCat, setFaqCat] = useState("all");
  const [faqQuery, setFaqQuery] = useState("");
  const [faqOpen, setFaqOpen] = useState(null);
  const visibleFaqs = FAQS
    .filter((f) => faqCat === "all" || f.cat === faqCat)
    .filter((f) =>
      !faqQuery.trim()
        ? true
        : (f.q + " " + f.a).toLowerCase().includes(faqQuery.trim().toLowerCase())
    );
  const faqCountByCat = FAQ_CATEGORIES.reduce((acc, c) => {
    acc[c.id] = c.id === "all" ? FAQS.length : FAQS.filter((f) => f.cat === c.id).length;
    return acc;
  }, {});

  async function submitBrochure(e) {
    e.preventDefault();
    try {
      await fetch("/api/travel/inbound/leads/web_form", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantSlug: "travel-stall",
          subBrand: "tmc",
          name: bf.parentName,
          email: bf.email,
          phone: bf.phone,
          source: "brochure_request",
          landingPage: "/trips",
          metaJson: JSON.stringify({ school: bf.school }),
        }),
      });
    } catch (_) {
      // Best-effort
    }
    setBrochureDone(true);
    setTimeout(() => {
      setBrochureDone(false);
      setBf({ parentName: "", phone: "", school: "", email: "" });
    }, 3000);
  }

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="trips-page">

      {/* NAV */}
      <header className="t-nav">
        <div className="t-nav-inner">
          <a className="t-brand" href="#">
            <span className="t-jp">日本</span> JAPAN 2026
          </a>
          <nav className="t-links">
            <a href="#programme">Programme</a>
            <a href="#safety">Safety</a>
            <a href="#investment">Investment</a>
            <a href="#faqs">FAQs</a>
          </nav>
          <a className="t-btn t-btn-primary" href="#register">Register Now</a>
        </div>
      </header>

      {/* HERO */}
      <section className="t-hero">
        <span className="t-kanji-wm t-kanji-left">成長</span>
        <div className="t-hero-grid">
          <div className="t-hero-copy">
            <div className="t-partners">
              <img src="/partner-school.png"  alt="School"               className="t-partner-logo" onError={(e) => (e.currentTarget.style.display = "none")} />
              <img src="/partner-soi.png"     alt="School of India"      className="t-partner-logo" onError={(e) => (e.currentTarget.style.display = "none")} />
              <img src="/partner-tmc.png"     alt="The Modern Classroom" className="t-partner-logo" onError={(e) => (e.currentTarget.style.display = "none")} />
            </div>

            <div className="t-eyebrow">
              <span>SEPT – OCT 2026</span>
              <span className="t-sep">|</span>
              <span>GRADES 6-12</span>
              <span className="t-pill">Limited to 45 Students per Batch</span>
            </div>
            <p className="t-hero-kicker">09 Days. 04 Cities.</p>
            <h1>Where Exposure<br />Becomes Perspective</h1>
            <p className="t-lede">
              Observe how disciplined societies think, organize, and operate. This is not
              tourism, but structured, guided international immersion.
            </p>

            <div className="t-cards">
              {BENEFIT_CARDS.map(({ icon, title, desc }) => (
                <div className="t-card" key={title}>
                  <div className="t-card-icon">{icon}</div>
                  <h3>{title}</h3>
                  <p>{desc}</p>
                </div>
              ))}
            </div>

            <div className="t-countdown">
              <p className="t-cd-label">PARENT ORIENTATION REGISTRATION CLOSES IN</p>
              <div className="t-cd-clock">
                <div className="t-cd-unit"><span>{cd.d}</span><small>DAYS</small></div>
                <i>:</i>
                <div className="t-cd-unit"><span>{cd.h}</span><small>HOURS</small></div>
                <i>:</i>
                <div className="t-cd-unit"><span>{cd.m}</span><small>MINUTES</small></div>
                <i>:</i>
                <div className="t-cd-unit"><span>{cd.s}</span><small>SECONDS</small></div>
              </div>
              <a className="t-btn t-btn-primary t-cd-cta" href="#register">Attend Parent Orientation</a>
            </div>
          </div>

          <aside className="t-hero-visual">
            <p className="t-visual-title">Japan 2026 Educational Immersion Program</p>
            <p className="t-visual-sub">
              A Structured Journey into Discipline, Culture, and Independent Thinking
            </p>
            <div className="t-poster">
              <img
                src="/japan_hero.webp"
                alt="Mount Fuji with red sun, traditional pagoda, and cherry blossoms"
              />
            </div>
          </aside>
        </div>
      </section>

      {/* SCROLLING PHOTO STRIP */}
      <div className="t-photo-strip">
        <div className="t-photo-strip-track">
          {[...CITIES, ...CITIES].map(({ tag, title, img }, i) => (
            <div
              className="t-photo-strip-card"
              key={i}
              style={{ backgroundImage: `url('${img}')` }}
            >
              <div className="t-pcard-grad" />
              <div className="t-pcard-cap">
                <span className="t-pcat">{tag}</span>
                <h3>{title}</h3>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* INTERACTIVE PREVIEW (video) */}
      <section className="t-preview">
        <span className="t-kanji-wm t-kanji-right">体験</span>
        <div className="t-wrap t-center">
          <p className="t-tag t-tag-red">INTERACTIVE PREVIEW</p>
          <h2 className="t-preview-title">
            See the Experience<br />Before You Decide.
          </h2>
          <p className="t-muted t-preview-sub">
            Before reading further, take a moment to see what this journey feels like.
          </p>

          <div className="t-preview-quote">
            <span className="t-quote-line" />
            <p>
              Notice the precision. The structure. The quiet discipline.<br />
              This is not tourism. It is structured exposure.
            </p>
            <span className="t-quote-line" />
          </div>

          <div className="t-video-frame">
            <div className="t-video-wrap">
              <iframe
                className="t-video-iframe"
                src="https://fast.wistia.net/embed/iframe/zwq5w6rf4r?seo=true&videoFoam=true"
                title="Japan 2026 Educational Immersion Program | The Modern Classroom"
                allow="autoplay; fullscreen; picture-in-picture"
                allowFullScreen
                frameBorder="0"
                scrolling="no"
              />
            </div>
          </div>

          <a className="t-btn t-btn-primary t-preview-cta" href="#register">
            REGISTER FOR PARENT ORIENTATION
          </a>
        </div>
      </section>

      {/* WHY / PROGRAMME */}
      <section className="t-why" id="programme">
        <span className="t-kanji-wm t-kanji-right">洞察</span>
        <div className="t-wrap">
          <div className="t-why-grid">
            <div className="t-why-left">
              <h2>Because Academics Alone<br />Are No Longer Enough.</h2>
              <div className="t-why-divider" />
              <p>
                Your child lives in a world that rewards more than grades. It rewards
                adaptability, cultural awareness, and composure under uncertainty.
              </p>
              <p>
                Yet most exposure today is filtered through screens. Real-world systems
                thinking is rarely observed firsthand.
              </p>
              <p>
                Japan offers a rare opportunity to experience a society where heritage and
                innovation evolve together.
              </p>
            </div>

            <aside className="t-why-card">
              <h3>What Students Gain</h3>
              <p className="t-why-card-quote">
                Students do not simply see Japan. They observe systems. They experience
                discipline. They learn through immersion.
              </p>
              <ul className="t-checks">
                <li>Confidence in unfamiliar environments</li>
                <li>Exposure to structured global systems</li>
                <li>Cultural awareness beyond textbooks</li>
                <li>Guided independence within supervision</li>
              </ul>
            </aside>
          </div>

          <div className="t-why-cta">
            <div className="t-why-cta-content">
              <h3>See the Structure. Ask Your Questions. Decide with Confidence.</h3>
              <p>
                The Parent Orientation walks you through the itinerary, safety protocols,
                supervision and investment, clearly and transparently.
              </p>
            </div>
            <a href="#register" className="t-btn t-btn-primary">Attend the Orientation Session</a>
          </div>
        </div>
      </section>

      {/* CULTURAL HIGHLIGHTS — hover-reveal cards */}
      <section className="t-cultural" id="cultural">
        <span className="t-kanji-wm t-kanji-left">文化</span>
        <div className="t-wrap">
          <p className="t-tag t-tag-red t-center">文化 &nbsp; CULTURAL HIGHLIGHTS</p>
          <h2 className="t-center t-cultural-title">Cultural Highlights</h2>
          <p className="t-muted t-center t-cultural-sub">
            Each location is selected not for tourism, but for its specific educational and
            developmental outcome.
          </p>

          <div className="t-ch-grid">
            {CULTURAL_HIGHLIGHTS.map((c) => (
              <article className="t-ch-card" key={c.id} tabIndex={0}>
                <div className="t-ch-front">
                  <div className="t-ch-icon" aria-hidden="true">{c.icon}</div>
                  <h3>{c.name}</h3>
                  <div className="t-ch-underline" />
                </div>
                <div className="t-ch-back">
                  <h3>{c.name}</h3>
                  <p className="t-ch-label">{c.label}</p>
                  <div className="t-ch-body">
                    {c.body.map((p, i) => <p key={i}>{p}</p>)}
                  </div>
                  <div className="t-ch-benefit">
                    <span>DERIVED BENEFIT</span>
                    <em>&ldquo;{c.benefit}&rdquo;</em>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <div className="t-ch-cta">
            <div className="t-why-cta">
              <div className="t-why-cta-content">
                <h3>Every Location Has a Purpose.</h3>
                <p>
                  See how this 9-day journey is academically structured, supervised, and
                  outcome-driven.
                </p>
              </div>
              <a href="#register" className="t-btn t-btn-primary">
                Reserve Your Orientation Seat
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* SAFETY (dark) */}
      <section className="t-safety" id="safety">
        <div className="t-wrap">
          <h2 className="t-center t-light">Engineered for Safety. Designed for Growth.</h2>
          <p className="t-muted t-center t-light">
            Your child&apos;s safety and well-being are non-negotiable. Every element has been
            designed with care.
          </p>

          <div className="t-safety-grid">
            {SAFETY.map(({ icon, title, desc }) => (
              <div className="t-sfeat" key={title}>
                <div className="t-sfeat-icon" aria-hidden="true">{icon}</div>
                <h4>{title}</h4>
                <p>{desc}</p>
              </div>
            ))}
          </div>

          <div className="t-included">
            <h3>What&apos;s Included</h3>
            <div className="t-inc-grid">
              {INCLUDED.map((item) => (
                <div className="t-inc-item" key={item}>
                  <span className="t-inc-check" aria-hidden="true">{SafetyIcons.check}</span>
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="t-safety-banner">
            <div className="t-sb-icon" aria-hidden="true">{SafetyIcons.shieldCheck}</div>
            <div className="t-sb-content">
              <h3>Your Child&apos;s Safety is Guaranteed</h3>
              <p>1:20 student-to-teacher ratio, 4-star hotels, comprehensive insurance. Every detail covered.</p>
            </div>
            <a href="#register" className="t-btn t-btn-primary">Register for Orientation →</a>
          </div>

          <p className="t-safety-quote">
            Independence within structure. Freedom within supervision.
          </p>
        </div>
      </section>

      {/* REVIEWS */}
      <section className="t-reviews">
        <div className="t-wrap">
          <h2 className="t-center">They Returned More Independent. More Composed.</h2>
          <div className="t-review-grid">
            {REVIEWS.map(({ initial, name, text }) => (
              <article className="t-review" key={name}>
                <div className="t-stars">★★★★★</div>
                <span className="t-quote-mark">”</span>
                <p>&ldquo;{text}&rdquo;</p>
                <div className="t-reviewer">
                  <span className="t-avatar">{initial}</span>
                  <div>
                    <b>{name}</b>
                    <small>Google Review</small>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <div className="t-cta-band">
            <div>
              <h3>Growth Is Designed Not Accidental.</h3>
              <p className="t-muted">
                Join the Parent Orientation to see how supervision, structure, and exposure
                work together.
              </p>
            </div>
            <a className="t-btn t-btn-primary" href="#register">Reserve Your Orientation Seat</a>
          </div>
        </div>
      </section>

      {/* INVESTMENT */}
      <section className="t-invest" id="investment">
        <div className="t-wrap">
          <p className="t-tag t-center">投資 &nbsp; TRANSPARENT PROGRAMME INVESTMENT</p>
          <h2 className="t-center t-invest-title">Transparent Programme Investment</h2>
          <div className="t-invest-divider" />
          <p className="t-muted t-center t-invest-sub">
            The complete cost structure, inclusions, and instalment details will be
            explained during the parent orientation session.
          </p>

          <div className="t-tiers">
            {TIERS.map((tier) => (
              <div
                className={`t-tier${tier.startHere ? " t-tier-start" : ""}`}
                key={tier.step}
              >
                {tier.startHere && <span className="t-tier-badge">START HERE</span>}
                <div className="t-tier-head">
                  <span className="t-tier-num">{tier.step}</span>
                  <div className="t-tier-titles">
                    <h4>{tier.title}</h4>
                    <small>{tier.subtitle}</small>
                  </div>
                </div>
                <p className="t-tier-amount">{tier.amount}</p>
                {tier.tag && <span className="t-tier-tag">{tier.tag}</span>}
                <div className="t-tier-meta">
                  <p><span className="t-tier-ico">{InvestIcons.calendar}</span> {tier.date}</p>
                  <p><span className="t-tier-ico">{InvestIcons.building}</span> {tier.vendor}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="t-inclusions">
            <p className="t-inclusions-label">INDICATIVE INCLUSIONS</p>
            <div className="t-inclusions-grid">
              {INCLUSIONS.map((item) => (
                <div className="t-inc-bullet" key={item}>
                  <span className="t-inc-square" aria-hidden="true" />
                  <span>{item}</span>
                </div>
              ))}
            </div>
          </div>

          <p className="t-invest-foot">
            All financial details will be shared transparently during orientation.
          </p>

          <div className="t-invest-cta">
            <div className="t-why-cta">
              <div className="t-why-cta-content">
                <h3>Transparency First. Commitment Later.</h3>
                <p>
                  Attend the Parent Orientation to review the complete cost structure and
                  ask your questions directly.
                </p>
              </div>
              <a href="#register" className="t-btn t-btn-primary">
                Reserve Your Orientation Seat
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* REGISTRATION */}
      <section className="t-register" id="register">
        <div className="t-wrap t-narrow">
          <p className="t-tag t-center">登録 &nbsp; REGISTRATION</p>
          <h2 className="t-center">Register for the Parent Orientation</h2>
          <p className="t-muted t-center">
            Reserve your seat — we&apos;ll cover the itinerary, safety protocols, supervision and
            investment, transparently.
          </p>

          {submitted ? (
            <div className="t-success">
              <div className="t-success-icon">✓</div>
              <h3>Registration Submitted!</h3>
              <p>
                Our team will contact you within 24 hours to confirm your slot and share
                next steps.
              </p>
            </div>
          ) : (
            <form
              className="t-form"
              onSubmit={
                step === 1
                  ? (e) => { e.preventDefault(); setStep(2); }
                  : submitReg
              }
            >
              <div className="t-form-progress" aria-label={`Step ${step} of 3`}>
                <span className={`t-form-bar${step >= 1 ? " t-form-bar-active" : ""}`} />
                <span className={`t-form-bar${step >= 2 ? " t-form-bar-active" : ""}`} />
                <span className={`t-form-bar${step >= 3 ? " t-form-bar-active" : ""}`} />
              </div>

              {step === 1 ? (
                <>
                  <h3 className="t-step-title">Step 1: Student Information</h3>
                  <label>
                    <span className="t-label-text">Student Full Name <span className="t-req">*</span></span>
                    <input type="text" placeholder="Enter student's full name"
                      value={fd.studentName} onChange={setF("studentName")} required />
                  </label>
                  <label>
                    <span className="t-label-text">Grade <span className="t-req">*</span></span>
                    <input type="text" placeholder="e.g., 8th Grade"
                      value={fd.grade} onChange={setF("grade")} required />
                  </label>
                  <label>
                    <span className="t-label-text">School <span className="t-req">*</span></span>
                    <select value={fd.school} onChange={setF("school")} required>
                      {SCHOOLS.map((s) => (
                        <option key={s} value={s === "Select school" ? "" : s}>{s}</option>
                      ))}
                    </select>
                  </label>
                  <button className="t-btn t-btn-dark t-wide" type="submit">Next →</button>
                  <p className="t-form-secure">
                    Your data is secure. You will be redirected to the confirmation page.
                  </p>
                </>
              ) : (
                <>
                  <h3 className="t-step-title">Step 2: Parent / Guardian Details</h3>
                  <label>
                    <span className="t-label-text">Parent / Guardian Name <span className="t-req">*</span></span>
                    <input type="text" placeholder="Enter parent's full name"
                      value={fd.parentName} onChange={setF("parentName")} required />
                  </label>
                  <label>
                    <span className="t-label-text">Mobile Number <span className="t-req">*</span></span>
                    <input type="tel" placeholder="+91 98765 43210"
                      value={fd.phone} onChange={setF("phone")} required />
                  </label>
                  <label>
                    <span className="t-label-text">Email Address <span className="t-req">*</span></span>
                    <input type="email" placeholder="you@email.com"
                      value={fd.email} onChange={setF("email")} required />
                  </label>
                  <label>
                    <span className="t-label-text">City</span>
                    <input type="text" placeholder="e.g., Bangalore"
                      value={fd.city} onChange={setF("city")} />
                  </label>
                  <div className="t-form-row">
                    <button className="t-btn t-btn-outline" type="button" onClick={() => setStep(1)}>
                      ← Back
                    </button>
                    <button className="t-btn t-btn-dark" type="submit" disabled={submitting}>
                      {submitting ? "Submitting…" : "Confirm Registration →"}
                    </button>
                  </div>
                  <p className="t-form-secure">
                    Your data is secure. You will be redirected to the confirmation page.
                  </p>
                </>
              )}
            </form>
          )}
        </div>
      </section>

      {/* BROCHURE */}
      <section className="t-brochure">
        <div className="t-wrap">
          <div className="t-info-cards">
            {INFO_CARDS.map(({ title, desc }) => (
              <div className="t-info-card" key={title}>
                <b>{title}</b>
                <p>{desc}</p>
              </div>
            ))}
          </div>

          {/* Title block — sits on the section background, no card */}
          <div className="t-brochure-head t-center">
            <span className="t-still-pill">STILL EXPLORING?</span>
            <h2 className="t-center">Download the Detailed Programme Overview.</h2>
          </div>

          {/* Info card — white box with subtitle + "SELECT YOUR SCHOOL..." divider */}
          <div className="t-brochure-info">
            <p className="t-muted t-center">
              If you would prefer to review the complete itinerary, inclusions, safety
              framework, and payment structure before attending the orientation, you may
              request the official brochure.
            </p>
            <div className="t-school-divider">
              <span className="t-school-line" />
              <span className="t-school-text">
                SELECT YOUR SCHOOL TO RECEIVE THE RESPECTIVE VERSION OF THE ITINERARY
              </span>
              <span className="t-school-line" />
            </div>
          </div>

          {/* Form card — separate white card with red left border */}
          <div className="t-brochure-card">
            <form className="t-form t-brochure-form" onSubmit={submitBrochure}>
              <label>
                <span className="t-label-text">PARENT&apos;S NAME</span>
                <input type="text" placeholder="Enter full name" required
                  value={bf.parentName} onChange={setB("parentName")} />
              </label>
              <label>
                <span className="t-label-text">PHONE NUMBER</span>
                <input type="tel" placeholder="+91" required
                  value={bf.phone} onChange={setB("phone")} />
              </label>
              <label>
                <span className="t-label-text">SELECT SCHOOL</span>
                <select value={bf.school} onChange={setB("school")}>
                  {BROCHURE_SCHOOLS.map((s) => (
                    <option key={s} value={s === "Select your school" ? "" : s}>{s}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="t-label-text">PARENT&apos;S EMAIL</span>
                <input type="email" placeholder="Enter email address" required
                  value={bf.email} onChange={setB("email")} />
              </label>
              <button className="t-btn t-btn-primary t-wide" type="submit" disabled={brochureDone}>
                {brochureDone ? "✓ Brochure Request Sent!" : "DOWNLOAD PROGRAMME BROCHURE →"}
              </button>
              <p className="t-brochure-note">No obligation. For informed decision-making.</p>
            </form>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="t-faqs" id="faqs">
        <span className="t-kanji-wm t-kanji-left">質問</span>
        <div className="t-wrap">
          <p className="t-tag t-tag-red t-center">CLARIFICATIONS</p>
          <h2 className="t-center t-faq-title">Frequently Asked Questions</h2>
          <div className="t-faq-divider" />
          <p className="t-muted t-center t-faq-sub">
            Everything you need to know about the Japan 2026 tour
          </p>

          <div className="t-faq-search">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search questions..."
              value={faqQuery}
              onChange={(e) => setFaqQuery(e.target.value)}
            />
          </div>

          <div className="t-faq-tabs">
            {FAQ_CATEGORIES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`t-faq-tab${faqCat === c.id ? " t-faq-tab-active" : ""}`}
                onClick={() => { setFaqCat(c.id); setFaqOpen(null); }}
              >
                <span className="t-faq-tab-icon" aria-hidden="true">{c.icon}</span>
                <span className="t-faq-tab-label">{c.label}</span>
                <span className="t-faq-tab-count">{faqCountByCat[c.id]}</span>
              </button>
            ))}
          </div>

          <div className="t-faq-list">
            {visibleFaqs.length === 0 ? (
              <p className="t-faq-empty">No questions match your search.</p>
            ) : (
              visibleFaqs.map((f, idx) => {
                const id = `${f.cat}-${idx}`;
                const open = faqOpen === id;
                return (
                  <div className={`t-faq-item${open ? " t-faq-item-open" : ""}`} key={id}>
                    <button
                      type="button"
                      className="t-faq-q"
                      onClick={() => setFaqOpen(open ? null : id)}
                      aria-expanded={open}
                    >
                      <span>{f.q}</span>
                      <span className="t-faq-chevron" aria-hidden="true">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </span>
                    </button>
                    {open && <div className="t-faq-a">{f.a}</div>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* DETAILS THAT MATTER — red CTA strip */}
      <section className="t-details">
        <div className="t-wrap t-center">
          <h2 className="t-details-title">The Details That Matter</h2>
          <div className="t-details-divider" />
          <div className="t-details-pill-row">
            <span className="t-details-pill">09 DAYS. 04 CITIES.</span>
            <span className="t-details-pill-line" />
            <em className="t-details-tagline">One Transformational Educational Journey.</em>
          </div>
          <div className="t-details-steps">
            <div className="t-details-step">
              <span className="t-details-num">1</span>
              <span className="t-details-label">Join Parent Orientation</span>
            </div>
            <span className="t-details-arrow">→</span>
            <div className="t-details-step">
              <span className="t-details-num">2</span>
              <span className="t-details-label">Review the framework</span>
            </div>
            <span className="t-details-arrow">→</span>
            <div className="t-details-step">
              <span className="t-details-num">3</span>
              <span className="t-details-label">Decide with clarity</span>
            </div>
          </div>
          <a href="#register" className="t-details-cta">REGISTER FOR THE PARENT ORIENTATION</a>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="t-foot">
        <div className="t-foot-top t-center">
          <h3 className="t-foot-title">
            <span className="t-jp">日本</span> JAPAN 2026
          </h3>
          <p className="t-foot-tagline">Where Precision Fuels Possibility</p>
          <img
            src="/tmc-logo.png"
            alt="The Modern Classroom"
            className="t-foot-logo"
          />
        </div>

        <div className="t-wrap t-foot-grid">
          <div>
            <p className="t-foot-h">EMAIL INQUIRIES</p>
            <p>mail@themodernclassroom.in</p>
          </div>
          <div>
            <p className="t-foot-h">DIRECT CONTACT</p>
            <p>9900786677 &nbsp;|&nbsp; 9886753632<br />080 4371 2595</p>
          </div>
        </div>

        <p className="t-copy">
          © 2026 THE MODERN CLASSROOM &nbsp;•&nbsp; 1:20 SUPERVISION FRAMEWORK &nbsp;•&nbsp; JAPAN 2026 EDUCATIONAL IMMERSION
        </p>
      </footer>

      {/* FLOATING REGISTER CTA */}
      <a className="t-float-register" href="#register">
        <span className="t-dot" /> REGISTER NOW
      </a>
    </div>
  );
}
