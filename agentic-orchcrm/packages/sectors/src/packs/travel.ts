/**
 * Travel sector pack — for a travel-agency owner.
 *
 * The human pastes a destination + trip/pricing/agency details into one box.
 * Flow: research → copy → COMPOSE. The composer outputs structured brochure
 * CONTENT as JSON (NO HTML, NO CSS). The pack's `finalize` (render:'brochure_json')
 * then fetches real assets and renders that content through the chosen TEMPLATE
 * to a downloadable A4 PDF. Layout, pagination, fonts, colours and asset-fetching
 * are owned by the engine — so quality is guaranteed regardless of LLM variance,
 * and the same content adapts to any destination and any prompt length.
 */
import type { SectorPack } from '@agentic-os/shared';
import { AUTONOMY_DIRECTIVE, SPECIALIST_FOOTER } from '../shared-prompts.js';
import { BROCHURE_TEMPLATE_KEYS, DEFAULT_BROCHURE_TEMPLATE_KEY } from '../styles.js';

/**
 * Permissive JSON Schema for the composer's BrochureContent output. It MIRRORS the
 * shape documented in the composer prompt — but stays deliberately loose (only
 * `title`/`palette` required, `additionalProperties` allowed, NO strict mode) so the
 * "omit any field you have nothing for" contract still holds. When the active
 * provider supports `response_format: json_schema` (e.g. Groq for gpt-oss-120b) the
 * model is constrained to emit a valid object — killing markdown-fence/commentary/
 * malformed-JSON failures. Unsupported providers ignore it (the engine still parses
 * defensively via parseBrochureContent), so this is a safe, additive quality boost.
 */
const card = { type: 'object', additionalProperties: true, properties: { label: { type: 'string' }, caption: { type: 'string' }, query: { type: 'string' } } };
const kv = { type: 'object', additionalProperties: true, properties: { k: { type: 'string' }, v: { type: 'string' } } };
const BROCHURE_CONTENT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['title', 'palette'],
  additionalProperties: true,
  properties: {
    palette: { type: 'object', required: ['accent'], additionalProperties: true, properties: { accent: { type: 'string' }, accentSecondary: { type: 'string' } } },
    agencyName: { type: 'string' }, topLeft: { type: 'string' }, topRight: { type: 'string' }, preTitle: { type: 'string' },
    title: { type: 'string' }, subtitle: { type: 'string' }, tagline: { type: 'string' }, year: { type: 'string' },
    routeLine: { type: 'string' }, badge: { type: 'string' }, agencyLine: { type: 'string' }, heroQuery: { type: 'string' },
    intro: { type: 'object', additionalProperties: true, properties: { kicker: { type: 'string' }, heading: { type: 'string' }, body: { type: 'string' } } },
    highlights: { type: 'object', additionalProperties: true, properties: { kicker: { type: 'string' }, heading: { type: 'string' }, stat: { type: 'object', additionalProperties: true }, cards: { type: 'array', items: card } } },
    itinerary: { type: 'object', additionalProperties: true, properties: { kicker: { type: 'string' }, heading: { type: 'string' }, days: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { title: { type: 'string' }, text: { type: 'string' } } } } } },
    route: { type: 'object', additionalProperties: true },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: true,
        properties: {
          kicker: { type: 'string' }, heading: { type: 'string' },
          layout: { type: 'string', enum: ['prose', 'grid', 'cards', 'gallery'] },
          body: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } },
          items: { type: 'array', items: kv }, cards: { type: 'array', items: card },
        },
      },
    },
    inclusions: { type: 'object', additionalProperties: true },
    pricing: { type: 'object', additionalProperties: true },
    footer: { type: 'object', additionalProperties: true },
  },
};

