// Shared destination-aware visuals for the public travel pages (itinerary
// share, trip microsite). The real photo comes from Wikipedia (keyless, via
// utils/destinationPhotos); the cultural motif, accent colour and gradient
// come from utils/destinationTheme. The themed gradient + motif always render,
// so a missing/slow photo never leaves a broken or empty block.
//
// Presentational only (inline styles) — the public pages render outside the
// app's AuthContext shell.

import { useEffect, useState } from "react";
import { MapPin } from "lucide-react";
import { destinationTheme } from "../utils/destinationTheme";
import { useDestinationPhoto, useDestinationGallery, useMultiDestinationGallery } from "../utils/destinationPhotos";

// Full-bleed destination hero with the title + a caller-supplied subtitle row
// (dates / status). For pages that DON'T have their own branded header.
// `photoDestination` (optional) overrides ONLY the photo + theme lookup while
// the visible title stays `destination`. Used by flight quotes whose
// destination is a route ("DEL→JED flights") that has no photo — we pass the
// arrival city so the hero still gets a real image + fitting theme.
export function DestinationHero({ destination, photoDestination, children }) {
  const photoKey = photoDestination || destination;
  const theme = destinationTheme(photoKey);
  const photoUrl = useDestinationPhoto(photoKey);
  return (
    <header
      style={{
        position: "relative", overflow: "hidden", borderRadius: 14,
        marginBottom: 22, minHeight: 220, background: theme.gradient,
        display: "flex", alignItems: "flex-end",
      }}
    >
      {photoUrl && (
        <img
          src={photoUrl}
          alt={`${destination}`}
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {/* The decorative motif-emoji watermark was removed 2026-06-26 — it read
          as a washed-out glyph over the photo (especially the ✈️ default for
          uncurated destinations) and looked like an artefact. theme.motif is
          still used elsewhere; the hero now relies on the photo + gradient. */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(10,16,30,0.78), rgba(10,16,30,0.10) 60%, rgba(10,16,30,0.20))" }} />
      <div style={{ position: "relative", padding: "24px 26px", color: "#fff", width: "100%" }}>
        <h1 style={{ margin: 0, display: "flex", alignItems: "center", gap: 10, fontSize: 30, textShadow: "0 1px 5px rgba(0,0,0,0.45)" }}>
          <MapPin size={28} aria-hidden style={{ color: theme.accent, filter: "brightness(1.8)" }} />
          {destination}
        </h1>
        {children && (
          <div style={{ color: "rgba(255,255,255,0.94)", marginTop: 8, fontSize: 14, textShadow: "0 1px 3px rgba(0,0,0,0.5)" }}>
            {children}
          </div>
        )}
      </div>
    </header>
  );
}

// Decorative side rails of small destination culture photos that fill the wide
// empty gutters either side of a narrow centered content card. Fixed to the
// viewport edges (always visible as you scroll) and only shown when there's
// enough room (≥1100px) so they never overlap the content on smaller screens.
// Pointer-events off + aria-hidden — purely ambience; degrades to nothing when
// there are no photos.
const RAIL_MIN_VIEWPORT = 1100;
const RAIL_TILES = 10;

export function DestinationSideRails({ destination, photoDestination, photoDestinations }) {
  const galleryKey = photoDestination || destination;
  // Multi-city trips (e.g. "Makkah · Madinah · Paris · France") pass the full
  // city list via photoDestinations so the rails span ALL cities, not just the
  // first. Single-destination callers omit it and get the one-city gallery.
  const multiList = Array.isArray(photoDestinations) ? photoDestinations.filter(Boolean) : [];
  const single = useDestinationGallery(galleryKey);
  const multi = useMultiDestinationGallery(multiList);
  const images = multiList.length > 1 ? multi : single;
  const [wide, setWide] = useState(false);
  const [hoveredIdx, setHoveredIdx] = useState(null);
  useEffect(() => {
    const check = () => setWide(typeof window !== "undefined" && window.innerWidth >= RAIL_MIN_VIEWPORT);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  if (!wide || !images.length) return null;

  const theme = destinationTheme(galleryKey);
  // Split the unique photos so the LEFT and RIGHT rails show DIFFERENT images
  // (even indices left, odd indices right). Each side cycles only its own
  // subset to fill the column, so the two rails never mirror each other.
  const leftSet = images.filter((_, i) => i % 2 === 0);
  const rightSet = images.filter((_, i) => i % 2 === 1);
  const fill = (set) => {
    const base = set.length ? set : images; // fallback if a side is empty
    return Array.from({ length: RAIL_TILES }, (_, i) => base[i % base.length]);
  };

  // Fade the strip into the page at top + bottom so it doesn't hard-cut.
  const fadeMask = "linear-gradient(to bottom, transparent 0, #000 70px, #000 calc(100% - 70px), transparent 100%)";
  const rail = (side) => ({
    position: "fixed", top: 0, bottom: 0, [side]: 0,
    width: "min(200px, calc((100vw - 720px) / 2))",
    display: "flex", flexDirection: "column", gap: 18,
    padding: "22px 16px", boxSizing: "border-box", overflow: "hidden",
    pointerEvents: "none", zIndex: 0,
    maskImage: fadeMask, WebkitMaskImage: fadeMask,
  });
  // Each photo sits in a white frame (polaroid-ish) with a soft shadow, a
  // destination-accent hairline, a dark-bottom tint, the place-name caption,
  // and a small left/right stagger for editorial rhythm. Hovering reveals a
  // description overlay pulled from the Wikipedia image metadata.
  const tile = (item, i) => {
    const shift = i % 2 === 0;
    const h = i % 3 === 0 ? 162 : 132;
    const isHovered = hoveredIdx === i;
    const hoverText = item.description || item.caption || null;
    return (
      <figure
        key={i}
        onMouseEnter={() => setHoveredIdx(i)}
        onMouseLeave={() => setHoveredIdx(null)}
        style={{
          margin: 0, background: "#fff", padding: 5, borderRadius: 14,
          boxShadow: isHovered ? "0 12px 32px rgba(20,30,55,0.28)" : "0 8px 22px rgba(20,30,55,0.14)",
          borderBottom: `3px solid ${theme.accent}`,
          marginLeft: shift ? 16 : 0, marginRight: shift ? 0 : 16,
          transform: isHovered
            ? (shift ? "rotate(-0.6deg) scale(1.04)" : "rotate(0.6deg) scale(1.04)")
            : (shift ? "rotate(-0.6deg)" : "rotate(0.6deg)"),
          transition: "transform 0.18s ease, box-shadow 0.18s ease",
          pointerEvents: "auto",
          cursor: "default",
          zIndex: isHovered ? 2 : 1,
          position: "relative",
        }}
      >
        <div style={{ position: "relative", borderRadius: 9, overflow: "hidden", height: h }}>
          <img
            src={item.url}
            alt={item.caption || ""}
            loading="lazy"
            onError={(e) => { const f = e.currentTarget.closest("figure"); if (f) f.style.display = "none"; }}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          <div style={{ position: "absolute", inset: 0, background: "linear-gradient(to top, rgba(12,18,32,0.55), transparent 55%)" }} />
          {/* Description overlay on hover */}
          {isHovered && hoverText && (
            <div style={{
              position: "absolute", inset: 0,
              background: "linear-gradient(to top, rgba(8,14,28,0.92) 60%, rgba(8,14,28,0.6))",
              display: "flex", flexDirection: "column", justifyContent: "flex-end",
              padding: "10px 8px 8px",
            }}>
              <p style={{
                margin: 0, fontSize: 10, color: "rgba(255,255,255,0.93)",
                lineHeight: 1.45, overflow: "hidden",
                display: "-webkit-box", WebkitLineClamp: 5, WebkitBoxOrient: "vertical",
              }}>
                {hoverText}
              </p>
            </div>
          )}
        </div>
        {item.caption && (
          <figcaption
            style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, color: "#1f2a44",
              padding: "5px 4px 1px", textAlign: "center", whiteSpace: "nowrap",
              overflow: "hidden", textOverflow: "ellipsis",
            }}
          >
            {item.caption}
          </figcaption>
        )}
      </figure>
    );
  };
  return (
    <>
      <div aria-hidden style={rail("left")}>{fill(leftSet).map((s, i) => tile(s, i))}</div>
      <div aria-hidden style={rail("right")}>{fill(rightSet).map((s, i) => tile(s, i + RAIL_TILES))}</div>
    </>
  );
}

// Photo-only destination banner (no title) — for pages that ALREADY have their
// own branded header (the microsite). Fills white space with the real photo +
// motif watermark, themed gradient behind. Renders nothing without a
// destination.
export function DestinationBanner({ destination }) {
  const theme = destinationTheme(destination);
  const photoUrl = useDestinationPhoto(destination);
  if (!destination) return null;
  return (
    <div
      aria-hidden
      style={{
        position: "relative", overflow: "hidden", borderRadius: 12,
        height: 180, background: theme.gradient,
      }}
    >
      {photoUrl && (
        <img
          src={photoUrl}
          alt=""
          loading="lazy"
          onError={(e) => { e.currentTarget.style.display = "none"; }}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        />
      )}
      {/* Motif-emoji watermark removed 2026-06-26 (see DestinationHero). */}
    </div>
  );
}
