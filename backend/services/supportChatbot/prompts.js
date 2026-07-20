/**
 * supportChatbot/prompts — system prompt, tool definitions, and the
 * static page-info map for the Wellness Admin Support Chatbot.
 *
 * The bot serves CLINIC STAFF (admins, managers, front-desk, practitioners)
 * inside the wellness vertical — never patients. It answers "how do I …"
 * product questions using the tenant's own KB articles plus the wellness
 * PRD/docs (RAG via the search_help_docs tool) and points users at the
 * right screen.
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
    keywords: ["appointment", "appointments", "schedule", "scheduling", "slot", "reschedule", "cancel", "check in", "arrived", "completed"],
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
    keywords: ["invoice", "invoices", "billing", "receipt", "refund", "gst", "create invoice"],
    description: "Create invoices, apply taxes and discounts, and manage billing history.",
  },
  {
    path: "/payments",
    title: "Payments",
    keywords: ["payment", "payments", "record payment", "view payment", "payment gateway", "razorpay", "stripe", "refund payment"],
    description: "Track received payments, record manual payments, process refunds and configure payment gateways.",
  },
  {
    path: "/estimates",
    title: "Estimates",
    keywords: ["estimate", "estimates", "quotation", "quote"],
    description: "Quotations you can send to a patient before billing.",
  },
  {
    path: "/expenses",
    title: "Expenses",
    keywords: ["expense", "expenses", "spending", "cost", "vendor bill"],
    description: "Track clinic spending and vendor bills.",
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
    path: "/wellness/coupons",
    title: "Coupons",
    keywords: ["coupon", "coupons", "discount code", "promo code", "voucher code"],
    description: "Create percentage or flat discount codes and preview their discount math.",
  },
  {
    path: "/wellness/cashback-rules",
    title: "Cashback Rules",
    keywords: ["cashback", "cashback rules", "wallet credit rule", "cash back"],
    description: "Automatic wallet credit as a percentage of paid visits, with optional minimum spend and service filters.",
  },
  {
    path: "/wellness/pos",
    title: "Point of Sale",
    keywords: ["pos", "sale", "cash register", "shift", "retail", "sell product"],
    description: "Retail point-of-sale with cash register and shift management.",
  },
  {
    path: "/wellness/inventory",
    title: "Inventory Overview",
    keywords: ["inventory", "inventory overview", "consumption overview"],
    description:
      "Explainer page: wellness inventory is per-patient consumption plus central stock. Manage stock under Products and Inventory Admin.",
  },
  {
    path: "/wellness/products",
    title: "Products",
    keywords: ["product", "products", "sku", "stock"],
    description: "Manage product catalog and stock quantities.",
  },
  {
    path: "/wellness/product-categories",
    title: "Product Categories",
    keywords: ["product category", "product categories", "product group"],
    description: "Organise products into categories, with images.",
  },
  {
    path: "/wellness/vendors",
    title: "Vendors",
    keywords: ["vendor", "vendors", "supplier", "purchase"],
    description: "Manage product vendors and purchase references.",
  },
  {
    path: "/wellness/inventory-receipts",
    title: "Inventory Receipts",
    keywords: ["receipt", "receipts", "stock received", "goods received", "purchase entry", "stock in"],
    description: "Record stock received from vendors; updates stock immediately.",
  },
  {
    path: "/wellness/inventory-adjustments",
    title: "Inventory Adjustments",
    keywords: ["adjustment", "adjustments", "stock adjustment", "shrinkage", "damage", "expiry", "recount"],
    description: "Signed stock corrections with a reason; permanent audit history.",
  },
  {
    path: "/wellness/auto-consumption-rules",
    title: "Auto-consumption Rules",
    keywords: ["auto consumption", "consumption rule", "product used per visit", "auto deduct"],
    description: "Define which product and quantity each service consumes; stock is deducted when a visit completes.",
  },
  {
    path: "/wellness/resources",
    title: "Resources",
    keywords: ["resource", "resources", "room", "rooms", "machine", "equipment", "chair"],
    description: "Treatment rooms, machines and equipment picked at booking time; prevents double-booking.",
  },
  {
    path: "/wellness/holidays",
    title: "Holidays",
    keywords: ["holiday", "holidays", "closed day", "clinic closed", "day off"],
    description: "Clinic closed dates that block booking and show a banner on the calendar.",
  },
  {
    path: "/wellness/working-hours",
    title: "Working Hours",
    keywords: ["working hours", "work hours", "shift timing", "availability hours", "doctor hours", "schedule hours"],
    description: "Per-staff working-day and time editor that controls bookable slots.",
  },
  {
    path: "/wellness/locations",
    title: "Locations",
    keywords: ["location", "locations", "branch", "clinic", "clinics", "multi location"],
    description: "Add and manage clinic locations/branches; activate or deactivate them.",
  },
  {
    path: "/staff",
    title: "Staff",
    keywords: ["staff", "employee", "add staff", "team", "invite user"],
    description: "Add staff members, set roles and send invites.",
  },
  {
    path: "/settings/roles",
    title: "Roles & Permissions",
    keywords: ["role", "roles", "permission", "permissions", "access control", "rbac"],
    description: "Create roles and grant module-level read/write/delete/export permissions.",
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
    path: "/wellness/attendance/calendar",
    title: "Attendance Calendar",
    keywords: ["attendance calendar", "attendance month view", "leave calendar"],
    description: "Month grid of attendance and approved leave per staff member.",
  },
  {
    path: "/wellness/leave",
    title: "Leave",
    keywords: ["leave", "apply leave", "approve leave", "reject leave"],
    description: "Apply for leave or approve/reject team leave requests.",
  },
  {
    path: "/leads",
    title: "All Leads",
    keywords: ["lead", "leads", "all leads", "lead list", "leads list", "raw leads"],
    description: "Full lead database across all sources and dispositions.",
  },
  {
    path: "/converted-leads",
    title: "Converted Leads",
    keywords: ["converted leads", "converted", "won leads", "converted lead list", "leads"],
    description: "Leads that have been converted to customers or deals.",
  },
  {
    path: "/wellness/telecaller",
    title: "Telecaller Queue",
    keywords: ["telecaller queue", "telecaller", "lead queue", "disposition", "follow up", "call back"],
    description: "Lead queue sorted by SLA; disposition leads and book appointments.",
  },
  {
    path: "/inbox",
    title: "Unified Inbox",
    keywords: ["inbox", "unified inbox", "messages", "all messages"],
    description: "Combined inbox of messages across channels.",
  },
  {
    path: "/tasks",
    title: "Tasks",
    keywords: ["task", "tasks", "todo", "reminder", "follow up task"],
    description: "Follow-ups and reminders, including callbacks created from the telecaller queue.",
  },
  {
    path: "/wellness/whatsapp",
    title: "WhatsApp Threads",
    keywords: ["whatsapp", "chat", "thread", "message"],
    description: "Two-way WhatsApp agent inbox for patient conversations.",
  },
  {
    path: "/wellness/whatsapp/templates",
    title: "WhatsApp Templates",
    keywords: ["whatsapp template", "templates", "meta template", "message template"],
    description: "Create and sync WhatsApp message templates with Meta approval status.",
  },
  {
    path: "/wellness/reports",
    title: "Reports",
    keywords: ["report", "reports", "analytics", "revenue report", "utilisation", "export", "p&l"],
    description: "Clinic analytics: revenue, utilisation, package consumption and staff performance reports.",
  },
  {
    path: "/wellness/per-location",
    title: "Per-Location Report",
    keywords: ["per location", "per-location", "location report", "branch report", "location dashboard"],
    description: "One column per clinic location with KPIs, top services, staff on duty and weekly revenue.",
  },
  {
    path: "/wellness/loyalty",
    title: "Loyalty & Referrals",
    keywords: ["loyalty", "points", "referral", "referrals", "reward", "rewards"],
    description: "Loyalty leaderboard, auto-credit rules, patient point lookup and the referral pipeline.",
  },
  {
    path: "/marketing",
    title: "Marketing Blasts",
    keywords: ["marketing", "sms blast", "email blast", "campaign", "bulk sms", "bulk email"],
    description: "SMS and email blasts to patient or lead lists.",
  },
  {
    path: "/signatures",
    title: "E-Signatures",
    keywords: ["signature", "signatures", "e-signature", "consent form", "consent", "signed form"],
    description: "All signed patient consent forms with PDF downloads.",
  },
  {
    path: "/knowledge-base",
    title: "Knowledge Base",
    keywords: ["knowledge base", "kb", "help articles", "articles"],
    description: "Tenant help articles for the public portal and staff.",
  },
  {
    path: "/surveys",
    title: "Surveys",
    keywords: ["survey", "surveys", "feedback form", "questionnaire"],
    description: "Create and send patient feedback surveys.",
  },
  {
    path: "/audit-log",
    title: "Audit Log",
    keywords: ["audit", "audit log", "who did what", "activity log", "history log"],
    description: "Sensitive action history (overrides, refunds, deletes, exports) with who and when.",
  },
  {
    path: "/settings",
    title: "Settings",
    keywords: ["settings", "configuration", "branding", "integrations", "ai provider", "support chatbot"],
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
      "Find CRM pages related to a topic. Returns a ranked list of matching pages with their routes. Use this whenever the user asks where a feature/page is. If one result is a clear exact match, answer with that single button; if several results are close, present all of them as options.",
    parameters: {
      type: "object",
      properties: {
        page: {
          type: "string",
          description: "Page name or topic, e.g. 'appointments', 'billing', 'patients', 'leads', 'inbox'.",
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
    "- When the user asks where a feature or page is, call get_page_info. It returns a ranked list of matching pages.",
    "- If one result is a clear exact match for what they asked (title or route matches the question closely and the score is much higher than the rest), answer with a brief plain sentence first, then give one deep-link button.",
    "- If two or more results are equally relevant, say you found a few related options, give a one-sentence explanation of what each is for or which one to pick, and list each one as a separate clickable button. Do not guess one when the question is ambiguous.",
    "- If the user asks about adding, creating, booking, editing or doing something, tell them the exact page/button/menu path and steps. Do not just say where to view it.",
    "- Never reply with only buttons. Always include a plain-language answer to the question as well.",
    "- Never invent KB article titles, routes, or doc content — only cite tool results.",
    "- If a question is outside the CRM product scope, say so politely and direct the user to the Settings → Support page or the main Globussoft support channel.",
  ].join("\n");
}

/**
 * findPageInfo(query) — keyword match over PAGE_INFO. Returns all matching
 * pages sorted by relevance. Scoring uses whole-word/phrase matches to avoid
 * substring false positives (e.g. "all" matching inside "Wallet"). Only
 * results above the threshold are returned so the LLM gets focused options.
 */
