/**
 * supportChatbot/prompts — system prompt, tool definitions, and the
 * static page-info map for the Wellness Admin Support Chatbot.
 *
 * The bot serves CLINIC STAFF (admins, managers, front-desk, practitioners)
 * inside the wellness vertical — never patients. It answers "how do I …"
 * product questions using the tenant's own KB articles plus the wellness
 * PRD/implementation docs (RAG via the search_help_docs tool) and points
 * users at the right page.
 */

/**
 * Static map of the wellness vertical's main surfaces. The get_page_info
 * tool reads from here — deliberately NOT from the DB so the tool is
 * deterministic and instant. Paths are SPA routes the frontend can render
 * as deep-link buttons.
 */
const PAGE_INFO = [
  {
    path: "/wellness",
    title: "Owner Dashboard",
    keywords: ["dashboard", "home", "overview", "metrics", "kpi", "snapshot", "owner dashboard"],
    description:
      "Clinic overview: today's appointments, revenue snapshot, patient stats and quick actions.",
  },
  {
    path: "/wellness/recommendations",
    title: "Recommendations",
    keywords: ["recommendation", "recommendations", "ai suggestion", "proposal", "approve"],
    description: "AI-generated daily proposal cards for the owner or manager dashboard.",
  },
  {
    path: "/wellness/appointments",
    title: "Appointments",
    keywords: ["appointment", "appointments", "schedule", "scheduling", "booking", "slot", "reschedule", "cancel", "check in", "arrived", "completed"],
    description:
      "Full appointment book. Create, reschedule, cancel and check in appointments; filter by practitioner, service or status.",
  },
  {
    path: "/wellness/book-appointment",
    title: "Book Appointment",
    keywords: ["book", "booking", "new appointment", "create appointment", "add appointment", "walk-in", "schedule patient"],
    description: "Guided booking flow for scheduling a patient with a practitioner and service.",
  },
  {
    path: "/wellness/calendar",
    title: "Calendar",
    keywords: ["calendar", "day view", "week view", "availability", "practitioner calendar"],
    description: "Day/week calendar of practitioner availability and booked sessions.",
  },
  {
    path: "/wellness/patients",
    title: "Patients",
    keywords: ["patient", "patients", "client", "clients", "record", "profile", "medical history", "add patient", "new patient", "create patient", "search patient", "find patient"],
    description:
      "Patient registry. Search patients, open clinical profiles, view visit history, prescriptions, packages and wallet balance. Use the + Add button to create a new patient.",
  },
  {
    path: "/wellness/patients/:id",
    title: "Patient Detail",
    keywords: ["patient detail", "patient profile", "case history", "prescribe", "consent", "treatment plan", "log visit", "patient record"],
    description:
      "Individual patient record with case history, prescriptions, consent forms, treatment plans, visits, photos, wallet and memberships.",
  },
  {
    path: "/wellness/visits",
    title: "Visits",
    keywords: ["visit", "visits", "clinical note", "soap", "consultation", "treatment note", "log visit", "create visit", "edit visit"],
    description:
      "Clinical visit records. Document consultations, attach treatment plans and record vitals.",
  },
  {
    path: "/wellness/prescriptions",
    title: "Prescriptions",
    keywords: ["prescription", "prescriptions", "rx", "drug", "medicine", "write prescription", "edit prescription", "download prescription"],
    description:
      "Tenant-wide prescription list. Create, edit, download PDF and send prescriptions to patients.",
  },
  {
    path: "/wellness/my-prescriptions",
    title: "My Prescriptions",
    keywords: ["my prescription", "my prescriptions", "own rx", "self prescription"],
    description: "Staff-authenticated self-view of your own prescriptions.",
  },
  {
    path: "/wellness/services",
    title: "Service Catalog",
    keywords: ["service", "services", "service catalog", "catalog", "treatment", "procedure", "add service"],
    description: "Add and manage clinic services, pricing, duration and categories.",
  },
  {
    path: "/wellness/service-categories",
    title: "Service Categories",
    keywords: ["service category", "service categories", "category", "categories"],
    description: "Organize services into categories and sub-categories.",
  },
  {
    path: "/wellness/drugs",
    title: "Drug Catalog",
    keywords: ["drug", "drugs", "drug catalog", "medicine", "medicines", "generic name", "dosage"],
    description: "Manage drugs, strengths, dosage forms and default prescription instructions.",
  },
  {
    path: "/wellness/memberships",
    title: "Memberships",
    keywords: ["package", "packages", "membership", "memberships", "sessions", "prepaid", "plan", "treatment plan", "sell package"],
    description:
      "Sell and manage session packages and memberships; track remaining sessions and expiry.",
  },
  {
    path: "/invoices",
    title: "Invoices",
    keywords: ["invoice", "invoices", "billing", "payment", "receipt", "refund", "gst", "create invoice", "record payment"],
    description: "Invoices, payments, refunds and GST-compliant receipts for clinic services.",
  },
  {
    path: "/wellness/wallet",
    title: "Wallet",
    keywords: ["wallet", "credit", "cashback", "gift card", "balance", "patient wallet"],
    description: "Patient wallet ledger, credits, cashback and gift-card balances.",
  },
  {
    path: "/wellness/giftcards",
    title: "Gift Cards",
    keywords: ["gift card", "gift cards", "voucher"],
    description: "Issue and manage patient gift cards.",
  },
  {
    path: "/wellness/inventory",
    title: "Inventory",
    keywords: ["inventory", "stock", "product", "products", "consumption"],
    description:
      "Stock levels, product receipts, adjustments and automatic consumption rules for treatment rooms.",
  },
  {
    path: "/wellness/products",
    title: "Products",
    keywords: ["product", "products", "sku", "stock"],
    description: "Manage product catalog and stock quantities.",
  },
  {
    path: "/wellness/vendors",
    title: "Vendors",
    keywords: ["vendor", "vendors", "supplier", "purchase"],
    description: "Manage product vendors and purchase references.",
  },
  {
    path: "/wellness/pos",
    title: "Point of Sale",
    keywords: ["pos", "sale", "cash register", "shift", "retail", "sell product"],
    description: "Retail point-of-sale with cash register and shift management.",
  },
  {
    path: "/staff",
    title: "Staff",
    keywords: ["staff", "employee", "add staff", "team", "invite user"],
    description: "Add staff members, set roles and send invites.",
  },
  {
    path: "/wellness/attendance-dashboard",
    title: "Attendance Dashboard",
    keywords: ["attendance", "attendance dashboard", "staff attendance", "punch in", "clock in"],
    description: "All-staff attendance KPIs, present/absent summary and manager edits.",
  },
  {
    path: "/wellness/attendance",
    title: "Attendance",
    keywords: ["my attendance", "self attendance", "mark attendance"],
    description: "Mark your own attendance and view your attendance calendar.",
  },
  {
    path: "/wellness/leave",
    title: "Leave",
    keywords: ["leave", "apply leave", "approve leave", "reject leave"],
    description: "Apply for leave or approve/reject team leave requests.",
  },
  {
    path: "/wellness/telecaller",
    title: "Telecaller Queue",
    keywords: ["lead", "leads", "telecaller", "telecaller queue", "disposition", "follow up", "call back"],
    description: "Lead queue sorted by SLA; disposition leads and book appointments.",
  },
  {
    path: "/wellness/reports",
    title: "Reports",
    keywords: ["report", "reports", "analytics", "revenue report", "utilisation", "export", "p&l"],
    description: "Clinic analytics: revenue, utilisation, package consumption and staff performance reports.",
  },
  {
    path: "/wellness/whatsapp",
    title: "WhatsApp Threads",
    keywords: ["whatsapp", "chat", "thread", "inbox", "message"],
    description: "Two-way WhatsApp agent inbox for patient conversations.",
  },
  {
    path: "/settings",
    title: "Settings",
    keywords: ["settings", "configuration", "branding", "integrations", "roles", "permissions", "ai provider", "support chatbot"],
    description:
      "Organization settings: branding, integrations (Callified, AdsGPT, AI provider), team invites and role permissions.",
  },
];

