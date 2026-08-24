import { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Keyboard, X } from "lucide-react";

const MOD = "Mod";
const SEQUENCE_TIMEOUT_MS = 900;
export const TRAVEL_KEYBOARD_SHORTCUTS_EVENT = "travel-keyboard-shortcuts:open";

const NAV_SHORTCUTS = [
  { key: "G then D", label: "Travel dashboard", path: "/travel" },
  { key: "G then L", label: "Leads", path: "/leads" },
  { key: "G then P", label: "Travel pipeline", path: "/travel/pipeline" },
  { key: "G then I", label: "Itineraries", path: "/travel/itineraries" },
  { key: "G then Q", label: "Quotes", path: "/travel/quotes-admin" },
  { key: "G then T", label: "Trips", path: "/travel/trips" },
  { key: "G then W", label: "WhatsApp", path: "/travel/whatsapp" },
  { key: "G then R", label: "Reports", path: "/travel/reports" },
  { key: "G then S", label: "Suppliers", path: "/travel/suppliers-admin" },
];

const GENERAL_SHORTCUTS = [
  { key: `${MOD} + /`, label: "Show keyboard shortcuts" },
  { key: "/", label: "Focus page search" },
  { key: "N", label: "Create a new record on supported travel pages" },
  { key: "F", label: "Focus filters on supported travel pages" },
  { key: "C", label: "Clear focused search text" },
  { key: "Esc", label: "Close this help or clear the active field" },
  { key: `${MOD} + Enter`, label: "Submit/send the active form or composer" },
];

const PAGE_SHORTCUTS = [
  { key: `${MOD} + S`, label: "Save draft/current form when a save button is visible" },
  { key: `${MOD} + P`, label: "Preview or download PDF when available" },
  { key: `${MOD} + D`, label: "Duplicate current quote when available" },
  { key: `${MOD} + M`, label: "Run markup/pricing calculation when available" },
  { key: "S", label: "Suggest itinerary on the itinerary list" },
  { key: "A", label: "Approve/add on supported queue/editor screens" },
  { key: "R", label: "Reject, reply, or refresh on supported screens" },
  { key: "E", label: "Edit/open editor on supported screens" },
  { key: "P", label: "Preview/public page on supported screens" },
];

const NAV_BY_KEY = NAV_SHORTCUTS.reduce((acc, item) => {
  acc[item.key.slice(-1).toLowerCase()] = item.path;
  return acc;
}, {});

function isMacPlatform() {
  if (typeof navigator === "undefined") return false;
  return /mac|iphone|ipad|ipod/i.test(navigator.platform || navigator.userAgent || "");
}

function isDarkTheme() {
  if (typeof document === "undefined") return false;
  return document.documentElement.getAttribute("data-theme") === "dark";
}

function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return Boolean(target.isContentEditable || target.closest?.("[contenteditable='true']"));
}

function isVisibleElement(el) {
  if (!el) return false;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  return el.offsetParent !== null || el.getClientRects().length > 0;
}

function isSearchInput(target) {
  if (!target || target.tagName !== "INPUT") return false;
  const type = String(target.getAttribute("type") || "text").toLowerCase();
  const label = `${target.getAttribute("aria-label") || ""} ${target.getAttribute("placeholder") || ""}`.toLowerCase();
  return type === "search" || label.includes("search");
}

function findVisibleListboxOptions() {
  return Array.from(
    document.querySelectorAll(
      "[role='listbox'] button, [role='listbox'] [role='option'], [role='listbox'] input[type='checkbox'], [data-testid*='listbox'] button",
    ),
  ).filter(isVisibleElement);
}

function moveThroughSearchSuggestions(e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
  const active = document.activeElement;
  const inListbox = active?.closest?.("[role='listbox'], [data-testid*='listbox']");
  if (!isSearchInput(e.target) && !inListbox) return false;
  const options = findVisibleListboxOptions();
  if (options.length === 0) return false;
  const currentIndex = options.indexOf(active);
  const nextIndex = e.key === "ArrowDown"
    ? (currentIndex + 1) % options.length
    : (currentIndex <= 0 ? options.length - 1 : currentIndex - 1);
  e.preventDefault();
  options[nextIndex]?.focus?.();
  options[nextIndex]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  return true;
}

function isModified(e) {
  return e.metaKey || e.ctrlKey;
}

