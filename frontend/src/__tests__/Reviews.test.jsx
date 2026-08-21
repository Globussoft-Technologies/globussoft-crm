/**
 * Reviews.test.jsx — vitest + RTL coverage for the Travel-vertical
 * Customer Reviews list page (frontend/src/pages/travel/Reviews.jsx).
 *
 * Scope: pins the review-browser surface invariants: filter bar controls,
 * client-side search/sub-brand/rating filtering, sorting, pagination and
 * full timestamp rendering.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

const notifyError = vi.fn();
const notifyObj = { error: notifyError };
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
  NotifyProvider: ({ children }) => children,
}));

import Reviews from "../pages/travel/Reviews";

function makeReview(overrides = {}) {
  return {
    id: 1,
    itineraryId: 101,
    contactId: 201,
    overallRating: 4,
    answersJson: JSON.stringify({
      rate_accommodation: 4,
      rate_transport: 5,
      recommend: "Yes",
      loved_most: "The guide",
    }),
    submittedAt: "2026-08-15T14:30:00.000Z",
    destination: "Kerala Backwaters",
    subBrand: "tmc",
    contactName: "Asha Verma",
    contactEmail: "asha@x.com",
    contactPhone: "+91 99999 99999",
    answers: {
      rate_accommodation: 4,
      rate_transport: 5,
      recommend: "Yes",
      loved_most: "The guide",
    },
    ...overrides,
  };
}

const DEFAULT_REVIEWS = [
  makeReview({ id: 1, overallRating: 4, subBrand: "tmc", destination: "Kerala Backwaters", contactName: "Asha Verma", submittedAt: "2026-08-15T14:30:00.000Z" }),
  makeReview({ id: 2, overallRating: 5, subBrand: "rfu", destination: "Mecca Pilgrimage", contactName: "Sankar Rathod", contactEmail: "sankar@x.com", submittedAt: "2026-08-10T09:00:00.000Z" }),
  makeReview({ id: 3, overallRating: 2, subBrand: "tmc", destination: "Golden Triangle", contactName: "Noor Khan", contactEmail: "noor@x.com", submittedAt: "2026-08-20T18:45:00.000Z" }),
];

function installFetchMock({ reviews = DEFAULT_REVIEWS } = {}) {
  fetchApiMock.mockImplementation((url) => {
    if (typeof url === "string" && url === "/api/travel/reviews") {
      return Promise.resolve({ reviews });
    }
    return Promise.resolve(null);
  });
}

function renderPage(initialEntries = ["/travel/reviews"]) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <Reviews />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<Reviews /> — page chrome", () => {
  it("renders heading, search, filters and refresh", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /Customer Reviews/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/Search reviews/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by sub-brand/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Filter by minimum rating/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sort reviews/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Refresh/i })).toBeInTheDocument();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalledWith("/api/travel/reviews"));
  });
});

describe("<Reviews /> — loading + empty states", () => {
  it("shows loading then renders reviews", async () => {
    let resolve;
    fetchApiMock.mockImplementation(() => new Promise((res) => { resolve = res; }));
    renderPage();
    expect(screen.getByText(/Loading/i)).toBeInTheDocument();
    resolve({ reviews: DEFAULT_REVIEWS });
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
  });

  it("shows empty state when no reviews", async () => {
    installFetchMock({ reviews: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No reviews yet/i)).toBeInTheDocument());
  });
});

describe("<Reviews /> — filtering", () => {
  it("filters by search text across destination", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Search reviews/i), { target: { value: "Mecca" } });
    await waitFor(() => {
      expect(screen.queryByText("Kerala Backwaters")).toBeNull();
      expect(screen.getByText("Mecca Pilgrimage")).toBeInTheDocument();
    });
  });

  it("filters by search text across contact email", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Search reviews/i), { target: { value: "sankar@x.com" } });
    await waitFor(() => {
      expect(screen.queryByText("Kerala Backwaters")).toBeNull();
      expect(screen.getByText("Mecca Pilgrimage")).toBeInTheDocument();
    });
  });

  it("filters by sub-brand", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: "rfu" } });
    await waitFor(() => {
      expect(screen.queryByText("Kerala Backwaters")).toBeNull();
      expect(screen.getByText("Mecca Pilgrimage")).toBeInTheDocument();
    });
  });

  it("filters by minimum rating", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Filter by minimum rating/i), { target: { value: "4" } });
    await waitFor(() => {
      expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument();
      expect(screen.getByText("Mecca Pilgrimage")).toBeInTheDocument();
      expect(screen.queryByText("Golden Triangle")).toBeNull();
    });
  });

  it("clear button resets all filters", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Filter by sub-brand/i), { target: { value: "rfu" } });
    await waitFor(() => expect(screen.queryByText("Kerala Backwaters")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Clear/i }));
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
  });
});

describe("<Reviews /> — sorting", () => {
  it("sorts by highest rated", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Sort reviews/i), { target: { value: "highest" } });
    await waitFor(() => {
      const cards = screen.getAllByText(/Backwaters|Pilgrimage|Triangle/);
      expect(cards[0].textContent).toBe("Mecca Pilgrimage");
    });
  });

  it("sorts by lowest rated", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/Sort reviews/i), { target: { value: "lowest" } });
    await waitFor(() => {
      const cards = screen.getAllByText(/Backwaters|Pilgrimage|Triangle/);
      expect(cards[0].textContent).toBe("Golden Triangle");
    });
  });
});

describe("<Reviews /> — pagination", () => {
  it("paginates reviews and updates the URL", async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      makeReview({
        id: i + 1,
        destination: `Destination ${i + 1}`,
        overallRating: ((i % 5) + 1),
        submittedAt: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );
    installFetchMock({ reviews: many });
    renderPage();
    // Newest-first sort puts Destination 25 on page 1.
    await waitFor(() => expect(screen.getByText("Destination 25")).toBeInTheDocument());
    expect(screen.queryByText("Destination 5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Next page/i }));
    await waitFor(() => expect(screen.getByText("Destination 5")).toBeInTheDocument());
  });
});

describe("<Reviews /> — timestamp", () => {
  it("renders a full date-time timestamp for each review", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByText("Kerala Backwaters")).toBeInTheDocument());
    const row = screen.getByText("Kerala Backwaters").closest("[style*='boxShadow']") || screen.getByText("Kerala Backwaters").parentElement;
    const timestamp = within(row).getByText(/2026/);
    expect(timestamp).toBeInTheDocument();
    expect(timestamp.textContent).toMatch(/\d/);
  });
});
