import { GENERIC_SIDEBAR_PAGE_SPECS } from "../utils/sidebarSearch";
import { getGenericTourProfile } from "./genericTourProfiles";
import { GENERIC_SECONDARY_WORKFLOW_TOURS } from "./secondaryWorkflowTours";

export function featureIdFromPath(path = "") {
  return path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-") || "home";
}

function buildSteps(feature) {
  const customSteps = {
    dashboard: [
      { target: '[data-tour="dashboard-header"]', title: "Your CRM overview", content: "Start with the role-aware summary and use its primary action to open your next workspace." },
      { target: '[data-tour="dashboard-kpis"]', title: "Business KPIs", content: "Select a KPI card to drill into contacts, deals, revenue, or reports." },
      { target: '[data-tour="dashboard-pipeline"]', title: "Pipeline analytics", content: "Review pipeline movement and value trends without leaving the dashboard." },
    ],
    contacts: [
      { target: '[data-tour="contacts-create"]', title: "Add a contact", content: "Create a contact manually, or use the adjacent import action for a spreadsheet." },
      { target: '[data-tour="contacts-search"]', title: "Find the right contact", content: "Search the tenant contact directory, then refine it with status and owner filters." },
      { target: '[data-tour="page-content"]', title: "Manage contacts", content: "Open a row to manage contact details, relationships, communication, and activity." },
    ],
    pipeline: [
      { target: '[data-tour="pipeline-primary"]', title: "Create a deal", content: "Add an opportunity with its contact, owner, stage, value, and expected close date." },
      { target: '[data-tour="pipeline-filters"]', title: "Focus the pipeline", content: "Filter by stage or search for a deal, company, or contact." },
      { target: '[data-tour="pipeline-records"]', title: "Monitor pipeline health", content: "Use the stage board to understand value, probability, and movement." },
    ],
    leads: [
      {
        target: '[data-tour-nav="/leads"]',
        title: "Find the Leads workspace",
        content: "Expand the Leads group to reach open leads, converted leads, scoring, routing, and reports.",
        actions: [{ type: "expand", target: '[data-tour="leads-group"]', required: true }],
        waitFor: '[data-tour-nav="/leads"]',
        skipIfMissing: true,
        placement: "right",
      },
      { target: '[data-tour="leads-create"]', title: "Create a lead", content: "Capture a new lead manually when it did not arrive through a form or integration." },
      { target: '[data-tour="leads-search"]', title: "Search and filter leads", content: "Find leads and combine the search with saved, source, stage, owner, and advanced filters." },
      { target: '[data-tour="page-content"]', title: "Work the lead queue", content: "Assign, contact, qualify, convert, and bulk-update leads from this workspace." },
    ],
  };
  if (customSteps[feature.id]) return customSteps[feature.id];
  const profile = getGenericTourProfile(feature.id);
  const steps = [];
  if (feature.launcherTarget) {
    steps.push({
      target: feature.launcherTarget,
      title: feature.label,
      content: feature.description,
      placement: "right",
    });
  } else if (feature.path) {
    steps.push({
      target: `[data-tour-nav="${feature.path}"]`,
      title: `Find ${feature.label}`,
      content: `${feature.label} is available from the main navigation whenever your role has access.`,
      placement: "right",
    });
  }
  if (!profile) {
    steps.push({
      target: '[data-tour="page-content"]',
      title: `Using ${feature.label}`,
      content: feature.description || `Learn the main controls available in ${feature.label}.`,
      placement: "center",
    });
    return steps;
  }
  if (feature.launcherTarget) {
    steps.push(
      {
        target: feature.launcherTarget,
        title: `Open ${feature.label}`,
        content: `This launcher opens the connected ${feature.label} workspace. Save unfinished CRM work before switching applications.`,
        placement: "right",
      },
      {
        target: feature.launcherTarget,
        title: "Access and sign-in",
        content: `Availability depends on your CRM role and the tenant's ${feature.label} connection. The external service may require a separate authorized session.`,
        placement: "right",
      },
      {
        target: feature.launcherTarget,
        title: `Work in ${feature.label}`,
        content: `${profile.editInstruction.charAt(0).toUpperCase()}${profile.editInstruction.slice(1)} there, then return to the CRM to verify synchronized results.`,
        placement: "right",
      },
      {
        target: feature.launcherTarget,
        title: "Tenant data boundary",
        content: "Confirm the connected organization before changing data. Do not assume an external workspace uses the CRM's current tenant automatically.",
        roles: ["ADMIN", "OWNER", "MANAGER"],
        placement: "right",
      },
      {
        target: feature.launcherTarget,
        title: `When ${feature.label} is unavailable`,
        content: "Check pop-up blocking, your role, the tenant integration status, and the external sign-in. An administrator can repair credentials in Settings.",
        placement: "right",
      },
    );
    return steps;
  }

  steps.push({
    target: `[data-tour="${feature.id}-header"]`,
    title: `${feature.label} workspace`,
    content: `${feature.description}. Start here to understand the available ${profile.plural} and the actions allowed for your role.`,
  });
  if (profile.create) steps.push({
    target: `[data-tour="${feature.id}-primary"]`,
    title: `Create a ${profile.singular}`,
    content: `Use the primary action to add a ${profile.singular}. Complete required fields first; optional details can be refined before saving.`,
  });
  else steps.push({
    target: '[data-tour="page-content"]',
    title: `How ${profile.plural} are created`,
    content: `${feature.label} is a review or configuration surface. Its ${profile.plural} come from CRM activity or a connected service rather than being created directly on this page.`,
    placement: "center",
  });
  if (profile.filter) steps.push({
    target: `[data-tour="${feature.id}-filters"]`,
    title: `Find the right ${profile.plural}`,
    content: `Search and combine the available filters to narrow ${profile.plural}. Clear filters before assuming a record is missing.`,
  });
  steps.push({
    target: `[data-tour="${feature.id}-records"]`,
    title: `Work with ${profile.plural}`,
    content: `Select a ${profile.singular} to ${profile.editInstruction}. Row and bulk actions appear only when your role permits them.`,
  });
  if (profile.edit) steps.push({
    target: `[data-tour="${feature.id}-edit"]`,
    title: `Edit safely`,
    content: `Open an existing ${profile.singular}, verify its tenant-owned relationships, make the change, and confirm the saved state before leaving.`,
    roles: ["ADMIN", "OWNER", "MANAGER", "USER"],
  });
  else steps.push({
    target: `[data-tour="${feature.id}-records"]`,
    title: "Review before acting",
    content: `This view summarizes ${profile.plural}. Follow the linked source record when a correction is needed instead of attempting to change derived results here.`,
  });
  if (profile.builder) steps.push({
    target: `[data-tour="${feature.id}-builder"]`,
    title: `${feature.label} builder`,
    content: `Use the builder to assemble and reorder the configuration. Preview or validate it before publishing changes to active users.`,
  });
  if (profile.create || profile.edit || profile.builder) steps.push({
    target: `[data-tour="${feature.id}-dialog"]`,
    title: `${feature.label} form`,
    content: `Create and edit forms open here. Review required fields and validation messages, then save or cancel explicitly; closing does not imply a save.`,
    optional: true,
    skipIfMissing: true,
  });
  if (profile.export) steps.push({
    target: `[data-tour="${feature.id}-export"]`,
    title: `Export ${profile.plural}`,
    content: `Apply the intended filters first, then export or download. Confirm whether the action includes the current page or the complete filtered result.`,
  });
  else steps.push({
    target: '[data-tour="page-content"]',
    title: "Export availability",
    content: `${feature.label} does not expose a direct bulk export in this workspace. Use the related report or data export area when a downloadable tenant data set is required.`,
    placement: "center",
  });
  steps.push({
    target: `[data-tour="${feature.id}-empty"]`,
    title: `When no ${profile.plural} appear`,
    content: `Clear search and filters, confirm your access and tenant context, then create or import the first ${profile.singular} when your role allows it.`,
    optional: true,
    skipIfMissing: true,
  });
  if (profile.admin) steps.push({
    target: '[data-tour="page-content"]',
    title: "Administrator responsibility",
    content: `These changes can affect other users in the tenant. Review scope and dependencies before saving, and use the audit trail to verify sensitive changes.`,
    roles: ["ADMIN", "OWNER"],
    placement: "center",
  });
  if (profile.personal) steps.push({
    target: '[data-tour="page-content"]',
    title: "Your preferences",
    content: "These settings apply to your account. Organization-wide defaults remain under administrator settings.",
    roles: ["USER", "MANAGER", "ADMIN", "OWNER"],
    placement: "center",
  });
  if (!profile.admin && !profile.personal) steps.push({
    target: '[data-tour="page-content"]',
    title: "Team oversight",
    content: `Managers can review team-wide ${profile.plural} and may see assignment or configuration actions that standard users do not.`,
    roles: ["ADMIN", "OWNER", "MANAGER"],
    placement: "center",
  });
  if (!feature.managerOnly && !feature.adminOnly && !profile.personal) steps.push({
    target: '[data-tour="page-content"]',
    title: "Your permitted work",
    content: `Standard users see only the ${profile.plural} and actions allowed by their role, ownership, and field permissions. Ask an administrator when an expected action is unavailable.`,
    roles: ["USER"],
    placement: "center",
  });
  return steps;
}

const catalogFeatures = GENERIC_SIDEBAR_PAGE_SPECS.map((page) => ({
  ...page,
  id: page.id || featureIdFromPath(page.path),
  launcherTarget: page.launcherTarget || page.actionTarget,
}));

const byId = new Map(catalogFeatures.map((feature) => [feature.id, feature]));

const primaryTours = Array.from(byId.values()).map((feature) => ({
  version: 1,
  ...feature,
  steps: buildSteps(feature),
}));

export const GENERIC_FEATURE_TOURS = [
  ...primaryTours,
  ...GENERIC_SECONDARY_WORKFLOW_TOURS,
];

export function findGenericFeatureForPath(pathname) {
  if (!pathname) return null;
  return (
    GENERIC_FEATURE_TOURS
      .filter((feature) => feature.path || feature.pattern)
      .sort((a, b) => {
        const aScore = a.pattern ? 10000 : a.path.length;
        const bScore = b.pattern ? 10000 : b.path.length;
        return bScore - aScore;
      })
      .find(
        (feature) =>
          feature.pattern?.test(pathname) ||
          pathname === feature.path ||
          (!feature.exact && pathname.startsWith(`${feature.path}/`)),
      ) || null
  );
}
