import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar, X } from "lucide-react";

const pad = (value) => String(value).padStart(2, "0");

const formatDateInput = (date) =>
  date instanceof Date && !Number.isNaN(date.getTime())
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : "";

const parseDateInput = (value) => {
  if (!value) return null;
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
};

const dayLabel = (date) =>
  new Intl.DateTimeFormat("en-US", { day: "numeric" }).format(date);

const monthLabel = (date) =>
  new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(date);

const triggerDateLabel = (value) => {
  const date = parseDateInput(value);
  return date
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date)
    : "";
};

export default function CompactRangeCalendar({ from, to, onChange, popover = false }) {
  const initial = parseDateInput(from) || parseDateInput(to) || new Date();
  const [viewMonth, setViewMonth] = useState(
    new Date(initial.getFullYear(), initial.getMonth(), 1),
  );
  const [dragging, setDragging] = useState(false);
  const [open, setOpen] = useState(!popover);
  const dragAnchorRef = useRef(null);

  const start = parseDateInput(from);
  const end = parseDateInput(to);
  const startKey = start ? formatDateInput(start) : "";
  const endKey = end ? formatDateInput(end) : "";
  const selectedStart = useMemo(() => {
    if (start && end && start > end) return end;
    return start;
  }, [startKey, endKey]);
  const selectedEnd = useMemo(() => {
    if (start && end && start > end) return start;
    return end;
  }, [startKey, endKey]);

  useEffect(() => {
    if (start || end) {
      const focus = start || end;
      setViewMonth(new Date(focus.getFullYear(), focus.getMonth(), 1));
    }
  }, [startKey, endKey]);

  useEffect(() => {
    const stopDragging = () => setDragging(false);
    window.addEventListener("mouseup", stopDragging);
    window.addEventListener("blur", stopDragging);
    return () => {
      window.removeEventListener("mouseup", stopDragging);
      window.removeEventListener("blur", stopDragging);
    };
  }, []);

  const monthStart = new Date(viewMonth.getFullYear(), viewMonth.getMonth(), 1);
  const monthEnd = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
  const leadingDays = monthStart.getDay();
  const daysInMonth = monthEnd.getDate();
  const cells = [];

  for (let index = 0; index < leadingDays; index += 1) {
    const day = new Date(monthStart);
    day.setDate(day.getDate() - leadingDays + index);
    cells.push({ date: day, currentMonth: false });
  }
  for (let dayNumber = 1; dayNumber <= daysInMonth; dayNumber += 1) {
    cells.push({
      date: new Date(viewMonth.getFullYear(), viewMonth.getMonth(), dayNumber),
      currentMonth: true,
    });
  }
  while (cells.length % 7 !== 0) {
    const day = new Date(cells[cells.length - 1].date);
    day.setDate(day.getDate() + 1);
    cells.push({ date: day, currentMonth: false });
  }

  const commitDate = (date, forceSingleDay = false) => {
    const next = formatDateInput(date);
    if (forceSingleDay) return onChange({ from: next, to: next });
    if (!from || (from && to)) return onChange({ from: next, to: "" });
    const currentStart = parseDateInput(from);
    if (!currentStart) return onChange({ from: next, to: "" });
    if (date < currentStart) return onChange({ from: next, to: from });
    return onChange({ from, to: next });
  };

  const commitDragDate = (date) => {
    const anchor = dragAnchorRef.current || date;
    const anchorKey = formatDateInput(anchor);
    const currentKey = formatDateInput(date);
    if (currentKey < anchorKey) {
      onChange({ from: currentKey, to: anchorKey });
    } else {
      onChange({ from: anchorKey, to: currentKey });
    }
  };

  const reset = () => onChange({ from: "", to: "" });
  const hasRange = Boolean(selectedStart && selectedEnd);
  const selectedLabel = hasRange
    ? `${triggerDateLabel(formatDateInput(selectedStart))} - ${triggerDateLabel(formatDateInput(selectedEnd))}`
    : "Pick date / range";

  const inRange = (date) => {
    if (!selectedStart) return false;
    if (!selectedEnd) return formatDateInput(date) === formatDateInput(selectedStart);
    return date >= selectedStart && date <= selectedEnd;
  };

  return (
    <div
      style={{
        position: popover ? "relative" : "static",
        width: popover ? "fit-content" : "100%",
      }}
    >
      {popover && (
        <div style={{ position: "relative", width: 182 }}>
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-label="Pick date / range"
            aria-haspopup="dialog"
            aria-expanded={open}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              width: "100%",
              height: 46,
              padding: hasRange ? "0 34px 0 14px" : "0 14px",
              border: "1px solid var(--border-color, rgba(148,163,184,.22))",
              borderRadius: 10,
              background: "var(--input-bg, #101321)",
              color: "var(--text-primary)",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
              boxSizing: "border-box",
            }}
          >
            <Calendar size={15} aria-hidden />
            <span>{selectedLabel}</span>
          </button>
          {hasRange && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                reset();
              }}
              aria-label="Clear selected dates"
              title="Clear selected dates"
              style={{
                position: "absolute",
                top: "50%",
                right: 9,
                display: "grid",
                placeItems: "center",
                width: 20,
                height: 20,
                padding: 0,
                transform: "translateY(-50%)",
                border: 0,
                background: "transparent",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </div>
      )}

      {(!popover || open) && <div
        role={popover ? "dialog" : undefined}
        style={{
          width: popover ? 320 : "100%",
          maxWidth: 320,
          padding: 14,
          borderRadius: 16,
          border: "1px solid rgba(255,255,255,.1)",
          // Use the theme's solid modal surface so light and dark themes stay readable.
          background: "var(--modal-bg, var(--bg-color, #0b0d12))",
          boxShadow: "0 18px 40px rgba(0,0,0,.24)",
          ...(popover ? { position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 1000 } : {}),
        }}
      >
        {popover && (
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close calendar"
            title="Close calendar"
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              padding: 0,
              border: "1px solid rgba(255,255,255,.12)",
              borderRadius: 999,
              background: "rgba(255,255,255,.04)",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            <X size={14} aria-hidden />
          </button>
        )}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginBottom: 12,
          paddingRight: popover ? 34 : 0,
          flexWrap: "nowrap",
        }}
      >
        <button
          type="button"
          onClick={() =>
            setViewMonth(
              new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1),
            )
          }
          aria-label="Previous month"
          style={{
            width: 32,
            minWidth: 32,
            flex: "0 0 32px",
            height: 32,
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,.12)",
            background: "rgba(255,255,255,.03)",
            color: "var(--text-primary)",
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          {"<"}
        </button>
        <strong
          style={{
            color: "var(--text-primary)",
            fontSize: 15,
            whiteSpace: "nowrap",
            textAlign: "center",
          }}
        >
          {monthLabel(viewMonth)}
        </strong>
        <button
          type="button"
          onClick={() =>
            setViewMonth(
              new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1),
            )
          }
          aria-label="Next month"
          style={{
            width: 32,
            minWidth: 32,
            flex: "0 0 32px",
            height: 32,
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,.12)",
            background: "rgba(255,255,255,.03)",
            color: "var(--text-primary)",
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          {">"}
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 4,
          marginBottom: 8,
          textAlign: "center",
          color: "var(--text-secondary)",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        {["S", "M", "T", "W", "T", "F", "S"].map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, minmax(0, 1fr))",
          gap: 4,
        }}
      >
        {cells.map(({ date, currentMonth }) => {
          const key = formatDateInput(date);
          const selected = key === startKey || key === endKey;
          const range = inRange(date);
          const isToday = key === formatDateInput(new Date());

          return (
            <button
              key={date.toISOString()}
              type="button"
              onMouseDown={(event) => {
                if (!event.ctrlKey && !event.metaKey) return;
                event.preventDefault();
                dragAnchorRef.current = date;
                setDragging(true);
                commitDragDate(date);
              }}
              onMouseEnter={() => {
                if (!dragging) return;
                commitDragDate(date);
              }}
              onMouseUp={() => {
                if (!dragging) return;
                commitDragDate(date);
                setDragging(false);
              }}
              onClick={(event) => {
                if (dragging || event.ctrlKey || event.metaKey) return;
                commitDate(date);
              }}
              onDoubleClick={() => commitDate(date, true)}
              style={{
                border: 0,
                minHeight: 31,
                borderRadius: 999,
                background: selected
                  ? "#5b7cfa"
                  : range
                    ? "rgba(91,124,250,.18)"
                    : "transparent",
                color: currentMonth
                  ? selected
                    ? "#fff"
                    : "var(--text-primary)"
                  : "rgba(148,163,184,.4)",
                fontSize: 13,
                fontWeight: selected || isToday ? 800 : 600,
                boxShadow: selected ? "0 0 0 1px rgba(91,124,250,.18)" : "none",
                outline:
                  isToday && !selected
                    ? "1px solid rgba(91,124,250,.35)"
                    : "none",
                cursor: "pointer",
              }}
            >
              {dayLabel(date)}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: popover ? "grid" : "flex",
          gridTemplateColumns: popover ? "minmax(0, 1fr)" : undefined,
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          marginTop: 12,
          paddingTop: 12,
          borderTop: "1px solid rgba(255,255,255,.08)",
        }}
      >
          <p
          style={{
            margin: 0,
            width: "100%",
            maxWidth: popover ? "none" : 195,
            color: "var(--text-secondary)",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          Double-click a date to pick one day, or click two dates to select a range.
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            width: "100%",
            gap: 8,
          }}
        >
          <span
            style={{
              color: "var(--text-secondary)",
              fontSize: 12,
              whiteSpace: popover ? "normal" : "nowrap",
              overflowWrap: "anywhere",
            }}
          >
            {hasRange ? `${from || "Start"} to ${to || "End"}` : "No date selected"}
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={reset}
              style={{
                border: "1px solid rgba(255,255,255,.14)",
                borderRadius: 999,
                padding: "8px 12px",
                background: "transparent",
                color: "var(--text-primary)",
                fontWeight: 700,
              }}
            >
              Reset
            </button>
            {popover && hasRange && (
              <button
                type="button"
                onClick={() => setOpen(false)}
                style={{
                  border: 0,
                  borderRadius: 999,
                  padding: "8px 14px",
                  background: "var(--primary-color, #5b7cfa)",
                  color: "var(--accent-text, #fff)",
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                OK
              </button>
            )}
          </div>
        </div>
      </div>
      </div>}
    </div>
  );
}