/**
 * Tool definitions in provider-neutral JSON Schema form. providerAdapters
 * translates these into Gemini functionDeclarations / OpenAI tools.
 */
const TOOL_DEFINITIONS = [
  {
    name: "search_help_docs",
    description:
      "Search the clinic's knowledge base (help articles) for how-to guidance. Use for any 'how do I' product question before answering from general knowledge.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Short keyword query, e.g. 'reschedule appointment' or 'refund invoice'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_page_info",
    description:
      "Get information about a page in the wellness CRM — what it does and its route. Use to point the user at the right screen.",
    parameters: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Page name or topic, e.g. 'appointments', 'billing', 'patients'.",
        },
      },
      required: ["page"],
    },
  },
];

/**
 * buildSystemPrompt({ pageContext }) — pageContext is
 * { path, pageName? } supplied by the widget from useLocation().
 */
function buildSystemPrompt({ pageContext } = {}) {
  const pageLine = pageContext && pageContext.path
    ? `The user is currently on the "${pageContext.pageName || pageContext.path}" page (route: ${pageContext.path}).`
    : "The user's current page is unknown.";
  return [
    "You are the Globussoft CRM support assistant for a wellness clinic's staff (admins, front-desk and practitioners).",
    "You help staff use the CRM product: appointments, patients, visits, prescriptions, billing, packages, inventory, POS, staff and reports.",
    "You do NOT give medical advice and you never discuss patient data.",
    pageLine,
    "Rules:",
    "- Use plain, friendly language that any clinic staff member can follow. Avoid technical jargon.",
    "- For 'how do I' questions, answer with clear numbered steps. Keep it practical and concise.",
    "- NEVER use markdown formatting like **bold**, *italic*, or `code`. Use plain words only.",
    "- NEVER add a 'This is based on...' or source citation line.",
    "- ALWAYS call search_help_docs first and base your answer on the returned articles/docs.",
    "- When you know which screen solves the task, call get_page_info and include the route in your answer as a deep link button label. Do not write raw URLs or paths in the text.",
    "- If the user asks about adding, creating, booking, editing or doing something, tell them the exact page/button/menu path and steps. Do not just say where to view it.",
    "- If no exact documentation matches, still direct the user to the most relevant page and explain what they can do there.",
    "- Never invent KB article titles, routes, or doc content — only cite tool results.",
    "- If a question is outside the CRM product scope, say so politely and direct the user to the Settings → Support page or the main Globussoft support channel.",
  ].join("\n");
}

/**
 * findPageInfo(query) — keyword match over PAGE_INFO. Returns the best
 * matching entry or null. Scoring: exact title word hits weigh 2,
 * keyword hits weigh 3 (keywords are curated), path-segment hits weigh 2.
 */
function findPageInfo(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return null;
  const terms = q.split(/[^a-z0-9]+/).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const page of PAGE_INFO) {
    let score = 0;
    const title = page.title.toLowerCase();
    for (const t of terms) {
      if (title.includes(t)) score += 2;
      if (page.path.toLowerCase().includes(t)) score += 2;
      if (page.keywords.some((k) => k.includes(t) || t.includes(k))) score += 3;
    }
    if (score > bestScore) {
      bestScore = score;
      best = page;
    }
  }
  return best;
}

module.exports = { PAGE_INFO, TOOL_DEFINITIONS, buildSystemPrompt, findPageInfo };
