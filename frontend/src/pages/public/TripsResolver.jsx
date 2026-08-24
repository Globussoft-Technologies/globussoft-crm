// TripsResolver — the /trips SPA fallback for local navigation/tests.
//
// Resolution flow:
//   1. GET /api/landing-pages/public/featured-full?vertical=travel (no auth).
//      Returns the full featured published travel page, or 404 if nothing
//      is featured yet.
//   2. On 200 → render a lightweight fallback inside the SPA.
//   3. On 404 / error → render TripsLanding fallback.
//
// Direct browser loads of /trips should be served by the backend proxy so
// the HTML matches production exactly.
import { useEffect, useState, lazy, Suspense } from "react";
import { LandingPageReactRenderer } from "../../components/landing-page-renderers";

const TripsLanding = lazy(() => import("./TripsLanding"));

function normalizePublicTripPage(page) {
  const slug = typeof page?.slug === "string" ? page.slug.trim() : "";
  if (!slug) return null;
  return {
    ...page,
    publicSubmit: true,
  };
}

export default function TripsResolver() {
  const [featuredPage, setFeaturedPage] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/landing-pages/public/featured-full?vertical=travel", {
          method: "GET",
          headers: { Accept: "application/json" },
        });
        if (cancelled) return;
        if (!r.ok) {
          setFeaturedPage(null);
          return;
        }

        const page = await r.json();
        if (cancelled) return;

        setFeaturedPage(normalizePublicTripPage(page));
      } catch (_e) {
        if (!cancelled) setFeaturedPage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (featuredPage === undefined) return null;

  if (featuredPage) {
    return <LandingPageReactRenderer landingPage={featuredPage} />;
  }

  return (
    <Suspense fallback={null}>
      <TripsLanding />
    </Suspense>
  );
}
