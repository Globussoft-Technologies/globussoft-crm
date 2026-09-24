export function readTmcPortalView(allowedViews, fallback = "dashboard") {
  try {
    const view = new URLSearchParams(window.location.search).get("view");
    return allowedViews.has(view) ? view : fallback;
  } catch {
    return fallback;
  }
}

export function persistTmcPortalView(view, allowedViews, fallback = "dashboard") {
  try {
    const nextView = allowedViews.has(view) ? view : fallback;
    const url = new URL(window.location.href);
    if (nextView === fallback) {
      url.searchParams.delete("view");
    } else {
      url.searchParams.set("view", nextView);
    }
    const nextUrl = url.pathname + url.search + url.hash;
    const currentUrl = window.location.pathname + window.location.search + window.location.hash;
    if (nextUrl !== currentUrl) {
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  } catch {
    // URL persistence is optional when browser history is unavailable.
  }
}
