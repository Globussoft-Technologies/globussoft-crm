import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

const VIEW_OPTIONS = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "agenda", label: "Agenda" },
  { key: "list", label: "List" },
];

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function startOfDay(value) {
  const date = safeDate(value) || new Date();
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(value, amount) {
  const date = startOfDay(value);
  date.setDate(date.getDate() + amount);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const mondayOffset = (date.getDay() + 6) % 7;
  return addDays(date, -mondayOffset);
}

function startOfMonth(value) {
  const date = startOfDay(value);
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function dateKey(value) {
  const date = safeDate(value);
  if (!date) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function rangeLabel(view, anchorDate) {
  const anchor = startOfDay(anchorDate);
  if (view === "day") {
    return anchor.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const from = startOfWeek(anchor);
    const to = addDays(from, 6);
    const fromLabel = from.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const toLabel = to.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${fromLabel} – ${toLabel}`;
  }
  if (view === "month") {
    return anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  return view === "agenda" ? "Upcoming agenda" : "All synchronized events";
}

function normalizeEvents(events) {
  return (Array.isArray(events) ? events : [])
    .map((event) => {
      const start = safeDate(event?.startTime || event?.start || event?.date);
      if (!start) return null;
      const end = safeDate(event?.endTime || event?.end) || start;
      return { ...event, _calendarStart: start, _calendarEnd: end };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const timeDifference = a._calendarStart - b._calendarStart;
      if (timeDifference !== 0) return timeDifference;
      return String(a.id || "").localeCompare(String(b.id || ""));
    });
}

function eventsForDay(events, day) {
  const from = startOfDay(day).getTime();
  const to = addDays(day, 1).getTime();
  return events.filter((event) => {
    const start = event._calendarStart.getTime();
    const end = Math.max(event._calendarEnd.getTime(), start + 1);
    return start < to && end > from;
  });
}

function formatTime(event) {
  if (event.allDay) return "All day";
  const start = event._calendarStart.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const end = event._calendarEnd;
  if (!end || end.getTime() === event._calendarStart.getTime()) return start;
  return `${start} – ${end.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function providerLabel(event) {
  if (event._provider === "google") return "Google Calendar";
  if (event._provider === "outlook") return "Microsoft Outlook";
  return "CRM";
}

function EventButton({ event, compact = false, onSelect }) {
  const eventButton = (
    <button
      type="button"
      className="generic-calendar-event"
      onClick={() => onSelect?.(event)}
      title={`${event.title || "Untitled event"} · ${formatTime(event)}`}
      style={{
        width: "100%",
        minWidth: 0,
        padding: compact ? "0.3rem 0.4rem" : "0.65rem 0.75rem",
        borderRadius: 8,
        border: "1px solid color-mix(in srgb, var(--accent-color) 28%, var(--border-color))",
        background: "color-mix(in srgb, var(--accent-color) 10%, var(--surface-color))",
        color: "var(--text-primary)",
        cursor: "pointer",
        textAlign: "left",
        overflow: "hidden",
      }}
    >
      <span
        style={{
          display: "block",
          fontSize: compact ? "0.72rem" : "0.86rem",
          fontWeight: 700,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {event.title || "Untitled event"}
      </span>
      {!compact && (
        <span style={{ display: "block", marginTop: 3, color: "var(--text-secondary)", fontSize: "0.75rem" }}>
          {formatTime(event)} · {providerLabel(event)}
          {event.attendees ? ` · ${attendeeCount(event.attendees)} attendees` : ""}
        </span>
      )}
    </button>
  );

  if (compact) return eventButton;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "0.5rem", alignItems: "center" }}>
      {eventButton}
      {event.meetingUrl && (
        <a
          href={event.meetingUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Join ${event.title || "calendar event"}`}
          style={{ padding: "0.55rem 0.7rem", borderRadius: 8, background: "color-mix(in srgb, var(--accent-color) 12%, transparent)", color: "var(--accent-color)", textDecoration: "none", fontSize: "0.78rem", fontWeight: 700 }}
        >
          Join
        </a>
      )}
    </div>
  );
}

function attendeeCount(value) {
  if (!value) return 0;
  try {
    const attendees = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(attendees) ? attendees.length : 0;
  } catch {
    return 0;
  }
}

function EmptyDay() {
  return <div style={{ padding: "1rem", color: "var(--text-secondary)", fontSize: "0.85rem" }}>No events</div>;
}

export default function GenericCalendarViews({ events, onEventClick }) {
  const [view, setView] = useState("agenda");
  const [anchorDate, setAnchorDate] = useState(() => startOfDay(new Date()));
  const normalizedEvents = useMemo(() => normalizeEvents(events), [events]);
  const renderedEvents = useMemo(() => normalizedEvents.slice(0, 50), [normalizedEvents]);

  const move = (direction) => {
    setAnchorDate((current) => {
      if (view === "day") return addDays(current, direction);
      if (view === "week") return addDays(current, direction * 7);
      const next = startOfDay(current);
      next.setMonth(next.getMonth() + direction, 1);
      return next;
    });
  };

  const renderDay = () => {
    const rows = eventsForDay(renderedEvents, anchorDate);
    return (
      <div data-testid="generic-calendar-day" style={{ display: "grid", gap: "0.5rem" }}>
        {rows.length ? rows.map((event) => (
          <EventButton key={`${event._provider || "crm"}-${event.id}`} event={event} onSelect={onEventClick} />
        )) : <EmptyDay />}
      </div>
    );
  };

  const renderWeek = () => {
    const firstDay = startOfWeek(anchorDate);
    return (
      <div data-testid="generic-calendar-week" style={{ overflowX: "auto" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(145px, 1fr))", minWidth: 1015, gap: 1, background: "var(--border-color)", border: "1px solid var(--border-color)", borderRadius: 12, overflow: "hidden" }}>
          {Array.from({ length: 7 }, (_, index) => addDays(firstDay, index)).map((day) => {
            const dayEvents = eventsForDay(renderedEvents, day);
            const isToday = dateKey(day) === dateKey(new Date());
            return (
              <section key={dateKey(day)} style={{ minHeight: 220, padding: "0.65rem", background: "var(--surface-color)" }}>
                <div style={{ marginBottom: "0.65rem", color: isToday ? "var(--accent-color)" : "var(--text-secondary)", fontSize: "0.78rem", fontWeight: isToday ? 800 : 600 }}>
                  {day.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
                </div>
                <div style={{ display: "grid", gap: "0.4rem" }}>
                  {dayEvents.map((event) => (
                    <EventButton key={`${event._provider || "crm"}-${event.id}`} event={event} compact onSelect={onEventClick} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    );
  };

  const renderMonth = () => {
    const monthStart = startOfMonth(anchorDate);
    const gridStart = startOfWeek(monthStart);
    const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));
    return (
      <div data-testid="generic-calendar-month" style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 840 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 6 }}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
              <div key={label} style={{ padding: "0.4rem", textAlign: "center", color: "var(--text-secondary)", fontSize: "0.75rem", fontWeight: 700 }}>{label}</div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(120px, 1fr))", gap: 1, background: "var(--border-color)", border: "1px solid var(--border-color)", borderRadius: 12, overflow: "hidden" }}>
            {days.map((day) => {
              const dayEvents = eventsForDay(renderedEvents, day);
              const inMonth = day.getMonth() === monthStart.getMonth();
              const isToday = dateKey(day) === dateKey(new Date());
              return (
                <section key={dateKey(day)} style={{ minHeight: 112, padding: "0.45rem", background: "var(--surface-color)", opacity: inMonth ? 1 : 0.52 }}>
                  <div style={{ width: 25, height: 25, display: "grid", placeItems: "center", marginBottom: 4, borderRadius: 999, background: isToday ? "var(--accent-color)" : "transparent", color: isToday ? "#fff" : "var(--text-secondary)", fontSize: "0.75rem", fontWeight: 700 }}>
                    {day.getDate()}
                  </div>
                  <div style={{ display: "grid", gap: 3 }}>
                    {dayEvents.slice(0, 3).map((event) => (
                      <EventButton key={`${event._provider || "crm"}-${event.id}`} event={event} compact onSelect={onEventClick} />
                    ))}
                    {dayEvents.length > 3 && <span style={{ fontSize: "0.7rem", color: "var(--text-secondary)" }}>+{dayEvents.length - 3} more</span>}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  const renderAgenda = () => {
    const today = startOfDay(new Date());
    const upcoming = renderedEvents.filter((event) => event._calendarEnd >= today);
    const groups = upcoming.reduce((result, event) => {
      const key = dateKey(event._calendarStart);
      if (!result.has(key)) result.set(key, []);
      result.get(key).push(event);
      return result;
    }, new Map());
    return (
      <div data-testid="generic-calendar-agenda" style={{ display: "grid", gap: "1rem" }}>
        {groups.size === 0 ? <EmptyDay /> : [...groups.entries()].map(([key, rows]) => (
          <section key={key} style={{ display: "grid", gridTemplateColumns: "minmax(120px, 170px) 1fr", gap: "1rem", alignItems: "start" }}>
            <div style={{ color: "var(--text-secondary)", fontSize: "0.82rem", fontWeight: 700 }}>
              {rows[0]._calendarStart.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
            </div>
            <div style={{ display: "grid", gap: "0.45rem" }}>
              {rows.map((event) => <EventButton key={`${event._provider || "crm"}-${event.id}`} event={event} onSelect={onEventClick} />)}
            </div>
          </section>
        ))}
      </div>
    );
  };

  const renderList = () => (
    <div data-testid="generic-calendar-list" style={{ overflowX: "auto" }}>
      {renderedEvents.length === 0 ? <EmptyDay /> : (
        <table style={{ width: "100%", minWidth: 680, borderCollapse: "collapse" }}>
          <thead><tr>
            {["Event", "Date", "Time", "Provider", "Location"].map((label) => <th key={label} style={{ padding: "0.7rem", borderBottom: "1px solid var(--border-color)", color: "var(--text-secondary)", textAlign: "left", fontSize: "0.75rem" }}>{label}</th>)}
          </tr></thead>
          <tbody>{renderedEvents.map((event) => (
            <tr key={`${event._provider || "crm"}-${event.id}`} onClick={() => onEventClick?.(event)} style={{ cursor: "pointer" }}>
              <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)", fontWeight: 700 }}>{event.title || "Untitled event"}</td>
              <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{event._calendarStart.toLocaleDateString()}</td>
              <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{formatTime(event)}</td>
              <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{providerLabel(event)}</td>
              <td style={{ padding: "0.75rem", borderBottom: "1px solid var(--border-color)" }}>{event.location || "—"}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );

  const viewBody = {
    day: renderDay,
    week: renderWeek,
    month: renderMonth,
    agenda: renderAgenda,
    list: renderList,
  }[view];

  return (
    <section aria-label="CRM event calendar">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <div role="group" aria-label="Calendar view" style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {VIEW_OPTIONS.map((option) => (
            <button key={option.key} type="button" aria-pressed={view === option.key} onClick={() => setView(option.key)} style={{ padding: "0.5rem 0.75rem", borderRadius: 8, border: "1px solid var(--border-color)", background: view === option.key ? "var(--accent-color)" : "var(--surface-color)", color: view === option.key ? "#fff" : "var(--text-primary)", cursor: "pointer", fontWeight: 700 }}>
              {option.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          {(view === "day" || view === "week" || view === "month") && (
            <>
              <button type="button" onClick={() => move(-1)} aria-label={`Previous ${view}`} style={navButtonStyle}><ChevronLeft size={16} /></button>
              <button type="button" onClick={() => setAnchorDate(startOfDay(new Date()))} style={navButtonStyle}>Today</button>
              <button type="button" onClick={() => move(1)} aria-label={`Next ${view}`} style={navButtonStyle}><ChevronRight size={16} /></button>
            </>
          )}
        </div>
      </div>
      <div style={{ marginBottom: "1rem", fontWeight: 800, fontSize: "1rem" }}>{rangeLabel(view, anchorDate)}</div>
      {normalizedEvents.length === 0 ? (
        <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-secondary)" }}>
          No events synced yet. Connect a calendar above and click &quot;Sync Now&quot;.
        </div>
      ) : viewBody()}
    </section>
  );
}

const navButtonStyle = {
  minHeight: 36,
  padding: "0.45rem 0.65rem",
  borderRadius: 8,
  border: "1px solid var(--border-color)",
  background: "var(--surface-color)",
  color: "var(--text-primary)",
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 700,
};
