import { useState, useRef, useEffect } from "react";
import { tagPopoverStyle, tagOptionStyle } from "./styles";
import { tagColour } from "./constants";

// ── Reusable tag picker popover ─────────────────────────────────────
export default function TagPickerPopover({ allTags, onPick, onClose, onCreated, onCreate, excludeIds = [], showCreate = true, title }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const containerRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const handler = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) onClose();
    };
    const keyHandler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [onClose]);

  const trimmed = query.trim();
  const filtered = allTags
    .filter((t) => !excludeIds.includes(t.id))
    .filter((t) => !trimmed || t.name.toLowerCase().includes(trimmed.toLowerCase()));
  const exactMatch = trimmed && filtered.some((t) => t.name.toLowerCase() === trimmed.toLowerCase());

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-label={title || "Tag picker"}
      style={tagPopoverStyle}
    >
      <div style={{ padding: "0.5rem 0.6rem", borderBottom: "1px solid var(--border-color, rgba(0,0,0,0.08))" }}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or create…"
          aria-label="Search tags"
          style={{
            width: "100%",
            background: "var(--surface-color, #fff)",
            border: "1px solid var(--border-color, rgba(0,0,0,0.12))",
            borderRadius: 6,
            color: "var(--text-primary)",
            padding: "0.35rem 0.55rem",
            fontSize: "0.85rem",
            outline: "none",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length && !exactMatch && trimmed === "") return;
              if (filtered[0] && (!trimmed || filtered[0].name.toLowerCase() === trimmed.toLowerCase())) {
                onPick(filtered[0]);
              } else if (showCreate && trimmed && !exactMatch && onCreate) {
                onCreate(trimmed);
              }
            }
          }}
        />
      </div>
      <div style={{ maxHeight: 200, overflowY: "auto", padding: "0.25rem" }}>
        {filtered.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onPick(t)}
            style={{ ...tagOptionStyle, display: "flex", alignItems: "center", gap: "0.4rem" }}
          >
            <span style={{ width: 8, height: 8, borderRadius: 4, background: tagColour(t) }} />
            {t.name}
          </button>
        ))}
        {filtered.length === 0 && !trimmed && (
          <div style={{ padding: "0.5rem", fontSize: "0.8rem", color: "var(--text-secondary)" }}>
            No tags yet.
          </div>
        )}
        {showCreate && trimmed && !exactMatch && (
          <button
            type="button"
            onClick={() => {
              if (onCreate) onCreate(trimmed);
              else if (onCreated) onCreated({ name: trimmed });
            }}
            style={{ ...tagOptionStyle, color: "var(--primary-color, var(--accent-color))" }}
          >
            + Create “{trimmed}”
          </button>
        )}
      </div>
    </div>
  );
}
