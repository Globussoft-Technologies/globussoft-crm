// Public TMC Readiness Report — the school-facing 10-section readiness
// profile rendered from the saved diagnostic JSON (PRD §3.5 / slice T10).
//
// Lives at /p/tmc/report/:slug (no auth, renders outside AuthContext shell).
// T9's form navigates here on POST 201 → `${diagnosticId}-${hex}` slug.
//
// HARD CONTRACT:
//   * NO LLM call at render time. The Job A narrative is pre-rendered on
//     the backend during the submit-tmc flow (T8 endpoint) + persisted /
//     served through the data endpoint. This page is a pure renderer.
//   * Renders the §3.5 10-section template verbatim (cover / ambition /
//     readiness profile / what becomes possible / cost of waiting /
//     peer-proof / institutional benefit / assurance / how TMC works /
//     single CTA).
//   * Standing facts (§3.5.5) are LITERAL constants here — peer-proof
//     numbers NEVER inflated, NEVER blended (§11.4 honest-at-305 rule).
//   * Board hook (§3.5.1) selected per curriculum answer — IB never sees
//     NEP (AC-3). Map mirrors backend `DEFAULT_STANDING_FACTS.board_policy_hooks`.
//   * Runway display (§3.5.2) selected per geo_preference. Map mirrors
//     backend `DEFAULT_STANDING_FACTS.runway`.
//   * §11.3 calm-institutional voice on the CTA — no countdown timers, no
//     urgency, no "limited spots."
//   * Theme-variable colors per CLAUDE.md standing rule: primary CTAs use
//     `var(--primary-color, var(--accent-color))` so wellness-themed
//     embedders don't render salmon CTAs.
//
// DATA SOURCE:
//   Calls public JSON endpoint `GET /api/travel/diagnostics/public/readiness-report/:slug`
//   for the saved diagnostic shape (school answers + engine output + persisted
//   narrative). That endpoint is a follow-up to T10 — the slice doesn't ship
//   it in this commit; this page is wired to it so the next slice that lands
//   the endpoint completes the chain with zero frontend churn. While the
//   endpoint is missing the page degrades gracefully to the "Report being
//   generated, please try again in a moment" fallback per slice contract.
//
// PDF DOWNLOAD:
//   Button calls `GET /api/travel/diagnostics/:id/readiness-report.pdf`
//   (T8 shipped, public, returns application/pdf). The id is extracted
//   from the slug — slug shape is `${diagnosticId}-${8-byte-hex}` per
//   T8's buildReportSlug helper.
//
// BOOKING CTA (DD-5.4):
//   Wired to `import.meta.env.VITE_TMC_BOOKING_URL` (Calendly / Google Meet
//   slot picker URL). When absent the button reads "Book a 30-minute
//   consultation with our team." with mailto fallback wired to the contact
//   email in the saved diagnostic. The actual Calendar API slot-picker
//   integration tracks as a follow-up — DD-5.4 explicitly accepts the
//   config-driven URL as the MVD path.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  GraduationCap,
  Download,
  Calendar,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