function normalizeLabel(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function clickButtonByLabels(labels) {
  const wanted = labels.map(normalizeLabel);
  const buttons = Array.from(document.querySelectorAll("button, [role='button']"));
  const match = buttons.find((button) => {
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    const label = normalizeLabel(
      button.getAttribute("aria-label") ||
      button.getAttribute("title") ||
      button.textContent,
    );
    return wanted.some((item) => label.includes(item));
  });
  if (!match) return false;
  match.click();
  return true;
}

function focusFirst(selectors) {
  const items = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
  const target = items.find((el) => !el.disabled && el.offsetParent !== null);
  if (!target) return false;
  target.focus();
  target.select?.();
  return true;
}

function clearFocusedField() {
  const active = document.activeElement;
  if (!active || !["INPUT", "TEXTAREA"].includes(active.tagName)) return false;
  active.value = "";
  active.dispatchEvent(new Event("input", { bubbles: true }));
  active.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

function submitActiveForm() {
  const active = document.activeElement;
  const form = active?.closest?.("form");
  if (form) {
    form.requestSubmit?.();
    return true;
  }
  return clickButtonByLabels(["send", "save", "create", "publish"]);
}

function isTravelShortcutPath(pathname) {
  return (
    pathname === "/travel" ||
    pathname.startsWith("/travel/") ||
    pathname === "/travel-stall" ||
    pathname.startsWith("/travel-stall/")
  );
}

function hasPageOwnedShortcutHelp(pathname) {
  return /^\/travel\/itineraries\/[^/]+\/edit$/.test(pathname);
}

export default function TravelKeyboardShortcuts() {
  const location = useLocation();
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);
  const [sequence, setSequence] = useState(null);
  const [darkTheme, setDarkTheme] = useState(() => isDarkTheme());
  const isMac = useMemo(() => isMacPlatform(), []);
  const modLabel = isMac ? "Cmd" : "Ctrl";
  const enabled = isTravelShortcutPath(location.pathname);
  const panelBg = darkTheme ? "#111317" : "#ffffff";
  const panelBorder = darkTheme ? "#303641" : "#d8dee8";
  const panelMuted = darkTheme ? "#c4cad4" : "#4b5563";

  useEffect(() => {
    if (!enabled) {
      setHelpOpen(false);
      setSequence(null);
    }
  }, [enabled]);

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return undefined;
    }
    const root = document.documentElement;
    const sync = () => setDarkTheme(isDarkTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!enabled || !sequence) return undefined;
    const t = setTimeout(() => setSequence(null), SEQUENCE_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [enabled, sequence]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return undefined;
    const onOpenRequest = () => {
      setHelpOpen(true);
      setSequence(null);
    };
    window.addEventListener(TRAVEL_KEYBOARD_SHORTCUTS_EVENT, onOpenRequest);
    return () => window.removeEventListener(TRAVEL_KEYBOARD_SHORTCUTS_EVENT, onOpenRequest);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return undefined;

    const onKeyDown = (e) => {
      if (e.defaultPrevented) return;
      const key = e.key.toLowerCase();
      const typing = isTypingTarget(e.target);

      if (e.key === "Escape") {
        if (helpOpen) {
          e.preventDefault();
          setHelpOpen(false);
        } else if (typing) {
          e.target.blur?.();
        }
        setSequence(null);
        return;
      }

      if (isModified(e) && e.key === "Enter") {
        e.preventDefault();
        submitActiveForm();
        return;
      }

      if (isModified(e) && e.key === "/") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (moveThroughSearchSuggestions(e)) return;

      if (typing) return;

      if (e.key === "?" && !hasPageOwnedShortcutHelp(location.pathname)) {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }

      if (e.key === "/") {
        e.preventDefault();
        focusFirst([
          "input[type='search']",
          "input[aria-label*='search']",
          "input[aria-label*='Search']",
          "input[placeholder*='Search']",
          "input[placeholder*='search']",
        ]);
        return;
      }

      if (sequence === "g") {
        const path = NAV_BY_KEY[key];
        setSequence(null);
        if (path) {
          e.preventDefault();
          navigate(path);
        }
        return;
      }

      if (key === "g") {
        setSequence("g");
        return;
      }

      if (key === "n") {
        if (clickButtonByLabels(["create a new", "create itinerary", "new deal", "new quote", "add line", "new trip"])) {
          e.preventDefault();
        }
        return;
      }

      if (key === "s") {
        if (isModified(e)) {
          if (clickButtonByLabels(["save draft", "save changes", "save plan", "save assignment", "save"])) {
            e.preventDefault();
          }
          return;
        }
        if (clickButtonByLabels(["suggest itinerary"])) e.preventDefault();
        return;
      }

      if (isModified(e) && key === "p") {
        if (clickButtonByLabels(["download pdf", "preview", "publish public page"])) e.preventDefault();
        return;
      }

      if (isModified(e) && key === "d") {
        if (clickButtonByLabels(["duplicate"])) e.preventDefault();
        return;
      }

      if (isModified(e) && key === "m") {
        if (clickButtonByLabels(["refresh pricing breakdown", "calculate"])) e.preventDefault();
        return;
      }

      if (key === "f") {
        if (focusFirst(["select", "button[aria-label*='Filter']", "button[title*='Filter']"])) e.preventDefault();
        return;
      }

      if (key === "c") {
        if (clearFocusedField()) e.preventDefault();
        return;
      }

      if (key === "a") {
        if (clickButtonByLabels(["approve", "add line", "add room", "add day"])) e.preventDefault();
        return;
      }

      if (key === "r") {
        if (clickButtonByLabels(["reject", "reply", "refresh", "retry"])) e.preventDefault();
        return;
      }

      if (key === "e") {
        if (clickButtonByLabels(["edit", "open editor"])) e.preventDefault();
        return;
      }

      if (key === "p") {
        if (clickButtonByLabels(["preview", "public page"])) e.preventDefault();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, helpOpen, location.pathname, navigate, sequence]);

  if (!enabled || !helpOpen) return null;

  const renderKey = (value) => value.replaceAll(MOD, modLabel);

  return (
    <div
      role="presentation"
      onClick={() => setHelpOpen(false)}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 6000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
        background: "rgba(0,0,0,0.42)",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Travel keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(760px, 100%)",
          maxHeight: "min(760px, calc(100vh - 32px))",
          overflow: "auto",
          borderRadius: 8,
          border: `1px solid ${panelBorder}`,
          background: panelBg,
          color: "var(--text-primary)",
          boxShadow: "0 18px 52px rgba(0,0,0,0.32)",
        }}
      >
        <header
          style={{
            position: "sticky",
            top: 0,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: `1px solid ${panelBorder}`,
            background: panelBg,
            zIndex: 1,
          }}
        >
          <Keyboard size={18} aria-hidden />
          <strong style={{ fontSize: 15 }}>Travel keyboard shortcuts</strong>
          <button
            type="button"
            aria-label="Close keyboard shortcuts"
            onClick={() => setHelpOpen(false)}
            style={{
              marginLeft: "auto",
              border: "none",
              background: "transparent",
              color: panelMuted,
              cursor: "pointer",
              padding: 4,
            }}
          >
            <X size={18} aria-hidden />
          </button>
        </header>

        <ShortcutSection
          title="General"
          items={GENERAL_SHORTCUTS}
          renderKey={renderKey}
          darkTheme={darkTheme}
        />
        <ShortcutSection
          title="Navigation"
          items={NAV_SHORTCUTS}
          renderKey={renderKey}
          darkTheme={darkTheme}
        />
        <ShortcutSection
          title="Page actions"
          items={PAGE_SHORTCUTS}
          renderKey={renderKey}
          darkTheme={darkTheme}
        />
      </section>
    </div>
  );
}

function ShortcutSection({ title, items, renderKey, darkTheme }) {
  const panelBorder = darkTheme ? "#303641" : "#d8dee8";
  const panelMuted = darkTheme ? "#c4cad4" : "#4b5563";
  const kbdBg = darkTheme ? "#1b2028" : "#f1f5f9";

  return (
    <div style={{ padding: "14px 16px 4px" }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 13, color: panelMuted }}>
        {title}
      </h2>
      <div style={{ display: "grid", gap: 6 }}>
        {items.map((item) => (
          <div
            key={`${title}-${item.key}`}
            style={{
              display: "grid",
              gridTemplateColumns: "140px minmax(0, 1fr)",
              gap: 12,
              alignItems: "center",
              minHeight: 30,
            }}
          >
            <kbd
              style={{
                justifySelf: "start",
                padding: "3px 7px",
                borderRadius: 5,
                border: `1px solid ${panelBorder}`,
                background: kbdBg,
                color: "var(--text-primary)",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.3,
              }}
            >
              {renderKey(item.key)}
            </kbd>
            <span style={{ color: panelMuted, fontSize: 13 }}>
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