function findPageInfo(query) {
  const q = String(query || "").toLowerCase().trim();
  if (!q) return [];
  const terms = q.split(/[^a-z0-9]+/).filter(Boolean);
  if (terms.length === 0) return [];

  const THRESHOLD = 4;
  const results = [];

  for (const page of PAGE_INFO) {
    let score = 0;
    const title = page.title.toLowerCase();
    const titleWords = title.split(/[^a-z0-9]+/).filter(Boolean);
    const path = page.path.toLowerCase();
    const pathSegments = path.split(/[^a-z0-9]+/).filter(Boolean);

    // Whole-title phrase match is the strongest signal.
    if (title === q) score += 12;
    else if (title.includes(q)) score += 8;

    for (const t of terms) {
      const titleWordMatch = titleWords.find((w) => w === t);
      const titleStartsWith = titleWords.find((w) => w.startsWith(t));
      if (titleWordMatch) score += 6;
      else if (titleStartsWith) score += 4;
      else if (title.includes(t)) score += 1; // weak substring fallback

      const pathWordMatch = pathSegments.find((s) => s === t);
      if (pathWordMatch) score += 2;
      else if (path.includes(t)) score += 1;

      if (page.keywords.some((k) => k.includes(t) || t.includes(k))) score += 3;
    }

    if (score >= THRESHOLD) {
      results.push({ ...page, score });
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

module.exports = { PAGE_INFO, TOOL_DEFINITIONS, buildSystemPrompt, findPageInfo };