// ─── §3.5.5 standing facts — LITERAL constants. Never inflated. ─────
//
// Mirrors backend/routes/travel_diagnostics.js DEFAULT_STANDING_FACTS so a
// future Yasin update is a 2-file change. PRD §11.4 rule: 305 / 14018 /
// 12055 / 1658 / over 50 / more than 100,000 are renderer-injected verbatim,
// never blended with all-time totals.
const STANDING_FACTS = Object.freeze({
  trust: {
    schools_served_since_2015: "over 50",
    students_moved_since_2015: "more than 100,000",
    students_moved_last_year: 14018,
    day_students_last_year: 12055,
    overnight_students_last_year: 1658,
    international_students_last_year: 305,
    operating_since: 2015,
    teacher_student_ratio: "1 teacher per 15 students",
  },
  runway: {
    day:             { lead_days:   7, display: "about 1 week" },
    domestic_bus:    { lead_days:  30, display: "about 1 month" },
    domestic_flight: { lead_days:  90, display: "minimum 90 days" },
    international:   { lead_days: 180, display: "minimum 4 to 6 months" },
  },
  board_policy_hooks: {
    "CBSE":      "Maps to NEP 2020 + NCF-SE 2023 + CBSE Experiential Learning Handbook — experiential learning as standard pedagogy.",
    "ICSE_ISC":  "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "ICSE":      "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "ISC":       "Aligns to CISCE's project-work assessment + SUPW mandate; geography fieldwork as core internal-assessment surface.",
    "IGCSE":     "Aligns to the Cambridge Learner Attributes; Geography 0460 fieldwork + Science practical assessment surfaces.",
    "IB":        "Anchored on CAS (Creativity, Activity, Service) + the IB Learner Profile; transdisciplinary inquiry the trip directly serves.",
    "State Board": "Generic experiential-learning case; named-policy citation withheld until state's NEP adoption is confirmed.",
  },
});

// PRD §3.5.2 — runway key by geo_preference. Mirrors backend resolveRunwayKey.
function resolveRunwayKey(geoPreference) {
  if (geoPreference === "day") return "day";
  if (geoPreference === "domestic") return "domestic_flight";
  if (geoPreference === "international") return "international";
  if (geoPreference === "open") return "international";
  return "domestic_flight";
}

function resolveRunwayDisplay(geoPreference) {
  const key = resolveRunwayKey(geoPreference);
  const entry = STANDING_FACTS.runway[key];
  return entry ? entry.display : "";
}

// PRD §3.5.1 — multi-board schools see all selected hooks stacked
// (PRD §9 open question 1 default proposal).  IB-never-sees-NEP is
// structurally enforced by the map itself (NEP only appears in CBSE row).
function resolveBoardHooks(curriculum) {
  const list = Array.isArray(curriculum) ? curriculum : (curriculum ? [curriculum] : []);
  const out = [];
  for (const board of list) {
    const k = String(board || "").trim();
    if (!k) continue;
    if (STANDING_FACTS.board_policy_hooks[k]) {
      out.push({ board: k, hook: STANDING_FACTS.board_policy_hooks[k] });
    }
  }
  return out;
}

