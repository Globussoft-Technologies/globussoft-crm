import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import TallyExportPreviewPage from "./TallyExportPreviewPage";
import { fetchApi } from "../../../utils/api";

const { navigate, routeParams, searchParamsState, setSearchParams, success } = vi.hoisted(() => ({
  navigate: vi.fn(),
  routeParams: { current: { tripId: "1" } },
  searchParamsState: { current: new URLSearchParams() },
  setSearchParams: vi.fn((next) => { searchParamsState.current = new URLSearchParams(next); }),
  success: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => navigate,
  useParams: () => routeParams.current,
  useLocation: () => ({ pathname: routeParams.current.tripId ? `/travel/tally/export/${routeParams.current.tripId}` : "/travel/tally/export" }),
  useSearchParams: () => [searchParamsState.current, setSearchParams],
}));
vi.mock("../../../components/PermissionGate", () => ({ default: ({ children }) => children }));
vi.mock("../../../utils/notify", () => ({ useNotify: () => ({ success, error: vi.fn() }) }));
vi.mock("../../../utils/api", () => ({ fetchApi: vi.fn() }));
vi.mock("./useTravelTallyMaster", () => ({
  useTravelTallyMaster: () => ({
    master: { companyName: "Travel Test Co", subBrand: "all", from: "2026-09-01", to: "2026-09-30" },
  }),
}));
vi.mock("./tallyMath", () => ({
  rowMatchesTrip: (row, tripId) => String(row.itineraryId) === String(tripId)
    || String(row.tripId) === String(tripId).replace(/^tmc-/, "")
    || String(row.quoteId) === String(tripId).replace(/^quote-/, ""),
  getTripLedgerRows: ({ trips }) => trips.map((trip) => ({
    id: trip.id,
    label: trip.destination || `Trip #${trip.id}`,
    status: trip.status || "Open",
    sales: 1000,
    unpaidSales: 0,
    purchase: 600,
    gst: 0,
    tcs: 0,
    profit: 400,
    accrualProfit: 400,
  })),
}));
vi.mock("./tallyExportBuilder", () => ({
  buildVoucherRows: () => [
    ["Date", "Voucher Type", "Ledger", "Counter Ledger", "Trip", "Voucher Number", "Debit", "Credit", "Narration", "Source", "Bill Reference"],
    ["2026-09-01", "Sales", "Sales", "Customer", "Goa", "INV-1", 1000, "", "Trip sale", "customer", "INV-1"],
  ],
  buildTallyMastersXml: () => "<ENVELOPE><MASTERS /></ENVELOPE>",
  buildTallyXml: ({ educationalMode }) => `<ENVELOPE><VOUCHERS educational="${Boolean(educationalMode)}" /></ENVELOPE>`,
}));

function apiResponse(url) {
  if (url.includes("/itineraries")) return { itineraries: [{ id: 1, destination: "Goa", status: "Open", startDate: "2026-09-01" }] };
  if (url.includes("/trips")) return { trips: [] };
  if (url.includes("/ledger")) return { customerDetails: [], payableDetails: [] };
  return {};
}

