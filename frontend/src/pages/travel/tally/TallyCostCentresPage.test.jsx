import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyCostCentresPage from "./TallyCostCentresPage";
import { fetchApi } from "../../../utils/api";

vi.mock("react-router-dom", () => ({
  useLocation: () => ({ pathname: "/travel/tally/cost-centres" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../../components/PermissionGate", () => ({ default: ({ children }) => children }));
vi.mock("../../../utils/api", () => ({ fetchApi: vi.fn() }));

const pageResponse = ({ sourcePage = 1, hasMore = false } = {}) => ({
  costCentres: [{ id: 1, code: "TRIP-1", name: "TRIP-1 - Goa", sourceType: "ITINERARY", sourceId: 1, status: "ACTIVE", syncStatus: "NOT_CONNECTED", itinerary: { destination: "Goa" } }],
  sources: [{ sourceType: "ITINERARY", sourceId: sourcePage, code: `TRIP-${sourcePage}`, label: sourcePage === 1 ? "Goa" : "Kerala" }],
  pagination: { page: 1, limit: 50, hasMore: false },
  sourcePagination: { page: sourcePage, limit: 100, hasMore },
});

describe("TallyCostCentresPage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads later source pages without replacing earlier options", async () => {
    fetchApi.mockImplementation(async (url) => url.includes("sourcePage=2")
      ? pageResponse({ sourcePage: 2 })
      : pageResponse({ sourcePage: 1, hasMore: true }));

    render(<TallyCostCentresPage />);
    await screen.findByRole("option", { name: "TRIP-1 - Goa" });
    fireEvent.click(screen.getByRole("button", { name: "Load more trips / quotes" }));

    await screen.findByRole("option", { name: "TRIP-2 - Kerala" });
    expect(screen.getByRole("option", { name: "TRIP-1 - Goa" })).toBeInTheDocument();
    expect(fetchApi).toHaveBeenCalledWith(expect.stringContaining("sourcePage=2"));
  });

  it("prepares missing rows through bounded batches for every Travel source type", async () => {
    fetchApi.mockImplementation(async (url, options) => {
      if (url.endsWith("/prepare-missing")) {
        const body = JSON.parse(options.body);
        return { sourceType: body.sourceType, created: 1, processed: 1, nextAfterSourceId: 1, done: true };
      }
      return pageResponse();
    });

    render(<TallyCostCentresPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Prepare Missing" }));

    await screen.findByText("3 cost centre(s) prepared.");
    const batchCalls = fetchApi.mock.calls.filter(([url]) => url.endsWith("/prepare-missing"));
    expect(batchCalls).toHaveLength(3);
    expect(batchCalls.map(([, options]) => JSON.parse(options.body).sourceType)).toEqual(["ITINERARY", "TMC_TRIP", "QUOTE"]);
    expect(batchCalls.every(([, options]) => JSON.parse(options.body).limit === 100)).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Prepare Missing" })).toBeEnabled());
  });
});
