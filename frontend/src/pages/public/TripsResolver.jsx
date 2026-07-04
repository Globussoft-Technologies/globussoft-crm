// TripsResolver — the dynamic /trips entry point.
//
// Why: marketing sites (Travel Stall, RFU, etc.) link "Discover Trips"
// to /trips and never to a specific /p/<slug>. The backend now serves
// /trips as the server-rendered HTML of the currently featured published
// landing page. This component only runs for client-side navigations
// inside the SPA; it forces a full-page load to /trips so the backend
// renderer is used instead of React Router. If no page is featured, it
// falls back to the hardcoded TripsLanding.jsx.
//
// Resolution flow:
//   1. GET /api/landing-pages/public/featured (no auth — wired into
//      server.js openPaths). Returns { slug, … } or 404 NO_FEATURED_PAGE.
//   2. On 200 → force `window.location.replace('/trips')`. The backend's
//      /trips route renders the featured page and keeps the URL as /trips.
//   3. On 404 / network/5xx → fall back to TripsLanding.jsx.
//
// The resolver is intentionally lightweight: no AuthContext, no global
// state, no router-context guards. /trips is a public marketing surface,
// so we keep its dependency surface minimal.
import { useEffect, useState, lazy, Suspense } from "react";

// Hardcoded Japan fallback. Lazy-imported so the small fast-path
// (featured page is set → immediate redirect) doesn't pull the whole
// TripsLanding bundle into the resolver's initial chunk.
const TripsLanding = lazy(() => import("./TripsLanding"));

const STATES = {
  LOADING: "loading",
  REDIRECT: "redirect",
  FALLBACK: "fallback",
};

export default function TripsResolver() {
  const [state, setState] = useState(STATES.LOADING);
  const [slug, setSlug] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/landing-pages/public/featured", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (r.ok) {
          const data = await r.json();
          if (data && typeof data.slug === "string" && data.slug.length > 0) {
            setSlug(data.slug);
            setState(STATES.REDIRECT);
            return;
          }
        }
        // 404 NO_FEATURED_PAGE or malformed response — show fallback.
        setState(STATES.FALLBACK);
      } catch (_e) {
        if (!cancelled) setState(STATES.FALLBACK);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state === STATES.LOADING) {
    // Render nothing during the resolve. Typical p99 is <100ms for a
    // cached featured-page lookup, so showing a spinner would flash
    // worse than blank. Browser keeps the prior page chrome visible
    // until either Navigate or Suspense kicks in.
    return null;
  }

  if (state === STATES.REDIRECT && slug) {
    // Redirect to the featured page's canonical /p/<slug> render URL instead
    // of the /trips vanity URL.
    //
    // WHY NOT /trips: the backend DOES have a GET /trips route that
    // server-renders the featured page (server.js), but it only fires if the
    // web layer proxies /trips to Express. On globuscrm.globussoft.com the
    // Nginx config serves the SPA shell at /trips, so replacing to /trips just
    // re-mounts THIS resolver → redirects again → infinite blank reload.
    //
    // /p/<slug> is the canonical public landing-page render surface
    // (app.use("/p", landingPagesPublic)). Every published landing page is
    // served through it, so it is reliably proxied to the backend wherever the
    // product is deployed. Redirecting there renders the real featured page
    // with no /trips loop and no Nginx change. It is also a distinct URL from
    // /trips, so this resolver never re-mounts — the loop is impossible by
    // construction. Returning null prevents any React render flash.
    window.location.replace(`/p/${encodeURIComponent(slug)}`);
    return null;
  }

  // Fallback path — render the hardcoded Japan landing page. Once UAT
  // signs off on the Japan seed and an operator marks it Featured, this
  // branch becomes unreachable for tenants that have a featured page,
  // and can be removed in Phase 4 of the /trips migration.
  return (
    <Suspense fallback={null}>
      <TripsLanding />
    </Suspense>
  );
}
