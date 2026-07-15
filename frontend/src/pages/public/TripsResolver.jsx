// TripsResolver — the /trips public entry point.
//
// Resolution flow:
//   1. GET /api/landing-pages/public/featured-html (no auth).
//      Returns rendered HTML of the live trip, or 404 if nothing published.
//   2. On 200 → write the HTML into the current document (replaces the SPA
//      shell entirely). URL stays at /trips. No redirect, no proxy needed.
//   3. On 404 / error → render TripsLanding fallback.
//
// This approach works on localhost (no extra proxy) and on the demo
// (no extra Nginx config) because /api/* is already proxied everywhere.
import { useEffect, useState, lazy, Suspense } from "react";

const TripsLanding = lazy(() => import("./TripsLanding"));

const STATES = { LOADING: "loading", SHOW_TRIP: "show_trip", FALLBACK: "fallback" };

export default function TripsResolver() {
  const [state, setState] = useState(STATES.LOADING);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/landing-pages/public/featured-html", {
          method: "GET",
          headers: { Accept: "text/html" },
        });
        if (cancelled) return;
        if (r.ok) {
          const html = await r.text();
          if (html && html.length > 0) {
            // Write the server-rendered trip HTML into the current document.
            // URL stays at /trips — no redirect, no proxy dependency.
            document.open();
            document.write(html);
            document.close();
            return;
          }
        }
        setState(STATES.FALLBACK);
      } catch (_e) {
        if (!cancelled) setState(STATES.FALLBACK);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (state === STATES.LOADING) return null;

  return (
    <Suspense fallback={null}>
      <TripsLanding />
    </Suspense>
  );
}
