// TripsResolver — the dynamic /trips entry point.
//
// Why: marketing sites (Travel Stall, RFU, etc.) link "Discover Trips"
// to /trips and never to a specific /p/<slug>. This component asks the
// backend which landing page is currently flagged as "featured" and
// navigates the browser to it. Admin can re-feature a different page
// at any time and /trips will follow without any marketing-site code
// change.
//
// Resolution flow:
//   1. GET /api/landing-pages/public/featured (no auth — wired into
//      server.js openPaths). Returns { slug, … } or 404 NO_FEATURED_PAGE.
//   2. On 200 → <Navigate replace to={`/p/${slug}`} />. The
//      backend's existing /p/:slug renderer takes over.
//   3. On 404 → fall back to the hardcoded TripsLanding.jsx so the
//      old Japan-only experience keeps working until an operator
//      Features a landing page. This fallback is the safety net that
//      lets us ship the featured concept without breaking /trips for
//      tenants that haven't featured a page yet.
//   4. On network/5xx → same fallback; we never break /trips.
//
// The resolver is intentionally lightweight: no AuthContext, no global
// state, no router-context guards. /trips is a public marketing surface,
// so we keep its dependency surface minimal.
import { useEffect, useState, lazy, Suspense } from "react";
import { Navigate } from "react-router-dom";

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
    return <Navigate to={`/p/${slug}`} replace />;
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
