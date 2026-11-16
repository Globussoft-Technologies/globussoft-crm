import { Children, createContext, isValidElement, useContext, useRef, useState } from "react";
import {
  ArrowLeft, ArrowRight, Bell, Bot, Building2, ChevronRight, Code2,
  KeyRound, Mail, MapPin, Palette, PhoneCall,
  Plug, Search, ShieldCheck, SlidersHorizontal, Sparkles, Sun, Users, X,
  FileSignature, Globe2, Stethoscope,
} from "lucide-react";
import "./SettingsWorkspace.css";

const WorkspaceContext = createContext(null);

const SECTIONS = [
  { id: "general", group: "Workspace", label: "General", icon: Building2, description: "Your organization details, regional defaults, and email storage preferences.", keywords: "organization name slug owner email plan currency locale review retention sent" },
  { id: "branding", group: "Workspace", label: "Branding", icon: Palette, description: "Make the CRM your own with your organization’s logo and colors.", keywords: "logo upload brand theme color" },
  { id: "hosting", vertical: "travel", group: "Publishing", label: "Website hosting", icon: Globe2, description: "Manage your travel landing-page website and file transfer connection.", keywords: "promotional website hosting publishing ftp ftps sftp transfer password fingerprint" },
  { id: "consent", vertical: "wellness", group: "Clinical workspace", label: "Consent templates", icon: FileSignature, description: "Manage the consent wording used by your wellness practice.", keywords: "clinic procedure patient consent templates wording" },
  { id: "clinicroles", vertical: "wellness", group: "Clinical workspace", label: "Clinical role types", icon: Stethoscope, description: "Manage your practice’s role types and visit eligibility.", keywords: "wellness doctor therapist practitioner role types visits" },
  { id: "appearance", group: "Your experience", label: "Appearance & tours", icon: Sun, description: "Choose your display preferences and manage guided product tours.", keywords: "light dark system theme product guided tours" },
  { id: "notifications", group: "Your experience", label: "Notifications", icon: Bell, description: "Choose which updates you receive and how they reach you.", keywords: "email push alerts reminders quiet hours" },
  { id: "members", group: "Team & access", label: "Members", icon: Users, description: "Invite a team member and choose their initial role.", keywords: "invite user team member name email password role" },
  { id: "roles", group: "Team & access", label: "Role recovery", icon: ShieldCheck, description: "Review saved permission history and recover a previous role configuration.", keywords: "permissions restore version history access security" },
  { id: "integrations", group: "Connections", label: "Integrations", icon: Plug, description: "Connect the tools your team uses for messaging, calling, maps, and marketing.", keywords: "adsgpt callified whatsapp meta twilio sms google maps calling" },
  { id: "ai", group: "Connections", label: "AI & generation", icon: Bot, description: "Manage your organization’s AI provider and landing-site generation settings.", keywords: "provider model key gemini openai anthropic pexels landing sites" },
  { id: "leadcapture", group: "Lead capture", label: "Forms & tracking", icon: SlidersHorizontal, description: "Manage lead sources, website attribution, and form spam protection.", keywords: "domains origins allowlist cookies utm attribution recaptcha captcha tracking web forms" },
  { id: "developer", group: "Developer", label: "API & webhooks", icon: Code2, description: "Manage signing credentials for your outbound webhook integrations.", keywords: "key secret signing hmac credential rotate revoke" },
];

const INTEGRATIONS = {
  adsgpt: { label: "AdsGPT", icon: Sparkles, description: "Connect your marketing workspace with single sign-on.", category: "Marketing", color: "violet" },
  callified: { label: "Callified", icon: PhoneCall, description: "Configure AI calling, lead sync, and webhook credentials.", category: "Calling", color: "blue" },
  whatsapp: { label: "WhatsApp / Meta", icon: Mail, description: "Connect your organization’s WhatsApp Business account.", category: "Messaging", color: "green" },
  twilio: { label: "Twilio", icon: PhoneCall, description: "Manage your calling and SMS provider configuration.", category: "Communication", color: "rose" },
  maps: { label: "Google Maps", icon: MapPin, description: "Configure maps and location services for your workspace.", category: "Location", color: "amber" },
  sendgrid: { label: "SendGrid", icon: Mail, description: "Configure your own email account and sender for Travel CRM.", category: "Email delivery", color: "green" },
};

