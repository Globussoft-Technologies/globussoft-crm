/**
 * wanderluxBridge.js — maps LLM-emitted block content into the
 * Wanderlux reference's `config` schema.
 *
 * Why: the existing `landingPagePrompts.js` prompts the LLM for a 9-block
 * array (destinationHero / highlightsGrid / cityCards / safetyFeatures /
 * inclusionsGrid / itineraryTimeline / tierPricing / faqAccordion /
 * contactFooter). The reference template renders a CONFIG object with
 * different top-level keys (theme / brand / hero / cities / intro /
 * highlights / safety / investment / register / faqs / finalCta /
 * footer). This bridge converts the former into the latter so the
 * Wanderlux template can render the LLM's output without an LLM-prompt
 * rewrite.
 *
 * Operator guardrails preserved:
 *   - investment.installments[i].amount stays null (operator-only)
 *   - testimonials stay omitted (operator-only)
 *   - footer.email / footer.phones stay empty (operator-only)
 *
 * Image strategy:
 *   The bridge ATTACHES `imagePrompt` strings per slot so the route's
 *   image-fetcher (destinationImageProvider → aiImageFallbackProvider →
 *   Pollinations) can generate matching photos. The reference uses the
 *   same approach. Bridge does NOT call the image provider — that
 *   happens in the route after this bridge returns.
 */

'use strict';

