import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import CountBadge from "../components/CountBadge";

describe("<CountBadge />", () => {
  it("shows the compact total chip treatment when the title includes the count context", () => {
    render(<CountBadge count={5} title="5 trips" />);

    const badge = screen.getByTitle("5 Total Trips");
    expect(badge).toBeInTheDocument();
    expect(within(badge).getByText("5")).toBeInTheDocument();
    expect(within(badge).getByText("Total Trips")).toBeInTheDocument();
  });

  it("stays compact and numeric when no label is provided", () => {
    render(<CountBadge count={4} />);

    const badge = screen.getByTitle("4 total");
    expect(badge).toBeInTheDocument();
    expect(within(badge).getByText("4")).toBeInTheDocument();
    expect(badge).not.toHaveTextContent(/items|payables|deals/i);
  });
});