const VERTICAL_COPY = {
  travel: {
    branding: { description: "Manage your travel brand logos, colors, and sub-brand branding." },
    appearance: { label: "Appearance", description: "Choose your display preferences for Travel CRM.", keywords: "light dark system theme display" },
    ai: { description: "Manage your Travel CRM AI provider, models, and access.", keywords: "provider model key gemini openai anthropic ai" },
    leadcapture: { description: "Manage lead-source access and spam protection for travel web forms.", keywords: "domains origins allowlist travel recaptcha captcha web forms" },
    integrations: { description: "Manage your marketing, email, calendar, Google Drive, and WhatsApp connections.", keywords: "adsgpt sendgrid gmail email google drive calendar whatsapp" },
  },
  wellness: {
    branding: { description: "Manage your wellness organization’s logo and brand colors." },
    appearance: { label: "Appearance", description: "Choose your display preferences for Wellness CRM.", keywords: "light dark system theme display" },
    ai: { description: "Manage your Wellness CRM AI provider, models, and access.", keywords: "provider model key gemini openai anthropic ai" },
    leadcapture: { label: "Lead sources", description: "Manage the partner origins allowed to capture leads for your practice.", keywords: "domains origins allowlist partner lead capture" },
    integrations: { description: "Manage your existing marketing and calling connections.", keywords: "adsgpt callified calling" },
  },
};

// Presentation only: controls stay mounted while hidden, preserving drafts,
// validation, save state, and the original components' request lifecycles.
export function SettingsSection({ section, integration, className = "", children }) {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) return children;
  const visible = workspace.section === section
    && (section !== "integrations" || workspace.integration === integration);
  return (
    <div className={`gs-section ${className}`} hidden={!visible} data-settings-section={section}>
      {children}
    </div>
  );
}

