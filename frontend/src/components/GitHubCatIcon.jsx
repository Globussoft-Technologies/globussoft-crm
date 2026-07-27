import React from "react";

export default function GitHubCatIcon({ C }) {
  return (
    <a
      href="https://github.com/Globussoft-Technologies/globussoft-crm.git"
      target="_blank"
      rel="noreferrer"
      aria-label="View Globus CRM on GitHub"
      onMouseEnter={(event) => {
        event.currentTarget.style.transform = "translateY(-2px) scale(1.04)";
        const tooltip = event.currentTarget.querySelector("[data-github-tooltip]");
        tooltip.style.transitionDelay = "0s";
        tooltip.style.opacity = "1";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.transform = "none";
        const tooltip = event.currentTarget.querySelector("[data-github-tooltip]");
        tooltip.style.transitionDelay = "0s";
        tooltip.style.opacity = "0";
      }}
      style={{
        width: 44,
        height: 44,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        textDecoration: "none",
        transition: "transform 180ms ease",
        position: "relative",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 42,
          height: 42,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 999,
          background:
            "radial-gradient(circle at 30% 28%, rgba(255,255,255,0.95) 0 10%, rgba(255,255,255,0.12) 11% 100%), linear-gradient(180deg, #6b4cff 0%, #4530a8 100%)",
          boxShadow: "0 8px 18px rgba(61, 45, 131, 0.22)",
          color: "#fff",
          pointerEvents: "none",
          transform: "translateZ(0)",
          animation: "gitHubCatFloat 3.8s ease-in-out infinite",
        }}
      >
        <svg
          viewBox="0 0 64 64"
          width="32"
          height="32"
          fill="none"
          role="img"
          aria-label="GitHub cat icon"
          style={{ overflow: "visible" }}
        >
          <defs>
            <linearGradient id="github-cat-face" x1="16" y1="12" x2="48" y2="52" gradientUnits="userSpaceOnUse">
              <stop stopColor="#ffffff" />
              <stop offset="1" stopColor="#d9d4ff" />
            </linearGradient>
          </defs>
          <path
            d="M22 16l-7-7c-1.2-1.2-3.1-1.2-4.3 0l-4 4c-1.2 1.2-1.2 3.1 0 4.3L12 24"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
          <path
            d="M42 16l7-7c1.2-1.2 3.1-1.2 4.3 0l4 4c1.2 1.2 1.2 3.1 0 4.3L52 24"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.9"
          />
          <path
            d="M18 28c0-7.7 6.3-14 14-14s14 6.3 14 14v6c0 7.7-6.3 14-14 14s-14-6.3-14-14v-6Z"
            fill="url(#github-cat-face)"
          />
          <path
            d="M25 34c1.2 0 2.2-1 2.2-2.2s-1-2.2-2.2-2.2-2.2 1-2.2 2.2 1 2.2 2.2 2.2Zm14 0c1.2 0 2.2-1 2.2-2.2s-1-2.2-2.2-2.2-2.2 1-2.2 2.2 1 2.2 2.2 2.2Z"
            fill="#4a327f"
          />
          <path
            d="M27 39c2.7 2.2 7.3 2.2 10 0"
            stroke="#4a327f"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <path
            d="M16 38l-5 2M16 42l-5 4M48 38l5 2M48 42l5 4"
            stroke="#e9e4ff"
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity="0.95"
          />
          <path
            d="M21 48c3.4 3.8 8.2 6 11 6s7.6-2.2 11-6"
            stroke="#f7f5ff"
            strokeWidth="2.5"
            strokeLinecap="round"
            opacity="0.85"
          />
        </svg>
      </span>
      <span
        data-github-tooltip
        role="tooltip"
        style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          left: "50%",
          transform: "translateX(-50%)",
          padding: "6px 10px",
          borderRadius: 6,
          background: C.text,
          color: "#fff",
          fontSize: "0.75rem",
          fontWeight: 500,
          lineHeight: 1,
          whiteSpace: "nowrap",
          opacity: 0,
          pointerEvents: "none",
          boxShadow: "0 4px 12px rgba(15,23,42,0.2)",
          transition: "opacity 120ms ease",
          zIndex: 110,
        }}
      >
        Globus CRM GitHub Code
      </span>
      <style>{`@keyframes gitHubCatFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-1.5px); } }`}</style>
    </a>
  );
}
