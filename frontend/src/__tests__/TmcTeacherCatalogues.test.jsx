import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TmcTeacherCatalogues from "../pages/travel/TmcTeacherCatalogues";

const API_ROOT = "/api/portal/tmc/teacher/catalogues";
const CATALOGUE_CACHE_KEY = "tmcTeacherCatalogueLibrary.v1:3107:7701";
const brochures = [
  {
    driveFileId: "pdf-nepal",
    fileName: "Nepal School Trip.pdf",
    folderPath: "TMC/CRM Itineraries",
    indexed: true,
    driveViewLink: "https://drive.google.com/file/d/pdf-nepal/view",
  },
  {
    driveFileId: "pdf-mysore",
    fileName: "Mysore Heritage.pdf",
    folderPath: "TMC/CRM Itineraries",
    indexed: false,
    driveViewLink: "https://drive.google.com/file/d/pdf-mysore/view",
  },
];

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

describe("TmcTeacherCatalogues", () => {
  let fetchSpy;
  let responseStorageAvailable;

  beforeEach(() => {
    responseStorageAvailable = true;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((url, options = {}) => {
      if (url === API_ROOT) {
        return Promise.resolve(jsonResponse({ connected: true, catalogues: brochures, responseStorageAvailable, response: null }));
      }
      if (url === `${API_ROOT}/response` && options.method === "POST") {
        return Promise.resolve(jsonResponse({
          ok: true,
          response: { selectedCatalogues: brochures, submittedAt: "2026-11-17T10:00:00.000Z" },
        }, 201));
      }
      return Promise.resolve(jsonResponse({ error: "Unexpected request" }, 404));
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    localStorage.removeItem(CATALOGUE_CACHE_KEY);
  });

  it("loads and displays the teacher's TMC brochures", async () => {
    render(<TmcTeacherCatalogues token="teacher-token" />);

    expect(await screen.findByText("Nepal School Trip.pdf")).toBeInTheDocument();
    expect(screen.getByText("Mysore Heritage.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 PDFs")).toBeInTheDocument();
    expect(fetchSpy).toHaveBeenCalledWith(API_ROOT, expect.objectContaining({
      headers: { Authorization: "Bearer teacher-token" },
    }));
  });

  it("shows the teacher-scoped cached catalogues while refreshing in the background", () => {
    const tokenPayload = btoa(JSON.stringify({ type: "PORTAL", tenantId: 3107, contactId: 7701 }));
    const token = `header.${tokenPayload}.signature`;
    localStorage.setItem(CATALOGUE_CACHE_KEY, JSON.stringify({
      connected: true,
      catalogues: brochures,
      selectedIds: ["pdf-nepal"],
      submittedAt: "2026-11-17T10:00:00.000Z",
    }));
    fetchSpy.mockImplementation(() => new Promise(() => {}));

    render(<TmcTeacherCatalogues token={token} />);

    expect(screen.getByText("Nepal School Trip.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 PDFs · Updating library…")).toBeInTheDocument();
    expect(screen.getByText(/catalogue selected/).parentElement).toHaveTextContent("1 catalogue selected");
    expect(screen.getByRole("button", { name: "Update selection" })).toBeEnabled();
  });

  it("keeps catalogue controls outside the independently scrollable brochure list", async () => {
    render(<TmcTeacherCatalogues token="teacher-token" />);
    await screen.findByText("Nepal School Trip.pdf");

    const fixedHeader = document.querySelector('[data-tmc-catalogue-fixed-header="true"]');
    const browser = document.querySelector('[data-tmc-catalogue-browser="true"]');
    const brochureScrollArea = document.querySelector('[data-tmc-catalogue-scroll="true"]');

    expect(fixedHeader).toBeInTheDocument();
    expect(fixedHeader).toHaveStyle({ flex: "0 0 auto" });
    expect(fixedHeader).toContainElement(screen.getByRole("button", { name: "Submit selection" }));
    expect(browser).toContainElement(screen.getByRole("heading", { name: "Available catalogues" }));
    expect(browser).toContainElement(screen.getByRole("combobox", { name: "Filter catalogue files" }));
    expect(browser).toContainElement(screen.getByRole("combobox", { name: "Catalogues per page" }));
    expect(browser).toContainElement(brochureScrollArea);
    expect(brochureScrollArea).toHaveStyle({ overflowY: "auto", minHeight: "0px" });
    expect(brochureScrollArea).not.toContainElement(fixedHeader);
    expect(brochureScrollArea).not.toContainElement(screen.getByRole("textbox", { name: "Search catalogues" }));
    expect(brochureScrollArea).not.toContainElement(screen.getByRole("combobox", { name: "Catalogues per page" }));
    expect((await screen.findByText("Nepal School Trip.pdf")).closest("article")).toHaveStyle({ height: "210px" });
  });

  it("keeps each numbered page within the selected page size", async () => {
    const manyCatalogues = Array.from({ length: 25 }, (_, index) => ({
      driveFileId: `pdf-${index + 1}`,
      fileName: `Catalogue ${index + 1}.pdf`,
      folderPath: "TMC/CRM Itineraries",
      indexed: true,
    }));
    fetchSpy.mockImplementation((url) => url === API_ROOT
      ? Promise.resolve(jsonResponse({ connected: true, catalogues: manyCatalogues, response: null }))
      : Promise.resolve(jsonResponse({ error: "Unexpected request" }, 404)));

    render(<TmcTeacherCatalogues token="teacher-token" />);
    expect(await screen.findByText("Catalogue 20.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Catalogue 21.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 1–20 of 25 catalogues · Page 1 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next catalogue page" }));

    expect(await screen.findByText("Catalogue 21.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Catalogue 20.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Showing 21–25 of 25 catalogues · Page 2 of 2")).toBeInTheDocument();
  });

  it("supports a custom page size and resets to the first page when it changes", async () => {
    const manyCatalogues = Array.from({ length: 25 }, (_, index) => ({
      driveFileId: `pdf-${index + 1}`,
      fileName: `Catalogue ${index + 1}.pdf`,
      folderPath: "TMC/CRM Itineraries",
      indexed: true,
    }));
    fetchSpy.mockImplementation((url) => url === API_ROOT
      ? Promise.resolve(jsonResponse({ connected: true, catalogues: manyCatalogues, response: null }))
      : Promise.resolve(jsonResponse({ error: "Unexpected request" }, 404)));

    render(<TmcTeacherCatalogues token="teacher-token" />);
    await screen.findByText("Catalogue 20.pdf");
    fireEvent.change(screen.getByRole("combobox", { name: "Catalogues per page" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Custom catalogues per page" }), { target: { value: "5" } });

    expect(screen.getByText("Showing 1–5 of 25 catalogues · Page 1 of 5")).toBeInTheDocument();
    expect(screen.getByText("Catalogue 5.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Catalogue 6.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next catalogue page" }));
    expect(await screen.findByText("Catalogue 6.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Catalogue 5.pdf")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Catalogues per page" }), { target: { value: "10" } });
    expect(screen.getByText("Showing 1–10 of 25 catalogues · Page 1 of 3")).toBeInTheDocument();
    expect(screen.getByText("Catalogue 10.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Catalogue 11.pdf")).not.toBeInTheDocument();
  });

  it("submits multiple selected catalogue ids and shows the saved time", async () => {
    render(<TmcTeacherCatalogues token="teacher-token" />);

    const nepalCard = (await screen.findByText("Nepal School Trip.pdf")).closest("article");
    const mysoreCard = screen.getByText("Mysore Heritage.pdf").closest("article");
    expect(within(nepalCard).getByRole("checkbox", { name: "Select Nepal School Trip.pdf" })).toBeVisible();
    expect(within(nepalCard).getByRole("button", { name: "Preview Nepal School Trip.pdf" })).toBeVisible();
    fireEvent.click(within(nepalCard).getByRole("checkbox", { name: "Select Nepal School Trip.pdf" }));
    fireEvent.click(within(mysoreCard).getByRole("checkbox", { name: "Select Mysore Heritage.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit selection" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith(
      `${API_ROOT}/response`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer teacher-token", "Content-Type": "application/json" },
        body: JSON.stringify({ selectedFileIds: ["pdf-nepal", "pdf-mysore"] }),
      }),
    ));
    expect(await screen.findByText(/Last submitted/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update selection" })).toBeInTheDocument();
  });

  it("filters the brochure grid by search text", async () => {
    render(<TmcTeacherCatalogues token="teacher-token" />);
    await screen.findByText("Nepal School Trip.pdf");

    fireEvent.change(screen.getByRole("textbox", { name: "Search catalogues" }), {
      target: { value: "Mysore" },
    });

    expect(screen.getByText("Mysore Heritage.pdf")).toBeInTheDocument();
    expect(screen.queryByText("Nepal School Trip.pdf")).not.toBeInTheDocument();
  });

  it("keeps brochures visible but blocks submission until response storage is ready", async () => {
    responseStorageAvailable = false;
    render(<TmcTeacherCatalogues token="teacher-token" />);

    const nepalCard = (await screen.findByText("Nepal School Trip.pdf")).closest("article");
    expect(screen.getByText("You can browse the brochures, but catalogue responses are not ready yet. Please contact your travel administrator.")).toBeInTheDocument();
    fireEvent.click(within(nepalCard).getByRole("checkbox", { name: "Select Nepal School Trip.pdf" }));

    expect(screen.getByRole("button", { name: "Submit selection" })).toBeDisabled();
    expect(fetchSpy).not.toHaveBeenCalledWith(`${API_ROOT}/response`, expect.anything());
  });
});
