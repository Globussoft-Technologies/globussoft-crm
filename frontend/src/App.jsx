import React, {
  useState,
  useContext,
  createContext,
  useEffect,
  useMemo,
  useCallback,
  Suspense,
} from "react";
import { flushSync } from "react-dom";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Outlet,
} from "react-router-dom";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Landing from "./pages/Landing";
import Layout from "./components/Layout";
import RouteErrorBoundary from "./components/RouteErrorBoundary";
import RoleGuard from "./components/RoleGuard";
import { NotifyProvider } from "./utils/notify";
import { ActiveSubBrandProvider } from "./utils/subBrand";
import { lazyWithRetry as lazy } from "./utils/lazyWithRetry";
import {
  setAuthToken,
  getAuthToken,
  clearAuthToken,
  markAuthReady,
} from "./utils/api";
import "./theme/wellness.css"; // wellness vertical theme overrides (scoped)

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Home = lazy(() => import("./pages/Home"));
const Contacts = lazy(() => import("./pages/Contacts"));
const ContactDetail = lazy(() => import("./pages/ContactDetail"));
const Pipeline = lazy(() => import("./pages/Pipeline"));
const Workflows = lazy(() => import("./pages/Workflows"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Marketing = lazy(() => import("./pages/Marketing"));
const Reports = lazy(() => import("./pages/Reports"));
const AgentReports = lazy(() => import("./pages/AgentReports"));
const Settings = lazy(() => import("./pages/Settings"));
// G009 (PRD_TRAVEL_MULTICHANNEL_LEADS FR-3.7) — admin page for per-channel
// enable/disable toggles + cooldowns + Meta form-ID routing mappings.
// ADMIN-only via RoleGuard at the route declaration below.
const LeadCapture = lazy(() => import("./pages/settings/LeadCapture"));
const UserSettings = lazy(() => import("./pages/UserSettings"));
const Developer = lazy(() => import("./pages/Developer"));
const Portal = lazy(() => import("./pages/Portal"));
const TravelCustomerPortal = lazy(() => import("./pages/travel/TravelCustomerPortal"));
const PublicTripMicrosite = lazy(() => import("./pages/travel/PublicTripMicrosite"));
// Public itinerary share page (no auth) — the advisor's "Share link" opens
// /p/itinerary/:shareToken here. Backed by GET /api/travel/itineraries/public/:shareToken.
const TripBooking = lazy(() => import("./pages/public/TripBooking"));
const TravelKycCallback = lazy(() => import("./pages/travel/TravelKycCallback"));
// PRD §3.1 / slice T9 — public no-auth TMC readiness diagnostic.
const TmcReadiness = lazy(() => import("./pages/public/TmcReadiness"));
// PRD §3.5 / slice T10 — public 10-section readiness report page.
const TmcReadinessReport = lazy(() => import("./pages/public/TmcReadinessReport"));
// PRD_TRAVEL_QUOTE_BUILDER §3.7 / slice C9 — public quote-accept landing.
const QuoteAcceptLanding = lazy(() => import("./pages/public/QuoteAcceptLanding"));
// Cross-vertical staff attendance dashboard — visible to wellness + travel
// tenants. Backend (/api/attendance/list + /summary) is role-gated to
// ADMIN/MANAGER; per-row edit/delete is ADMIN-only.
const AttendanceDashboard = lazy(() => import("./pages/AttendanceDashboard"));
const WellnessAttendanceCalendar = lazy(() => import("./pages/wellness/AttendanceCalendar"));
const Marketplace = lazy(() => import("./pages/Marketplace"));
const CPQ = lazy(() => import("./pages/CPQ"));
const CustomObjects = lazy(() => import("./pages/CustomObjects"));
const CustomObjectView = lazy(() => import("./pages/CustomObjectView"));
const Sequences = lazy(() => import("./pages/Sequences"));
const SequenceBuilder = lazy(() => import("./pages/SequenceBuilder"));
const Tasks = lazy(() => import("./pages/Tasks"));
const CallifiedData = lazy(() => import("./pages/CallifiedData"));
const Tickets = lazy(() => import("./pages/Tickets"));
const Support = lazy(() => import("./pages/Support"));
const Staff = lazy(() => import("./pages/Staff"));
const Invoices = lazy(() => import("./pages/Invoices"));
const LeadScoring = lazy(() => import("./pages/LeadScoring"));
const Leads = lazy(() => import("./pages/Leads"));
const ConvertedLeads = lazy(() => import("./pages/ConvertedLeads"));
const Clients = lazy(() => import("./pages/Clients"));
const Expenses = lazy(() => import("./pages/Expenses"));
const Contracts = lazy(() => import("./pages/Contracts"));
const Estimates = lazy(() => import("./pages/Estimates"));
const Projects = lazy(() => import("./pages/Projects"));
const Profile = lazy(() => import("./pages/Profile"));
const Pricing = lazy(() => import("./pages/Pricing"));
const ManagePlans = lazy(() => import("./pages/ManagePlans"));
const Channels = lazy(() => import("./pages/Channels"));
const LandingPages = lazy(() => import("./pages/LandingPages"));
const LandingPageBuilder = lazy(() => import("./pages/LandingPageBuilder"));
const LegalPage = lazy(() => import("./pages/LegalPage"));
const AuditLog = lazy(() => import("./pages/AuditLog"));
const Privacy = lazy(() => import("./pages/Privacy"));
const CalendarSync = lazy(() => import("./pages/CalendarSync"));
const Profile2FA = lazy(() => import("./pages/Profile2FA"));
const Pipelines = lazy(() => import("./pages/Pipelines"));
const Forecasting = lazy(() => import("./pages/Forecasting"));
const Dashboards = lazy(() => import("./pages/Dashboards"));
const CustomReports = lazy(() => import("./pages/CustomReports"));
const BookingPages = lazy(() => import("./pages/BookingPages"));
const Signatures = lazy(() => import("./pages/Signatures"));
const KnowledgeBase = lazy(() => import("./pages/KnowledgeBase"));
const Currencies = lazy(() => import("./pages/Currencies"));
const FieldPermissions = lazy(() => import("./pages/FieldPermissions"));
// Per-sub-brand BrandKit admin UI — consumes /api/brand-kits CRUD
// (backend route commit e4783e0). Operator manages logo / colors / font /
// tagline per (subBrand, version) with one-active-per-sub-brand semantics.
const BrandKits = lazy(() => import("./pages/admin/BrandKits"));
// RateHawk hotel-search admin UI — consumes /api/ratehawk (backend route
// commit be67789, tick #103). Operator searches RateHawk hotel inventory
// + sees cap utilisation; stub-mode banner surfaces while Q19 cred-blocked.
const RateHawkSearch = lazy(() => import("./pages/admin/RateHawkSearch"));
// Booking.com / Expedia hotel-search admin UI — consumes /api/booking-expedia
// (backend route commit bb33cbe, tick #105). 4th and FINAL cap-consumer UI.
// Phase 2 deferred-by-design: Expedia returns 503 EXPEDIA_NOT_YET_ENABLED
// until DC-4 flips; Booking.com (Phase 1) is stub-mode until Q-cluster B6/C
// cred swap lands. Page mounts in a Phase-2-pending state by default.
const BookingExpediaSearch = lazy(() =>
  import("./pages/admin/BookingExpediaSearch"),
);
// CSP violations operator-inspect — slice 4 of #917, consumes slice-3 GET /api/csp/violations.
const CSPViolations = lazy(() => import("./pages/admin/CSPViolations"));
// Voyagr (OJR) per-site API key admin — slice C1 of TRAVEL_CODEABLE_BACKLOG.
// ADMIN-only; provisions per-sub-brand API keys consumed by /api/v1/voyagr.
const VoyagrApiKeys = lazy(() => import("./pages/admin/VoyagrApiKeys"));
// Embed allowlist admin — S128 of TRAVEL_BIG_SCOPE_BACKLOG. ADMIN-only;
// sets Tenant.embedAllowlistJson which controls per-tenant iframe
// frame-ancestors enforcement (S38/S39/S66/S129 chain).
const EmbedAllowlist = lazy(() => import("./pages/admin/EmbedAllowlist"));
// PRD Gap §1.5 / §1.6 — admin pages for commission profiles + per-staff
// revenue goals.
const CommissionProfiles = lazy(() => import("./pages/CommissionProfiles"));
const CommissionData = lazy(() => import("./pages/CommissionData"));
const RevenueGoals = lazy(() => import("./pages/RevenueGoals"));
const LeadRouting = lazy(() => import("./pages/LeadRouting"));
const Territories = lazy(() => import("./pages/Territories"));
const Quotas = lazy(() => import("./pages/Quotas"));
const WinLoss = lazy(() => import("./pages/WinLoss"));
const AbTests = lazy(() => import("./pages/AbTests"));
const WebVisitors = lazy(() => import("./pages/WebVisitors"));
const Chatbots = lazy(() => import("./pages/Chatbots"));
const Approvals = lazy(() => import("./pages/Approvals"));
const DocumentTemplates = lazy(() => import("./pages/DocumentTemplates"));
const Surveys = lazy(() => import("./pages/Surveys"));
const Payments = lazy(() => import("./pages/Payments"));
const DealInsights = lazy(() => import("./pages/DealInsights"));
const SharedInbox = lazy(() => import("./pages/SharedInbox"));
const SLA = lazy(() => import("./pages/SLA"));
const LiveChat = lazy(() => import("./pages/LiveChat"));
const Playbooks = lazy(() => import("./pages/Playbooks"));
const DocumentTracking = lazy(() => import("./pages/DocumentTracking"));
const IndustryTemplates = lazy(() => import("./pages/IndustryTemplates"));
const Social = lazy(() => import("./pages/Social"));
const Sandbox = lazy(() => import("./pages/Sandbox"));
const Funnel = lazy(() => import("./pages/Funnel"));
const Zapier = lazy(() => import("./pages/Zapier"));
// RBAC: admin role/permission management + per-user effective-permission view.
// Both are protected behind auth (Layout wrapper) but use page-internal
// permission checks (usePermissions) rather than RoleGuard wrap so non-ADMIN
// users granted `roles.read` through RBAC can also reach the page.
const RolesAdmin = lazy(() => import("./pages/RolesAdmin"));
const MyPermissions = lazy(() => import("./pages/MyPermissions"));
// Per-target user permission view at /staff/:userId/permissions. Reuses the
// MyPermissions visual layout but is driven by a URL param and the
// /api/users/:userId/permissions endpoint. Page-level gated on roles.read.
const StaffPermissions = lazy(() => import("./pages/StaffPermissions"));
// Public pages
const SsoReturn = lazy(() => import("./pages/SsoReturn"));
const PaymentSuccess = lazy(() => import("./pages/PaymentSuccess"));
const PaymentFailed = lazy(() => import("./pages/PaymentFailed"));
// Landing-page marketing funnel: email check → register → plan selection → Razorpay → success.
const GetStarted = lazy(() => import("./pages/GetStarted"));
const RegisterSuccess = lazy(() => import("./pages/RegisterSuccess"));
// Self-service customer registration. Creates a User with userType='CUSTOMER'
// — distinct from the wellness patient portal (OTP-based, /wellness/portal).
const CustomerRegister = lazy(() => import("./pages/CustomerRegister"));
// Travel vertical (Day 1 scaffolding — Phase 1 pages land per docs/TRAVEL_CRM_PRD.md §7)
const TravelDashboard = lazy(() => import("./pages/travel/Dashboard"));
const TravelDiagnostics = lazy(() => import("./pages/travel/Diagnostics"));
const TravelDiagnosticWizard = lazy(() => import("./pages/travel/DiagnosticWizard"));
const TravelDiagnosticBuilder = lazy(() => import("./pages/travel/DiagnosticBuilder"));
const TravelDiagnosticDetail = lazy(() => import("./pages/travel/DiagnosticDetail"));
// T16 — dedicated TMC catalogue admin (extracts the Promote-to-active sub-panel
// from DiagnosticBuilder's EngineWeights tab into a first-class page).
const TravelTmcCatalogueAdmin = lazy(() => import("./pages/travel/TmcCatalogueAdmin"));
const TravelItineraries = lazy(() => import("./pages/travel/Itineraries"));
const TravelTrips = lazy(() => import("./pages/travel/Trips"));
const TravelTripDetail = lazy(() => import("./pages/travel/TripDetail"));
const TravelWebCheckinQueue = lazy(() => import("./pages/travel/WebCheckinQueue"));
// Slice C2 — Passport OCR verification queue (ADMIN+MANAGER). PRD_PASSPORT_OCR §5.4.
const TravelPassportVerificationQueue = lazy(() => import("./pages/travel/PassportVerificationQueue"));
const TravelCostMaster = lazy(() => import("./pages/travel/CostMaster"));
// Arc 2 Travel Gap #907 slice 5/N — SightseeingMaster wire-in. SUT page
// shipped slice 3 (ca052d20); this lazy import + Route below register the
// admin-facing CRUD surface. Framed as "the 6th category in Cost Master"
// per #907, so placed adjacent to TravelCostMaster.
const TravelSightseeingMaster = lazy(() => import("./pages/travel/SightseeingMaster"));
// Arc 2 Travel Gap #907 slice 8/N — ItineraryTemplates wire-in. SUT page
// shipped slice 7 (f8768836); this lazy import + Route below register the
// admin-facing CRUD surface for reusable itinerary templates.
const TravelItineraryTemplates = lazy(() => import("./pages/travel/ItineraryTemplates"));
// S99 (TRAVEL_BIG_SCOPE_BACKLOG) — POI rep-suggested pending-approval queue
// wire-in. SUT page shipped S12 (PoiPendingApprovalQueue.jsx). ADMIN-only
// surface — backend RBAC enforces; frontend RoleGuard mirrors so non-ADMIN
// roles hit a friendly access-denied surface rather than a 403 from the
// queue fetch. Backend route mounted S98 (commit 37d9ce40).
const TravelPoiPendingApprovalQueue = lazy(() => import("./pages/travel/PoiPendingApprovalQueue"));
// S49 (TRAVEL_BIG_SCOPE_BACKLOG) — App.jsx route registration for the S31
// QuoteTemplates admin page (frontend/src/pages/travel/QuoteTemplates.jsx,
// commit 8fb23237). Sibling to ItineraryTemplates above. Without this lazy
// import + Route below, the page is unreachable from the running app.
const TravelQuoteTemplates = lazy(() => import("./pages/travel/QuoteTemplates"));
// S55 (TRAVEL_BIG_SCOPE_BACKLOG) — App.jsx route registration for the S54
// CancellationPolicies admin page (frontend/src/pages/travel/CancellationPolicies.jsx,
// commit 4823b160). Sibling to QuoteTemplates above; both are travel admin
// CRUD surfaces that mirror the QuotesAdmin / InvoicesAdmin pattern.
const TravelCancellationPolicies = lazy(() => import("./pages/travel/CancellationPolicies"));
const TravelLeads = lazy(() => import("./pages/travel/Leads"));
const TravelPricingRules = lazy(() => import("./pages/travel/PricingRules"));
const TravelReports = lazy(() => import("./pages/travel/Reports"));
const TravelRfuCustomerProfile = lazy(() => import("./pages/travel/RfuCustomerProfile"));
const TravelSuppliers = lazy(() => import("./pages/travel/Suppliers"));
const TravelSuppliersAdmin = lazy(() => import("./pages/travel/SuppliersAdmin"));
// PRD_TRAVEL_SUPPLIER_MASTER G035/G036 — Supplier PO ledger UI.
const TravelPurchaseOrders = lazy(() => import("./pages/travel/PurchaseOrders"));
// PRD_TRAVEL_SUPPLIER_MASTER G045 (FR-3.1.e, FR-3.5.a, FR-3.5.b) —
// per-supplier commission ledger landing at /travel/suppliers/:id/commissions.
const TravelSupplierCommissions = lazy(() => import("./pages/travel/SupplierCommissions"));
// PRD_TRAVEL_SUPPLIER_MASTER G044 + G046 (FR-3.3.c, FR-3.4.a-c) —
// per-supplier statement reconciliation + invoice-PDF uploads, lands at
// /travel/suppliers/:id/reconcile.
const TravelSupplierReconciliation = lazy(() => import("./pages/travel/SupplierReconciliation"));
const TravelQuotesAdmin = lazy(() => import("./pages/travel/QuotesAdmin"));
// Arc 2 #900 slice 2 — operator-facing single-quote builder (line items +
// totals panel + Save/Send/Duplicate/Download-PDF action cluster). Distinct
// from TravelQuotesAdmin which is the CRUD list. PRD:
// docs/PRD_TRAVEL_QUOTE_BUILDER.md §3. RoleGuard allow=[ADMIN,MANAGER]
// mirrors backend write RBAC.
const TravelQuoteBuilder = lazy(() => import("./pages/travel/QuoteBuilder"));
// G019 — operator-facing counter-offer review surface.
const TravelQuoteCounterReview = lazy(() => import("./pages/travel/QuoteCounterReview"));
// PRD §7 page plan — Flight quick-quote (in-CRM fallback for the not-yet-built
// Chrome flight plugin). Advisor manually enters up to 4 flight options;
// markup applies server-side (POST /api/v1/flight-plugin/agent-quotes) and
// the result panel surfaces the branded PDF + WhatsApp share. No RoleGuard —
// backend gates on travel tenant + sub-brand access; any travel operator may
// raise a quick quote (view-by-default convention like QuotesAdmin).
const TravelFlightQuoteAgent = lazy(() => import("./pages/travel/FlightQuoteAgent"));
const TravelInvoicesAdmin = lazy(() => import("./pages/travel/InvoicesAdmin"));
// Arc 2 #901 slice 7 frontend consumer — cross-invoice payment-milestone
// dashboard. Consumes /api/travel/payment-schedules/upcoming (backend commit
// e4832fee). Operator surface for upcoming/overdue milestones across all
// travel invoices; complements the per-invoice schedule view on InvoicesAdmin.
const TravelMilestoneTracker = lazy(() => import("./pages/travel/MilestoneTracker"));
// Arc 2 #903 frontend consumer — cross-supplier Payables (A/P) review page.
// Aggregates every TravelSupplierPayable across every supplier into one
// operator-facing month-end review surface; complements the per-supplier
// expand panel on SuppliersAdmin (slice 4). Placeholder fan-out fetch today;
// will swap to GET /api/travel/payables once slice 6 ships the consolidating
// endpoint (shipped page commit 2a0b00ab).
const TravelPayables = lazy(() => import("./pages/travel/Payables"));
// PRD_TRAVEL_BILLING G022 (FR-3.5.e) — supplier-payable batch ops surface.
// CRUD + state-machine ops for bundling N payables into one bank-transfer
// run with a CSV export. Consumes /api/travel/payable-batches (backend route
// travel_payable_batches.js).
const TravelPayableBatches = lazy(() => import("./pages/travel/PayableBatches"));
// PRD_TRAVEL_BILLING G024 (FR-3.6.c) — settlement-timeline Gantt view.
// Inflow (payment schedules) + outflow (supplier payables) on a single
// horizontal axis. Consumes /api/travel/settlements/timeline.
const TravelSettlementGantt = lazy(() => import("./pages/travel/SettlementGantt"));
// Q9 — travel WhatsApp dispatch log (Wati transport). Read-only list of the
// WhatsAppMessage rows backend/services/watiClient.js persists (OTPs,
// reminders, itinerary shares, boarding-pass deliveries). Consumes the
// existing tenant-scoped GET /api/whatsapp/messages — no new backend
// surface. Travel-only; the wellness/generic WhatsApp surfaces are separate.
const TravelWhatsAppLog = lazy(() => import("./pages/travel/WhatsAppLog"));
// Q9 — travel 2-way WhatsApp chat (Wati). Clone of the wellness agent inbox
// with sends routed via POST /api/travel/whatsapp/send (watiClient) and
// inbound delivered by the Wati webhook through the same socket events.
// The wellness page + its Meta Cloud transport are untouched.
const TravelWhatsAppChat = lazy(() => import("./pages/travel/WhatsAppChat"));
// Q9 — read-only Wati template library (templates are authored/approved in
// the Wati dashboard). Target of the chat sub-components' templatesPath.
const TravelWhatsAppTemplates = lazy(() => import("./pages/travel/WhatsAppTemplates"));
// #905 slice 3 frontend consumer — TravelCommissionProfile CRUD admin.
// Consumes /api/travel/commission-profiles (backend slice 2 b5042743). GET
// is verifyToken-only (any role can view); POST/PUT gated to ADMIN+MANAGER
// and DELETE gated to ADMIN — mirrored client-side via canWrite + Delete
// button gates inside the page. Shipped page commit 6c2805f9.
const TravelCommissionProfilesAdmin = lazy(() => import("./pages/travel/CommissionProfilesAdmin"));
// #908 slice 2 frontend consumer — TravelFlyerTemplate list page; companion
// to MarketingFlyerStudio (the live composer). Lists operator-saved templates
// with sub-brand filter, name search, palette-swatch preview, and a "Use as
// starting point" handoff to the Studio. Backend slice 3 (TravelFlyerTemplate
// CRUD at /api/travel/flyer-templates) shipped 5c2dd474. Shipped page commit
// a64c1058.
const TravelFlyerTemplates = lazy(() => import("./pages/travel/FlyerTemplates"));
// S79 (TRAVEL_BIG_SCOPE_BACKLOG) — operator-facing flyer share-link admin
// (companion to S18's backend POST /api/v1/flyers/:id/share mint route).
// Pick a template → mint → modal with shareUrl + embedCode + copy-clipboards.
// History panel reads /api/audit-viewer for past mints + Revoke button with
// graceful 404 when S80 revoke endpoint not yet shipped. ADMIN-gated.
const TravelFlyerShareAdmin = lazy(() => import("./pages/travel/FlyerShareAdmin"));
const TravelReligiousPackets = lazy(() => import("./pages/travel/ReligiousPackets"));
const TravelTmcMicrositePreview = lazy(() => import("./pages/travel/TmcMicrositePreview"));
const TravelItineraryDetail = lazy(() => import("./pages/travel/ItineraryDetail"));
const TravelItineraryEditor = lazy(() => import("./pages/travel/ItineraryEditor"));
const TravelLeadDetail = lazy(() => import("./pages/travel/LeadDetail"));
// Arc 2 #904 slice — InboundLeads admin page (STUB consumer). Operator-facing
// list of inbound leads ingested via POST /api/travel/inbound/leads/:channel
// (slice 1 webhook scaffold 8b562b0b + slice 4 HMAC/spam verification
// 5bd46b2e). The dedicated GET listing endpoint is deferred to a future
// slice — page currently fetches /api/contacts?limit=100 and filters
// client-side for `source.startsWith('inbound:')`. Convert-to-Lead button
// hands off to /leads/:contactId. Shipped page commit 56f549f7.
const TravelInboundLeads = lazy(() => import("./pages/travel/InboundLeads"));
// Phase 3 Visa Sure scaffolding (cluster B3) — placeholder shells only.
// Real implementation gated on product calls in docs/PRD_VISA_SURE_PHASE_3.md §5 + §9.
const TravelVisaDashboard = lazy(() => import("./pages/travel/visa/Dashboard"));
const TravelVisaApplications = lazy(() => import("./pages/travel/visa/Applications"));
const TravelVisaChecklists = lazy(() => import("./pages/travel/visa/Checklists"));
const TravelVisaAdvisorDashboard = lazy(() => import("./pages/travel/visa/AdvisorDashboard"));
const TravelVisaReports = lazy(() => import("./pages/travel/visa/Reports"));
// Phase 3 Visa Sure embassy-rules admin (tick #178, consumes /api/embassy-rules
// from backend commit 05587ac7). ADMIN-only mutation gate; route wrapped in
// RoleGuard allow=["ADMIN"] mirroring backend POST/PUT/DELETE RBAC.
const TravelVisaEmbassyRulesAdmin = lazy(() => import("./pages/travel/visa/EmbassyRulesAdmin"));
// G107 — Visa Sure rejection-recovery program admin (PRD_VISA_SURE_PHASE_3 §FR-7).
const TravelVisaRecoveryProgram = lazy(() => import("./pages/travel/visa/RecoveryProgram"));
// Phase 1 TMC curriculum-mappings admin (tick #181, consumes /api/travel-curriculum
// from backend commit 6d5919a8 — tick #180). ADMIN-only mutation gate;
// route wrapped in RoleGuard allow=["ADMIN"] mirroring backend
// POST/PUT/DELETE RBAC. School-trip pitch-deck mappings (curriculum ×
// grade × subject → destination) consumed by the diagnostic engine.
const TravelCurriculumAdmin = lazy(() => import("./pages/travel/CurriculumAdmin"));
// TMC school term calendar admin — term/holiday/exam windows for trip scheduling.
const TravelSchoolTermCalendar = lazy(() => import("./pages/travel/SchoolTermCalendar"));
// Phase 2 SHELL for #908 Marketing Flyer Studio (tick #186). Designed in
// docs/PRD_TRAVEL_MARKETING_FLYER.md; this is a non-functional scaffold —
// real implementation lands per PRD §8 dependency build order. ADMIN +
// MANAGER only per RoleGuard on the route element.
const TravelMarketingFlyerStudio = lazy(() => import("./pages/travel/MarketingFlyerStudio"));
// Phase 2 Travel Stall operator landing (TS21) — scaffold shell.
const TravelStallDashboard = lazy(() => import("./pages/travel/TravelStallDashboard"));
// Wellness vertical
const WellnessOwnerDashboard = lazy(
  () => import("./pages/wellness/OwnerDashboard"),
);
const WellnessRecommendations = lazy(
  () => import("./pages/wellness/Recommendations"),
);
const WellnessPatients = lazy(() => import("./pages/wellness/Patients"));
const WellnessPatientDetail = lazy(
  () => import("./pages/wellness/PatientDetail"),
);
const WellnessServices = lazy(() => import("./pages/wellness/Services"));
const WellnessLocations = lazy(() => import("./pages/wellness/Locations"));
const WellnessMemberships = lazy(() => import("./pages/wellness/Memberships"));
// Unified CSV import / export hub — single dropdown picks the entity then
// delegates to the existing CsvImportExportToolbar component.
const DataImportExport = lazy(() => import("./pages/DataImportExport"));
// Wave 7 Agent A — ServiceCategory + Drug catalogue (PRD Gap §10 #1 + #2)
const WellnessServiceCategories = lazy(() => import("./pages/wellness/ServiceCategories"));
const WellnessDrugs = lazy(() => import("./pages/wellness/Drugs"));
// Wave 11 Agent FF — Wallet + Gift Cards + Coupons + Cashback rules
// (4 admin/manager-gated pages under /wellness/* — see RoleGuard wrap below).
const WellnessWallet = lazy(() => import("./pages/wellness/Wallet"));
const WellnessGiftCards = lazy(() => import("./pages/wellness/GiftCards"));
const WellnessBuyGiftCards = lazy(() => import("./pages/wellness/BuyGiftCards"));
// Customer-facing transaction history — surfaced in the sidebar only for
// customer-tier roles (USER / CUSTOMER) via the `customerOnly` catalog flag.
const WellnessMyTransactions = lazy(() => import("./pages/wellness/MyTransactions"));
const WellnessCoupons = lazy(() => import("./pages/wellness/Coupons"));
const WellnessCashbackRules = lazy(() => import("./pages/wellness/CashbackRules"));
const WellnessCalendar = lazy(() => import("./pages/wellness/Calendar"));
const WellnessBookAppointment = lazy(() => import("./pages/wellness/BookAppointment"));
const WellnessAppointments = lazy(() => import("./pages/wellness/Appointments"));
const WellnessMyAppointments = lazy(() => import("./pages/wellness/MyAppointments"));
const WellnessMyBookings = lazy(() => import("./pages/wellness/MyBookings"));
const WellnessReports = lazy(() => import("./pages/wellness/Reports"));
const WellnessVisits = lazy(() => import("./pages/wellness/Visits"));
const WellnessPrescriptions = lazy(
  () => import("./pages/wellness/Prescriptions"),
);
// Staff-authed self-view of own Rx — granted via `my_prescriptions.read`.
// Companion to the patient portal's prescriptions tab for staff users who
// are ALSO patients at this clinic.
const WellnessMyPrescriptions = lazy(
  () => import("./pages/wellness/MyPrescriptions"),
);
const WellnessPublicBooking = lazy(
  () => import("./pages/wellness/PublicBooking"),
);
const WellnessTelecallerQueue = lazy(
  () => import("./pages/wellness/TelecallerQueue"),
);
const WellnessPatientPortal = lazy(
  () => import("./pages/wellness/PatientPortal"),
);
const WellnessPerLocation = lazy(
  () => import("./pages/wellness/PerLocationDashboard"),
);
const WellnessLoyalty = lazy(() => import("./pages/wellness/Loyalty"));
const WellnessWaitlist = lazy(() => import("./pages/wellness/Waitlist"));
// #305: /wellness/inventory used to render a blank page (no route element).
// Inventory is implemented as a tab inside PatientDetail; this stub explains
// that and links to the patient list.
const WellnessInventory = lazy(() => import("./pages/wellness/Inventory"));
// Wave 11 Agent HH — Inventory backbone admin pages (categories, products, vendors,
// receipts, adjustments, auto-consumption rules). All ADMIN/MANAGER-only.
const WellnessProductCategories = lazy(() => import("./pages/wellness/ProductCategories"));
const WellnessProducts = lazy(() => import("./pages/wellness/Products"));
const WellnessVendors = lazy(() => import("./pages/wellness/Vendors"));
const WellnessInventoryReceipts = lazy(() => import("./pages/wellness/InventoryReceipts"));
const WellnessInventoryAdjustments = lazy(() => import("./pages/wellness/InventoryAdjustments"));
const WellnessAutoConsumptionRules = lazy(() => import("./pages/wellness/AutoConsumptionRules"));
// Wave 11 Agent GG — Resource availability admin pages (rooms / machines /
// holidays / per-doctor working hours). All ADMIN/MANAGER-only.
const WellnessResources = lazy(() => import("./pages/wellness/Resources"));
const WellnessHolidays = lazy(() => import("./pages/wellness/Holidays"));
const WellnessWorkingHours = lazy(() => import("./pages/wellness/WorkingHoursEditor"));
// Wave 2 Agent KK - WhatsApp 2-way threads (agent inbox).
const WellnessWhatsAppThreads = lazy(() => import("./pages/wellness/WhatsAppThreads"));
const WellnessWhatsAppTemplates = lazy(() => import("./pages/wellness/WhatsAppTemplates"));
// Wave 2 Agent JJ — Staff Attendance + Leave Management. Open to all roles
// (everyone needs to clock in/out + manage their own leave); manager+
// surfaces appear inline based on AuthContext.role.
const WellnessAttendance = lazy(() => import("./pages/wellness/Attendance"));
const WellnessLeave = lazy(() => import("./pages/wellness/Leave"));
// Wave 2 Agent II — POS / Cash Register / Shift / Sale MVP UI.
const WellnessPointOfSale = lazy(() => import("./pages/wellness/PointOfSale"));
// Public customer-facing survey page (no admin chrome — see /survey/:id route below)
const SurveyPublic = lazy(() => import("./pages/SurveyPublic"));
// v3.7.17 — token-based respondent landing page (the email link target).
// Renders the survey form (legacy NPS/CSAT or new multi-question types)
// and posts answers back to the matching /respond endpoint.
const SurveyRespond = lazy(() => import("./pages/SurveyRespond"));
// Public signer-facing e-signature landing page (the email link target).
// Token-protected, no admin chrome — renders a PDF preview + signature pad.
const SignDocument = lazy(() => import("./pages/SignDocument"));
// Public customer-facing knowledge-base article view (no auth, no admin chrome).
// Replaces the raw-JSON backend response that the KB "View" button used to open.
const KbArticleView = lazy(() => import("./pages/KbArticleView"));
// #341: global catch-all 404. Previously unmapped or wrong-prefix URLs
// (e.g. /loyalty without /wellness/) rendered a blank <main> with HTTP 200
// because the SPA layout served but nothing inside it matched.
const NotFound = lazy(() => import("./pages/NotFound"));

export const AuthContext = createContext();
export const ThemeContext = createContext();

// Issue #207/#214/#216: wellness staff carry RBAC role=USER + an orthogonal
// `wellnessRole` (doctor/professional/telecaller/helper/stylist). The Owner
// Dashboard at /wellness exposes org-wide P&L (₹12L) and is for ADMIN/MANAGER
// only — clinical and operational staff need their own landing page so they
// don't see financial KPIs they shouldn't see. Login.jsx routes correctly on
// fresh login; this helper covers refresh / `/` / GenericOnly bounces where
// the URL would otherwise resolve to /wellness Owner Dashboard for everyone.
function wellnessLandingFor(user) {
  if (!user) return '/home';
  if (user.role === 'ADMIN' || user.role === 'MANAGER') return '/wellness';
  switch (user.wellnessRole) {
    case 'owner':
    case 'manager':
    case 'admin':
      return '/wellness';
    default:
      // Everyone else (doctor / professional / telecaller / helper /
      // plain users) lands on the role-aware /home widget dashboard.
      // /home renders only the widgets and quick-actions the user has
      // permission for, so it's always the right starting surface even
      // when the user has zero wellness clinical permissions.
      return '/home';
  }
}

// Per-role landingPath (configured by admin via Roles & Permissions) wins
// over the vertical-default heuristic. Lets a new role become a config
// change rather than a code edit in this file. Exported helper so the
// GenericOnly / WellnessOwnerOnly guards use a single source of truth.
//
// EXCEPTION: a configured value of "/dashboard" is the system-wide ADMIN
// default (and the implicit fallback for any role missing an explicit
// landingPath). For non-generic verticals (wellness, travel) that's wrong
// — those verticals have their own home surfaces, not the Enterprise
// Overview. We override the generic default; any explicitly-customised
// non-default path (e.g. /home, /wellness/calendar, /travel/leads) still
// wins.
function landingFor(user, tenant) {
  const configured = user?.landingPath || user?.primaryRole?.landingPath || null;
  const isGenericDefault = !configured || configured === '/dashboard';
  if (isGenericDefault) {
    if (tenant?.vertical === 'wellness') return wellnessLandingFor(user);
    if (tenant?.vertical === 'travel') return '/travel';
    return '/dashboard';
  }
  return configured;
}

// Honour the marketing-site `?next=` handoff when an already-authenticated
// user hits /login or /customer/register (the route guards normally bounce
// them to their landing page, which loses the handoff context). Only
// accepts in-app paths so a hostile `?next=https://evil.com/phish` falls
// back to the supplied default.
function landingWithHandoff(fallback) {
  try {
    const next = new URLSearchParams(window.location.search).get('next');
    if (next && next.startsWith('/') && !next.startsWith('//')) {
      return decodeURIComponent(next);
    }
  } catch (_e) { /* fall through */ }
  return fallback;
}

// Detect whether the URL carries marketing-site handoff params. When yes,
// /customer/register should ALWAYS render its form — even if there's an
// existing session — because the user explicitly came in to create a new
// customer account (often distinct from whatever stale admin/staff session
// happens to be lingering in their browser).
function hasMarketingHandoff() {
  try {
    const p = new URLSearchParams(window.location.search);
    return !!(p.get('tenantSlug') && p.get('next'));
  } catch (_e) {
    return false;
  }
}

// Route guard: bounces wellness tenants away from generic-CRM-only pages.
// The generic Enterprise Overview, deal pipeline, forecasting, etc. don't apply
// to a clinic — wellness has its own /wellness Owner Dashboard. Without this
// guard, typing /dashboard in the URL bar (or following a stale bookmark) would
// surface "Pipeline Analytics" + "Recent Deals" panels that confuse the user.
// #207/#214: route to a role-aware wellness landing rather than the org-wide
// Owner Dashboard so doctors / telecallers / helpers don't see ₹12L P&L.
function GenericOnly({ children }) {
  const { tenant, user } = useContext(AuthContext);
  if (tenant?.vertical === 'wellness') {
    return <Navigate to={landingFor(user, tenant)} replace />;
  }
  return children;
}

// #207/#214: doctor/telecaller landing on /wellness directly (e.g. clicking
// the sidebar logo, typing the URL, or refreshing) would still see the Owner
// Dashboard with org-wide P&L. Gate the Owner Dashboard route to ADMIN/MANAGER
// (or `wellnessRole === owner|manager|admin`) and redirect everyone else to
// their role-appropriate landing.
function WellnessOwnerOnly({ children }) {
  const { user, tenant } = useContext(AuthContext);
  const target = landingFor(user, tenant);
  if (target !== '/wellness') {
    return <Navigate to={target} replace />;
  }
  return children;
}

// #325: mirror of GenericOnly for the wellness vertical. Generic CRM tenants
// (e.g. admin@globussoft.com on the Default Org) were able to navigate to
// /wellness URLs even though wellness is a separate tenant — the pages would
// load but show empty/cross-tenant data. Bounce them to the generic dashboard.
// A stricter RBAC check at the API level still applies; this guard is just to
// stop the URL bar from rendering a misleading wellness UI on non-wellness
// tenants.
function WellnessOnly({ children }) {
  const { user, tenant } = useContext(AuthContext);
  if (tenant && tenant.vertical !== "wellness") {
    return <Navigate to={landingFor(user, tenant)} replace />;
  }
  return children;
}

// Sibling of WellnessOnly for the travel vertical. Inline-defined here to
// match the WellnessOnly pattern (no separate component file). Main added
// the <TravelOnly>...</TravelOnly> wrapper at every travel route (41 call
// sites at App.jsx:1174-1289) but the inline component definition was
// dropped by the main→staging_crm Python union pass on commit bd25d6f2.
// This restores the definition so the 41 react/jsx-no-undef lint errors
// clear.
function TravelOnly({ children }) {
  const { user, tenant } = useContext(AuthContext);
  if (tenant && tenant.vertical !== "travel") {
    return <Navigate to={landingFor(user, tenant)} replace />;
  }
  return children;
}

// /home is the role-aware widget dashboard for non-admin users. Admins
// already have their tenant's primary dashboard (Owner Dashboard at
// /wellness on wellness tenants, Enterprise Overview at /dashboard on
// generic) which covers the same ground — so bounce admins away rather
// than rendering a near-duplicate landing page. The sidebar already hides
// the Home link for admins; this guard handles direct-URL / bookmarked
// visits.
function HomeForNonAdmin({ children }) {
  const { user, tenant } = useContext(AuthContext);
  if (user?.role === 'ADMIN') {
    const target = tenant?.vertical === 'wellness' ? '/wellness' : '/dashboard';
    return <Navigate to={target} replace />;
  }
  return children;
}

// #303: bare /calendar used to render a blank <main> because the route table
// had no entry for it. Wellness tenants are bounced to their themed calendar
// (/wellness/calendar); generic tenants land on /calendar-sync which is the
// closest analog (Google/Outlook calendar binding management).
//
// Patient-experience separation (Path B): a CUSTOMER user (the patient
// cohort) lands on /wellness/my-bookings instead of the operational
// Calendar, which is reserved for Admin / Reception / Practitioners.
function CalendarRedirect() {
  const { tenant, user } = useContext(AuthContext);
  if (tenant?.vertical === "wellness") {
    if (user?.role === "CUSTOMER") {
      return <Navigate to="/wellness/my-bookings" replace />;
    }
    return <Navigate to="/wellness/calendar" replace />;
  }
  return <Navigate to="/calendar-sync" replace />;
}

export default function App() {
  // #116: persist user across reloads. Pre-fix, user started as null on every
  // page load (token + tenant were restored, but not user), so the header showed
  // "User" / "?" even though login had succeeded.
  const [user, setUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("user") || "null");
    } catch {
      return null;
    }
  });
  const [tenant, setTenant] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("tenant") || "null");
    } catch {
      return null;
    }
  });
  // #343 [SECURITY]: token no longer lives in localStorage. It's held in
  // memory inside utils/api.js with sessionStorage as the rehydrate source on
  // hard refresh, so it doesn't survive a browser restart and isn't readable
  // from a stolen disk image. We do a one-time migration of any legacy
  // localStorage token from a pre-fix build so users don't get punted to
  // /login on first deploy. The XSS-can-still-read-it caveat is documented
  // in utils/api.js — the real fix is httpOnly cookies (TODOS.md wishlist).
  const [token, setTokenState] = useState(() => {
    let initial = getAuthToken();
    if (!initial) {
      try {
        const legacy = localStorage.getItem("token");
        if (legacy) {
          initial = legacy;
          setAuthToken(legacy);
          localStorage.removeItem("token");
        }
      } catch {
        /* ignore */
      }
    }
    return initial || null;
  });
  // setToken accepts an optional `opts` object — currently only `remember`,
  // which the Login form passes from its "Keep me signed in" checkbox. When
  // set, the token is mirrored to localStorage so deep links opened in new
  // tabs can rehydrate without forcing a re-login. See utils/api.js for the
  // security trade-off.
  const setToken = (next, opts) => {
    setAuthToken(next, opts);
    setTokenState(next || null);
  };
  // #347: gate initial mount until we've finished rehydrating the token
  // from sessionStorage. Without this, child pages fire fetches in their
  // own useEffect before AuthContext finishes mounting, racing the token
  // and getting 403s. We render a splash until `loading` flips false on
  // first effect tick (synchronous-after-mount).
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem("theme");
    if (stored) return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [subscription, setSubscription] = useState(null);
  const [daysRemaining, setDaysRemaining] = useState(null);

  useEffect(() => {
    // Token storage is owned by setAuthToken/clearAuthToken in utils/api.js
    // (in-memory + sessionStorage). Nothing to mirror to localStorage anymore.
    if (!token) {
      // Defensive: if some legacy code path nulled `token` directly via
      // setTokenState, make sure the api-side state is in sync.
      clearAuthToken();
    }
  }, [token]);

  // Mark auth as ready after the very first render so any fetch helpers
  // that wait on whenAuthReady() unblock once we've had a chance to read
  // sessionStorage. This runs synchronously after mount.
  useEffect(() => {
    setLoading(false);
    markAuthReady();
  }, []);

  useEffect(() => {
    if (user) {
      localStorage.setItem("user", JSON.stringify(user));
    } else {
      localStorage.removeItem("user");
    }
  }, [user]);

  useEffect(() => {
    if (tenant) {
      localStorage.setItem("tenant", JSON.stringify(tenant));
    } else {
      localStorage.removeItem("tenant");
    }
  }, [tenant]);

  // Fetch subscription status after login
  useEffect(() => {
    if (token) {
      const fetchSubscriptionStatus = async () => {
        try {
          const data = await fetch("/api/subscriptions/status", {
            headers: { "Authorization": `Bearer ${token}` }
          }).then((res) => res.json());
          setSubscription(data);
          setDaysRemaining(data.daysRemaining || 0);
        } catch (err) {
          console.error("[Subscription] Fetch status error:", err);
        }
      };
      fetchSubscriptionStatus();
    }
  }, [token]);

  useEffect(() => {
    let effectiveTheme = theme;
    if (theme === "system") {
      effectiveTheme = window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
    }
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    if (theme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = (e) => {
      const effectiveTheme = e.matches ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", effectiveTheme);
    };
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [theme]);

  // Apply vertical-specific theme overrides (e.g. wellness gets Dr. Haror palette)
  useEffect(() => {
    const v = tenant?.vertical || "generic";
    document.documentElement.setAttribute("data-vertical", v);
    document.body.setAttribute("data-vertical", v);
  }, [tenant]);

  // Theme toggle. Uses the View Transitions API in browsers that support it
  // (Chrome/Edge 111+, Safari 18+) so the swap is a GPU-composited crossfade
  // instead of a sharp snap. The browser captures the page as a screenshot,
  // applies the new theme synchronously inside the callback, then fades the
  // old screenshot out over the new state — entirely on the compositor, no
  // main-thread work. flushSync forces React to commit the setState before
  // the callback returns, otherwise the API would crossfade the OLD state
  // with itself (the React update would land after the screenshot was
  // taken). Browsers without the API fall through to a plain setState,
  // which is now an instant snap (no desync since body's stranded
  // transition was removed in index.css).
  const toggleTheme = () => {
    const advance = () =>
      setTheme((t) => {
        if (t === "light") return "dark";
        if (t === "dark") return "system";
        return "light";
      });
    if (typeof document.startViewTransition === "function") {
      document.startViewTransition(() => {
        flushSync(advance);
      });
    } else {
      advance();
    }
  };

  // #529 / #530: stable callback reference. Prior shape created a new fn
  // on every App render, which (combined with the inline AuthContext
  // value object below) made every consumer's useEffect re-run on every
  // App render — Sidebar's count-fetcher fired a flurry of duplicate HTTP
  // calls + a fresh socket on each cycle. Hoisted ABOVE the `loading`
  // early-return so the hook count stays consistent across renders
  // (rules-of-hooks).
  const loginWithToken = useCallback(async (tokenArg, tenantArg) => {
    // #343 [SECURITY] follow-up: setToken routes the token through
    // setAuthToken (utils/api.js) which puts it in the in-memory holder +
    // sessionStorage. A previous explicit localStorage write of the token key
    // sat here from before the #343 migration and silently re-introduced the
    // XSS-readable credential the migration removed. Deleted; the
    // sessionStorage write inside setToken is the only canonical storage now.
    // Regression-guarded by frontend/src/__tests__/security-token-storage.test.js.
    setToken(tokenArg);
    if (tenantArg) {
      setTenant(tenantArg);
      localStorage.setItem("tenant", JSON.stringify(tenantArg));
      // Set data-vertical synchronously here (not just in the useEffect that
      // fires after re-render) so navigation immediately following login sees
      // the correct attribute — the React state update + useEffect cycle is
      // async and tests / route guards landing on /wellness can otherwise read
      // body[data-vertical="generic"] for one frame.
      const v = tenantArg.vertical || "generic";
      document.documentElement.setAttribute("data-vertical", v);
      document.body.setAttribute("data-vertical", v);
    }
    const res = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${tokenArg}` },
    });
    if (!res.ok) {
      setToken(null);
      localStorage.removeItem("token");
      throw new Error("SSO token rejected");
    }
    const profile = await res.json();
    setUser(profile);
    localStorage.setItem("user", JSON.stringify(profile));
    return profile;
  }, []);

  // #529 / #530: memoise the AuthContext value so consumers don't re-render
  // (and re-fire mount effects) on every App render. State setters from
  // useState are stable by React contract; loginWithToken is now a stable
  // useCallback. The remaining inputs (user/token/tenant/loading) are real
  // state — when one genuinely changes, all consumers SHOULD update.
  const authValue = useMemo(
    () => ({
      user,
      setUser,
      token,
      setToken,
      tenant,
      setTenant,
      loading,
      loginWithToken,
      subscription,
    }),
    [user, token, tenant, loading, loginWithToken, subscription],
  );

  // #347: while AuthContext is still rehydrating the token from sessionStorage
  // we render a single splash. Pages mount their own fetches in useEffect, and
  // before this gate they raced the token and 403'd. Since `loading` flips
  // false on the first effect tick (synchronous after mount), this is a one-
  // frame splash on cold-start, invisible in normal nav. Lives BELOW the
  // hooks so the hook count is consistent across renders (rules-of-hooks).
  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          height: "100vh",
          color: "var(--text-primary, #888)",
        }}
      >
        Loading...
      </div>
    );
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>
      <AuthContext.Provider value={authValue}>
        <NotifyProvider>
          <ActiveSubBrandProvider>
          <BrowserRouter>
            <RouteErrorBoundary>
              <Suspense
                fallback={
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      height: "100vh",
                      color: "var(--text-primary)",
                    }}
                  >
                    Loading...
                  </div>
                }
              >
                <Routes>
                  <Route
                    path="/login"
                    element={
                      // Same handoff treatment as /customer/register — when
                      // the marketing-site link is present, let the user
                      // sign in as whoever they actually came in to be (the
                      // pre-filled customer email is rarely the same as the
                      // stale admin/staff session their browser holds).
                      (!token || hasMarketingHandoff()) ? (
                        <Login />
                      ) : (
                        <Navigate to={landingWithHandoff(landingFor(user, tenant))} replace />
                      )
                    }
                  />
                  <Route
                    path="/signup"
                    element={
                      !token ? (
                        <Signup />
                      ) : (
                        <Navigate to={landingFor(user, tenant)} replace />
                      )
                    }
                  />
                  <Route
                    path="/customer/register"
                    element={
                      // Always show the form when the URL carries a marketing
                      // handoff — even if there's an existing session — so
                      // users coming from Dr. Haror's checkout can register a
                      // new customer account regardless of whatever stale
                      // staff/admin session their browser is holding.
                      (!token || hasMarketingHandoff())
                        ? <CustomerRegister />
                        : <Navigate to={landingWithHandoff("/home")} replace />
                    }
                  />
                  <Route path="/sso/return" element={<SsoReturn />} />
                  <Route path="/pricing" element={<Pricing />} />
                  <Route path="/payment-success" element={<PaymentSuccess />} />
                  <Route path="/payment-failed" element={<PaymentFailed />} />
                  <Route
                    path="/get-started"
                    element={!token ? <GetStarted /> : <Navigate to={landingFor(user, tenant)} replace />}
                  />
                  <Route path="/register-success" element={<RegisterSuccess />} />
                  <Route path="/terms-and-conditions" element={<LegalPage page="terms-and-conditions" />} />
                  <Route path="/privacy-policy" element={<LegalPage page="privacy-policy" />} />
                  <Route path="/deleted-account-policy" element={<LegalPage page="deleted-account-policy" />} />
                  <Route path="/portal" element={<Portal />} />
                  {/* Travel customer portal — end-user (Contact) login + dashboard
                      + DigiLocker / Aadhaar verification (PRD §4.5 extended).
                      Distinct from /portal (Knowledge Base) + /wellness/portal
                      (wellness patient OTP). Travel-tenant scoped on the
                      backend via requireTravelPortalTenant. */}
                  {/* Wildcard: TravelCustomerPortal handles its own sub-paths
                      (/login, /bookings, etc.) internally — must stay /* or
                      those sub-routes 404. The more-specific kyc/callback route
                      below still wins via React Router's specificity ranking. */}
                  <Route path="/travel/portal/*" element={<TravelCustomerPortal />} />
                  {/* Public TMC trip microsite (parent/teacher, no login) +
                      the DigiLocker/Aadhaar OAuth callback landing pages.
                      All three are public — server openPath allowlist covers
                      the backend. The two callback routes catch DigiLocker's
                      ?code&state redirect and complete verification. */}
                  <Route path="/p/tripmicrosite/:publicUuid" element={<PublicTripMicrosite />} />
                  {/* Public itinerary share link (no auth). The advisor's
                      "Share link" generates /p/itinerary/:shareToken; the lead
                      reviews the itinerary + pays the 50% advance here without
                      logging in. Backend openPath: /travel/itineraries/public. */}
                  <Route path="/p/itinerary/:shareToken" element={<TripBooking />} />
                  {/* PRD §3.1 / slice T9 — public 12-Q readiness diagnostic. */}
                  <Route path="/p/tmc/readiness" element={<TmcReadiness />} />
                  {/* PRD §3.5 / slice T10 — public 10-section readiness report. */}
                  <Route path="/p/tmc/report/:slug" element={<TmcReadinessReport />} />
                  {/* PRD_TRAVEL_QUOTE_BUILDER §3.7 / slice C9 — customer-accept landing. */}
                  <Route path="/p/quote/:shareToken" element={<QuoteAcceptLanding />} />
                  <Route path="/travel/kyc/callback" element={<TravelKycCallback flow="microsite" />} />
                  <Route path="/travel/portal/kyc/callback" element={<TravelKycCallback flow="portal" />} />
                  <Route
                    path="/book/:slug"
                    element={<WellnessPublicBooking />}
                  />
                  {/* #208: wellness patient portal lives under /wellness/portal so it
                inherits the wellness theme + namespace. The generic /portal route
                above stays as the Knowledge Base / customer portal for non-wellness
                tenants. /patient-portal kept as a back-compat alias. */}
                  <Route
                    path="/wellness/portal"
                    element={<WellnessPatientPortal />}
                  />
                  <Route
                    path="/wellness/portal/login"
                    element={<WellnessPatientPortal />}
                  />
                  <Route
                    path="/patient-portal"
                    element={<WellnessPatientPortal />}
                  />
                  {/* #184: customer-facing survey landing page from SMS — no auth, no admin chrome */}
                  <Route path="/survey/:id" element={<SurveyPublic />} />
                  {/* v3.7.17 — token-based respondent landing page. The
                      Send-Survey email link points here. */}
                  <Route path="/surveys/respond/:token" element={<SurveyRespond />} />
                  <Route path="/sign/:token" element={<SignDocument />} />
                  {/* Public knowledge-base article view (no auth). Replaces the raw
                      backend JSON URL that the KB "View" button used to open. */}
                  <Route
                    path="/kb/:tenantSlug/:slug"
                    element={<KbArticleView />}
                  />
                  {/* Landing page for unauthenticated visitors; authenticated users
                route to their per-role landingPath. The marketing Landing page
                links to /login and /signup in its navbar, hero, and footer. */}
                  <Route
                    path="/"
                    element={
                      !token ? (
                        <Landing />
                      ) : (
                        <Navigate to={landingFor(user, tenant)} replace />
                      )
                    }
                  />
                  <Route
                    path="/*"
                    element={token ? <Layout /> : <Navigate to="/login" />}
                  >
                    <Route
                      path="dashboard"
                      element={
                        <GenericOnly>
                          <Dashboard />
                        </GenericOnly>
                      }
                    />
                    {/* /home — role-aware widget dashboard for non-admin
                        roles. Admins are bounced to /wellness (wellness
                        tenants) or /dashboard (generic) since the Owner
                        Dashboard covers the same ground. Widgets filter
                        by permission server-side via /api/widgets/me. */}
                    <Route
                      path="home"
                      element={
                        <HomeForNonAdmin>
                          <Home />
                        </HomeForNonAdmin>
                      }
                    />
                    <Route path="contacts" element={<Contacts />} />
                    <Route path="contacts/:id" element={<ContactDetail />} />
                    <Route
                      path="pipeline"
                      element={
                        <GenericOnly>
                          <Pipeline />
                        </GenericOnly>
                      }
                    />
                    <Route path="inbox" element={<Inbox />} />
                    <Route
                      path="marketing"
                      element={
                        <RoleGuard
                          allow={["ADMIN", "MANAGER"]}
                          feature="Marketing"
                          roles="manager (or admin)"
                          lockedInPlace
                        >
                          <Marketing />
                        </RoleGuard>
                      }
                    />
                    <Route path="reports" element={<Reports />} />
                    <Route path="agent-reports" element={<AgentReports />} />
                    <Route path="workflows" element={<Workflows />} />
                    <Route path="developer" element={<Developer />} />
                    <Route
                      path="billing"
                      element={<Navigate to="/invoices" />}
                    />
                    <Route path="cpq" element={<CPQ />} />
                    <Route path="marketplace" element={<Marketplace />} />
                    <Route
                      path="channels"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Channels requires admin access.">
                          <Channels />
                        </RoleGuard>
                      }
                    />
                    <Route path="landing-pages" element={<LandingPages />} />
                    <Route
                      path="landing-pages/builder/:id"
                      element={<LandingPageBuilder />}
                    />
                    <Route path="objects" element={<CustomObjects />} />
                    <Route
                      path="objects/:entityName"
                      element={<CustomObjectView />}
                    />
                    <Route path="sequences" element={<Sequences />} />
                    <Route
                      path="sequences/:id/builder"
                      element={<SequenceBuilder />}
                    />
                    <Route path="support" element={<Support />} />
                    <Route
                      path="settings"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Settings requires admin access.">
                          <Settings />
                        </RoleGuard>
                      }
                    />
                    {/* Manage Subscription Plans — Owner-only catalog editor.
                        The page itself gates render on usePermissions().isOwner,
                        so no RoleGuard wrap (RoleGuard reads user.role which is
                        ADMIN/MANAGER/USER; OWNER lives on the isOwner flag). */}
                    <Route path="manage-plans" element={<ManagePlans />} />
                    <Route
                      path="data-import-export"
                      element={
                        <RoleGuard allow={["ADMIN", "MANAGER"]} message="Import / Export requires admin or manager access.">
                          <DataImportExport />
                        </RoleGuard>
                      }
                    />
                    <Route path="expenses" element={<Expenses />} />
                    <Route path="contracts" element={<Contracts />} />
                    <Route path="estimates" element={<Estimates />} />
                    <Route path="invoices" element={<Invoices />} />
                    <Route path="tickets" element={<Tickets />} />
                    <Route path="tasks" element={<Tasks />} />
                    <Route path="lead-scoring" element={<LeadScoring />} />
                    <Route path="projects" element={<Projects />} />
                    <Route path="clients" element={<Clients />} />
                    <Route path="leads" element={<Leads />} />
                    <Route
                      path="converted-leads"
                      element={<ConvertedLeads />}
                    />
                    <Route
                      path="callified-data"
                      element={<CallifiedData />}
                    />
                    <Route
                      path="staff"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Staff requires admin access.">
                          <Staff />
                        </RoleGuard>
                      }
                    />
                    {/* Per-target user permission view. Route is auth-only;
                        the page rechecks roles.read so non-admin admins
                        with the RBAC grant can also reach it, and so a
                        cross-tenant userId hits the backend's tenant guard
                        rather than a frontend allow-list. */}
                    <Route
                      path="staff/:userId/permissions"
                      element={<StaffPermissions />}
                    />
                    <Route path="profile" element={<Profile />} />
                    <Route path="profile/2fa" element={<Profile2FA />} />
                    {/* RBAC: every authed user can view their own effective
                        permissions. Page is read-only and not gated. */}
                    <Route path="profile/permissions" element={<MyPermissions />} />
                    {/* RBAC: role + permission admin. Route is auth-only; the
                        page renders <AccessDenied /> for users without
                        roles.read so non-ADMIN admins with the RBAC grant can
                        still reach it. */}
                    <Route path="settings/roles" element={<RolesAdmin />} />
                    {/* G009 — Multi-channel Lead Capture admin (FR-3.7). */}
                    <Route
                      path="settings/lead-capture"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Lead Capture settings require admin access.">
                          <LeadCapture />
                        </RoleGuard>
                      }
                    />
                    <Route path="notification-settings" element={<UserSettings />} />
                    {/* #589: Audit Log is ADMIN-only (mirrors Sidebar's
                        adminOnly visibility + the "System Admin Required"
                        toast text). Pre-fix, USER + MANAGER navigation to
                        /audit-log rendered the full Audit Log shell (KPI
                        cards, entity/action/user/date filters) before a
                        toast surfaced — leaking the existence of the audit
                        pipeline, tracked entities, and the role-name. The
                        backend route at /api/audit-viewer allows MANAGER too,
                        but the more-restrictive frontend gate prevents the
                        info-disclosure render. */}
                    <Route
                      path="audit-log"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Audit Log requires admin access.">
                          <AuditLog />
                        </RoleGuard>
                      }
                    />
                    <Route path="privacy" element={<Privacy />} />
                    <Route path="calendar-sync" element={<CalendarSync />} />
                    <Route
                      path="pipelines"
                      element={
                        <GenericOnly>
                          <Pipelines />
                        </GenericOnly>
                      }
                    />
                    <Route
                      path="forecasting"
                      element={
                        <GenericOnly>
                          <Forecasting />
                        </GenericOnly>
                      }
                    />
                    <Route path="dashboards" element={<Dashboards />} />
                    <Route path="custom-reports" element={<CustomReports />} />
                    <Route path="booking-pages" element={<BookingPages />} />
                    <Route path="signatures" element={<Signatures />} />
                    <Route path="knowledge-base" element={<KnowledgeBase />} />
                    <Route path="currencies" element={<Currencies />} />
                    <Route
                      path="field-permissions"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Field Permissions requires admin access.">
                          <FieldPermissions />
                        </RoleGuard>
                      }
                    />
                    {/* Per-sub-brand BrandKit admin UI. ADMIN-only mirrors the
                        backend gate (verifyRole(['ADMIN']) on POST/PUT/DELETE in
                        backend/routes/brand_kits.js commit e4783e0). */}
                    <Route
                      path="admin/brand-kits"
                      element={
                        <TravelOnly>
                          <RoleGuard allow={["ADMIN"]} message="Brand Kits requires admin access.">
                            <BrandKits />
                          </RoleGuard>
                        </TravelOnly>
                      }
                    />
                    {/* RateHawk hotel-search admin UI. ADMIN + MANAGER (operator
                        search, not tenant-config). Consumes /api/ratehawk
                        (backend route commit be67789). Cap-status endpoint is
                        ADMIN-only on the backend; MANAGER gets a 403 there which
                        is swallowed silently (no pill renders). Search works
                        for both roles. Stub-mode banner surfaces until Q19
                        (RateHawk partner onboarding) cred swap lands. */}
                    <Route
                      path="admin/ratehawk-search"
                      element={
                        <TravelOnly>
                          <RoleGuard allow={["ADMIN", "MANAGER"]} message="RateHawk Search requires admin or manager access.">
                            <RateHawkSearch />
                          </RoleGuard>
                        </TravelOnly>
                      }
                    />
                    {/* Booking.com / Expedia hotel-search admin UI. ADMIN +
                        MANAGER (operator search, not tenant-config). Consumes
                        /api/booking-expedia (backend route commit bb33cbe,
                        tick #105). Cap-status endpoint is ADMIN-only on the
                        backend; MANAGER gets a 403 there which is swallowed
                        silently (no pill renders). Phase 2 deferred-by-design:
                        Expedia provider returns 503 EXPEDIA_NOT_YET_ENABLED
                        until DC-4 flips the demand threshold + Q11 vendor
                        handover lands. Booking.com (Phase 1) is itself
                        stub-mode pending Q-cluster B6/C cred swap. The page
                        renders a Phase-2-pending banner by default with a
                        "Show form anyway" toggle for QA. */}
                    <Route
                      path="admin/booking-expedia-search"
                      element={
                        <TravelOnly>
                          <RoleGuard allow={["ADMIN", "MANAGER"]} message="Booking/Expedia Search requires admin or manager access.">
                            <BookingExpediaSearch />
                          </RoleGuard>
                        </TravelOnly>
                      }
                    />
                    <Route path="admin/csp-violations" element={<CSPViolations />} />
                    {/* Slice C1 — Voyagr per-site API key admin. ADMIN-only. */}
                    <Route path="admin/voyagr-api-keys" element={<RoleGuard allow={["ADMIN"]} message="Voyagr API Keys requires admin access."><VoyagrApiKeys /></RoleGuard>} />
                    {/* S128 — Embed allowlist admin (sets Tenant.embedAllowlistJson). ADMIN-only. */}
                    <Route path="admin/embed-allowlist" element={<RoleGuard allow={["ADMIN"]} message="Embed Allowlist requires admin access."><EmbedAllowlist /></RoleGuard>} />
                    {/* PRD Gap §1.5 / §1.6 */}
                    <Route
                      path="commission-profiles"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Commission Profiles requires admin access.">
                          <CommissionProfiles />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="commission-data"
                      element={
                        <RoleGuard allow={["ADMIN"]} message="Commission Data requires admin access.">
                          <CommissionData />
                        </RoleGuard>
                      }
                    />
                    <Route
                      path="revenue-goals"
                      element={
                        <RoleGuard allow={["ADMIN", "MANAGER", "USER"]} message="Revenue Goals requires staff access.">
                          <RevenueGoals />
                        </RoleGuard>
                      }
                    />
                    <Route path="lead-routing" element={<LeadRouting />} />
                    <Route path="territories" element={<Territories />} />
                    <Route
                      path="quotas"
                      element={
                        <GenericOnly>
                          <Quotas />
                        </GenericOnly>
                      }
                    />
                    <Route
                      path="win-loss"
                      element={
                        <GenericOnly>
                          <WinLoss />
                        </GenericOnly>
                      }
                    />
                    <Route path="ab-tests" element={<AbTests />} />
                    <Route path="web-visitors" element={<WebVisitors />} />
                    <Route path="chatbots" element={<Chatbots />} />
                    <Route path="approvals" element={<Approvals />} />
                    <Route
                      path="document-templates"
                      element={<DocumentTemplates />}
                    />
                    <Route path="surveys" element={<Surveys />} />
                    <Route path="payments" element={<Payments />} />
                    <Route
                      path="deal-insights"
                      element={
                        <GenericOnly>
                          <DealInsights />
                        </GenericOnly>
                      }
                    />
                    <Route path="shared-inbox" element={<SharedInbox />} />
                    <Route path="sla" element={<SLA />} />
                    <Route path="live-chat" element={<LiveChat />} />
                    <Route path="playbooks" element={<Playbooks />} />
                    <Route
                      path="document-tracking"
                      element={<DocumentTracking />}
                    />
                    <Route
                      path="industry-templates"
                      element={<IndustryTemplates />}
                    />
                    <Route path="social" element={<Social />} />
                    <Route path="sandbox" element={<Sandbox />} />
                    <Route
                      path="funnel"
                      element={
                        <GenericOnly>
                          <Funnel />
                        </GenericOnly>
                      }
                    />
                    <Route path="zapier" element={<Zapier />} />
                    {/* #522: Live Call Monitor removed — live-call surfaces are owned
                        by sister product Callified.ai (CRM ingests calls via
                        /api/v1/external/calls but does not render live-monitoring UI). */}
                    {/* #303: bare /calendar previously rendered a blank <main>. Wellness
                  tenants get bounced to their themed calendar; everyone else sees
                  the calendar-sync page (which is the closest generic equivalent). */}
                    <Route path="calendar" element={<CalendarRedirect />} />
                    {/* Travel vertical — Day 1 scaffolding. Gated by TravelOnly
                  so generic + wellness tenants get bounced to /dashboard
                  rather than rendering empty travel UI. Phase 1 sub-pages
                  (diagnostics, itineraries, trips, visa, suppliers) mount
                  under /travel/* per docs/TRAVEL_CRM_PRD.md §7. */}
              <Route path="travel" element={<TravelOnly><TravelDashboard /></TravelOnly>} />
              <Route path="travel/diagnostics" element={<TravelOnly><TravelDiagnostics /></TravelOnly>} />
              <Route path="travel/diagnostics/new" element={<TravelOnly><TravelDiagnosticWizard /></TravelOnly>} />
              <Route path="travel/diagnostics/banks/new" element={<TravelOnly><TravelDiagnosticBuilder /></TravelOnly>} />
              <Route path="travel/diagnostics/:id" element={<TravelOnly><TravelDiagnosticDetail /></TravelOnly>} />
              <Route path="travel/itineraries" element={<TravelOnly><TravelItineraries /></TravelOnly>} />
              <Route path="travel/trips" element={<TravelOnly><TravelTrips /></TravelOnly>} />
              <Route path="travel/trips/:id" element={<TravelOnly><TravelTripDetail /></TravelOnly>} />
              {/* #912 — canonical kebab-case path matches sibling travel routes
                  (cost-master, pricing-rules, religious-packets). The unhyphenated
                  alias stays registered so existing bookmarks / sidebar links keep working. */}
              <Route path="travel/web-checkins" element={<TravelOnly><TravelWebCheckinQueue /></TravelOnly>} />
              <Route path="travel/webcheckins" element={<TravelOnly><TravelWebCheckinQueue /></TravelOnly>} />
              {/* Slice C2 — Passport OCR verification queue. Backend route gates
                  ADMIN+MANAGER; frontend RoleGuard mirrors so non-privileged
                  users hit a friendly access-denied surface rather than the
                  503 / 403 on the queue fetch. */}
              <Route path="travel/passport-verification" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} message="Passport verification requires admin or manager access.">
                    <TravelPassportVerificationQueue />
                  </RoleGuard>
                </TravelOnly>
              } />
              <Route path="travel/cost-master" element={<TravelOnly><TravelCostMaster /></TravelOnly>} />
              {/* Arc 2 Travel Gap #907 slice 5/N — SightseeingMaster admin
                  CRUD surface. Adjacent to cost-master per #907's "6th
                  category in Cost Master" framing. SUT page commit ca052d20. */}
              <Route path="travel/sightseeing" element={<TravelOnly><TravelSightseeingMaster /></TravelOnly>} />
              {/* Arc 2 Travel Gap #907 slice 8/N — ItineraryTemplates admin
                  CRUD surface. Adjacent to sightseeing because both are #907
                  admin pages. SUT page commit f8768836. */}
              <Route path="travel/itinerary-templates" element={<TravelOnly><TravelItineraryTemplates /></TravelOnly>} />
              {/* S99 (TRAVEL_BIG_SCOPE_BACKLOG) — POI rep-suggested
                  pending-approval queue. ADMIN-only — backend RBAC enforces
                  on /api/travel/pois/pending + approve + reject, frontend
                  RoleGuard mirrors to surface an access-denied panel for
                  non-ADMIN roles rather than the route's 403. SUT page
                  shipped S12; backend mount S98 (commit 37d9ce40). */}
              <Route path="travel/pois/pending" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN"]} message="POI approval queue requires admin access.">
                    <TravelPoiPendingApprovalQueue />
                  </RoleGuard>
                </TravelOnly>
              } />
              {/* S49 (TRAVEL_BIG_SCOPE_BACKLOG) — QuoteTemplates admin
                  route registration. SUT page commit 8fb23237 (S31). Sits
                  adjacent to ItineraryTemplates because both are reusable-
                  template admin surfaces. Backend route mounted as
                  /api/travel/quote-templates (S48, commit 32630ec1).
                  No RoleGuard wrap — page is view-by-default for any
                  logged-in travel-tenant user; write gates (canWrite for
                  POST/PATCH; Delete for ADMIN-only) live inside the page,
                  mirroring the QuotesAdmin / InvoicesAdmin convention. */}
              <Route path="travel/quote-templates" element={<TravelOnly><TravelQuoteTemplates /></TravelOnly>} />
              {/* S55 (TRAVEL_BIG_SCOPE_BACKLOG) — CancellationPolicies
                  admin route registration. SUT page commit 4823b160 (S54).
                  Sits adjacent to QuoteTemplates because both are tenant-
                  policy admin CRUD surfaces. Backend route mounted as
                  /api/travel/cancellation-policies (S53, commit 7e6a98b1).
                  No RoleGuard wrap — page is view-by-default for any
                  logged-in travel-tenant user; write gates (canWrite for
                  POST/PATCH; Delete for ADMIN-only) live inside the page,
                  mirroring the QuotesAdmin / InvoicesAdmin convention. */}
              <Route path="travel/cancellation-policies" element={<TravelOnly><TravelCancellationPolicies /></TravelOnly>} />
              <Route path="travel/leads" element={<TravelOnly><TravelLeads /></TravelOnly>} />
              <Route path="travel/rfu/customers/:contactId" element={<TravelOnly><TravelRfuCustomerProfile /></TravelOnly>} />
              <Route path="travel/pricing-rules" element={<TravelOnly><TravelPricingRules /></TravelOnly>} />
              <Route path="travel/reports" element={<TravelOnly><TravelReports /></TravelOnly>} />
              <Route path="travel/suppliers" element={<TravelOnly><TravelSuppliers /></TravelOnly>} />
              <Route path="travel/suppliers-admin" element={<TravelOnly><TravelSuppliersAdmin /></TravelOnly>} />
              {/* PRD_TRAVEL_SUPPLIER_MASTER G035/G036 — Supplier PO ledger */}
              <Route path="travel/purchase-orders" element={<TravelOnly><TravelPurchaseOrders /></TravelOnly>} />
              {/* PRD_TRAVEL_SUPPLIER_MASTER G045 — per-supplier commission ledger */}
              <Route path="travel/suppliers/:id/commissions" element={<TravelOnly><TravelSupplierCommissions /></TravelOnly>} />
              {/* PRD_TRAVEL_SUPPLIER_MASTER G044 + G046 — per-supplier statement
                  reconciliation + invoice-PDF uploads. */}
              <Route path="travel/suppliers/:id/reconcile" element={<TravelOnly><TravelSupplierReconciliation /></TravelOnly>} />
              <Route path="travel/quotes-admin" element={<TravelOnly><TravelQuotesAdmin /></TravelOnly>} />
              {/* Arc 2 #900 slice 2 — Quote Builder (line-items composition).
                  Optional :id param (`/builder` = new; `/builder/:id` = edit).
                  RoleGuard allow=[ADMIN,MANAGER] mirrors backend write RBAC. */}
              <Route path="travel/quotes/builder" element={<TravelOnly><RoleGuard allow={["ADMIN", "MANAGER"]} feature="Quote Builder" roles="manager or admin"><TravelQuoteBuilder /></RoleGuard></TravelOnly>} />
              <Route path="travel/quotes/builder/:id" element={<TravelOnly><RoleGuard allow={["ADMIN", "MANAGER"]} feature="Quote Builder" roles="manager or admin"><TravelQuoteBuilder /></RoleGuard></TravelOnly>} />
              {/* G019 — operator-facing counter-offer review (side-by-side
                  ours vs customer counter). Accept / Reject / Counter back. */}
              <Route path="travel/quotes/:id/counter-review" element={<TravelOnly><RoleGuard allow={["ADMIN", "MANAGER"]} feature="Counter Review" roles="manager or admin"><TravelQuoteCounterReview /></RoleGuard></TravelOnly>} />
              {/* PRD §7 — Flight quick-quote (FlightQuoteAgent). Manual
                  fallback for the Chrome flight plugin: up to 4 options,
                  server-side markup, branded PDF + WhatsApp share. */}
              <Route path="travel/flights/quote" element={<TravelOnly><TravelFlightQuoteAgent /></TravelOnly>} />
              <Route path="travel/invoices-admin" element={<TravelOnly><TravelInvoicesAdmin /></TravelOnly>} />
              {/* PRD_TRAVEL_BILLING G022 (FR-3.5.e) — supplier-payable batch
                  ops surface. Lists / approves / sends / settles batches +
                  bank-friendly CSV export. */}
              <Route path="travel/payable-batches" element={<TravelOnly><TravelPayableBatches /></TravelOnly>} />
              {/* PRD_TRAVEL_BILLING G024 (FR-3.6.c) — settlement-timeline
                  Gantt view (inflow + outflow on one date axis). */}
              <Route path="travel/settlements/gantt" element={<TravelOnly><TravelSettlementGantt /></TravelOnly>} />
              {/* Arc 2 #901 slice 7 — cross-invoice milestone dashboard.
                  Operator-facing aggregate of upcoming/overdue payment
                  milestones across all travel invoices. */}
              <Route path="travel/milestones" element={<TravelOnly><TravelMilestoneTracker /></TravelOnly>} />
              {/* Q9 — travel 2-way WhatsApp chat (Wati transport). The sidebar
                  WhatsApp item lands here; the read-only dispatch log moved to
                  the /log sub-path (linked from the chat's status strip).
                  TravelOnly bounces wellness/generic tenants on both. */}
              <Route path="travel/whatsapp" element={<TravelOnly><TravelWhatsAppChat /></TravelOnly>} />
              <Route path="travel/whatsapp/log" element={<TravelOnly><TravelWhatsAppLog /></TravelOnly>} />
              <Route path="travel/whatsapp/templates" element={<TravelOnly><TravelWhatsAppTemplates /></TravelOnly>} />
              {/* Arc 2 #903 — cross-supplier A/P review (all payables across
                  all suppliers in one table, distinct from per-supplier expand
                  on SuppliersAdmin). Placeholder client-side fan-out fetch
                  until slice 6 consolidating endpoint ships. */}
              <Route path="travel/payables" element={<TravelOnly><TravelPayables /></TravelOnly>} />
              {/* #905 slice 3 — TravelCommissionProfile CRUD admin. Backend
                  GET is verifyToken-only (any role can view); write gates are
                  enforced client-side via canWrite (ADMIN/MANAGER) and the
                  Delete button (ADMIN-only) inside the page. No RoleGuard
                  wrap mirrors the MilestoneTracker / Payables pattern. */}
              <Route path="travel/commission-profiles" element={<TravelOnly><TravelCommissionProfilesAdmin /></TravelOnly>} />
              {/* #908 slice 2 — FlyerTemplates list page. Backend GET is
                  verifyToken-only; write gates (canWrite) live inside the
                  page. Same no-RoleGuard convention as the other view-by-
                  default travel admin pages. */}
              <Route path="travel/flyer-templates" element={<TravelOnly><TravelFlyerTemplates /></TravelOnly>} />
              {/* S79 — operator UI for flyer share-link admin (mint + revoke +
                  history). ADMIN-gated. Page itself also surfaces an
                  access-denied card for non-ADMIN as a defensive layer. */}
              <Route
                path="travel/flyer-share-admin"
                element={
                  <TravelOnly>
                    <RoleGuard allow={["ADMIN"]} feature="Flyer Share Admin" roles="admin" lockedInPlace>
                      <TravelFlyerShareAdmin />
                    </RoleGuard>
                  </TravelOnly>
                }
              />
              <Route path="travel/religious-packets" element={<TravelOnly><TravelReligiousPackets /></TravelOnly>} />
              <Route path="travel/tmc/microsite-preview" element={<TravelOnly><TravelTmcMicrositePreview /></TravelOnly>} />
              {/* T16 — dedicated TMC catalogue admin page; the
                  Promote-to-active surface is also retained as a sub-panel
                  inside DiagnosticBuilder's EngineWeights tab for now. */}
              <Route path="travel/tmc/catalogue" element={<TravelOnly><TravelTmcCatalogueAdmin /></TravelOnly>} />
              <Route path="travel/itineraries/:id" element={<TravelOnly><TravelItineraryDetail /></TravelOnly>} />
              <Route path="travel/itineraries/:id/edit" element={<TravelOnly><TravelItineraryEditor /></TravelOnly>} />
              <Route path="travel/leads/:contactId" element={<TravelOnly><TravelLeadDetail /></TravelOnly>} />
              {/* Arc 2 #904 slice — InboundLeads admin (STUB client-side
                  filter pending dedicated GET endpoint). Operator surface
                  for inbound webhook-ingested leads (Voyagr / web form /
                  WhatsApp / ads / adsgpt / metaads / manual). No RoleGuard
                  wrap — page is view-by-default and Convert-to-Lead routes
                  to /leads/:contactId which carries its own gates. */}
              <Route path="travel/inbound-leads" element={<TravelOnly><TravelInboundLeads /></TravelOnly>} />
              {/* Phase 3 Visa Sure scaffolding (cluster B3) — placeholder shells.
                  Real implementation gated on product calls in
                  docs/PRD_VISA_SURE_PHASE_3.md §5 + §9. */}
              <Route path="travel/visa" element={<TravelOnly><TravelVisaDashboard /></TravelOnly>} />
              <Route path="travel/visa/applications" element={<TravelOnly><TravelVisaApplications /></TravelOnly>} />
              {/* Phase 3 FR-4 advisor dashboard — per-application drilldown
                  from the Applications list. SHELL only; backend GET
                  /api/travel/visa/applications/:id (PRD §3 FR-5) pending. */}
              <Route path="travel/visa/applications/:applicationId" element={<TravelOnly><TravelVisaAdvisorDashboard /></TravelOnly>} />
              <Route path="travel/visa/checklists" element={<TravelOnly><TravelVisaChecklists /></TravelOnly>} />
              {/* Phase 3 FR-7 analytics SHELL (V16-V18) — backend
                  /api/travel/reports/visa wiring pending (cluster B3). */}
              <Route path="travel/visa/reports" element={<TravelOnly><TravelVisaReports /></TravelOnly>} />
              {/* Phase 3 Visa Sure embassy-rules admin (tick #178) — consumes
                  /api/embassy-rules CRUD shipped tick #175 (commit 05587ac7).
                  ADMIN-only per backend POST/PUT/DELETE gates. */}
              <Route path="travel/visa/embassy-rules" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN"]} message="Embassy Rules admin requires admin access.">
                    <TravelVisaEmbassyRulesAdmin />
                  </RoleGuard>
                </TravelOnly>
              } />
              {/* G107 — Visa Sure rejection-recovery program admin (PRD §FR-7).
                  ADMIN+MANAGER CRUD backend; non-write roles see read-only cards. */}
              <Route path="travel/visa/recovery-programs" element={
                <TravelOnly>
                  <TravelVisaRecoveryProgram />
                </TravelOnly>
              } />
              {/* Phase 1 TMC curriculum-mappings admin (tick #181) — consumes
                  /api/travel-curriculum CRUD shipped tick #180 (commit 6d5919a8).
                  ADMIN-only per backend POST/PUT/DELETE gates. TMC vertical
                  (school-trip pitch deck), NOT under Visa Sure. */}
              <Route path="travel/curriculum-mappings" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN"]} message="Curriculum Mappings admin requires admin access.">
                    <TravelCurriculumAdmin />
                  </RoleGuard>
                </TravelOnly>
              } />
              {/* TMC school term calendar admin — ADMIN-only per backend gates. */}
              <Route path="travel/school-terms" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN"]} message="School Term Calendar requires admin access.">
                    <TravelSchoolTermCalendar />
                  </RoleGuard>
                </TravelOnly>
              } />
              {/* Phase 2 SHELL for #908 Marketing Flyer Studio (tick #186) —
                  designed in docs/PRD_TRAVEL_MARKETING_FLYER.md. Non-
                  functional scaffold; real impl per PRD §8 build order
                  (canvas editor, asset library, AI copy/image, PDF/PNG
                  export, WhatsApp share). MANAGER+ per operator-facing
                  marketing surface. */}
              <Route path="travel/marketing/flyer-studio" element={
                <TravelOnly>
                  <RoleGuard allow={["ADMIN", "MANAGER"]} feature="Marketing Flyer Studio">
                    <TravelMarketingFlyerStudio />
                  </RoleGuard>
                </TravelOnly>
              } />
              {/* Phase 2 Travel Stall operator landing (TS21) — scaffold shell.
                  Each card CTAs to an existing route filtered by ?subBrand=travelstall. */}
              <Route path="travel-stall" element={<TravelOnly><TravelStallDashboard /></TravelOnly>} />
                    {/* Wellness vertical — gated by WellnessOnly so generic-CRM
                  tenants can't surface wellness pages by URL (#325). */}
              <Route path="wellness" element={<WellnessOnly><WellnessOwnerOnly><WellnessOwnerDashboard /></WellnessOwnerOnly></WellnessOnly>} />
              <Route path="wellness/recommendations" element={<WellnessOnly><WellnessRecommendations /></WellnessOnly>} />
              <Route path="wellness/patients" element={<WellnessOnly><WellnessPatients /></WellnessOnly>} />
              <Route path="wellness/patients/:id" element={<WellnessOnly><WellnessPatientDetail /></WellnessOnly>} />
              <Route path="wellness/services" element={<WellnessOnly><WellnessServices /></WellnessOnly>} />
              {/* Wave 7 Agent A — ServiceCategory + Drug admin pages (admin/manager) */}
              {/* Wave 7 Agent A — ServiceCategory + Drug admin pages. Gated
                  by permissions that mirror the page catalog's entries — any
                  role granted `services.write` / `prescriptions.write` passes
                  (no hardcoded ADMIN/MANAGER allowlist). */}
              <Route path="wellness/service-categories" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'services', action: 'read' }}
                    feature="Service Categories"
                    lockedInPlace
                  >
                    <WellnessServiceCategories />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/drugs" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'prescriptions', action: 'read' }}
                    feature="Drug catalogue"
                    lockedInPlace
                  >
                    <WellnessDrugs />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/visits" element={<WellnessOnly><WellnessVisits /></WellnessOnly>} />
              {/* Prescriptions list — tenant-wide, with patient filter +
                  per-row PDF download. Gated on prescriptions.read via
                  the page catalog (Sidebar) AND the page-level RoleGuard
                  here (route protection). Backend PDF endpoint inherits
                  the same RBAC + tenant scope. */}
              <Route path="wellness/prescriptions" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'prescriptions', action: 'read' }}
                    feature="Prescriptions"
                    lockedInPlace
                  >
                    <WellnessPrescriptions />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Staff-authed self-view of own Rx. Sidebar surfacing comes
                  from the page catalog entry (gated on my_prescriptions.read).
                  Backend `/api/wellness/my-prescriptions[/:id/pdf]` is gated
                  on the same permission + scoped to req.user.userId's linked
                  Patient row. */}
              <Route path="wellness/my-prescriptions" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'my_prescriptions', action: 'read' }}
                    feature="My Prescriptions"
                    lockedInPlace
                  >
                    <WellnessMyPrescriptions />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/locations" element={<WellnessOnly><WellnessLocations /></WellnessOnly>} />
              {/* Wave 11 Agent EE: Memberships catalog */}
              <Route path="wellness/memberships" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'services', action: 'read' }}
                    feature="Memberships"
                    lockedInPlace
                  >
                    <WellnessMemberships />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 11 Agent FF: Wallet + Gift Cards + Coupons + Cashback */}
              <Route path="wellness/wallet" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'patient_wallets', action: 'read' }}
                    feature="Wallet ledger"
                    lockedInPlace
                  >
                    <WellnessWallet />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/giftcards" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'gift_cards', action: 'read' }}
                    feature="Gift Cards"
                    lockedInPlace
                  >
                    <WellnessGiftCards />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Customer-facing storefront — any authenticated user
                  can browse + buy. Gift card value lands on the chosen
                  patient's wallet on Razorpay payment success. */}
              <Route path="wellness/buy-giftcards" element={
                <WellnessOnly>
                  <WellnessBuyGiftCards />
                </WellnessOnly>
              } />
              {/* Customer-facing transaction history. Like Buy Gift Cards,
                  any authenticated wellness user can open it; the data is
                  scoped server-side to the caller's own Patient. The sidebar
                  entry is gated to customer-tier roles via the customerOnly
                  page-catalog flag. */}
              <Route path="wellness/my-transactions" element={
                <WellnessOnly>
                  <WellnessMyTransactions />
                </WellnessOnly>
              } />
              <Route path="wellness/coupons" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'marketing', action: 'read' }}
                    feature="Coupons"
                    lockedInPlace
                  >
                    <WellnessCoupons />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/cashback-rules" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'marketing', action: 'read' }}
                    feature="Cashback rules"
                    lockedInPlace
                  >
                    <WellnessCashbackRules />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/calendar" element={<WellnessOnly><WellnessCalendar /></WellnessOnly>} />
              <Route path="wellness/appointments" element={<WellnessOnly><WellnessAppointments /></WellnessOnly>} />
              <Route path="wellness/my-appointments" element={<WellnessOnly><WellnessMyAppointments /></WellnessOnly>} />
              <Route path="wellness/my-bookings" element={<WellnessOnly><WellnessMyBookings /></WellnessOnly>} />
              <Route path="wellness/book-appointment" element={<WellnessOnly><WellnessBookAppointment /></WellnessOnly>} />
              {/* Wave 2 Agent KK - WhatsApp 2-way threads (agent inbox). */}
              <Route path="wellness/whatsapp" element={<WellnessOnly><WellnessWhatsAppThreads /></WellnessOnly>} />
              <Route path="wellness/whatsapp/templates" element={<WellnessOnly><WellnessWhatsAppTemplates /></WellnessOnly>} />
              <Route path="wellness/reports" element={<WellnessOnly><WellnessReports /></WellnessOnly>} />
              <Route path="wellness/telecaller" element={<WellnessOnly><WellnessTelecallerQueue /></WellnessOnly>} />
              {/* #183: alias for users who land on /telecaller (no /wellness prefix). */}
              <Route path="telecaller" element={<Navigate to="/wellness/telecaller" replace />} />
              {/* #406: stale-URL aliases. Older docs / QA prompts reference
                  /wellness/service-catalog + /wellness/telecaller-queue;
                  canonical routes are /wellness/services + /wellness/telecaller.
                  Mirrors the #183 alias pattern above so deep links from old
                  docs / bookmarks still land on the right page. */}
              <Route path="wellness/service-catalog" element={<Navigate to="/wellness/services" replace />} />
              <Route path="wellness/telecaller-queue" element={<Navigate to="/wellness/telecaller" replace />} />
              <Route path="wellness/per-location" element={<WellnessOnly><WellnessPerLocation /></WellnessOnly>} />
              <Route path="wellness/loyalty" element={<WellnessOnly><WellnessLoyalty /></WellnessOnly>} />
              <Route path="wellness/waitlist" element={<WellnessOnly><WellnessWaitlist /></WellnessOnly>} />
              <Route path="wellness/inventory" element={<WellnessOnly><WellnessInventory /></WellnessOnly>} />
              {/* Wave 11 Agent HH — Inventory backbone admin pages. All
                  6 pages gated on `inventory.read` for sidebar + page-mount
                  visibility (matches the page catalog). The create / edit
                  / delete actions inside each page are gated separately at
                  the backend route level (.write / .update / .delete /
                  .manage in routes/inventory.js) — a read-only role sees
                  the page in read-only mode; the action buttons should
                  hide themselves based on per-action permission checks
                  via usePermissions(). */}
              <Route path="wellness/product-categories" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'products', action: 'read' }}
                    feature="Product categories"
                    lockedInPlace
                  >
                    <WellnessProductCategories />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/products" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'products', action: 'read' }}
                    feature="Products"
                    lockedInPlace
                  >
                    <WellnessProducts />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/vendors" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'inventory', action: 'read' }}
                    feature="Vendors"
                    lockedInPlace
                  >
                    <WellnessVendors />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/inventory-receipts" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'inventory', action: 'read' }}
                    feature="Inventory receipts"
                    lockedInPlace
                  >
                    <WellnessInventoryReceipts />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/inventory-adjustments" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'inventory', action: 'read' }}
                    feature="Inventory adjustments"
                    lockedInPlace
                  >
                    <WellnessInventoryAdjustments />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/auto-consumption-rules" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'products', action: 'manage' }}
                    feature="Auto-consumption rules"
                    lockedInPlace
                  >
                    <WellnessAutoConsumptionRules />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 11 Agent GG — Resource availability admin pages.
                  Gated on settings.read (matches page catalog). The
                  booking-conflict gate runs on every POST/PUT visit. */}
              <Route path="wellness/resources" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'settings', action: 'read' }}
                    feature="Resources"
                    lockedInPlace
                  >
                    <WellnessResources />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/holidays" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'settings', action: 'read' }}
                    feature="Holidays"
                    lockedInPlace
                  >
                    <WellnessHolidays />
                  </RoleGuard>
                </WellnessOnly>
              } />
              <Route path="wellness/working-hours" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'settings', action: 'read' }}
                    feature="Working hours"
                    lockedInPlace
                  >
                    <WellnessWorkingHours />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* Wave 2 Agent JJ — Staff Attendance + Leave Management. */}
              <Route path="wellness/attendance" element={<WellnessOnly><WellnessAttendance /></WellnessOnly>} />
              {/* Admin/Manager attendance dashboard — KPI tiles + all-staff
                  list + admin-only edit/delete. Mounted under both wellness
                  and travel since both verticals have staff that punch in/out.
                  Page itself reads tenant from AuthContext and uses the same
                  /api/attendance/* routes; no per-vertical branching needed. */}
              <Route path="wellness/attendance-dashboard" element={<WellnessOnly><AttendanceDashboard /></WellnessOnly>} />
              <Route path="wellness/attendance/calendar" element={<WellnessOnly><WellnessAttendanceCalendar /></WellnessOnly>} />
              <Route path="travel/attendance" element={<AttendanceDashboard />} />
              <Route path="wellness/leave" element={<WellnessOnly><WellnessLeave /></WellnessOnly>} />
              {/* Wave 2 Agent II — POS / Cash Register / Shift / Sale.
                  Backend is wellness-vertical-gated + role
                  ADMIN/MANAGER/doctor/professional/telecaller/helper.
                  Frontend allows the wider operational bucket (everyone
                  except plain USER) so a cashier user can ring sales. */}
              <Route path="wellness/pos" element={
                <WellnessOnly>
                  <RoleGuard
                    requiredPermission={{ module: 'pos', action: 'read' }}
                    feature="Point of Sale"
                    lockedInPlace
                  >
                    <WellnessPointOfSale />
                  </RoleGuard>
                </WellnessOnly>
              } />
              {/* #309: /wellness/invoices used to render a blank page (no
                  route binding). Wellness shares the generic CRM Invoices
                  UI — alias the prefixed URL to the canonical /invoices
                  route so the sidebar link, deep links from emails, and
                  bookmarks all resolve. Mirrors the /wellness/inventory
                  fix from #305. */}
                    <Route
                      path="wellness/invoices"
                      element={<Navigate to="/invoices" replace />}
                    />
                    {/* #341: catch-all for unmapped or wrong-prefix URLs. Renders
                  inside the layout chrome so the user keeps the sidebar +
                  header. Pre-fix the SPA returned a blank <main>; now we
                  show a real 404 with a path suggestion when applicable. */}
                    <Route path="*" element={<NotFound />} />
                  </Route>
                </Routes>
              </Suspense>
            </RouteErrorBoundary>
          </BrowserRouter>
          </ActiveSubBrandProvider>
        </NotifyProvider>
      </AuthContext.Provider>
    </ThemeContext.Provider>
  );
}
