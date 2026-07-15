// Public fallback page — shown at /trips when no featured trip is published.
// No auth, renders outside the CRM AuthContext shell.
import "./TripsLanding.css";

const DESTINATIONS = [
  {
    tag: "CULTURAL HERITAGE",
    title: "Kyoto, Japan",
    subtitle: "Ancient temples & cherry blossom trails",
    img: "https://images.unsplash.com/photo-1493976040374-85c8e12f0c0e?w=900&q=80",
  },
  {
    tag: "ISLAND PARADISE",
    title: "Bali, Indonesia",
    subtitle: "Rice terraces, temples & tropical shores",
    img: "https://images.unsplash.com/photo-1537996194471-e657df975ab4?w=900&q=80",
  },
  {
    tag: "METROPOLIS",
    title: "Tokyo, Japan",
    subtitle: "Neon skylines & timeless tradition",
    img: "https://images.unsplash.com/photo-1542051841857-5f90071e7989?w=900&q=80",
  },
  {
    tag: "NATURAL WONDER",
    title: "Swiss Alps",
    subtitle: "Glacial peaks & breathtaking panoramas",
    img: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=900&q=80",
  },
  {
    tag: "ANCIENT HISTORY",
    title: "Rome, Italy",
    subtitle: "2,000 years of art, architecture & cuisine",
    img: "https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=900&q=80",
  },
  {
    tag: "COASTAL ESCAPE",
    title: "Santorini, Greece",
    subtitle: "Whitewashed cliffs over the Aegean Sea",
    img: "https://images.unsplash.com/photo-1570077188670-e3a8d69ac5ff?w=900&q=80",
  },
];

const PILLARS = [
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <polyline points="9 12 11 14 15 10" />
      </svg>
    ),
    title: "Safe & Supervised",
    desc: "Dedicated tour directors and structured itineraries for complete peace of mind.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
    title: "Immersive Experiences",
    desc: "Hand-curated cultural encounters that go beyond the tourist trail.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <line x1="12" y1="11" x2="12" y2="16" />
        <line x1="9.5" y1="13.5" x2="14.5" y2="13.5" />
      </svg>
    ),
    title: "All-Inclusive",
    desc: "Flights, hotels, meals, and guided tours — no hidden costs, no hassle.",
  },
  {
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    title: "Expert Educators",
    desc: "Experienced faculty-led tours tailored for school and college groups.",
  },
];

export default function TripsLanding() {
  return (
    <div className="tl-root">
      {/* ── Hero ── */}
      <header className="tl-hero">
        <div className="tl-hero-overlay" />
        <div className="tl-hero-bg" />

        <div className="tl-hero-content">
          <span className="tl-hero-badge">New Trips Coming Soon</span>
          <h1 className="tl-hero-title">
            The World Is Waiting.<br />Your Journey Starts Here.
          </h1>
          <p className="tl-hero-sub">
            Educational immersion programs and curated travel experiences for schools &amp; colleges.
            We&rsquo;re currently preparing our next season of extraordinary destinations.
          </p>
          <a href="#destinations" className="tl-btn-ghost">
            Explore Destinations
          </a>
        </div>

      </header>


      {/* ── Destinations grid ── */}
      <section id="destinations" className="tl-section">
        <div className="tl-section-inner">
          <p className="tl-eyebrow">Explore the Possibilities</p>
          <h2 className="tl-section-title">Destinations We Love</h2>
          <p className="tl-section-sub">
            A taste of the incredible places our programs have taken students — and where we&rsquo;re headed next.
          </p>

          <div className="tl-dest-grid">
            {DESTINATIONS.map((d) => (
              <div key={d.title} className="tl-dest-card">
                <div className="tl-dest-img-wrap">
                  <img src={d.img} alt={d.title} className="tl-dest-img" loading="lazy" />
                  <span className="tl-dest-tag">{d.tag}</span>
                </div>
                <div className="tl-dest-body">
                  <h3 className="tl-dest-title">{d.title}</h3>
                  <p className="tl-dest-sub">{d.subtitle}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Why us ── */}
      <section className="tl-section tl-section--dark">
        <div className="tl-section-inner">
          <p className="tl-eyebrow tl-eyebrow--light">What We Offer</p>
          <h2 className="tl-section-title tl-title--light">Built for Students. Trusted by Schools.</h2>

          <div className="tl-pillars">
            {PILLARS.map((p) => (
              <div key={p.title} className="tl-pillar">
                <div className="tl-pillar-icon">{p.icon}</div>
                <h3 className="tl-pillar-title">{p.title}</h3>
                <p className="tl-pillar-desc">{p.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Marquee strip ── */}
      <div className="tl-marquee-wrap" aria-hidden="true">
        <div className="tl-marquee-track">
          {[...Array(3)].map((_, i) =>
            ["Japan", "Bali", "Switzerland", "Italy", "Greece", "Vietnam", "Australia", "Singapore", "France", "Thailand"].map((c) => (
              <span key={`${c}-${i}`} className="tl-marquee-item">{c}</span>
            ))
          )}
        </div>
      </div>

      {/* ── Closing note ── */}
      <section className="tl-cta-section">
        <div className="tl-cta-inner">
          <h2 className="tl-cta-title">New Trips Coming Soon</h2>
          <p className="tl-cta-sub">
            Our next season of educational travel experiences is being planned. Stay tuned for announcements.
          </p>
        </div>
      </section>
    </div>
  );
}