// Per-sub-brand theme palettes. The LLM doesn't emit a theme today; we
// pick one based on subBrand + destination family so each tour ships with
// a distinct visual identity. The reference's sample-config.json shows
// the shape exactly — these are #RRGGBB hex.
const SUB_BRAND_THEMES = {
  rfu: {
    brandColor: '#0E7C7B', accentColor: '#C89A4E', darkColor: '#0B3954',
    footerColor: '#072438', lightBg: '#F7FAF9', panelBg: '#FFFFFF',
    softBg: '#E8F3F1', textColor: '#15242B', textColor2: '#5B6B70',
    borderColor: '#DCE6E4',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  tmc: {
    brandColor: '#0F1B3D', accentColor: '#D9A441', darkColor: '#0A1330',
    footerColor: '#080F25', lightBg: '#F7F9FC', panelBg: '#FFFFFF',
    softBg: '#EEF3FB', textColor: '#16202E', textColor2: '#5A6678',
    borderColor: '#DCE3EF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  travelstall: {
    brandColor: '#122647', accentColor: '#C89A4E', darkColor: '#0A1430',
    footerColor: '#070D1F', lightBg: '#F7F6F1', panelBg: '#FFFFFF',
    softBg: '#EEEAE0', textColor: '#1A1F2E', textColor2: '#5A5E68',
    borderColor: '#E0DBCF',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
  visasure: {
    brandColor: '#1E3A8A', accentColor: '#E0A458', darkColor: '#0F1F4E',
    footerColor: '#0B1638', lightBg: '#F7F9FC', panelBg: '#FFFFFF',
    softBg: '#E8EEF8', textColor: '#15202E', textColor2: '#5B6678',
    borderColor: '#D9E2F0',
    serifFont: "'Cormorant Garamond', Georgia, serif",
    sansFont: "'Inter', system-ui, sans-serif",
    pattern: 'none',
  },
};

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function pickThemeFor(subBrand) {
  return SUB_BRAND_THEMES[subBrand] || SUB_BRAND_THEMES.travelstall;
}

/**
 * Build a vivid imagePrompt for a destination + sub-context. These feed
 * the image-provider chain (Pollinations Flux at the bottom). Rich
 * prompts produce photo-realistic outputs; short queries produce
 * generic mush.
 */
function vividPrompt(destination, subject, mood) {
  const dest = String(destination || '').trim();
  const subj = String(subject || '').trim();
  const flavour = String(mood || 'golden hour, cinematic').trim();
  if (!dest && !subj) return `professional travel photography, ${flavour}`;
  if (!subj) return `${dest}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
  if (!dest) return `${subj}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
  return `${subj}, ${dest}, professional travel photography, ${flavour}, sharp focus, no text, no watermark, photorealistic`;
}

/**
 * Common landmark-type categories that show up in place names worldwide.
 * Used by `extractCategory` to detect the subject type and emit it as a
 * separate search keyword so stock providers filter to that visual
 * category. Order matters for multi-word categories — longest match wins.
 */
const LANDMARK_CATEGORIES = [
  // Multi-word categories — checked first (longest match wins)
  'national park', 'wildlife sanctuary', 'tiger reserve', 'old town',
  'town square', 'main street', 'red square',
  // Single-word religious / spiritual
  'temple', 'mosque', 'church', 'cathedral', 'shrine', 'pagoda',
  'monastery', 'gurudwara', 'synagogue', 'basilica', 'chapel',
  // Single-word cultural / heritage
  'museum', 'gallery', 'library', 'palace', 'fort', 'fortress',
  'citadel', 'castle', 'tower', 'pyramid', 'ruins',
  'memorial', 'monument', 'statue', 'tomb', 'mausoleum', 'cenotaph',
  // Single-word infrastructure
  'bridge', 'gate', 'arch', 'wall', 'observatory', 'lighthouse',
  // Single-word natural
  'river', 'lake', 'beach', 'falls', 'waterfall', 'mountain', 'peak',
  'volcano', 'canyon', 'desert', 'cave', 'forest', 'glacier', 'island',
  'valley', 'lagoon', 'reef', 'cliff', 'hill', 'gorge',
  // Single-word green spaces
  'park', 'garden', 'reserve', 'sanctuary', 'zoo', 'aquarium',
  // Single-word commercial / civic
  'market', 'bazaar', 'street', 'square', 'plaza', 'avenue', 'boulevard',
  'harbor', 'harbour', 'port', 'bay', 'coast', 'pier', 'wharf',
  'stadium', 'arena', 'theatre', 'theater', 'opera',
  // Single-word miscellaneous
  'terraces', 'plantation', 'vineyard', 'oasis', 'springs', 'crossing',
  'dam', 'spire', 'minaret', 'dome', 'mall', 'park',
];

/**
 * Detect a category from a prefix pattern (e.g. "Mount Fuji" → "mountain",
 * "Lake Como" → "lake"). Some place names front-load the type with a
 * prefix word that the suffix-based extractor doesn't pick up.
 */
const PREFIX_CATEGORIES = {
  mount: 'mountain',
  mt: 'mountain',
  lake: 'lake',
  river: 'river',
  bay: 'bay',
  cape: 'cape',
  isle: 'island',
  fort: 'fort',
  palace: 'palace',
  temple: 'temple',
};

/**
 * Extract the landmark category keyword from a subject string.
 *
 * "Kaziranga National Park" → "national park"
 * "Kamakhya Temple"          → "temple"
 * "Howrah Bridge"            → "bridge"
 * "Brahmaputra River"        → "river"
 * "Park Street"              → "street"
 * "Random City Name"         → '' (no recognised category)
 *
 * Returns '' when no category is found, so the prompt falls back to the
 * subject + destination tokens only.
 */
function extractCategory(subject) {
  const s = String(subject || '').toLowerCase().trim();
  if (!s) return '';
  // Multi-word suffix first — longest match wins.
  let best = '';
  for (const cat of LANDMARK_CATEGORIES) {
    if (cat.includes(' ') && s.endsWith(cat)) {
      if (cat.length > best.length) best = cat;
    }
  }
  if (best) return best;
  const tokens = s.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  // Prefix pattern first (e.g. "Mount Fuji" → "mountain", "Lake Como" →
  // "lake") because these are unambiguous landmark-type signals.
  const first = tokens[0] || '';
  if (PREFIX_CATEGORIES[first]) return PREFIX_CATEGORIES[first];
  // Any-token scan: pick the LAST token that matches a category. Walking
  // back-to-front means "Tower of London" finds "tower"; "Pyramids of
  // Giza" finds "pyramids" → "pyramid"; "Victoria Memorial Hall" finds
  // "hall" only if hall is a category, otherwise "memorial". The
  // last-match-wins rule reflects the convention that landmark names
  // end with their type ("Howrah Bridge", "Kamakhya Temple").
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tok = tokens[i];
    if (LANDMARK_CATEGORIES.includes(tok)) return tok;
    if (tok.length > 3 && tok.endsWith('s')) {
      const singular = tok.slice(0, -1);
      if (LANDMARK_CATEGORIES.includes(singular)) return singular;
    }
  }
  return '';
}

/**
 * Build a keyword-based image-search query for a destination subject.
 *
 * Format: `<subject>, <category>, <destination>` — comma-separated so
 * stock providers (Pexels, Unsplash) treat each token as a distinct
 * keyword filter.
 *
 * Example outputs:
 *   landmarkPrompt('Kolkata', 'Howrah Bridge')        → "Howrah Bridge, bridge, Kolkata"
 *   landmarkPrompt('Assam', 'Kaziranga National Park') → "Kaziranga National Park, national park, Assam"
 *   landmarkPrompt('Kolkata', 'Park Street')          → "Park Street, street, Kolkata"
 *   landmarkPrompt('Tokyo', 'Mount Fuji')             → "Mount Fuji, mountain, Tokyo"
 *
 * The category keyword forces a visual-type filter so EVERY slot gets a
 * photo of the actual place-type asked for, not just the city's most-
 * photographed landmark. Previous prompt strings layered photo-style
 * descriptors ("famous landmark, iconic monument, architecture") that
 * all happened to match Victoria Memorial well, so every slot for any
 * Kolkata landmark returned Victoria Memorial photos.
 *
 * Pexels' `orientation=landscape` parameter (pexelsProvider.js) already
 * filters out the people-portrait class; explicit "no people" negatives
 * in the prompt were redundant.
 *
 * Used by both the marquee (city strip) and the flip cards.
 */
function landmarkPrompt(destination, subject) {
  const dest = String(destination || '').trim();
  const subj = String(subject || '').trim();
  if (!dest && !subj) return 'landmark';
  if (!subj) return `${dest} landmark`;
  const category = extractCategory(subj);
  if (!dest) return category ? `${subj}, ${category}` : subj;
  return category ? `${subj}, ${category}, ${dest}` : `${subj}, ${dest}`;
}

/**
 * Compute an ISO deadline for the hero countdown — N weeks from now,
 * capped at 28 days minimum (so a "7-day trip" doesn't surface a 1-day
 * urgency). Operator can override in the builder.
 */
function defaultCountdownIso(durationDays) {
  const days = Number.isFinite(durationDays) && durationDays > 0 ? durationDays : 7;
  const offsetDays = Math.max(28, Math.round(days * 2));
  const ms = Date.now() + offsetDays * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Detect whether the configured audience describes a STUDENT / school
 * programme — in which case the registration flow needs to capture
 * student details, parent details, and passport-status separately
 * across 3 steps (matches the educational-trip reference). For every
 * other audience (Travellers / Pilgrims / Families / Honeymooners / …)
 * a single Traveller step suffices.
 *
 * Universal — uses a keyword set that catches every common school /
 * student framing regardless of destination.
 */
function isStudentAudience(audience) {
  const s = String(audience || '').toLowerCase();
  if (!s) return false;
  return /\b(student|school|grade|grades|class|college|university|youth|kids|children|child|teen|teenager|teenage|minor|pupil|scholar|academy|institute|gurukul|madrasa)\b/.test(s);
}

/**
 * Build the registration steps for a given audience.
 *
 * Every audience gets a Passport Status step at the end — international
 * tours require visa-eligible passports, and capturing the status up
 * front lets the sales team flag passport issues during the first call
 * instead of weeks before departure.
 *
 * STUDENT audience → 3 steps:
 *   1. Student info  (name, grade, school)
 *   2. Parent info   (name, email, phone)
 *   3. Passport info (select: valid / expires / not obtained)
 *
 * Everything else → 2 steps:
 *   1. Traveller   (name, email, phone)
 *   2. Passport    (select: valid / expires / not obtained)
 *
 * Returns { steps, submitLabel, successTitle, successBody } — all
 * universal copy that adapts per audience. Destination-agnostic.
 */
function buildRegisterFlow(audience) {
  const isStudent = isStudentAudience(audience);

  // Universal Passport step — same shape for every audience. The
  // question wording shifts subtly (child vs traveller) but the field
  // name + option set are identical so server-side analytics aggregate
  // cleanly across audiences.
  const passportStep = {
    title: isStudent ? 'Step 3: Passport Information' : 'Step 2: Passport Information',
    fields: [
      {
        name: 'passport_status',
        label: isStudent
          ? "Is your child's passport valid for at least 6 months from the trip start date?"
          : 'Is your passport valid for at least 6 months from the trip start date?',
        type: 'select',
        required: true,
        placeholder: 'Select an option',
        options: [
          'Yes, passport is valid for 6+ months',
          'No, passport expires sooner',
          'Passport not yet obtained',
        ],
      },
    ],
  };

  if (isStudent) {
    return {
      steps: [
        {
          title: 'Step 1: Student Information',
          fields: [
            { name: 'student_name', label: 'Student Full Name', type: 'text', required: true, placeholder: "Enter student's full name" },
            { name: 'student_grade', label: 'Grade', type: 'text', required: true, placeholder: 'e.g., 8th Grade' },
            { name: 'student_school', label: 'School', type: 'text', required: true, placeholder: 'School name' },
          ],
        },
        {
          title: 'Step 2: Parent Information',
          fields: [
            { name: 'name', label: 'Parent Name', type: 'text', required: true, placeholder: "Enter parent's name" },
            { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'email@example.com' },
            { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: '+91 XXXXX XXXXX' },
          ],
        },
        passportStep,
      ],
      submitLabel: 'Reserve Orientation Seat',
      successTitle: "Thanks — You're on the List!",
      successBody: 'Our team will reach out within one business day with the orientation call details and next steps.',
    };
  }
  return {
    steps: [
      {
        title: 'Step 1: Traveller',
        fields: [
          { name: 'name', label: 'Full Name', type: 'text', required: true, placeholder: 'Enter your full name' },
          { name: 'email', label: 'Email', type: 'email', required: true, placeholder: 'email@example.com' },
          { name: 'phone', label: 'Phone', type: 'tel', required: true, placeholder: 'Mobile number' },
        ],
      },
      passportStep,
    ],
    submitLabel: 'Submit Registration',
    successTitle: "Thanks — You're on the List!",
    successBody: 'Our team will reach out within one business day with the full itinerary and next steps.',
  };
}

function getBlock(blocks, type) {
  const found = (Array.isArray(blocks) ? blocks : []).find(
    (b) => b && b.type === type,
  );
  return (found && found.props) || {};
}

/**
 * Default hero value cards per sub-brand.
 *
 * These describe HOW THE COMPANY RUNS TRIPS — supervision ratio,
 * cultural prep, structured independence — not the destination's
 * landmarks. The destination-specific content lives in the Highlights
 * (flip cards) section; this slot is for the company-level value-prop
 * messaging.
 *
 * Previously the bridge seeded `hero.valueCards` from the LLM's
 * `highlightsGrid.items[]` — meaning Assam pages showed "Kamakhya
 * Temple / Kaziranga / Tea Gardens" as value cards, which read as
 * "what we'll see" rather than "what you'll gain". Operators flagged
 * this; the fix is to seed sensible per-sub-brand defaults and let
 * the operator edit them via the Hero → Value cards editor.
 *
 * Keep these short (≤ 3 words title, ≤ 60 chars body) — the cards are
 * narrow and overflow looks bad. Kanji / glyph is optional decoration.
 */
function defaultValueCardsFor(subBrand) {
  switch ((subBrand || '').toLowerCase()) {
    case 'tmc':
      return [
        { title: 'Global Confidence', body: 'Composure and adaptability in unfamiliar environments.' },
        { title: 'Global Perspective', body: 'Exposure to structured global systems and ways of thinking.' },
        { title: 'Cultural Awareness', body: 'Deep appreciation of host-country tradition and etiquette.' },
        { title: 'Guided Independence', body: 'Freedom to explore within a safe, structured framework.' },
      ];
    case 'rfu':
      return [
        { title: 'Spiritual Focus', body: 'Every itinerary serves the ritual, not the sightseeing.' },
        { title: 'Trained Mutawwifs', body: 'Scholarly guidance through each rite, in your language.' },
        { title: 'Comfort, Always', body: 'Proximity stays, gentle pacing, accessible transport.' },
        { title: 'No Hidden Costs', body: 'Single all-inclusive fee — visa, stays, transfers and ziyarah.' },
      ];
    case 'visasure':
      return [
        { title: 'Document Vetting', body: 'Every file checked against current consulate requirements.' },
        { title: 'Appointment Slots', body: 'We hold and book your VFS slot the moment one opens.' },
        { title: 'Status Tracking', body: 'WhatsApp updates from submission to passport delivery.' },
        { title: 'Refusal Recovery', body: 'Re-application support if your first attempt is declined.' },
      ];
    case 'travelstall':
    default:
      return [
        { title: 'Curated Stays', body: 'Hand-picked hotels and villas — never on price alone.' },
        { title: 'Local Experts', body: 'Region-resident guides who go beyond the guidebook.' },
        { title: 'Flexible Pacing', body: 'Time built in to wander, not rush from box to box.' },
        { title: 'Always-on Support', body: 'A real human on call from departure to homecoming.' },
      ];
  }
}

/**
 * Main bridge entry point.
 *
 * @param {Array<Object>} blocks    — LLM block array
 * @param {Object} input            — { destination, durationDays, audience, subBrand, suggestedTitle, metaDescription }
 * @returns {Object} reference-config-shape object
 */
function mapBlocksToWanderluxConfig(blocks, input) {
  const inp = (input && typeof input === 'object') ? input : {};
  const destination = String(inp.destination || '').trim() || 'Destination';
  const audience = String(inp.audience || '').trim();
  const days = Number.isFinite(Number(inp.durationDays))
    ? Math.max(1, Math.min(60, Math.trunc(Number(inp.durationDays))))
    : 7;
  const subBrand = String(inp.subBrand || 'travelstall').toLowerCase();
  const suggestedTitle = String(inp.suggestedTitle || '').trim();
  const metaDescription = String(inp.metaDescription || '').trim();

  const hero = getBlock(blocks, 'destinationHero');
  const highlights = getBlock(blocks, 'highlightsGrid');
  const cities = getBlock(blocks, 'cityCards');
  const safety = getBlock(blocks, 'safetyFeatures');
  const inclusions = getBlock(blocks, 'inclusionsGrid');
  const itinerary = getBlock(blocks, 'itineraryTimeline');
  const pricing = getBlock(blocks, 'tierPricing');
  const faq = getBlock(blocks, 'faqAccordion');

  const cityCards = Array.isArray(cities.cards) ? cities.cards : [];
  const highlightItems = Array.isArray(highlights.items) ? highlights.items : [];
  const safetyItems = Array.isArray(safety.items) ? safety.items : [];
  const inclusionsItems = Array.isArray(inclusions.items) ? inclusions.items : [];
  const itineraryDays = Array.isArray(itinerary.days) ? itinerary.days : [];
  const pricingTiers = Array.isArray(pricing.tiers) ? pricing.tiers : [];
  const faqItems = Array.isArray(faq.faqs) ? faq.faqs : [];
  const faqCategories = Array.isArray(faq.categories) ? faq.categories : [];

  const theme = pickThemeFor(subBrand);
  const cityCount = cityCards.length;
  const kicker = cityCount > 0
    ? `${String(days).padStart(2, '0')} Days. ${String(cityCount).padStart(2, '0')} ${cityCount === 1 ? 'City' : 'Cities'}.`
    : `${String(days).padStart(2, '0')} Days.`;

  // Derive the "trip year" from the countdown deadline so the register
  // section, image alt-text, and footer all align on the same year.
  // Previously these used `new Date().getFullYear() + 1` which hardcoded
  // "next year" — fine for school groups planning a year ahead, wrong
  // for trips departing in the same calendar year (e.g. a Sept-Oct
  // 2026 trip being labelled "Register — Assam 2027"). The deadline
  // is "now + max(28, days*2) days" which is the right anchor.
  const deadlineIso = defaultCountdownIso(days);
  const tripYear = new Date(deadlineIso).getFullYear();

  return {
    theme,
    brand: {
      subBrand: subBrand === 'rfu' ? 'RFU' : subBrand === 'tmc' ? 'TMC' : subBrand === 'visasure' ? 'VisaSure' : 'TravelStall',
      mark: '',
      name: (destination ? destination.toUpperCase() : 'Untitled Tour').slice(0, 40),
    },
    meta: {
      slug: slugify(`${destination}-${days}d`),
      tripId: null,
      // Stash the raw audience string so the server-side submit handler
      // can pick the right form block from page.content, and so the
      // client-side toast can tailor wording per audience.
      audience: String(audience || '').trim(),
      isStudentAudience: isStudentAudience(audience),
    },
    nav: {
      links: [
        { label: 'Itinerary', href: '#itinerary' },
        { label: 'Inclusions', href: '#inclusions' },
        { label: 'Pricing', href: '#investment' },
        { label: 'FAQs', href: '#faqs' },
      ],
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      ctaHref: '#register',
      floating: true,
    },
    hero: {
      logos: [],
      // Eyebrow shape: "<DATES> | <AUDIENCE>" — both halves split by '|'
      // in the editor's HeroEyebrowFields. The bridge has no operator-
      // supplied travel dates at generation time, so we emit a LEADING
      // separator ("| AUDIENCE") to anchor the audience on the right
      // side of the split. Without the separator, the frontend's split
      // puts an audience-only string into the Dates slot (operator sees
      // "SCHOOL STUDENTS" under the Dates label, audience field empty).
      eyebrow: audience ? ` | ${audience.toUpperCase()}` : '',
      badge: '', // operator-controlled (seat scarcity claims)
      kicker,
      titleLines: (hero.headline || destination).split(/\s+/).reduce((acc, w) => {
        // Split the headline into 2-3 lines around its midpoint.
        if (acc.length === 0) return [w];
        const last = acc[acc.length - 1];
        if (last.length + w.length < 18 && acc.length < 3) {
          acc[acc.length - 1] = `${last} ${w}`;
        } else if (acc.length < 3) {
          acc.push(w);
        } else {
          acc[acc.length - 1] = `${last} ${w}`;
        }
        return acc;
      }, []),
      subhead: hero.subhead || metaDescription || '',
      // Value cards seed from the per-sub-brand defaults (company
      // approach — supervision, cultural prep, pacing — NOT the
      // destination's landmarks). Destination-specific content lives
      // in the Highlights flip-cards section further down. Operator
      // edits these via the Hero → Value cards editor.
      valueCards: defaultValueCardsFor(subBrand),
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      // imagePrompt drives the image-provider chain. We use the FIRST
      // highlight's title (a specific famous landmark per destination —
      // e.g. "Kaziranga National Park" for Assam, "Mount Fuji" for
      // Japan) as the hero subject. Generic strings like "iconic
      // landmark skyline" surface unrelated photos from neighbouring
      // regions on Pexels (Victoria Memorial in Kolkata was being
      // returned for Assam queries). A specific landmark name with
      // the destination as context tilts toward the right photo.
      imagePrompt: landmarkPrompt(
        destination,
        (highlightItems[0] && highlightItems[0].title) || 'iconic landmark',
      ),
      imageTitle: suggestedTitle || `${destination} ${tripYear}`,
      imageSubtitle: metaDescription || hero.subhead || '',
    },
    countdown: {
      enabled: true,
      deadline: deadlineIso,
      label: 'Registration Closes In',
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
      ctaHref: '#register',
    },
    // Cities marquee strip — historically sourced from cityCards
    // (Guwahati / Jorhat / Dibrugarh etc.) but those city names have
    // weak Pexels coverage for lesser-known destinations, so the
    // marquee surfaced unrelated photos (e.g. Latvian statue for
    // "Dibrugarh"). We now source from highlightItems — which are
    // genuine landmark names emitted by the LLM (Kaziranga / Kamakhya
    // Temple / Brahmaputra River) that DO have strong Pexels coverage.
    // Falls back to cityCards if no highlights were generated so the
    // marquee never goes empty.
    cities: (highlightItems.length > 0
      ? highlightItems.slice(0, 6).map((it) => ({
          name: it.title || '',
          tag: destination.toUpperCase().slice(0, 20),
          imagePrompt: landmarkPrompt(destination, it.title || ''),
        }))
      : cityCards.slice(0, 6).map((c) => ({
          name: c.title || '',
          tag: c.tag || '',
          imagePrompt: landmarkPrompt(destination, c.title || ''),
        }))),
    // Reference's intro block — left col = paragraphs, right col = quote
    // + gains list. Maps from highlights subtitle (intro paragraph) +
    // highlight titles (gains list).
    intro: highlightItems.length > 0 ? {
      title: highlights.title || `Why ${destination}.`,
      paragraphs: [
        hero.subhead || metaDescription || '',
        highlights.subtitle || '',
      ].filter(Boolean),
      gainsTitle: 'What You Gain',
      // gainsQuote is the italic intro that sits in the LEFT column
      // above the "Talk to Our Team" CTA — it gives the column visual
      // weight so it isn't just a header floating in whitespace.
      // We use highlights.subtitle (the LLM's one-line summary of the
      // destination) which is shape-perfect for this slot and never
      // duplicates the per-item bullets on the right. Falls back to
      // the hero subhead or meta description if subtitle is empty.
      gainsQuote: highlights.subtitle || hero.subhead || metaDescription || '',
      // gains is now an array of { title, description } objects so the
      // right-side list can render a one-line description per item.
      // Cap at 6 (schema max) — operators rarely want more bullets
      // than that. Pre-existing pages still render fine because the
      // template's sc-for treats missing description as empty.
      gains: highlightItems.slice(0, 6)
        .map((it) => ({
          title: String((it && it.title) || '').trim(),
          description: String((it && it.body) || '').trim(),
        }))
        .filter((g) => g.title),
      ctaLabel: 'Talk to Our Team →',
    } : null,
    // Destination flip cards. Body + benefit + matching photo.
    // Capped at 5 — the flip-card grid lays out cleanly as 3 + 2
    // centred; more than 5 starts to overflow the row and the cards
    // become uniformly cramped. The defensive .slice handles older
    // LLM outputs that emitted 8-10 cards under the previous schema.
    // frontBody is intentionally empty here — the front of the flip
    // card now shows ONLY the eyebrow + name (clean, minimal —
    // matches the educational-trip reference); the description lives
    // on the back where it has room to breathe.
    highlights: cityCards.length > 0 ? {
      eyebrow: 'Destinations',
      title: cities.title || 'Destination Highlights',
      subtitle: cities.subtitle || '',
      cards: cityCards.slice(0, 5).map((c) => {
        // Dedup guard: if the LLM emitted tag === title (the failure
        // mode where Jorhat's tag becomes "JORHAT", duplicating the
        // h3 below it), drop the eyebrow entirely. The schema asks
        // the LLM for a thematic descriptor, but the template stays
        // robust if a future run regresses.
        const tagRaw = String(c.tag || '').trim();
        const titleRaw = String(c.title || '').trim();
        const tagDuplicatesTitle = tagRaw.toLowerCase() === titleRaw.toLowerCase();
        return {
          name: titleRaw,
          eyebrow: tagDuplicatesTitle ? '' : tagRaw,
          frontBody: '',
          backBody: String(c.body || ''),
          benefit: String(c.benefit || ''),
          imagePrompt: landmarkPrompt(destination, titleRaw),
        };
      }),
      bannerTitle: `Every Day Has a Purpose in ${destination}.`,
      bannerBody: 'See the full day-by-day plan and how each stop fits the programme.',
      bannerCtaLabel: hero.ctaText || 'Reserve Your Spot',
    } : null,
    safety: safetyItems.length > 0 ? {
      eyebrow: 'Safety Framework',
      title: safety.title || 'Safe by Design.',
      subtitle: safety.subtitle || '',
      // Stats are operator-controlled by design (specific ratios feel
      // like vendor claims). We seed 4 generic tiles ready for operator
      // edit.
      stats: [
        { stat: 'All', title: 'Inclusions', body: 'Transport, stays, meals and key activities.' },
        { stat: '24/7', title: 'On-Call Support', body: 'Round-the-clock contact line for parents.' },
        { stat: 'Vetted', title: 'Accommodations', body: 'Inspected stays only.' },
        { stat: '✈', title: 'Return Flights', body: 'Full-service carriers throughout.' },
      ],
      includedTitle: "What's Included",
      includedQuote: safety.subtitle || '',
      included: inclusionsItems.slice(0, 8),
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
    } : null,
    // testimonials — operator-only by design, omitted.
    testimonials: null,
    investment: pricingTiers.length > 0 ? {
      eyebrow: 'Investment',
      title: pricing.title || 'Transparent Pricing',
      subtitle: pricing.subtitle || 'A simple multi-instalment plan. No hidden costs.',
      featuredIndex: 0,
      installments: pricingTiers.map((t) => ({
        tag: t.label || '',
        title: t.label || '',
        sub: t.subtitle || '',
        // amount/date/entity stay empty — operator fills them.
        amount: '',
        date: '',
        entity: '',
      })),
      inclusionsTitle: 'Indicative Inclusions',
      inclusions: inclusionsItems.slice(0, 6),
      note: 'A detailed cost sheet is shared on enquiry.',
    } : null,
    register: (() => {
      // Audience-aware registration flow. School / student programmes
      // get a 3-step form (student info → parent info → passport status);
      // every other audience gets the single Traveller step. See
      // buildRegisterFlow for the keyword list.
      const flow = buildRegisterFlow(audience);
      return {
      eyebrow: 'Reserve Your Seat',
      title: `Register — ${destination} ${tripYear}`,
      intro: "Tell us about you and we'll be in touch within one business day.",
      endpoint: null, // route fills this on persist (post-save)
      // Phase 6 — hybrid registration-draft flow. Wizard submissions on
      // trip-linked Wanderlux pages create a PendingTripRegistration and
      // redirect to the trip microsite for phone OTP verification instead
      // of falling back to the generic lead-capture path.
      mode: 'registration-draft',
      // capacity: 50 (was 0) — the reference's "Registration Closed" gate
      // fires when `registered >= capacity`. With capacity=0 + registered=0
      // every fresh draft rendered as already-full despite the countdown
      // showing 27 days remaining. 50 is a sensible default the operator
      // can edit per-tour.
      capacity: 50,
      registered: 0,
      deadline: deadlineIso,
      successTitle: flow.successTitle,
      successBody: flow.successBody,
      submitLabel: flow.submitLabel,
      steps: flow.steps,
      // Right-column cards next to the registration form. Previously
      // these were sourced from the LLM's inclusionsItems with a
      // hardcoded placeholder body ("Detail shared during the
      // orientation call.") — the placeholder repeated on every card
      // and read as filler. They're now a fixed set of orientation-
      // topic cards that describe WHAT THE FOLLOW-UP CALL COVERS,
      // which is universal across destinations (every operator runs
      // a similar discovery call before confirming a trip). Operator
      // can edit per-tour in the Wanderlux builder.
      covers: [
        { title: 'Complete Itinerary', body: 'Review the day-by-day plan and accommodation list.' },
        { title: 'Safety Framework', body: 'Supervision, insurance, and emergency protocols explained.' },
        { title: 'Investment Breakdown', body: 'See the full transparent financial structure.' },
        { title: 'Live Q&A', body: 'Get all your specific questions answered directly.' },
      ],
      };
    })(),
    // Brochure download — AI-seeded so operators don't see an empty
    // section after generation. The destination + trip year tailor the
    // copy; the form ships with a standard 3-field capture (name, phone,
    // email). `fileUrl` stays empty — operator either uploads a PDF via
    // the editor's Upload button OR pastes a hosted-PDF link, after
    // which the published page surfaces a direct-download CTA on the
    // success state (in addition to emailing it via the lead-capture
    // flow). Operator can still hide the whole section via the layout
    // panel if they don't want it on a particular page.
    brochure: {
      enabled: true,
      eyebrow: 'Still Exploring?',
      title: 'Download the Detailed Programme Overview.',
      body: destination
        ? `If you would prefer to review the complete itinerary, inclusions, safety framework, and payment structure for the ${destination} ${tripYear} programme before committing, you may request the official brochure.`
        : 'If you would prefer to review the complete itinerary, inclusions, safety framework, and payment structure before committing, you may request the official brochure.',
      note: 'Select your school to receive the respective version of the itinerary',
      submitLabel: 'Download Programme Brochure →',
      successTitle: 'Brochure On Its Way',
      successBody: destination
        ? `Thank you — we've emailed the ${destination} programme brochure to the address you provided.`
        : "Thank you — we've emailed the programme brochure to the address you provided.",
      // fileUrl is the operator-uploaded PDF (or pasted hosted link).
      // When set, the success state surfaces a direct-download CTA in
      // addition to the email-on-its-way copy.
      fileUrl: '',
      fields: [
        { name: 'parent_name', label: "Parent's Name", type: 'text', required: true, placeholder: 'Enter full name' },
        { name: 'phone', label: 'Phone Number', type: 'tel', required: true, placeholder: '+91' },
        { name: 'school', label: 'School', type: 'text', required: true, placeholder: 'Enter your school name' },
        { name: 'parent_email', label: "Parent's Email", type: 'email', required: true, placeholder: 'Enter email address' },
      ],
    },
    faqs: faqItems.length > 0 ? {
      eyebrow: 'Clarifications',
      title: faq.title || 'Frequently Asked Questions',
      subtitle: faq.subtitle || '',
      allLabel: 'All Questions',
      categories: faqCategories.length > 0
        ? faqCategories.map((c) => ({ id: c.id || 'all', label: c.label || 'All', icon: c.icon || '◇' }))
        : [{ id: 'all', label: 'All Questions', icon: '◇' }],
      items: faqItems.map((q) => ({
        category: q.cat || 'all',
        q: q.q || '',
        a: q.a || '',
      })),
    } : null,
    finalCta: {
      eyebrow: kicker,
      title: `Plan ${destination} With Confidence.`,
      subtitle: 'One structured journey. One team. One clear path.',
      steps: [
        { label: 'Register interest' },
        { label: 'Review the plan' },
        { label: 'Confirm the seat' },
      ],
      ctaLabel: hero.ctaText || 'Reserve Your Spot',
    },
    footer: {
      mark: '',
      name: destination ? destination.toUpperCase() : 'Untitled Tour',
      tagline: metaDescription || hero.subhead || '',
      // email + phones intentionally empty — operator-controlled per
      // commercial guardrails.
      email: '',
      phones: [],
      legal: [`© ${new Date().getFullYear()} ${subBrand === 'rfu' ? 'RFU' : subBrand === 'tmc' ? 'TMC' : subBrand === 'visasure' ? 'Visa Sure' : 'Travel Stall'}`],
    },
    // Itinerary block — the reference renders only when intro is set,
    // but we also expose the day-by-day for the wanderlux intro block.
    // The reference itself doesn't have an itinerary section; we surface
    // it via intro.paragraphs concatenation.
    _itinerary: itineraryDays.map((d) => ({
      day: d.day || 0,
      title: d.title || '',
      bullets: Array.isArray(d.bullets) ? d.bullets : [],
    })),
  };
}

module.exports = {
  mapBlocksToWanderluxConfig,
  vividPrompt,
  pickThemeFor,
  SUB_BRAND_THEMES,
};
