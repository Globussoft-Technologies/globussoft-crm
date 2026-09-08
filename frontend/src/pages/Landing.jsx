import { useEffect, useRef } from "react";
import landingMarkup from "./landingMarkup.html?raw";

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

function setupLandingInteractions(container) {
  const header = container.querySelector("#site-header");
  const heroFormFrame = container.querySelector(".hero-form-card iframe");
  const observers = [];
  const animationFrames = new Set();

  const handleMessage = (event) => {
    if (
      !heroFormFrame ||
      event.source !== heroFormFrame.contentWindow ||
      event.origin !== window.location.origin ||
      !event.data ||
      event.data.source !== "gbs-web-form"
    ) {
      return;
    }

    const height = Number(event.data.height);
    if (!Number.isFinite(height) || height <= 0) return;
    const frameHeight = `${Math.ceil(height)}px`;
    heroFormFrame.style.height = frameHeight;
    heroFormFrame.style.minHeight = frameHeight;
  };

  const handleScroll = () => {
    header?.classList.toggle("scrolled", window.scrollY > 8);
  };

  window.addEventListener("message", handleMessage);
  window.addEventListener("scroll", handleScroll);

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
        counterObserver.unobserve(element);
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
    hamburger?.removeEventListener("click", handleMenuToggle);
    observers.forEach((observer) => observer.disconnect());
    animationFrames.forEach((frameId) => window.cancelAnimationFrame(frameId));
  };
}

export default function Landing() {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const container = containerRef.current;
    mountLandingTemplate(container);
    const cleanupInteractions = setupLandingInteractions(container);

    return () => {
      cleanupInteractions();
      container.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} style={{ minHeight: "100vh" }} />;
}
