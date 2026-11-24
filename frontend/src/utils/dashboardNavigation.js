const DASHBOARD_NAVIGATION_STORAGE_KEY = 'crm-dashboard-navigation';

export function dashboardNavigationState(vertical) {
  if (vertical === 'wellness') return { fromWellnessDashboard: true };
  if (vertical === 'travel') return { fromTravelDashboard: true };
  return null;
}

export function dashboardPathForState(state) {
  if (state?.fromWellnessDashboard === true) return '/wellness';
  if (state?.fromTravelDashboard === true) return '/travel';
  return null;
}

export function rememberDashboardNavigation(location) {
  const dashboardPath = dashboardPathForState(location.state);
  if (!dashboardPath || typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(DASHBOARD_NAVIGATION_STORAGE_KEY, JSON.stringify({
      pathname: location.pathname,
      search: location.search,
      dashboardPath,
    }));
  } catch {
    // Navigation state remains sufficient when storage is unavailable.
  }
}

export function readRefreshedDashboardNavigation(location) {
  if (typeof performance !== 'undefined' && performance.getEntriesByType) {
    const entry = performance.getEntriesByType('navigation')[0];
    if (entry && entry.type !== 'reload') return null;
  }
  if (typeof sessionStorage === 'undefined') return null;
  try {
    const stored = JSON.parse(sessionStorage.getItem(DASHBOARD_NAVIGATION_STORAGE_KEY) || 'null');
    if (stored?.pathname !== location.pathname || stored?.search !== location.search) return null;
    return stored.dashboardPath || null;
  } catch {
    return null;
  }
}
