import { useEffect, useRef } from "react";
import {
  injectLandingHeroForm,
  resizeHeroFormFrame,
  responsiveFormDevice,
  sendHeroFormContext,
} from "../utils/landingHeroForm";
import landingMarkup from "./landingMarkup.html?raw";
import LandingChatbotWidget from "../components/LandingChatbotWidget";

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

  return (
    <>
      <div ref={containerRef} style={{ minHeight: "100vh" }} />
      <LandingChatbotWidget />
      <style>{`
        .landing-chatbot { position: fixed; right: 24px; bottom: 24px; z-index: 1000; font-family: inherit; }
        .landing-chatbot__launcher { display: inline-flex; align-items: center; gap: 9px; border: 0; border-radius: 999px; padding: 13px 18px; background: linear-gradient(135deg, #5944e8, #a43de0); color: #fff; box-shadow: 0 14px 32px rgba(77, 48, 186, .28); font: inherit; font-weight: 700; cursor: pointer; transition: transform .2s ease, box-shadow .2s ease; }
        .landing-chatbot__launcher:hover, .landing-chatbot__launcher:focus-visible { transform: translateY(-2px); box-shadow: 0 18px 38px rgba(77, 48, 186, .38); outline: none; }
        .landing-chatbot__launcher--open { padding: 13px; }
        .landing-chatbot__panel { width: min(360px, calc(100vw - 32px)); height: min(560px, calc(100vh - 108px)); margin-bottom: 12px; display: flex; flex-direction: column; overflow: hidden; border: 1px solid rgba(91, 74, 221, .18); border-radius: 20px; background: #fff; box-shadow: 0 24px 70px rgba(20, 24, 70, .22); }
        .landing-chatbot__header { display: flex; align-items: center; justify-content: space-between; padding: 16px 17px; background: linear-gradient(135deg, #5944e8, #a43de0); color: #fff; }
        .landing-chatbot__ticket-status { padding: 7px 14px; background: #f2efff; border-bottom: 1px solid #e2dcff; color: #4c3ca8; font-size: .72rem; font-weight: 600; }
        .landing-chatbot__ticket-answer { margin-top: 4px; color: #25233b; font-weight: 400; line-height: 1.4; white-space: pre-wrap; }
        .landing-chatbot__identity { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .landing-chatbot__identity > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .landing-chatbot__identity strong { font-size: .9rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .landing-chatbot__identity span:last-child { font-size: .72rem; opacity: .84; }
        .landing-chatbot__avatar { display: grid; place-items: center; width: 34px; height: 34px; flex: 0 0 auto; border-radius: 50%; background: rgba(255,255,255,.18); }
        .landing-chatbot__close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: rgba(255,255,255,.13); color: #fff; cursor: pointer; }
        .landing-chatbot__header-actions { display: flex; align-items: center; gap: 6px; }
        .landing-chatbot__clear { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: rgba(255,255,255,.13); color: #fff; cursor: pointer; }
        .landing-chatbot__clear:hover, .landing-chatbot__close:hover { background: rgba(255,255,255,.24); }
        .landing-chatbot__messages { display: flex; flex: 1; flex-direction: column; gap: 10px; overflow-y: auto; padding: 16px; background: #f8f8fc; }
        .landing-chatbot__message { max-width: 84%; padding: 10px 12px; border-radius: 14px; font-size: .84rem; line-height: 1.45; white-space: pre-wrap; }
        .landing-chatbot__message--bot { align-self: flex-start; border: 1px solid #e6e4f5; border-bottom-left-radius: 4px; background: #fff; color: #25233b; }
        .landing-chatbot__message--agent { align-self: flex-start; border: 1px solid #d8d1f7; border-bottom-left-radius: 4px; background: #f2efff; color: #25233b; }
        .landing-chatbot__message--user { align-self: flex-end; border-bottom-right-radius: 4px; background: #5944e8; color: #fff; }
        .landing-chatbot__composer { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #ecebf4; background: #fff; }
        .landing-chatbot__composer input { min-width: 0; flex: 1; border: 1px solid #dddbea; border-radius: 10px; padding: 10px 11px; color: #25233b; font: inherit; font-size: .84rem; }
        .landing-chatbot__composer input:focus { border-color: #5944e8; outline: 2px solid rgba(89,68,232,.16); }
        .landing-chatbot__composer button { display: grid; place-items: center; width: 38px; flex: 0 0 auto; border: 0; border-radius: 10px; background: #5944e8; color: #fff; cursor: pointer; }
        .landing-chatbot__composer button:disabled { opacity: .45; cursor: not-allowed; }
        @media (max-width: 520px) { .landing-chatbot { right: 16px; bottom: 16px; } .landing-chatbot__panel { height: min(560px, calc(100vh - 92px)); } }
      `}</style>
    </>
  );
}