// Slug → diagnosticId.  Slug shape: `${id}-${hex}` per T8's
// buildReportSlug.  Returns null if malformed (page renders fallback).
function parseDiagnosticId(slug) {
  if (typeof slug !== "string") return null;
  const m = slug.match(/^(\d+)(?:-|$)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

// Q1 primary_outcome value → human-readable phrase. Mirrors the T9
// option labels exactly so the ambition restatement reads back what
// the school typed.
const PRIMARY_OUTCOME_LABEL = {
  confidence: "confidence",
  curiosity: "curiosity",
  empathy: "empathy",
  global_awareness: "global awareness",
  resilience: "resilience",
  pride: "pride",
};

// Q3 growth_area value → human-readable phrase.
const GROWTH_AREA_LABEL = {
  speaking_up: "speaking up in unfamiliar settings",
  handling_setbacks: "handling setbacks without giving up",
  comfort_with_difference: "comfort with people unlike themselves",
  working_with_peers: "working effectively with peers they didn't choose",
  curiosity_beyond_syllabus: "curiosity that survives beyond the syllabus",
  noticing_others: "noticing what others are feeling",
  attention_to_now: "slowing down and paying attention to the present",
};

function humanise(value, table, fallback = "") {
  if (!value) return fallback;
  return table[value] || String(value).replace(/_/g, " ");
}

export default function TmcReadinessReport() {
  const { slug } = useParams();
  const diagnosticId = useMemo(() => parseDiagnosticId(slug), [slug]);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      if (!slug || diagnosticId == null) {
        setError("This report link looks malformed. Please check the URL.");
        setLoading(false);
        return;
      }
      try {
        const r = await fetch(
          `/api/travel/diagnostics/public/readiness-report/${encodeURIComponent(slug)}`,
        );
        if (!r.ok) {
          if (cancelled) return;
          // 404 or 503 → the diagnostic isn't yet visible. Tell the user
          // calmly. The submit endpoint already returned 201, so the row
          // exists; this is a propagation / endpoint-not-yet-deployed
          // race per slice contract.
          setError(
            "Report being generated, please try again in a moment.",
          );
          setLoading(false);
          return;
        }
        const body = await r.json();
        if (cancelled) return;
        setData(body);
        setLoading(false);
      } catch {
        if (cancelled) return;
        setError("Report being generated, please try again in a moment.");
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [slug, diagnosticId]);

  // ─── Loading state ──────────────────────────────────────────────
  if (loading) {
    return (
      <Shell>
        <div role="status" aria-live="polite" style={loadingBlock}>
          <CheckCircle2 size={20} aria-hidden style={{ color: "#5a6275" }} />
          <span>Loading your readiness profile…</span>
        </div>
      </Shell>
    );
  }

  // ─── Error / not-yet-ready fallback ─────────────────────────────
  if (error || !data) {
    return (
      <Shell>
        <div role="alert" style={errorBlock}>
          <AlertCircle size={20} aria-hidden style={{ color: "#7a1f1f" }} />
          <div>
            <strong>We're still preparing your report.</strong>
            <p style={{ margin: "6px 0 0", lineHeight: 1.5 }}>{error || "Report being generated, please try again in a moment."}</p>
          </div>
        </div>
      </Shell>
    );
  }

  // ─── Render the 10-section template ─────────────────────────────
  const answers = (data && data.answers) || {};
  const narrative = (data && data.narrative) || {};
  const schoolProfile = (answers.school_profile && typeof answers.school_profile === "object") ? answers.school_profile : {};
  const contact = (answers.contact && typeof answers.contact === "object") ? answers.contact : {};
  const schoolName = schoolProfile.school_name || "your school";
  const contactName = contact.contact_name || "";
  const contactRole = contact.contact_role || "";
  const contactEmail = contact.email || "";
  const today = new Date().toLocaleDateString("en-IN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const primaryOutcomeLabel = humanise(answers.primary_outcome, PRIMARY_OUTCOME_LABEL, "their stated outcome");
  const secondarySkills = Array.isArray(answers.secondary_skills) ? answers.secondary_skills : [];
  const growthAreaLabel = humanise(answers.growth_area, GROWTH_AREA_LABEL, "the gap you named");
  const runwayDisplay = resolveRunwayDisplay(answers.geo_preference);
  const boardHooks = resolveBoardHooks(answers.curriculum);

  // Narrative fields (Job A output, validated through T7 guard before
  // it reached us). Each fallback string is the §3.7.1 Layer-3 template
  // we'd surface anyway if the LLM fell through — safe-by-default.
  const ambitionText = narrative.ambition_restatement ||
    `You told us your goal for ${schoolName}'s students is ${primaryOutcomeLabel}` +
    (secondarySkills.length ? `, supported by ${secondarySkills.join(" and ")}.` : ".");
  const readinessProfileText = narrative.readiness_profile ||
    `Your students have the most room to grow in ${growthAreaLabel}. Experiential learning builds this through real tasks outside the classroom, repeated and reflected on, which is how a skill becomes a habit.`;
  const whatBecomesPossibleText = narrative.what_becomes_possible ||
    "Three pathways open up at different commitment levels — a meaningful day out as a first step, a domestic overnight that deepens reflection, an international programme that reframes how students see their own place in the world. Each is described here by the growth it produces, not by a place or price.";
  const costOfWaitingText = narrative.cost_of_waiting ||
    `The gap you named in ${growthAreaLabel} does not wait for the school. Every term it goes unaddressed, another cohort moves on without it.`;
  const institutionalBenefitText = narrative.institutional_benefit ||
    "Programmes like this strengthen student outcomes, deepen parent satisfaction, and give your admissions team a credible differentiator — experiential learning that's documented, defensible, and tied to the school's own goals.";
  const assuranceFramingText = narrative.assurance_framing ||
    "Four concerns matter to any school owner approving a trip — risk reduction, reputation protection, governance confidence, parent acceptance. Each is addressed below from facts the team operates on, not adjectives.";

  // PDF download URL — public endpoint T8 shipped.
  const pdfUrl = `/api/travel/diagnostics/${diagnosticId}/readiness-report.pdf`;

  // DD-5.4 booking URL — Vite env var; mailto fallback when absent.
  const bookingUrl = (typeof import.meta !== "undefined" && import.meta.env &&
    import.meta.env.VITE_TMC_BOOKING_URL) || "";

  const onBook = () => {
    if (bookingUrl) {
      window.open(bookingUrl, "_blank", "noopener,noreferrer");
      return;
    }
    if (contactEmail) {
      window.location.href = `mailto:hello@tmc.in?subject=${encodeURIComponent("Book a 30-minute consultation — " + schoolName)}&body=${encodeURIComponent("Hi TMC,\n\nWe'd like to set up a 30-minute consultation about our students' experiential-learning programme.\n\nFrom: " + contactName + " (" + contactRole + ")\nSchool: " + schoolName + "\nReply to: " + contactEmail)}`;
      return;
    }
    window.location.href = "mailto:hello@tmc.in?subject=Book a 30-minute consultation";
  };

  return (
    <Shell>
      {/* §3.5 Section 1 — Cover */}
      <header style={cover}>
        <div style={brandRow}>
          <GraduationCap size={28} aria-hidden style={{ color: "#0E7FA7" }} />
          <span style={brandText}>TMC</span>
        </div>
        <h1 style={coverTitle}>Student experiential readiness profile</h1>
        <div style={coverMeta}>
          <div><strong>{schoolName}</strong></div>
          <div>{today}</div>
          {contactName && (
            <div style={{ color: "#5a6275", marginTop: 4 }}>
              Prepared for {contactName}{contactRole ? `, ${contactRole.replace(/_/g, " ")}` : ""}
            </div>
          )}
        </div>
      </header>

      {/* §3.5 Section 2 — Your ambition, in your words */}
      <Section number={1} title="Your ambition, in your words">
        <p style={para}>{ambitionText}</p>
      </Section>

      {/* §3.5 Section 3 — Your students' readiness profile */}
      <Section number={2} title="Your students' readiness profile">
        <p style={para}>{readinessProfileText}</p>
      </Section>

      {/* §3.5 Section 4 — What becomes possible */}
      <Section number={3} title="What becomes possible">
        <p style={para}>{whatBecomesPossibleText}</p>
      </Section>

      {/* §3.5 Section 5 — The cost of waiting */}
      <Section number={4} title="The cost of waiting">
        <p style={para}>{costOfWaitingText}</p>
        {runwayDisplay && (
          <p style={runwayLine}>
            <strong>Planning runway:</strong> {runwayDisplay}.{" "}
            A decision this month places the trip in the next achievable window;
            a decision later than that pushes it.
          </p>
        )}
      </Section>

      {/* §3.5 Section 6 — Schools already moving (§3.5.3 peer-proof) */}
      {/*
        LITERAL numbers per §3.5.3 + §11.4 honest-at-305. NEVER inflate.
        NEVER say "300+" or "more than 305" — the build holds the line at
        the verified figure.
      */}
      <Section number={5} title="Schools already moving">
        <p style={para}>
          TMC has served{" "}
          <strong>{STANDING_FACTS.trust.schools_served_since_2015} schools across India</strong>{" "}
          since {STANDING_FACTS.trust.operating_since}, moving{" "}
          <strong>{STANDING_FACTS.trust.students_moved_since_2015} students</strong>{" "}
          on experiential programmes in that time.
        </p>
        <p style={para}>
          Last year alone, <strong>{STANDING_FACTS.trust.students_moved_last_year.toLocaleString("en-IN")} students</strong> travelled with us —{" "}
          {STANDING_FACTS.trust.day_students_last_year.toLocaleString("en-IN")} on day programmes,{" "}
          {STANDING_FACTS.trust.overnight_students_last_year.toLocaleString("en-IN")} on overnight domestic trips, and{" "}
          {STANDING_FACTS.trust.international_students_last_year} on international experiences — our emerging
          flagship tier that a smaller set of schools has already run.
        </p>
      </Section>

      {/* §3.5 Section 7 — How this benefits your institution */}
      <Section number={6} title="How this benefits your institution">
        <p style={para}>{institutionalBenefitText}</p>
        {/* §3.5.1 board hook (renderer-injected, multi-board safe). */}
        {boardHooks.length > 0 && (
          <div style={boardBlock}>
            {boardHooks.map(({ board, hook }) => (
              <p key={board} style={boardLine}>
                <strong>{board}:</strong> {hook}
              </p>
            ))}
          </div>
        )}
      </Section>

      {/* §3.5 Section 8 — Your decision, de-risked (§3.5.4 assurance) */}
      <Section number={7} title="Your decision, de-risked">
        <p style={para}>{assuranceFramingText}</p>
        <ul style={assuranceList}>
          <li>
            <strong>Risk reduction.</strong> Supervision ratio of {STANDING_FACTS.trust.teacher_student_ratio};
            TMC tour directors travel with every group; vetted vendors and transport;
            documented medical and emergency protocol.
          </li>
          <li>
            <strong>Reputation protection.</strong> {STANDING_FACTS.trust.schools_served_since_2015} schools and{" "}
            {STANDING_FACTS.trust.students_moved_since_2015} students since {STANDING_FACTS.trust.operating_since} —
            a diagnostic-led model that makes the trip defensible as education, not tourism.
          </li>
          <li>
            <strong>Governance confidence.</strong> An approval file pack including a documented itinerary,
            curriculum-alignment map, written safety and supervision plan, insurance and consent templates,
            and clear costing for your committee.
          </li>
          <li>
            <strong>Parent acceptance.</strong> Learning outcomes tied to your school's own goals plus the
            same supervision and safety record above — a value story parents accept.
          </li>
        </ul>
      </Section>

      {/* §3.5 Section 9 — How TMC works */}
      <Section number={8} title="How TMC works">
        <p style={para}>
          Every TMC trip starts with a diagnostic like the one you just completed.
          Programmes are then matched to what your students actually need to grow —
          not the other way around. We've been operating this way since{" "}
          {STANDING_FACTS.trust.operating_since}, and the model is what lets schools
          present these programmes to committees as education rather than tourism.
        </p>
      </Section>

      {/* §3.5 Section 10 — The single CTA */}
      {/*
        §11.3 calm voice: NO countdown timers, NO "limited spots", NO "act now".
        The push is the calendar (runway display above), never the copy here.
      */}
      <section style={ctaBlock} aria-label="Next step">
        <h2 style={ctaTitle}>Your students are ready.</h2>
        <p style={ctaCopy}>
          The calendar is the only thing between this profile and a programme that
          can run in the window you have. Book a 30-minute consultation with our
          team — we'll walk through the matched programme and your approval pack.
        </p>
        <div style={ctaRow}>
          <button
            type="button"
            onClick={onBook}
            style={primaryBtn}
            aria-label="Book a 30-minute consultation with our team"
          >
            <Calendar size={16} aria-hidden />
            Book a 30-minute consultation
          </button>
          <a
            href={pdfUrl}
            style={secondaryBtn}
            aria-label="Download readiness profile PDF"
            data-testid="pdf-download-link"
          >
            <Download size={16} aria-hidden />
            Download as PDF
          </a>
        </div>
      </section>

      <footer style={footer}>
        TMC · School experiential-learning programmes since{" "}
        {STANDING_FACTS.trust.operating_since}
        {contactEmail && (
          <span style={{ marginLeft: 8, color: "#5a6275" }}>
            · Profile sent to {contactEmail}
          </span>
        )}
      </footer>
    </Shell>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────
function Section({ number, title, children }) {
  return (
    <section style={section} aria-labelledby={`section-${number}`}>
      <h2 id={`section-${number}`} style={sectionTitle}>
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function Shell({ children }) {
  return (
    <div style={page}>
      <div style={card}>{children}</div>
    </div>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────
// Cream/navy palette aligned with sibling TmcReadiness.jsx for visual
// cohesion. Primary CTAs use CSS vars so wellness-themed embedders
// don't render salmon buttons (CLAUDE.md standing rule).
const page = {
  minHeight: "100vh",
  background: "#fbf7f0",
  padding: "32px 16px",
  fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  color: "#1c2233",
};
const card = {
  maxWidth: 760,
  margin: "0 auto",
  background: "#fff",
  borderRadius: 16,
  padding: "32px 36px 36px",
  boxShadow: "0 8px 32px rgba(18, 38, 71, 0.08)",
  border: "1px solid #ece6da",
};
const cover = {
  textAlign: "left",
  paddingBottom: 20,
  marginBottom: 24,
  borderBottom: "2px solid #0E7FA7",
};
const brandRow = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginBottom: 12,
};
const brandText = {
  fontSize: 14,
  fontWeight: 700,
  color: "#0E7FA7",
  letterSpacing: 1.5,
};
const coverTitle = {
  fontSize: 28,
  margin: "0 0 16px",
  lineHeight: 1.25,
  color: "#0A0A0A",
};
const coverMeta = {
  fontSize: 14,
  lineHeight: 1.6,
};
const section = {
  marginBottom: 24,
};
const sectionTitle = {
  fontSize: 18,
  margin: "0 0 10px",
  color: "#0A0A0A",
  fontWeight: 600,
};
const para = {
  fontSize: 15,
  lineHeight: 1.65,
  margin: "0 0 10px",
  color: "#1c2233",
};
const runwayLine = {
  marginTop: 12,
  padding: "12px 14px",
  background: "#F2F7FD",
  borderRadius: 8,
  borderLeft: "3px solid #0E7FA7",
  fontSize: 14,
  lineHeight: 1.6,
};
const boardBlock = {
  marginTop: 14,
  padding: "12px 14px",
  background: "#F2F7FD",
  borderRadius: 8,
  borderLeft: "3px solid #0E7FA7",
};
const boardLine = {
  fontSize: 14,
  lineHeight: 1.6,
  margin: "0 0 6px",
};
const assuranceList = {
  margin: "8px 0 0",
  padding: "0 0 0 18px",
  fontSize: 14,
  lineHeight: 1.7,
  display: "grid",
  gap: 6,
};
const ctaBlock = {
  marginTop: 32,
  padding: "28px 28px 30px",
  background: "#F2F7FD",
  borderRadius: 12,
  border: "1px solid #d4e5f5",
  textAlign: "left",
};
const ctaTitle = {
  fontSize: 22,
  margin: "0 0 10px",
  color: "#0A0A0A",
};
const ctaCopy = {
  fontSize: 15,
  lineHeight: 1.6,
  margin: "0 0 18px",
  color: "#1c2233",
};
const ctaRow = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
};
const primaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 22px",
  background: "var(--primary-color, var(--accent-color, #122647))",
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};
const secondaryBtn = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "12px 22px",
  background: "#fff",
  color: "#1c2233",
  border: "1px solid #dadfe8",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  textDecoration: "none",
};
const footer = {
  marginTop: 24,
  paddingTop: 16,
  borderTop: "1px solid #ece6da",
  fontSize: 12,
  color: "#5a6275",
  textAlign: "left",
};
const loadingBlock = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "40px 20px",
  fontSize: 14,
  color: "#5a6275",
  justifyContent: "center",
};
const errorBlock = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  padding: "20px 22px",
  background: "#fdecec",
  border: "1px solid #f5b5b5",
  color: "#7a1f1f",
  borderRadius: 10,
};
