import { useState } from "react";
import {
  Globe,
  UserPlus,
  Calendar as CalendarIcon,
  Tag as TagIcon,
} from "lucide-react";
import { DateRangeFilter, resolveDateRangeYmd, EMPTY_DATE_FILTER } from "../../../components/wellness/DateRangeFilter";
import MultiSelectDropdown from "../../../components/MultiSelectDropdown";
import ModalShell from "./ModalShell";
import { iconBtnSmall, primaryTealBtn, filterLabelStyle } from "./styles";
import { SOURCE_OPTIONS, GENDER_OPTIONS, tagColour } from "./constants";

// ── FilterModal — popup with dropdown selectors for each filter ────
// Holds a DRAFT copy of the active filters; nothing commits until the
// user clicks "Apply". Cancel / outside-click / Esc discards the draft.
export default function FilterModal({ onClose, initial, allTags, onApply }) {
  const [draft, setDraft] = useState({
    source: initial.source || [],
    gender: initial.gender || [],
    // Existing addedFrom/addedTo URL params reconstruct as a custom-preset filter
    // so the picker re-opens on the user's current selection.
    dateFilter: (initial.addedFrom || initial.addedTo)
      ? { preset: 'custom', start: initial.addedFrom || '', end: initial.addedTo || '' }
      : EMPTY_DATE_FILTER,
    tags: initial.tags || [],
  });
  const hasDateFilter = draft.dateFilter && draft.dateFilter.preset !== 'all';
  const activeCount =
    draft.source.length +
    draft.gender.length +
    draft.tags.length +
    (hasDateFilter ? 1 : 0);
  const reset = () =>
    setDraft({ source: [], gender: [], dateFilter: EMPTY_DATE_FILTER, tags: [] });
  const apply = () => {
    const [addedFrom, addedTo] = resolveDateRangeYmd(draft.dateFilter);
    onApply({
      source: draft.source,
      gender: draft.gender,
      addedFrom: addedFrom || "",
      addedTo: addedTo || "",
      tags: draft.tags,
    });
    onClose();
  };
  return (
    <ModalShell
      title="Filter customers"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span style={{ marginRight: "auto", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
            {activeCount} filter{activeCount === 1 ? "" : "s"} active
          </span>
          <button
            type="button"
            onClick={reset}
            disabled={activeCount === 0}
            style={{
              background: "transparent",
              border: "none",
              color: activeCount === 0
                ? "var(--text-tertiary, var(--text-secondary))"
                : "var(--primary-color, var(--accent-color))",
              cursor: activeCount === 0 ? "default" : "pointer",
              fontSize: "0.85rem",
              fontWeight: 500,
              padding: "0.35rem 0.6rem",
              borderRadius: 6,
              opacity: activeCount === 0 ? 0.55 : 1,
            }}
          >
            Reset
          </button>
          <button type="button" onClick={onClose} style={iconBtnSmall}>Cancel</button>
          <button
            type="button"
            onClick={apply}
            style={{ ...primaryTealBtn, padding: "0.55rem 1.25rem" }}
          >
            Apply
          </button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "1.1rem" }}>
        <FilterFieldRow label="Source" icon={<Globe size={14} />}>
          <MultiSelectDropdown
            options={SOURCE_OPTIONS}
            selected={draft.source}
            onChange={(v) => setDraft({ ...draft, source: v })}
            placeholder="All sources"
          />
        </FilterFieldRow>
        <FilterFieldRow label="Gender" icon={<UserPlus size={14} />}>
          <MultiSelectDropdown
            options={GENDER_OPTIONS}
            selected={draft.gender}
            onChange={(v) => setDraft({ ...draft, gender: v })}
            placeholder="Any gender"
          />
        </FilterFieldRow>
        <FilterFieldRow label="Added date" icon={<CalendarIcon size={14} />}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
            <DateRangeFilter
              value={draft.dateFilter}
              onChange={(next) => setDraft({ ...draft, dateFilter: next })}
              label={null}
            />
          </div>
        </FilterFieldRow>
        <FilterFieldRow label="Tags" icon={<TagIcon size={14} />}>
          <MultiSelectDropdown
            options={allTags.map((t) => ({ value: String(t.id), label: t.name, color: tagColour(t) }))}
            selected={draft.tags}
            onChange={(v) => setDraft({ ...draft, tags: v })}
            placeholder="Any tag"
            searchable
            chipColours
          />
        </FilterFieldRow>
      </div>
    </ModalShell>
  );
}

function FilterFieldRow({ label, icon, children }) {
  return (
    <div>
      <div style={{ ...filterLabelStyle, marginBottom: "0.45rem", display: "inline-flex", alignItems: "center", gap: "0.4rem" }}>
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
