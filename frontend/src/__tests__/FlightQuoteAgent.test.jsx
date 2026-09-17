/**
 * FlightQuoteAgent.test.jsx - vitest + RTL coverage for the Travel-vertical
 * flight quick-quote page.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const fetchApiMock = vi.fn();
vi.mock("../utils/api", () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => "test-token",
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock("../utils/notify", () => ({
  useNotify: () => notifyObj,
}));

const flightOfferPdfBlob = new Blob(["pdf"], { type: "application/pdf" });
const buildFlightOfferPdfBlobMock = vi.fn(() => Promise.resolve(flightOfferPdfBlob));
vi.mock("../pages/travel/flightOfferPdf", () => ({
  buildFlightOfferPdfBlob: (...args) => buildFlightOfferPdfBlobMock(...args),
  FLIGHT_OFFER_PDF_WIDTH: 595,
  FLIGHT_OFFER_PDF_HEIGHT: 842,
}));

import { AuthContext } from "../App";
import FlightQuoteAgent from "../pages/travel/FlightQuoteAgent";

const ADMIN_USER = { userId: 7, name: "Admin", email: "a@x.com", role: "ADMIN" };
const CONTACTS = [
  { id: 31, name: "Asha Verma", phone: "+919876543210" },
  { id: 32, name: "Bilal Khan", phone: "+918765432109" },
];
const RULES = [
  { id: 5, subBrand: "tmc", scope: "flight", markupPct: 10, markupFlat: null, priority: 100, isActive: true, ownerUserId: null },
];
const QUOTE_RESULT = {
  itineraryId: 12,
  items: [{ itineraryItemId: 901, totalWithMarkup: 1100, currency: "INR" }],
  totalWithMarkup: 1100,
  currency: "INR",
  pdfUrl: "/api/travel/itineraries/12/pdf",
};
const EXTRACT_RESULT = {
  provider: "openai",
  model: "gpt-4o",
  stub: false,
  currency: "INR",
  tripType: "domestic",
  routeLabel: "Mumbai to Delhi",
  rows: [{ label: "Air India", basePrice: 12345, currency: "INR" }],
};

function ymdOffset(days = 0) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function installFetchMock({ quote = QUOTE_RESULT } = {}) {
  fetchApiMock.mockImplementation((url, opts) => {
    const method = opts?.method || "GET";
    if (url === "/api/contacts?status=Customer" && method === "GET") {
      return Promise.resolve(CONTACTS);
    }
    if (url.startsWith("/api/travel/markup-rules?") && method === "GET") {
      return Promise.resolve({ rules: RULES });
    }
    if (url === "/api/v1/flight-plugin/extract-prices" && method === "POST") {
      return Promise.resolve(EXTRACT_RESULT);
    }

    if (url === "/api/v1/flight-plugin/agent-quotes" && method === "POST") {
      if (quote instanceof Error) return Promise.reject(quote);
      return Promise.resolve(quote);
    }
    return Promise.resolve(null);
  });
}

function renderPage(user = ADMIN_USER) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, token: "tk", tenant: { id: 1, vertical: "travel" }, loading: false }}>
        <FlightQuoteAgent />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function uploadScreenshot() {
  const input = screen.getByLabelText(/Upload screenshots/i);
  const file = new File(["fake image bytes"], "screenshot-1.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

function continueToPricing() {
  fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyError.mockReset();
  notifySuccess.mockReset();
  notifyInfo.mockReset();
  notifyConfirm.mockReset();
  notifyConfirm.mockResolvedValue(true);
  buildFlightOfferPdfBlobMock.mockReset();
  buildFlightOfferPdfBlobMock.mockResolvedValue(flightOfferPdfBlob);
  if (typeof URL.revokeObjectURL === "function") {
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  } else {
    URL.revokeObjectURL = vi.fn();
  }
  window.localStorage.clear();
  installFetchMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<FlightQuoteAgent />", () => {
  it("renders the quick-quote workspace and generator wizard", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: /Flight quick-quote/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Search contacts")).toBeInTheDocument();
    expect(screen.getByLabelText("Upload screenshots")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Flight offer image generator/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Continue/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Select contact")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create quote/i })).toBeInTheDocument();
    await waitFor(() => expect(fetchApiMock).toHaveBeenCalled());
  });

  it("renders clean flight search hints without decorative symbols", () => {
    renderPage();
    expect(screen.getByPlaceholderText("From city or code")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("To city or code")).toBeInTheDocument();
    expect(screen.getByLabelText("Flight date")).toHaveAttribute("type", "date");
    expect(screen.getByLabelText("Departure 1")).toHaveAttribute("type", "datetime-local");
    expect(screen.getByLabelText("Arrival 1")).toHaveAttribute("type", "datetime-local");
    expect(screen.getByText("Option 1: enter a fare to preview")).toBeInTheDocument();

  });

  it("fetches contacts and markup rules on mount", async () => {
    renderPage();
    uploadScreenshot();
    continueToPricing();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map(([u]) => u);
      expect(urls).toContain("/api/contacts?status=Customer");
      expect(urls.some((u) => typeof u === "string" && u.startsWith("/api/travel/markup-rules?"))).toBe(true);
    });
    const contactSelect = screen.getByLabelText("Select contact");
    await waitFor(() => {
      expect(within(contactSelect).getByText(/Asha Verma/)).toBeInTheDocument();
      expect(within(contactSelect).getByText(/Bilal Khan/)).toBeInTheDocument();
    });
  });

  it("search button updates the inline summary without firing a toast", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Flight from"), { target: { value: "BLR" } });
    fireEvent.change(screen.getByLabelText("Flight to"), { target: { value: "DEL" } });
    fireEvent.change(screen.getByLabelText("Flight date"), { target: { value: ymdOffset(1) } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
    expect(screen.getByText(new RegExp(`Searching BLR -> DEL on ${ymdOffset(1)}`, "i"))).toBeInTheDocument();
    expect(notifyInfo).not.toHaveBeenCalled();
  });

  it("rejects a past flight date before search", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Flight from"), { target: { value: "BLR" } });
    fireEvent.change(screen.getByLabelText("Flight to"), { target: { value: "DEL" } });
    fireEvent.change(screen.getByLabelText("Flight date"), { target: { value: ymdOffset(-1) } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
    expect(notifyError).toHaveBeenCalledWith("Flight date must be today or later.");
  });

  it("rejects a round-trip end date that is not after the start date when creating a quote", async () => {
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Select contact")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Select contact"), { target: { value: "31" } });
    fireEvent.click(screen.getByRole("button", { name: /Round trip/i }));
    fireEvent.change(screen.getByLabelText("Departure 1"), { target: { value: `${ymdOffset(1)}T10:00` } });
    fireEvent.change(screen.getByLabelText("Return departure 1"), { target: { value: `${ymdOffset(1)}T09:00` } });
    fireEvent.change(screen.getByLabelText("Airline 1"), { target: { value: "AI" } });
    fireEvent.change(screen.getByLabelText("Fare 1"), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: /Create quote/i }));
    expect(notifyError).toHaveBeenCalledWith("End date must be after Start date.");
    expect(fetchApiMock.mock.calls.some(([url, opts]) => url === "/api/v1/flight-plugin/agent-quotes" && opts?.method === "POST")).toBe(false);
  });

  it("adds and removes option rows", () => {
    renderPage();
    const addBtn = screen.getByRole("button", { name: /Add option/i });
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    expect(screen.getByLabelText("Airline 4")).toBeInTheDocument();
    expect(addBtn).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove option 2" }));
    expect(screen.queryByLabelText("Airline 4")).toBeNull();
  });

  it("generates and exposes a downloadable flight offer image", async () => {
    renderPage();
    uploadScreenshot();
    continueToPricing();
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Type \+ markup/i })).toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText("Base price 1"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Markup type 1"), { target: { value: "amount" } });
    fireEvent.change(screen.getByLabelText("Markup value 1"), { target: { value: "200" } });
    fireEvent.click(screen.getByRole("button", { name: /Next/i }));
    fireEvent.click(screen.getByRole("button", { name: /Generate image/i }));
    const generatedPreview = screen.getByAltText(/Generated flight offer preview/i);
    const generatedSvg = decodeURIComponent(generatedPreview.src.split(",")[1] || "");
    expect(generatedPreview).toBeInTheDocument();
    expect(generatedSvg).toContain("Flight offer quotation");
    expect(generatedSvg).toContain("Flight details");
    expect(generatedSvg).toContain("Top flight options");
    expect(generatedSvg).toContain("Timing notes");
    expect(generatedSvg).toContain("Policies &amp; notes");
    expect(generatedSvg).toContain("\u00B7");
    const previewButton = screen.getByRole("button", { name: /Preview image/i });
    expect(previewButton).not.toBeDisabled();
    fireEvent.click(previewButton);
    expect(screen.getByRole("dialog", { name: /Flight offer preview/i })).toBeInTheDocument();
    expect(screen.getByAltText(/Full-size flight offer preview/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Close/i }));
    expect(screen.queryByRole("dialog", { name: /Flight offer preview/i })).toBeNull();
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:flight-offer-pdf");
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const downloadButton = screen.getByRole("button", { name: /Download PDF/i });
    expect(downloadButton).not.toBeDisabled();
    fireEvent.click(downloadButton);
    await waitFor(() => expect(buildFlightOfferPdfBlobMock).toHaveBeenCalled());
    expect(buildFlightOfferPdfBlobMock).toHaveBeenCalledWith(expect.stringContaining("Flight offer quotation"), expect.objectContaining({ pageWidth: 595, pageHeight: 842 }));
    expect(createObjectURLSpy).toHaveBeenCalledWith(flightOfferPdfBlob);
    expect(clickSpy).toHaveBeenCalled();
  });

  it("requests price extraction before entering markup rows", async () => {
    renderPage();
    uploadScreenshot();
    continueToPricing();
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith("/api/v1/flight-plugin/extract-prices", expect.objectContaining({ method: "POST" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /Type \+ markup/i })).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Base price 1")).toHaveValue("12345");
    expect(screen.getByText("Air India")).toBeInTheDocument();
    expect(notifySuccess).toHaveBeenCalled();
  });
});
