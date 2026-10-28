import { useEffect, useRef } from "react";
import {
  injectLandingHeroForm,
  resizeHeroFormFrame,
  responsiveFormDevice,
  sendHeroFormContext,
} from "../utils/landingHeroForm";
import landingMarkup from "./landingMarkup.html?raw";

// No hardcoded form fallback: an unavailable configuration fails closed.

function mountLandingTemplate(container) {
  const documentFragment = new DOMParser().parseFromString(
    landingMarkup,
    "text/html",
  );
  const styleNodes = Array.from(documentFragment.head.querySelectorAll("style"));
  const fontLinks = Array.from(
    documentFragment.head.querySelectorAll('link[rel="stylesheet"]'),
  );
  const bodyNodes = Array.from(documentFragment.body.childNodes).filter(
    (node) => node.nodeName !== "SCRIPT",
  );
  container.replaceChildren();
  styleNodes.forEach((style) => container.appendChild(style.cloneNode(true)));
  fontLinks.forEach((link) => container.appendChild(link.cloneNode(true)));
  bodyNodes.forEach((node) => container.appendChild(node.cloneNode(true)));
}

function setupLandingInteractions(container, getHeroFrame) {
  const header = container.querySelector("#site-header");
  const observers = [];
  const animationFrames = new Set();

  const sendResponsiveDevice = () => {
    const heroFormFrame = typeof getHeroFrame === "function" ? getHeroFrame() : null;
    if (!heroFormFrame) return;
    try {
      heroFormFrame.contentWindow?.postMessage({
        source: "gbs-web-form-host",
        type: "responsive-device",
        device: responsiveFormDevice(window.innerWidth),
      }, "*");
    } catch {
      // The iframe may have been replaced while the landing page is resizing.
    }
  };

  const handleMessage = (event) => {
    const heroFormFrame = typeof getHeroFrame === "function" ? getHeroFrame() : null;
    if (
      !heroFormFrame ||
      event.source !== heroFormFrame.contentWindow ||
      event.origin !== window.location.origin ||
      !event.data ||
      event.data.source !== "gbs-web-form"
    ) {
      return;
    }

    if (event.data.type === "ready") {
      sendHeroFormContext(heroFormFrame);
      sendResponsiveDevice();
    }
    if (event.data.type === "size") {
      resizeHeroFormFrame(heroFormFrame, event.data.height);
    }
  };

  const handleScroll = () => {
    header?.classList.toggle("scrolled", window.scrollY > 8);
  };

  window.addEventListener("message", handleMessage);
  window.addEventListener("scroll", handleScroll);
  window.addEventListener("resize", sendResponsiveDevice);

  const revealElements = container.querySelectorAll(".reveal, .reveal-stagger");
  if (typeof window.IntersectionObserver === "function") {
    const revealObserver = new window.IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          revealObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });
    revealElements.forEach((element) => revealObserver.observe(element));
    observers.push(revealObserver);

    const counterObserver = new window.IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const element = entry.target;
        const target = Number.parseInt(element.dataset.count, 10);
        const suffix = element.dataset.suffix || "";
        const start = performance.now();

        const tick = (now) => {
          const progress = Math.min((now - start) / 1200, 1);
          const eased = 1 - Math.pow(1 - progress, 3);
          element.textContent = `${Math.round(eased * target)}${suffix}`;
          if (progress < 1) {
            const frameId = window.requestAnimationFrame(tick);
            animationFrames.add(frameId);
          }
        };

        const frameId = window.requestAnimationFrame(tick);
        animationFrames.add(frameId);
        counterObserver.unobserve(entry.target);
      });
    }, { threshold: 0.5 });
    container.querySelectorAll(".stat .num").forEach((element) => counterObserver.observe(element));
    observers.push(counterObserver);
  } else {
    revealElements.forEach((element) => element.classList.add("in"));
  }

  const hamburger = container.querySelector(".hamburger");
  const navList = container.querySelector("nav ul");
  const handleMenuToggle = () => {
    if (!navList) return;
    const open = navList.style.display === "flex";
    navList.style.display = open ? "none" : "flex";
    if (!open) {
      Object.assign(navList.style, {
        flexDirection: "column",
        position: "absolute",
        top: "72px",
        left: "0",
        right: "0",
        background: "#fff",
        padding: "20px 24px",
        gap: "16px",
        boxShadow: "0 12px 24px rgba(16,19,42,0.08)",
      });
    }
  };
  hamburger?.addEventListener("click", handleMenuToggle);

  return () => {
    window.removeEventListener("message", handleMessage);
    window.removeEventListener("scroll", handleScroll);
    window.removeEventListener("resize", sendResponsiveDevice);
    hamburger?.removeEventListener("click", handleMenuToggle);
    observers.forEach((observer) => observer.disconnect());
    animationFrames.forEach((frameId) => window.cancelAnimationFrame(frameId));
  };
}

export default function Landing() {
  const containerRef = useRef(null);
  const heroFrameRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const container = containerRef.current;
    const documentRoot = document.documentElement;
    const previousTheme = documentRoot.getAttribute("data-theme");

    // The marketing landing page has a fixed light palette. A persisted dark
    // preference from a previous authenticated session must not leak into it;
    // doing so leaves the page's dark text on the app's dark body background.
    // Restore the preference when navigating to login or back into the CRM.
    documentRoot.setAttribute("data-theme", "light");
    mountLandingTemplate(container);
    heroFrameRef.current = injectLandingHeroForm(
      container.querySelector("#hero-form-mount"),
    );
    const cleanupInteractions = setupLandingInteractions(
      container,
      () => heroFrameRef.current,
    );

    return () => {
      cleanupInteractions();
      heroFrameRef.current = null;
      container.replaceChildren();
      if (previousTheme === null) {
        documentRoot.removeAttribute("data-theme");
      } else {
        documentRoot.setAttribute("data-theme", previousTheme);
      }
    };
  }, []);

  return <div ref={containerRef} style={{ minHeight: "100vh" }} />;
}