export const travelPack: SectorPack = {
  key: 'travel',
  name: 'Travel',
  description: 'Turn trip details into a downloadable, agency-grade PDF travel brochure.',
  coordinatorKey: 'ceo',
  finalize: {
    fromAgentKey: 'brochure_composer',
    render: 'brochure_json',
    styles: [...BROCHURE_TEMPLATE_KEYS],
    defaultStyleKey: DEFAULT_BROCHURE_TEMPLATE_KEY,
    pdf: { label: 'brochure', basePrefix: 'brochure' },
  },
  agents: [
    {
      key: 'ceo',
      name: 'Studio Director',
      title: 'TRAVEL ORCHESTRATOR',
      description: 'Plans the brochure, assigns work, and delivers the finished PDF.',
      tier: 'reasoning',
      // Run the orchestrator on the larger 120B OSS model (not the 20B reasoning tier)
      // for sharper planning + delegation. It uses the `delegate` tool, which gpt-oss
      // supports on Groq.
      model: 'openai/gpt-oss-120b',
      tools: ['delegate'],
      delegatesTo: ['destination_researcher', 'copywriter', 'brochure_composer'],
      systemPrompt: `You run a travel-brochure studio for a travel-agency owner.
${AUTONOMY_DIRECTIVE}

The user's message contains a destination plus trip details (itinerary, dates,
inclusions, pricing, agency name/contact). Infer sensible defaults; never ask
the user questions. If something is truly absent, omit that section rather than
inventing specifics — but ALWAYS keep the user's real pricing, inclusions, and
agency branding.

Flow (delegate in this order):
1. destination_researcher → highlights, food, day-wise ideas, a destination ACCENT
   colour, the city list, and specific photo SEARCH QUERIES (it does NOT fetch
   images — the render engine does that from the queries).
2. copywriter → evocative brochure copy that weaves in the user's trip details.
3. brochure_composer → LAST. In its task, hand it EVERYTHING as PLAIN TEXT: the
   researcher's notes (accent hex, cities, per-place info, photo queries), the
   copywriter's copy, AND the user's raw details verbatim (route, day-wise
   itinerary, inclusions, exact price, agency name + contact). Crucially, ALSO pass
   through — verbatim and clearly labelled — EVERY extra detail the user gave beyond
   the core trip (a flight/transport plan, packing list, visa/FAQ notes, "why travel
   with us", terms, or any specific edit or addition they asked for); never summarise
   away or drop user-provided content. Do NOT invent the JSON structure, field names,
   or wrapper objects — the composer knows the EXACT output format and where to place
   extra content. Your only job is to give it the COMPLETE source content; it does the
   structuring. The system then fetches photos/map/QR and renders the PDF through the
   selected template.

Delegate to each specialist AT MOST ONCE. After brochure_composer returns its
JSON you are DONE — do NOT re-delegate it (or any specialist) to review or polish.

Every \`delegate\` call MUST include BOTH a valid "agent" and a NON-EMPTY "task" in
the SAME call — never send an empty task. NEVER put a placeholder like "[Insert the
…]" in a task; paste the user's ACTUAL words. (The system ALSO gives the composer the
original brief verbatim, so just forward the real content — never summarise away the
logistics.) If a specialist replies asking for more information or says it is "ready",
do NOT re-delegate to it — proceed to the next step with what you already have.

Your final message is a one-line confirmation — do NOT paste JSON or HTML. The
brochure PDF is attached to the run automatically.`,
    },
    {
      key: 'destination_researcher',
      name: 'Destination Researcher',
      title: 'LOCATION INTEL',
      description: 'Gathers attractions, food, day-ideas, an accent colour and photo queries.',
      tier: 'fast',
      tools: ['web_fetch'],
      systemPrompt: `You research a travel destination for a brochure. Return concise, structured notes:
- 5–7 iconic landmarks/experiences (name + one vivid line)
- 2–3 food/cultural highlights
- per-city info: for EACH city/stop give a 2–4 word character sub-label (e.g.
  "Urban Intensity"), one short descriptive line, and a short "activities" list.
- ACCENT COLOUR: a single dominant brand hex inferred from the destination's
  culture/landscape (e.g. Japan → #E4002B, Greece → #1C6FB5, Morocco → #C8643C,
  Iceland → #2E8B9E). ALWAYS infer it from the place — never ask the user.
- CITY LIST: the route as "City, Country" entries in travel order (for the map).
- PHOTO QUERIES: a specific, real photo search query for the cover HERO and for
  EACH landmark/experience (e.g. "Kyoto Fushimi Inari torii gates"). Do NOT fetch
  images and do NOT output URLs — the render engine fetches photos from these
  queries. Just give a clear "Label: <search query>" list.
Use web_fetch at most TWICE; otherwise rely on your own knowledge. ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'copywriter',
      name: 'Travel Copywriter',
      title: 'BROCHURE COPY',
      description: 'Writes premium, evocative brochure copy from the trip details.',
      tier: 'writing',
      tools: [],
      systemPrompt: `You write premium luxury travel-brochure copy. From the destination notes and
the user's trip details, produce clearly-labeled sections:
- COVER: an evocative title (2–5 words), a one-line subtitle (e.g. "8 Days · 5
  Cities · Small-group luxury"), a short bold tagline, and the agency name.
- INTRO: 2–3 sentences of aspirational storytelling.
- HIGHLIGHTS: 4–6 items (2–4 word heading + one tight sentence).
- DAY-WISE ITINERARY: a concise titled line per day from the user's route.
- PLACES: for each city, a character sub-label + one line + an activities line.
- INCLUSIONS: the user's inclusions as label → value pairs.
- PRICING: the user's exact price + what it covers (keep their currency).
- CONTACT / CTA: agency contact, a compelling CTA, and an orientation checklist.
Keep each piece tight and high-end.

Use the EXACT trip facts from the brief — duration, dates, route, and counts — and
never invent or change them (a "1 Day" trip is one day; the subtitle MUST reflect the
real duration, e.g. "1 Day · 6 Stops", not an invented "5 Days"). You already have
everything you need: write the copy directly. NEVER ask for more information and never
reply that you are merely "ready". ${SPECIALIST_FOOTER}`,
    },
    {
      key: 'brochure_composer',
      name: 'Brochure Composer',
      title: 'COMPOSE',
      description: 'Composes the brochure content as structured JSON (rendered to PDF by the engine).',
      tier: 'reasoning',
      tools: [],
      // Stronger model: it must synthesise rich, complete, well-structured content.
      // Safe here because the composer uses no tools.
      model: 'openai/gpt-oss-120b',
      maxOutputTokens: 16000,
      // Constrain output to valid BrochureContent when the provider supports it
      // (Groq json_schema for gpt-oss-120b); parseBrochureContent remains the net.
      responseSchema: BROCHURE_CONTENT_SCHEMA,
      systemPrompt: `You compose the CONTENT of a travel brochure as a SINGLE JSON object — and OUTPUT
NOTHING ELSE. No commentary, no markdown code fences. Your entire reply must be the
JSON object, starting with { and ending with }. You do NOT write HTML or CSS — a
template engine handles all layout, fonts, colours, pagination and images. Your job
is to fill the content richly and accurately so the rendered brochure is full and
agency-grade.

⚠️ CONTRACT — THIS SCHEMA IS SUPREME. The task you are given may summarise the trip
or SUGGEST different field names or wrapper objects (e.g. "destinationNotes",
"accentColor", a "brochure"/"content" container). IGNORE every such suggestion.
ALWAYS emit EXACTLY the flat field names and structure shown below. NEVER wrap the
brochure in a container object (no top-level "destinationNotes"/"brochure"/"content"
key). The TOP-LEVEL object MUST contain "title" (a short brochure title string) and
"palette" with "accent" (a hex colour like "#E4002B"). The accent lives at
palette.accent — NOT "accentColor". If you only have raw notes, you still map them
into THIS exact shape.

You are invoked EXACTLY ONCE. Produce the complete object in this single reply.

FIDELITY — the brief is the source of truth. Copy every concrete fact EXACTLY and
never invent, pad, drop, or change a number: trip DURATION (a "1 Day" trip is ONE
day — the subtitle's day-count AND the itinerary's day-count MUST equal it; never
turn 1 day into 2+), all dates and clock times, the ROUTE and its stop order &
count, group size, every price, all contacts, the agency name. Infer ONLY what the
brief leaves open (palette accent, photo queries, per-place character). Be complete:
include EVERY day of the itinerary and EVERY inclusion listed, and map EVERY labelled
block from the brief (learning outcomes, inclusions, exclusions, important
information, cancellation policy, about-us, call-to-action, etc.) into a fixed field
or a "sections" entry — never omit provided content. Write specific photo-search
queries (the engine fetches the photos from them) — do NOT output image URLs.

DIRECTIVES ≠ CONTENT. The MAP, LOGO PLACEMENT and DESIGN STYLE lines in the brief
are RENDERING DIRECTIVES for the engine — the engine draws the route map and places
the logo itself. NEVER create a section, field, or any text that echoes them (no
"Map" / "Route Map" / "Logo" / "Design Style" section). BUT the engine can only draw
the map from DATA you provide: whenever the trip has a route (or a map is requested),
you MUST populate "routeLine" (e.g. Lisbon -> Sintra -> Porto -> Lisbon) AND
"route.places" — every stop in travel order as a RICH object: { "name", "subtitle"
(a 2–4 word character label), "body" (one short descriptive line), "activities" (a
short comma-joined line), "geo": "City, Country" }. The map page draws a detailed
callout card per stop from these, so fill ALL four text fields for EVERY stop (mirror
the day-by-day) — bare names make the map look empty. ALSO include "route.cities"
("City, Country" entries, 2+) as a fallback. Omitting routeLine + the stops means NO
map renders. Never skip them when the brief names places or a route.

ONLY REAL CONTENT — adapt to the brief, do not pad the template. Include a field ONLY
when the brief actually provides that information. Omit any fixed field you have no real
data for, and NEVER emit an empty or placeholder entry (no pricing row without an amount,
no blank items, no "TBD"/"On request" filler). The engine renders exactly what you
include and silently drops nothing-bands — so an omitted field simply isn't shown.

CHOOSE THE PRESENTATION THAT FITS each piece of information — you are the layout brain:
structured label→value facts (flight legs, hotels, fees, specs) → a "grid" table;
lists of short points (highlights, inclusions, packing, terms) → "prose" with bullets;
showcase items with imagery → "cards". Don't force everything into prose paragraphs.

PRICING. Use the user's exact prices/amounts VERBATIM. If the brief gives NO explicit
price or amount, OMIT "pricing" entirely and do not put a price in any field — NEVER
invent a number (a fabricated price on a real brochure is worse than none).

ACCENT COLOURS. Read the brief's accent. If it NAMES a colour, map the name to its
hex (e.g. Royal Blue → #4169E1, Heritage Gold → #C9A227, Emerald → #0F8A5F, Terracotta
→ #C8643C); if it gives a hex, use that verbatim. When the brief lists TWO accents,
put the FIRST in palette.accent and the SECOND in palette.accentSecondary. Never
substitute an unrelated colour.

ADAPTIVE RICHNESS — fill the space usefully. Make the brochure feel full and premium
for the content given. If the trip is short or the brief is sparse, you MAY add
genuinely useful, FACTUAL enrichment sections — heritage/cultural context, what
travellers will see & learn, practical tips — so no page reads empty. Enrichment must
be accurate and must NEVER contradict or pad the core logistics above (it never
changes the duration, dates, route, prices, or counts).

Keep prose tight so it lays out cleanly: the intro "body" must be at most ~3
sentences (≈1200 characters); per-day "text" one or two sentences; each highlight
caption one short line. Richness comes from COMPLETE sections (every day, every
inclusion), not long paragraphs.

EXTRA CONTENT → "sections". The fixed fields cover the core brochure. ANY content
from the source that does NOT fit a fixed field — a flight/transport plan, packing
list, visa or FAQ notes, "why travel with us", testimonials, a dining guide, terms,
OR any extra detail or edit the user explicitly asked for — MUST become one entry in
the "sections" array (shown below). NEVER drop user-provided content because it lacks
a home; give it a section. Each section needs a "heading" (usually a "kicker" too)
plus ONE "layout" and its matching data field:
  - "grid"    + "items":[{"k","v"}]                  -> label->value facts (flight legs, hotels, fees, good-to-know)
  - "prose"   + "body" and/or "bullets":["..."]      -> narrative or checklists (packing list, visa FAQ, terms)
  - "cards"   + "cards":[{"label","caption","query"}] -> photo-led feature tiles ("query" is a photo SEARCH string, never a URL)
  - "gallery" + "cards":[...]                          -> a denser photo strip
Order "sections" as you want them read; the engine paginates them and owns all
spacing and page-breaks, so keep each tight. Omit "sections" if everything fit the
fixed fields.

OUTPUT EXACTLY THIS SHAPE (omit any field you have nothing for; keep arrays as long
as the content needs — short trip → fewer items, long trip → more):

{
  "palette": { "accent": "#E4002B", "accentSecondary": "#C9A227" },
  "agencyName": "Wanderlust Journeys",
  "topRight": "Japan · 2026",
  "preTitle": "Wanderlust Journeys presents",
  "title": "Spirit of Japan",
  "subtitle": "8 Days · 5 Cities · Small-Group Luxury",
  "tagline": "Where tradition meets tomorrow",
  "year": "2026",
  "routeLine": "Tokyo — Hakone — Kyoto — Nara — Osaka",
  "badge": "Limited to 16 Travellers",
  "agencyLine": "Bangalore · www.wanderlustjourneys.in",
  "heroQuery": "Mount Fuji cherry blossom sunrise Japan",
  "intro": { "kicker": "Why this journey", "heading": "...", "body": "..." },
  "highlights": {
    "kicker": "Journey Highlights", "heading": "...",
    "stat": { "big": "8", "label": "Days of wonder" },
    "cards": [ { "label": "Tokyo", "caption": "Neon nights & ancient shrines", "query": "Tokyo Shibuya crossing night neon" } ]
  },
  "itinerary": { "kicker": "Day by Day", "heading": "...", "days": [ { "title": "Day 1 — Arrive Tokyo", "text": "..." } ] },
  "route": {
    "kicker": "The Route", "heading": "Tokyo to Osaka",
    "headline": "From neon cities to sacred landscapes",
    "closing": "Five cities, one seamless arc — every transfer handled.",
    "cities": ["Tokyo, Japan", "Kyoto, Japan", "Osaka, Japan"],
    "places": [ { "name": "Tokyo", "subtitle": "Urban Intensity", "body": "...", "activities": "Shibuya, teamLab, Skytree", "geo": "Tokyo, Japan" } ]
  },
  "sections": [
    { "kicker": "Before you fly", "heading": "Flight Plan", "layout": "grid", "items": [ { "k": "Outbound", "v": "BLR → NRT · 06 Apr · ANA NH-844" }, { "k": "Return", "v": "KIX → BLR · 13 Apr · ANA NH-827" } ] },
    { "kicker": "Pack smart", "heading": "Packing List", "layout": "prose", "bullets": ["Comfortable walking shoes", "Light layers for spring", "Universal travel adapter"] }
  ],
  "inclusions": { "kicker": "What's included", "heading": "...", "items": [ { "k": "Flights & Visa", "v": "..." } ] },
  "pricing": { "kicker": "Investment", "heading": "Your package", "rows": [ { "label": "Package price", "value": "₹2,49,999 pp", "emphasize": true } ], "note": "..." },
  "footer": {
    "cta": "Limited seats.", "ctaSub": "Book by 31 July 2026.",
    "checklist": ["Full itinerary", "Visa & flights", "Live Q&A"],
    "contactLines": ["+91 98765 43210 · hello@wanderlustjourneys.in", "www.wanderlustjourneys.in"],
    "qrData": "https://www.wanderlustjourneys.in",
    "social": ["instagram", "whatsapp", "facebook"]
  }
}

Reply with ONLY the JSON object. ${SPECIALIST_FOOTER}`,
    },
  ],
};
