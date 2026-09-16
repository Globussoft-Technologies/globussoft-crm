import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { findGenericFeatureForPath } from "./genericFeatureRegistry";

const PRIMARY_ACTION = /\b(add|create|new|compose|connect|invite|upload|import|build|request|schedule|configure)\b/i;
const EDIT_ACTION = /\b(edit|manage|configure|review|open|view|details?)\b/i;
const EXPORT_ACTION = /\b(export|download|csv|pdf|print)\b/i;
const EMPTY_COPY = /\b(no\s+.+(?:found|yet|available)|nothing here|empty|create your first|get started)\b/i;

function visible(element) {
  if (!element || !element.isConnected || element.hidden || element.closest('[aria-hidden="true"]')) return false;
  const style = window.getComputedStyle?.(element);
  return style?.display !== "none" && style?.visibility !== "hidden";
}

function textOf(element) {
  return [element?.textContent, element?.getAttribute?.("aria-label"), element?.getAttribute?.("title")]
    .filter(Boolean)
    .join(" ")
    .trim();
}

function firstMatching(elements, pattern) {
  return Array.from(elements).find((element) => visible(element) && pattern.test(textOf(element)));
}

function mark(element, value, marked) {
  if (!element || element.hasAttribute("data-tour")) return;
  element.setAttribute("data-tour", value);
  element.setAttribute("data-tour-generated", "true");
  marked.add(element);
}

function findHintTarget(root, hint) {
  let target = null;
  if (hint.selector) {
    try {
      target = root.querySelector(hint.selector);
    } catch (_err) {
      target = null;
    }
  }
  if (!target && hint.match) {
    const pattern = new RegExp(hint.match, "i");
    target = Array.from(root.querySelectorAll(hint.elements || "button, a[href], h1, h2, h3, [role='button'], [role='tab']"))
      .filter((element) => visible(element) && pattern.test(textOf(element)))
      .sort((a, b) => textOf(a).length - textOf(b).length)[0];
  }
  if (target && hint.closest) target = target.closest(hint.closest) || target;
  return target;
}

/**
 * Normalizes the varied markup used by older CRM pages into a stable tour
 * contract. Explicit page-owned data-tour attributes always win; generated
 * anchors are removed on route change/unmount.
 */
export default function TourPageAnchors() {
  const location = useLocation();

  useEffect(() => {
    const feature = findGenericFeatureForPath(location.pathname);
    const root = document.querySelector('[data-tour="page-content"]')
      || document.querySelector('main, [role="main"]');
    if (!feature) return undefined;

    const marked = new Set();
    const navTarget = Array.from(document.querySelectorAll("a[href], button"))
      .find((element) => {
        const href = element.getAttribute("href");
        return href && (href === feature.path || href.startsWith(`${feature.path}/`));
      });
    mark(navTarget, `nav-${feature.path}`, marked);
    if (navTarget && !navTarget.hasAttribute("data-tour-nav")) {
      navTarget.setAttribute("data-tour-nav", feature.path);
      navTarget.setAttribute("data-tour-generated-nav", "true");
    }
    if (feature.id === "leads") {
      const leadsGroup = Array.from(document.querySelectorAll("button, [role='button']"))
        .find((element) => /\bleads\b/i.test(textOf(element)) && element.hasAttribute("aria-expanded"));
      mark(leadsGroup, "leads-group", marked);
    }
    if (!root) return undefined;
    if (!root.hasAttribute("data-tour")) mark(root, "page-content", marked);
    let frame = null;
    const scan = () => {
      frame = null;
      const controls = root.querySelectorAll("button, a[href], [role='button']");
      const heading = root.querySelector("h1, h2, [role='heading']");
      mark(heading?.closest("header") || heading, `${feature.id}-header`, marked);

      // Dedicated workflow anchors take precedence over the generic legacy
      // classifications when the same control could satisfy both contracts.
      for (const hint of feature.anchors || []) {
        mark(findHintTarget(root, hint), `${feature.id}-${hint.slot}`, marked);
      }

      if (feature.id === "contacts") {
        mark(firstMatching(controls, PRIMARY_ACTION), "contacts-create", marked);
        mark(root.querySelector("input[placeholder*='search' i], [role='searchbox']"), "contacts-search", marked);
      }
      mark(firstMatching(controls, PRIMARY_ACTION), `${feature.id}-primary`, marked);
      mark(firstMatching(controls, EDIT_ACTION), `${feature.id}-edit`, marked);
      mark(firstMatching(controls, EXPORT_ACTION), `${feature.id}-export`, marked);

      const filterControl = Array.from(root.querySelectorAll("input, select, [role='searchbox'], [role='combobox']"))
        .find(visible);
      mark(filterControl?.closest("form, [role='search'], .filters, .filter-bar") || filterControl, `${feature.id}-filters`, marked);

      const records = root.querySelector("table, [role='grid'], [class*='kanban'], [class*='data-table'], [class*='record-list']");
      mark(records, `${feature.id}-records`, marked);

      const builder = root.querySelector("[data-builder], [class*='builder-canvas'], [class*='workflow-canvas'], [class*='react-flow']");
      mark(builder, `${feature.id}-builder`, marked);

      const dialog = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], .modal-content"))
        .find(visible);
      mark(dialog, `${feature.id}-dialog`, marked);
      mark(dialog?.querySelector("form") || dialog?.querySelector("input, select, textarea")?.closest("div"), `${feature.id}-editor`, marked);

      const empty = Array.from(root.querySelectorAll("p, h2, h3, [role='status'], [class*='empty']"))
        .find((element) => visible(element) && EMPTY_COPY.test(textOf(element)));
      mark(empty, `${feature.id}-empty`, marked);

    };
    const scheduleScan = () => {
      if (!frame) frame = window.requestAnimationFrame(scan);
    };
    scan();
    const observer = new MutationObserver(scheduleScan);
    observer.observe(root, { childList: true, subtree: true });
    observer.observe(document.body, { childList: true, subtree: false });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      marked.forEach((element) => {
        if (element.getAttribute("data-tour-generated") === "true") {
          element.removeAttribute("data-tour");
          element.removeAttribute("data-tour-generated");
        }
        if (element.getAttribute("data-tour-generated-nav") === "true") {
          element.removeAttribute("data-tour-nav");
          element.removeAttribute("data-tour-generated-nav");
        }
      });
    };
  }, [location.pathname]);

  return null;
}
