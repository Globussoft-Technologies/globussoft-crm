import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import GenericCalendarViews from "../components/GenericCalendarViews";

function eventOn(dayOffset, overrides = {}) {
  const start = new Date();
  start.setDate(start.getDate() + dayOffset);
  start.setHours(10, 0, 0, 0);
  const end = new Date(start);
  end.setHours(11, 0, 0, 0);
  return {
    id: `event-${dayOffset}`,
    title: `Client review ${dayOffset}`,
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    _provider: "google",
    location: "Meeting room",
    ...overrides,
  };
}

describe("GenericCalendarViews", () => {
  it("offers day, week, month, agenda, and list modes", () => {
    render(<GenericCalendarViews events={[]} />);

    const controls = screen.getByRole("group", { name: "Calendar view" });
    ["Day", "Week", "Month", "Agenda", "List"].forEach((label) => {
      expect(within(controls).getByRole("button", { name: label })).toBeInTheDocument();
    });
    expect(within(controls).getByRole("button", { name: "Agenda" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders synchronized events across every view", () => {
    const event = eventOn(0);
    render(<GenericCalendarViews events={[event]} />);

    expect(screen.getByTestId("generic-calendar-agenda")).toHaveTextContent(event.title);

    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(screen.getByTestId("generic-calendar-month")).toHaveTextContent(event.title);

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByTestId("generic-calendar-day")).toHaveTextContent(event.title);

    fireEvent.click(screen.getByRole("button", { name: "Week" }));
    expect(screen.getByTestId("generic-calendar-week")).toHaveTextContent(event.title);

    fireEvent.click(screen.getByRole("button", { name: "Agenda" }));
    expect(screen.getByTestId("generic-calendar-agenda")).toHaveTextContent(event.title);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    expect(screen.getByTestId("generic-calendar-list")).toHaveTextContent(event.title);
  });

  it("navigates date-based views and returns to today", () => {
    render(<GenericCalendarViews events={[eventOn(0)]} />);

    fireEvent.click(screen.getByRole("button", { name: "Day" }));
    expect(screen.getByTestId("generic-calendar-day")).toHaveTextContent("Client review 0");

    fireEvent.click(screen.getByRole("button", { name: "Next day" }));
    expect(screen.getByTestId("generic-calendar-day")).toHaveTextContent("No events");

    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(screen.getByTestId("generic-calendar-day")).toHaveTextContent("Client review 0");
  });

  it("opens the existing event-detail flow when an event is selected", () => {
    const onEventClick = vi.fn();
    const event = eventOn(0);
    render(<GenericCalendarViews events={[event]} onEventClick={onEventClick} />);

    fireEvent.click(screen.getByRole("button", { name: new RegExp(event.title) }));
    expect(onEventClick).toHaveBeenCalledWith(expect.objectContaining({ id: event.id }));
  });

  it("ignores malformed event dates and shows the empty state", () => {
    render(<GenericCalendarViews events={[{ id: "bad", title: "Broken", startTime: "not-a-date" }]} />);

    expect(screen.getByText(/No events synced yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Broken")).not.toBeInTheDocument();
  });
});
