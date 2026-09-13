const target = (id, slot) => slot === "page"
  ? '[data-tour="page-content"]'
  : `[data-tour="${id}-${slot}"]`;

function workflow({ id, label, path, pattern, anchors = [], access = {}, steps }) {
  return {
    id,
    label,
    path,
    pattern,
    exact: Boolean(path),
    version: 1,
    description: `${label} guided workflow`,
    secondary: true,
    anchors,
    ...access,
    steps: steps.map(([slot, title, content, roles, behavior]) => ({
      target: target(id, slot),
      title,
      content,
      ...(roles ? { roles } : {}),
      ...(slot === "page" ? { placement: "center" } : {}),
      ...(behavior || {}),
    })),
  };
}

const heading = (slot, match) => ({ slot, match, elements: "h1, h2, h3, [role='heading']" });
const control = (slot, match) => ({ slot, match, elements: "button, a[href], [role='button']" });
const section = (slot, match) => ({ slot, match, elements: "h2, h3, legend, [role='tab'], [role='heading']", closest: "section, .card, div" });

export const GENERIC_SECONDARY_WORKFLOW_TOURS = [
  workflow({
    id: "contact-detail", label: "Contact Detail", pattern: /^\/contacts\/[^/]+$/,
    anchors: [control("edit", "Edit contact"), section("summary", "Chat Summary|AI Summary|Summary"), heading("activity", "Activity Timeline"), section("attachments", "Attachments")],
    steps: [
      ["header", "Contact identity", "Confirm the contact, company, owner, and tenant context before changing customer data."],
      ["edit", "Edit contact details", "Open edit mode to update core and custom fields. Save explicitly, and correct validation errors before leaving."],
      ["summary", "Conversation summary", "Review the generated conversation summary and refresh it after important calls or messages."],
      ["attachments", "Contact documents", "Upload supported files here and verify the attachment appears before sharing it with the team."],
      ["activity", "Activity timeline", "Use the tenant-scoped timeline to understand calls, messages, notes, and record changes in chronological order."],
    ],
  }),
  workflow({
    id: "landing-site-builder", label: "Landing Site Builder", pattern: /^\/landing-sites\/builder\/[^/]+$/,
    anchors: [
      { slot: "identity", selector: "input[aria-label='Page title']", closest: "div" },
      control("preview", "Preview|Desktop preview|Mobile preview"), control("save", "^Save"), control("publish", "Publish|Unpublish|Check"),
      { slot: "canvas", selector: "[data-builder], [class*='builder'], [class*='canvas'], main" },
    ],
    steps: [
      ["identity", "Page identity and URL", "Edit the title and slug carefully. Changing a published slug can invalidate existing links."],
      ["canvas", "Build the landing site", "Add and reorder content blocks, select a block, then edit its properties. Preview responsive behavior as you work."],
      ["preview", "Preview safely", "Switch desktop and mobile previews, then open the production preview to validate the rendered page and form."],
      ["save", "Save a draft", "Save before navigating away. The unsaved marker indicates builder changes that have not reached the server."],
      ["publish", "Validate and publish", "Run readiness checks before publishing. Confirm forms, destinations, legal content, and the public URL."],
    ],
  }),
  workflow({
    id: "sequence-builder", label: "Sequence Builder", pattern: /^\/sequences\/[^/]+\/builder$/,
    anchors: [control("status", "Active|Inactive"), heading("preview", "Flow preview"), control("add", "Email|SMS|Wait|Condition"), control("save", "Save")],
    steps: [
      ["header", "Sequence identity", "Verify the sequence before editing; changes affect future enrolled leads when the sequence is active."],
      ["status", "Activation status", "Keep the sequence inactive while restructuring it, then activate only after validating every step."],
      ["preview", "Read the flow", "Use the ordered preview to check timing, message type, branching, and pause-on-reply behavior."],
      ["add", "Add a sequence step", "Choose email, SMS, wait, or condition. Select the new row to configure its complete behavior."],
      ["save", "Configure the selected step", "Complete templates, message content, delays, conditions, and reply behavior, then save the step."],
    ],
  }),
  workflow({
    id: "custom-object-records", label: "Custom Object Records", pattern: /^\/objects\/[^/]+$/,
    anchors: [control("filter", "Filter Set"), control("export", "Export CSV"), control("create", "Add New"), { slot: "records", selector: "table" }],
    steps: [
      ["header", "Custom object workspace", "Confirm the object and its configured fields before working with tenant records."],
      ["filter", "Filter custom records", "Apply a filter set to narrow records; clear it before concluding that data is absent."],
      ["records", "Review records", "Inspect values and creation dates in the record table. Field behavior comes from the App Builder schema."],
      ["create", "Create a record", "Open the record form and complete every required custom field before inserting the record."],
      ["dialog", "Custom record form", "Validate number, date, boolean, and text inputs against the field definitions, then submit or cancel explicitly.", null, {
        actions: [{ type: "click", target: target("custom-object-records", "create"), required: true, restoreTarget: `${target("custom-object-records", "dialog")} button[aria-label*="close" i], ${target("custom-object-records", "dialog")} button[type="button"]` }],
        waitFor: target("custom-object-records", "dialog"),
        skipIfMissing: true,
      }],
      ["export", "Export records", "Apply the intended filter first and verify the CSV contains the expected custom fields and row scope."],
    ],
  }),
  workflow({
    id: "staff-permissions", label: "Staff Permissions", pattern: /^\/staff\/[^/]+\/permissions$/,
    access: { requiredPermission: { module: "roles", action: "read" } },
    anchors: [control("roles", "Manage roles"), heading("effective", "Effective|permissions"), control("back", "Back to Staff")],
    steps: [
      ["header", "Selected staff account", "Confirm the staff name and email before reviewing access; the route is tenant-isolated by the backend."],
      ["effective", "Effective permissions", "These permissions are computed from all assigned roles. Review module actions and field restrictions together."],
      ["roles", "Change access through roles", "This page is read-only. Use Manage roles to change assignments instead of expecting edits here."],
      ["page", "Least-privilege review", "Grant only the actions needed for the staff member's work and verify sensitive modules after making role changes.", ["ADMIN", "OWNER", "MANAGER"]],
    ],
  }),
  workflow({
    id: "profile", label: "Profile", path: "/profile",
    anchors: [{ slot: "editor", selector: "form" }, heading("billing", "Billing History"), control("security", "Two-Factor|2FA|Password"), control("save", "Save")],
    steps: [
      ["header", "Your profile", "Review your account identity, role, tenant, and contact details before updating personal information."],
      ["editor", "Edit profile details", "Update only the fields that changed. Phone and email validation must pass before saving."],
      ["save", "Save profile changes", "The save action avoids unnecessary requests when nothing changed and reports validation or server errors."],
      ["security", "Account security", "Use the security controls to change credentials or open two-factor authentication setup."],
      ["billing", "Billing history", "Review paid subscription invoices and download the required invoice PDF from your own tenant account."],
    ],
  }),
  workflow({
    id: "profile-2fa", label: "Two-Factor Authentication", path: "/profile/2fa",
    anchors: [section("status", "Status"), control("enable", "Enable|Begin setup|Set up"), control("verify", "Verify|Confirm"), section("backup", "backup codes")],
    steps: [
      ["header", "Protect your account", "Two-factor authentication adds a time-based authenticator code after your password."],
      ["status", "Check 2FA status", "Confirm whether protection is enabled before starting setup or attempting recovery."],
      ["enable", "Begin secure setup", "Start setup, scan the QR code with an authenticator app, and keep the shared secret private."],
      ["verify", "Verify the authenticator", "Enter the current six-digit code. Device clock drift can cause otherwise correct codes to fail."],
      ["backup", "Store backup codes", "Save the one-time recovery codes offline. They are shown only at creation and each code should be used once."],
    ],
  }),
  workflow({
    id: "lead-capture-settings", label: "Lead Capture Settings", path: "/settings/lead-capture",
    access: { adminOnly: true }, anchors: [section("channels", "Channels.*cooldowns"), section("routing", "Form-ID routing"), section("test", "Test intake"), control("save", "Save Settings")],
    steps: [
      ["header", "Inbound lead controls", "Configure channel ingestion only for the current tenant and avoid duplicate routes across providers."],
      ["channels", "Channels and cooldowns", "Enable required sources and set cooldowns that suppress duplicates without hiding legitimate repeat enquiries."],
      ["routing", "Form-ID routing", "Map each external form identifier to the correct tenant destination and keep identifiers unique."],
      ["test", "Test intake", "Send a controlled sample through each channel and verify the created lead's source, ownership, and deduplication result."],
      ["save", "Save and re-check", "Save settings, wait for the server round trip, and confirm the refreshed values match the intended configuration."],
    ],
  }),
  workflow({
    id: "lead-fields-settings", label: "Lead Fields Settings", path: "/settings/lead-fields",
    access: { adminOnly: true }, anchors: [control("create", "Add field|New field|Create"), { slot: "records", selector: "table" }, control("reorder", "Move up|Move down"), section("preview", "Preview")],
    steps: [
      ["header", "Lead field schema", "Custom fields affect lead creation, editing, imports, and forms across the tenant."],
      ["create", "Create a custom field", "Choose a stable key, label, type, requirement, and options. Avoid changing a field's meaning after data exists."],
      ["records", "Manage existing fields", "Review active fields and their types before editing, disabling, or deleting any schema item."],
      ["reorder", "Control field order", "Reorder fields to match the team's workflow and verify the new order on lead forms."],
      ["preview", "Preview input behavior", "Test dropdown, radio, multiselect, date, URL, and numeric behavior before exposing the field to users."],
      ["dialog", "Field editor", "Validate options and required settings, then save and confirm the field appears in the list."],
    ],
  }),
  workflow({
    id: "gmail", label: "Gmail", path: "/gmail",
    anchors: [control("connect", "Connect Gmail|Disconnect"), { slot: "search", selector: "input[aria-label='Search mail']" }, control("folders", "Inbox|Sent|Drafts|Trash"), { slot: "messages", selector: "[class*='message'], [class*='mail-list'], [role='list']" }],
    steps: [
      ["connect", "Connect Gmail", "Authorize the intended mailbox through Google OAuth. Disconnect before switching to a different account."],
      ["search", "Search synchronized mail", "Search the connected mailbox and clear the query when messages appear missing."],
      ["folders", "Choose a mailbox folder", "Switch between inbox and other available folders, then refresh to retrieve the latest messages.", null, {
        actions: [{ type: "tab", target: target("gmail", "folders") }],
        waitFor: target("gmail", "folders"),
        skipIfMissing: true,
      }],
      ["messages", "Open a message", "Select a message to inspect recipients, body, attachments, and thread context without leaving the CRM.", null, {
        requiresRecords: target("gmail", "messages"),
        skipIfMissing: true,
      }],
      ["page", "Connection troubleshooting", "If connection fails, verify tenant OAuth configuration, allowed redirect URLs, account consent, and pop-up settings."],
    ],
  }),
  workflow({
    id: "callified-data", label: "Callified Data", path: "/callified-data",
    anchors: [control("refresh", "Refresh"), { slot: "campaigns", selector: "[class*='campaign']" }, { slot: "calls", selector: "[class*='callsList'], [class*='callItem']" }],
    steps: [
      ["header", "Callified campaigns", "Review synchronized calling campaigns for the current tenant and check the last refresh state."],
      ["refresh", "Refresh synchronized data", "Request fresh campaign and transcript data after calls complete or when totals look stale."],
      ["campaigns", "Inspect a campaign", "Expand a campaign to review lead coverage, call counts, status, and available transcripts."],
      ["calls", "Review calls and transcripts", "Use call metadata and transcript content to understand outcomes before updating the CRM record."],
      ["page", "When no calling data appears", "Confirm the tenant's Callified connection, campaign mapping, permissions, and whether synchronization has completed."],
    ],
  }),
  workflow({
    id: "marketplace-leads", label: "Marketplace Leads", path: "/marketplace-leads",
    anchors: [control("sync", "Sync All|Sync now"), control("configure", "Configure|Configuration"), { slot: "filters", selector: "input[type='search'], select" }, { slot: "records", selector: "table" }, control("import", "Import to CRM|Import")],
    steps: [
      ["header", "Marketplace lead intake", "Review IndiaMART, JustDial, and TradeIndia enquiries before importing them into CRM."],
      ["sync", "Synchronize providers", "Sync active providers, then verify provider health and the latest-sync timestamp before retrying."],
      ["filters", "Filter incoming leads", "Filter by provider, status, and search so bulk actions affect only the intended enquiries."],
      ["records", "Review duplicates and status", "Inspect contact details and import status; do not re-import duplicate or dismissed leads."],
      ["import", "Import into CRM", "Import selected new leads and confirm the resulting tenant contact or lead was created once."],
      ["configure", "Configure provider credentials", "Administrators can update provider keys and webhook details. Test each provider after saving."],
    ],
  }),
  workflow({
    id: "shared-inbox", label: "Shared Inbox", path: "/shared-inbox",
    anchors: [control("create", "Create Inbox|Create Your First Inbox"), { slot: "inboxes", selector: "[class*='card']" }, control("back", "Back"), { slot: "assignment", selector: "select" }],
    steps: [
      ["header", "Team inboxes", "Shared inboxes centralize addresses such as support or sales for tenant team collaboration."],
      ["create", "Create a shared inbox", "Set a unique address and choose members who should be allowed to read and work its messages."],
      ["dialog", "Configure inbox membership", "Review the mailbox address and selected staff before saving; membership controls message visibility."],
      ["inboxes", "Open an inbox", "Select an inbox card to view its conversations, participants, and assignment state."],
      ["assignment", "Assign messages", "Assign a conversation to the responsible staff member and verify the update before leaving the thread."],
      ["page", "Empty shared inbox", "Forward mail to the displayed address and confirm inbound email processing is configured when no conversations arrive."],
    ],
  }),
  workflow({
    id: "subscription-management", label: "Subscription Plan Management", path: "/manage-plans",
    access: { ownerOnly: true }, anchors: [control("add", "Add Plan"), { slot: "plans", selector: "input[placeholder='Starter']", closest: "section, .card, div" }, control("save", "Save"), control("preview", "Preview")],
    steps: [
      ["header", "Subscription catalogue", "Owner-only plan management changes the catalogue customers can purchase."],
      ["plans", "Edit plan terms", "Review keys, prices, billing periods, features, currencies, visibility, and display order as one contract."],
      ["add", "Add a plan", "Start from a complete plan definition and use a unique stable plan key."],
      ["preview", "Preview customer presentation", "Check labels, currencies, CTA text, popular state, and feature ordering before activation."],
      ["save", "Save one plan at a time", "Save and verify each plan independently. Removing a plan deactivates it and can affect future purchases."],
    ],
  }),
  workflow({
    id: "ai-subscription", label: "AI Subscription", path: "/ai-subscription",
    access: { adminOnly: true }, anchors: [{ slot: "balance", selector: "[class*='card']" }, control("usage", "Usage|View usage"), control("purchase", "Buy|Purchase|Subscribe|Upgrade"), { slot: "plans", selector: "[class*='card']" }],
    steps: [
      ["header", "AI subscription", "Review the tenant's AI entitlement before purchasing additional capacity."],
      ["balance", "Current token balance", "Check remaining tokens, plan status, and renewal context before selecting another plan."],
      ["plans", "Compare AI plans", "Compare included tokens, price, and validity; purchases apply to the current tenant."],
      ["purchase", "Complete a purchase", "Select the intended plan and finish payment in the approved gateway. Avoid repeating while confirmation is pending."],
      ["usage", "Open usage details", "Use the usage dashboard to confirm credits and understand which features consume the allocation."],
    ],
  }),
  workflow({
    id: "ai-usage", label: "AI Usage Dashboard", path: "/settings/ai-usage",
    access: { adminOnly: true }, anchors: [{ slot: "summary", selector: "[class*='card']" }, control("subscription", "Subscription|Manage"), { slot: "requests", selector: "[class*='card']:nth-of-type(1)" }, { slot: "transactions", selector: "[class*='card']:nth-of-type(2)" }],
    steps: [
      ["header", "AI usage overview", "Monitor tenant token consumption, remaining balance, and recent activity."],
      ["summary", "Usage and allowance", "Compare used and available tokens and investigate unexpected changes before the balance is exhausted."],
      ["requests", "Recent AI requests", "Review feature, task, token count, and timestamp to identify the largest consumers."],
      ["transactions", "Credit transactions", "Audit purchases, grants, deductions, and adjustments against the displayed balance."],
      ["subscription", "Manage AI capacity", "Open AI Subscription when the tenant needs a different allowance or additional credits."],
    ],
  }),
];