describe("TallyExportPreviewPage connector and fallback exports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routeParams.current = { tripId: "1" };
    searchParamsState.current = new URLSearchParams();
    window.localStorage.clear();
    URL.createObjectURL = vi.fn(() => "blob:tally-export");
    URL.revokeObjectURL = vi.fn();
  });

  it("downloads Masters and Voucher XML when push is attempted while the connector is offline", async () => {
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: false };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);

    await screen.findByRole("button", { name: /Push directly to Tally/i });
    expect(screen.queryByRole("button", { name: /Download Masters XML/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download Voucher XML/i })).not.toBeInTheDocument();
    const push = screen.getByRole("button", { name: /Push directly to Tally/i });
    expect(push).toBeEnabled();

    fireEvent.click(push);

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(2));
    expect(fetchApi).not.toHaveBeenCalledWith(
      "/api/travel/tally/connector/push",
      expect.anything(),
    );
    expect(screen.getByRole("alertdialog", { name: /Connector offline/i })).toHaveTextContent(
      "downloaded for manual import into Tally",
    );
  });

  it("refreshes connector status without navigating away", async () => {
    routeParams.current = {};
    let statusRequests = 0;
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) {
        statusRequests += 1;
        return statusRequests === 1
          ? { configured: true, online: false }
          : { configured: true, online: true, machineId: "office-pc-1" };
      }
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    await screen.findByText("Configured, but currently offline");
    fireEvent.click(screen.getByRole("button", { name: /Refresh status/i }));

    await screen.findByText("Online on office-pc-1");
    expect(statusRequests).toBe(2);
    expect(navigate).not.toHaveBeenCalledWith("/travel/tally/export");
  });

  it("uses browser history for the Back button", async () => {
    routeParams.current = {};
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));

    expect(navigate).toHaveBeenCalledWith(-1);
    expect(navigate).not.toHaveBeenCalledWith("/travel/tally");
  });

  it("opens Sync History from the All Trips page", async () => {
    routeParams.current = {};
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Sync history" }));

    expect(navigate).toHaveBeenCalledWith("/travel/tally/sync-history");
  });

  it("filters the All Trips records by sub-brand", async () => {
    routeParams.current = {};
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.includes("/itineraries")) {
        return url.includes("subBrand=rfu")
          ? { itineraries: [{ id: 2, destination: "RFU Pilgrimage", status: "completed", subBrand: "rfu" }] }
          : { itineraries: [
              { id: 1, destination: "TMC Corporate Trip", status: "completed", subBrand: "tmc" },
              { id: 2, destination: "RFU Pilgrimage", status: "completed", subBrand: "rfu" },
            ] };
      }
      if (url.includes("/trips")) return { trips: [] };
      if (url.includes("/ledger")) return { customerDetails: [], payableDetails: [] };
      return {};
    });

    render(<TallyExportPreviewPage />);
    await screen.findByText("TMC Corporate Trip");

    fireEvent.change(screen.getByLabelText("Sub-brand"), { target: { value: "rfu" } });

    await screen.findByText("RFU Pilgrimage");
    await waitFor(() => expect(screen.queryByText("TMC Corporate Trip")).not.toBeInTheDocument());
    expect(fetchApi).toHaveBeenCalledWith(expect.stringContaining("subBrand=rfu"));
    expect(fetchApi).toHaveBeenCalledWith("/api/travel/tally/ledger?subBrand=rfu");
  });

  it("marks a synced trip when vouchers were added after its last successful push", async () => {
    routeParams.current = {};
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.includes("/itineraries")) return { itineraries: [{ id: 1, destination: "Goa", status: "completed" }] };
      if (url.includes("/trips")) return { trips: [] };
      if (url.includes("/ledger")) return {
        customerDetails: [{ id: 11, itineraryId: 1, amount: 0, transactionDate: "2026-09-16T10:00:00.000Z" }],
        paymentDetails: [],
        payableDetails: [],
      };
      if (url.includes("/cost-centres")) return {
        costCentres: [{ sourceType: "ITINERARY", sourceId: 1, syncStatus: "SYNCED", lastVoucherSyncAt: "2026-09-15T10:00:00.000Z" }],
      };
      return {};
    });

    render(<TallyExportPreviewPage />);

    expect((await screen.findAllByText("New vouchers pending")).length).toBeGreaterThan(1);
    expect(screen.getByText("1 new voucher(s) to push")).toBeInTheDocument();
  });

  it("shows Failed when the cost centre synced but the latest voucher import failed", async () => {
    routeParams.current = {};
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.includes("/itineraries")) return { itineraries: [{ id: 1, destination: "Goa", status: "completed" }] };
      if (url.includes("/trips")) return { trips: [] };
      if (url.includes("/ledger")) return { customerDetails: [], paymentDetails: [], payableDetails: [] };
      if (url.includes("/cost-centres")) return {
        costCentres: [{ sourceType: "ITINERARY", sourceId: 1, syncStatus: "SYNCED", voucherSyncStatus: "FAILED" }],
      };
      return {};
    });

    render(<TallyExportPreviewPage />);

    expect((await screen.findAllByText("Failed")).length).toBeGreaterThan(1);
  });

  it("restores the sub-brand from the URL and keeps it in the preview link", async () => {
    routeParams.current = {};
    searchParamsState.current = new URLSearchParams("subBrand=travelstall");
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.includes("/itineraries")) return { itineraries: [{ id: 10, destination: "Kerala", status: "completed", subBrand: "travelstall" }] };
      if (url.includes("/trips")) return { trips: [] };
      if (url.includes("/ledger")) return { customerDetails: [], payableDetails: [] };
      return {};
    });

    render(<TallyExportPreviewPage />);

    expect(await screen.findByLabelText("Sub-brand")).toHaveValue("travelstall");
    fireEvent.click(await screen.findByRole("button", { name: "Preview Kerala" }));
    expect(navigate).toHaveBeenCalledWith("/travel/tally/export/10?subBrand=travelstall");
  });

  it("does not let a stale browser flag block a changed trip from being pushed", async () => {
    window.localStorage.setItem("travel-tally-pushed:1:normal", "true");
    fetchApi.mockImplementation(async (url) => {
      if (url.endsWith("/connector/status")) return { configured: true, online: true };
      if (url.endsWith("/connector/push")) return { success: true, results: [{ stage: "vouchers", tally: { created: 1, altered: 0 } }] };
      return apiResponse(url);
    });

    render(<TallyExportPreviewPage />);
    const push = await screen.findByRole("button", { name: /Push directly to Tally/i });
    await waitFor(() => expect(push).toBeEnabled());
    fireEvent.click(push);

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(
      "/api/travel/tally/connector/push",
      expect.objectContaining({ method: "POST" }),
    ));
    expect(success).toHaveBeenCalledWith(expect.stringContaining("Trip pushed to Tally"));
  });
});
