import { Suspense } from "react";
import Lottie from "lottie-react";
import purpleGitCat from "../assets/purple-git-cat.json";

export default function GitHubCatIcon({ C }) {
  return (
    <a
      href="https://github.com/Globussoft-Technologies/globussoft-crm.git"
      target="_blank"
      rel="noreferrer"
      aria-label="View Globus CRM on GitHub"
      onMouseEnter={(event) => {
        event.currentTarget.style.transform = "translateY(-2px) scale(1.04)";
        const tooltip = event.currentTarget.querySelector(
          "[data-github-tooltip]",
        );
        tooltip.style.transitionDelay = "0s";
        tooltip.style.opacity = "1";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.transform = "none";
        const tooltip = event.currentTarget.querySelector(
          "[data-github-tooltip]",
        );
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
      <Suspense
        fallback={
          <span style={{ width: 42, height: 42 }} aria-hidden="true" />
        }
      >
        <Lottie
          animationData={purpleGitCat}
          loop
          autoplay
          aria-hidden="true"
          style={{ width: 42, height: 42, pointerEvents: "none" }}
        />
      </Suspense>
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
    </a>
  );
}