export default function SettingsWorkspace({ enabled, vertical = "generic", integrationExtras = null, integrationStatuses = {}, children }) {
  const [section, setSection] = useState("general");
  const [integration, setIntegration] = useState(null);
  const [query, setQuery] = useState("");
  const contentRef = useRef(null);
  const scrollRef = useRef(null);

  if (!enabled) return <div className="settings-grid">{children}</div>;

  const panels = Children.toArray(children).filter((child) => isValidElement(child) && child.type === SettingsSection);
  const available = SECTIONS
    .filter((item) => (!item.vertical || item.vertical === vertical) && panels.some((panel) => panel.props.section === item.id))
    .map((item) => ({ ...item, ...VERTICAL_COPY[vertical]?.[item.id] }));
  const active = available.find((item) => item.id === section) || available[0] || SECTIONS[0];
  const integrations = vertical === "generic" ? INTEGRATIONS : {
    ...INTEGRATIONS,
    callified: { ...INTEGRATIONS.callified, description: "Connect your existing Callified account for AI calling." },
  };
  const currentIntegration = active.id === "integrations" && panels.some((panel) => panel.props.integration === integration)
    ? integrations[integration] : null;
  const search = query.trim().toLowerCase();
  const results = available.filter((item) => `${item.label} ${item.group} ${item.keywords}`.toLowerCase().includes(search));
  const groups = [...new Set(results.map((item) => item.group))];
  const mobileOptions = results.some((item) => item.id === active.id) ? results : [active, ...results];
  const Icon = currentIntegration?.icon || active.icon;

  const navigate = (id, detail = null) => {
    setSection(id);
    setIntegration(detail);
    // Keyboard users can move directly into the chosen section; no page reload.
    const content = contentRef.current;
    content?.focus({ preventScroll: true });
    // Show the chosen section heading without moving the page or navigation.
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  return (
    <WorkspaceContext.Provider value={{ section: active.id, integration: currentIntegration ? integration : null }}>
      <div className="gs-workspace">
        <aside className="gs-navigation" aria-label="Settings navigation">
          <label className="gs-search">
            <Search size={16} aria-hidden="true" />
            <input type="search" aria-label="Find a setting" placeholder="Find a setting…" value={query} onChange={(event) => setQuery(event.target.value)} />
            {query && <button type="button" aria-label="Clear settings search" onClick={() => setQuery("")}><X size={14} /></button>}
          </label>
          <label className="gs-mobile">
            <span>Settings section</span>
            <select aria-label="Settings section" value={active.id} onChange={(event) => navigate(event.target.value)}>
              {mobileOptions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <nav aria-label="Settings sections">
            {groups.map((group) => (
              <div className="gs-nav-group" key={group}>
                <p>{group}</p>
                {results.filter((item) => item.group === group).map((item) => {
                  const ItemIcon = item.icon;
                  return (
                    <button type="button" key={item.id} className="gs-nav-item" title={item.label} aria-current={active.id === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>
                      <ItemIcon size={17} aria-hidden="true" />
                      <span>{item.label}</span>
                      <ChevronRight className="gs-nav-chevron" size={14} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
          {results.length === 0 && <p className="gs-no-results" role="status">No matching settings. Try “email”, “logo”, or “calling”.</p>}
        </aside>

        <div className="gs-content" ref={contentRef} tabIndex={-1} aria-labelledby="gs-section-title">
          <div className="gs-scroll" ref={scrollRef}>
          <div className="gs-section-heading">
            <div className="gs-breadcrumb"><span>Settings</span><ChevronRight size={12} aria-hidden="true" /><span>{active.group}</span></div>
            {currentIntegration && <button type="button" className="gs-back" onClick={() => navigate("integrations")}><ArrowLeft size={15} /> All integrations</button>}
            <div className="gs-heading-row">
              <span className="gs-heading-icon"><Icon size={22} aria-hidden="true" /></span>
              <div><h2 id="gs-section-title">{currentIntegration?.label || active.label}</h2><p>{currentIntegration?.description || active.description}</p></div>
            </div>
          </div>

          {active.id === "integrations" && !currentIntegration && (
            <div className="gs-apps" aria-label="Available integrations">
              {Object.entries(integrations).filter(([id]) => panels.some((panel) => panel.props.integration === id)).map(([id, item]) => {
                const IntegrationIcon = item.icon;
                const connection = integrationStatuses?.[id];
                const known = !connection?.loading && typeof connection?.ready === "boolean";
                const connectionLabel = connection?.loading ? "Checking connection…" : !known ? "Status unavailable" : connection.ready ? "Connected" : "Not connected";
                return (
                  <button type="button" key={id} className="gs-app" onClick={() => navigate("integrations", id)}>
                    <span className={`gs-app-icon gs-app-icon--${item.color}`}><IntegrationIcon size={22} aria-hidden="true" /></span>
                    <span className="gs-app-category">{item.category}</span>
                    {connection ? <span className="gs-app-title"><strong>{item.label}</strong><span className="gs-app-connection" data-status={known ? connection.ready ? "connected" : "disconnected" : "unknown"} title={connection.detail}>{connectionLabel}</span></span> : <strong>{item.label}</strong>}
                    <span className="gs-app-description">{item.description}</span>
                    <span className="gs-app-action">Manage integration <ArrowRight size={15} aria-hidden="true" /></span>
                  </button>
                );
              })}
              {vertical === "travel" && integrationExtras}
            </div>
          )}
          <div className="gs-panels">{children}</div>
          <div className="gs-footer"><KeyRound size={13} aria-hidden="true" /><span>Each section saves independently. Use its save or connect button to apply changes.</span></div>
          </div>
        </div>
      </div>
    </WorkspaceContext.Provider>
  );
}
