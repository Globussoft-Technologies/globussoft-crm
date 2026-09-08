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
  const scriptNodes = Array.from(documentFragment.body.querySelectorAll("script"));

  container.replaceChildren();
  styleNodes.forEach((style) => container.appendChild(style.cloneNode(true)));
  fontLinks.forEach((link) => container.appendChild(link.cloneNode(true)));
  bodyNodes.forEach((node) => container.appendChild(node.cloneNode(true)));

  if (typeof window.IntersectionObserver !== "undefined") {
    scriptNodes.forEach((script) => {
      const executableScript = document.createElement("script");
      executableScript.textContent = script.textContent || "";
      container.appendChild(executableScript);
    });
  }
}

export default function Landing() {
  const containerRef = useRef(null);

  useEffect(() => {
    if (containerRef.current) mountLandingTemplate(containerRef.current);

    return () => {
      containerRef.current?.replaceChildren();
    };
  }, []);

  return <div ref={containerRef} style={{ minHeight: "100vh" }} />;
}
