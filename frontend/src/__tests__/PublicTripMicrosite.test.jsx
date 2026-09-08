/**
 * PublicTripMicrosite.test.jsx - vitest + RTL coverage for the public
 * parent/teacher trip microsite (frontend/src/pages/travel/PublicTripMicrosite.jsx).
 *
 * The page loads public trip info and, when the visitor arrives from the
 * landing-page registration with a ?draftToken, lets them upload their own
 * Passport, Aadhaar and Parent consent letter documents with a
 * parent-consent checkbox.
 *
 * Pinned invariants:
 *   1. mount loads public info -> renders destination; no participant list / Aadhaar section is rendered.
 *   2. 404 -> "Trip page not found"; 410 GONE -> "expired".
 *   3. no draftToken -> no upload button; a hint tells the visitor to open their registration link.
 *   4. with draftToken -> an "Upload documents" button opens a modal that requires Passport + Aadhaar + Parent consent letter + consent checkbox and POSTs multipart to /documents.
 *   5. the phone-OTP registration panel does not render on this page, even when a draftToken is present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import PublicTripMicrosite from "../pages/travel/PublicTripMicrosite";

const BASE = "/api/travel/microsites/public/uuid-x";

let infoResponse;

function jsonResponse(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

function installMock() {
  global.fetch = vi.fn((url, opts = {}) => {
    const method = opts.method || "GET";
    if (url === BASE && method === "GET") {
      return jsonResponse(infoResponse.status, infoResponse.body);
    }
    return jsonResponse(404, { error: "unexpected", code: "X" });
  });
}

function renderPage(uuid = "uuid-x") {
  return render(
    <MemoryRouter initialEntries={[`/p/tripmicrosite/${uuid}`]}>
      <Routes>
        <Route
          path="/p/tripmicrosite/:publicUuid"
          element={<PublicTripMicrosite />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  infoResponse = {
    status: 200,
    body: {
      trip: {
        destination: "Goa Ed Tour",
        departDate: "2026-09-01",
        returnDate: "2026-09-10",
      },
      itineraryHtml: "<p>Itinerary details</p>",
      brandKit: null,
    },
  };
  sessionStorage.clear();
  installMock();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<PublicTripMicrosite /> - load states", () => {
  it("renders the trip destination and does not render any participant / Aadhaar section", async () => {
    renderPage();
    expect(
      await screen.findByTestId("microsite-destination-title"),
    ).toHaveTextContent("Goa Ed Tour");
    expect(
      screen.queryByTestId("microsite-aadhaar-section"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Verify Aadhaar/i)).not.toBeInTheDocument();
    expect(
      global.fetch.mock.calls.some(([u]) => String(u).endsWith("/participants")),
    ).toBe(false);
  });

  it('shows "Trip page not found" on 404', async () => {
    infoResponse = {
      status: 404,
      body: { error: "Microsite not found", code: "NOT_FOUND" },
    };
    renderPage();
    expect(await screen.findByText(/Trip page not found/i)).toBeInTheDocument();
  });

  it("shows an expiry message on 410 GONE", async () => {
    infoResponse = { status: 410, body: { error: "expired", code: "GONE" } };
    renderPage();
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
  });
});

describe("<PublicTripMicrosite /> - brand-kit consumer", () => {
  it("renders brand logo + tagline in the header when brandKit is populated", async () => {
    infoResponse = {
      status: 200,
      body: {
        trip: {
          destination: "Bali Trip",
          departDate: "2026-09-01",
          returnDate: "2026-09-10",
        },
        itineraryHtml: "<p>Itinerary</p>",
        brandKit: {
          logoUrl: "https://cdn.example/tmc-logo.png",
          primaryColor: "#1F4E79",
          tagline: "Travel that teaches",
        },
      },
    };
    renderPage();
    const logo = await screen.findByTestId("microsite-brand-logo");
    expect(logo).toBeInTheDocument();
    expect(logo.tagName).toBe("IMG");
    expect(logo).toHaveAttribute("alt", "Travel that teaches logo");
    expect(screen.getByText("Travel that teaches")).toBeInTheDocument();
  });

  it("renders the brand footer with mission + support contacts when populated", async () => {
    infoResponse = {
      status: 200,
      body: {
        trip: {
          destination: "Bali Trip",
          departDate: "2026-09-01",
          returnDate: "2026-09-10",
        },
        itineraryHtml: "<p>Itinerary</p>",
        brandKit: {
          primaryColor: "#1F4E79",
          missionStatement: "Designing educational tours since 2015.",
          supportEmail: "hello@example.com",
          supportPhone: "+91-22-1234-5678",
          footerText: "Copyright 2026 Test Brand",
        },
      },
    };
    renderPage();
    expect(
      await screen.findByTestId("microsite-brand-footer"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Designing educational tours since 2015/i),
    ).toBeInTheDocument();
    expect(screen.getByText("hello@example.com")).toBeInTheDocument();
    expect(screen.getByText("+91-22-1234-5678")).toBeInTheDocument();
    expect(screen.getByText("Copyright 2026 Test Brand")).toBeInTheDocument();
    expect(
      screen.getByText("hello@example.com").closest("a")?.getAttribute("href"),
    ).toBe("mailto:hello@example.com");
    expect(
      screen.getByText("+91-22-1234-5678").closest("a")?.getAttribute("href"),
    ).toBe("tel:+91-22-1234-5678");
  });

  it("falls back to the default Plane icon and no brand footer when brandKit is null", async () => {
    renderPage();
    await screen.findByTestId("microsite-destination-title");
    expect(screen.queryByAltText(/Brand logo/i)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("microsite-brand-footer"),
    ).not.toBeInTheDocument();
  });
});

describe("<PublicTripMicrosite /> - document upload", () => {
  async function withLocation(search, body) {
    const orig = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        search,
        origin: "http://localhost",
        href: "http://localhost",
        assign: vi.fn(),
      },
    });
    try {
      return await body();
    } finally {
      if (orig) Object.defineProperty(window, "location", orig);
    }
  }

  async function withDraftToken(token, body) {
    return withLocation(`?draftToken=${token}`, body);
  }

  function installDocMock({
    draftSummary = {
      id: 7001,
      status: "DRAFT",
      studentFirstName: "Aarav",
      parentFirstName: "Rohan",
      parentPhoneMasked: "masked-3210",
      parentPhoneLast4: "3210",
      parentEmailMasked: "masked@example.com",
      hasPassport: true,
      hasPassportDoc: false,
      hasAadhaarDoc: false,
      hasConsentLetterDoc: false,
      consentGiven: false,
    },
    uploadResponse = jsonResponse(200, {
      ok: true,
      documents: {
        passport: true,
        aadhaar: true,
        consentCapturedAt: "2026-07-01T00:00:00.000Z",
      },
    }),
  } = {}) {
    global.fetch = vi.fn((url, opts = {}) => {
      const method = opts.method || "GET";
      if (url === BASE && method === "GET") {
        return jsonResponse(infoResponse.status, infoResponse.body);
      }
      if (url.startsWith(`${BASE}/draft-summary?token=`) && method === "GET") {
        return jsonResponse(200, draftSummary);
      }
      if (url === `${BASE}/documents` && method === "POST") {
        return uploadResponse;
      }
      return jsonResponse(404, { error: "unexpected", code: "X" });
    });
  }

  const makeFile = (name, type) => new File(["x"], name, { type });

  it('shows no upload button and a "use your registration link" hint when there is no draftToken', async () => {
    installMock();
    renderPage();
    await screen.findByTestId("microsite-destination-title");
    expect(
      screen.queryByTestId("microsite-upload-docs-btn"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/open this page from the registration link/i),
    ).toBeInTheDocument();
  });

  it("shows the upload button under a draftToken and opens the modal on click", async () => {
    installDocMock();
    await withDraftToken("abc123", async () => {
      renderPage();
      const btn = await screen.findByTestId("microsite-upload-docs-btn");
      expect(btn).toHaveTextContent(/Upload documents/i);
      fireEvent.click(btn);
      expect(
        await screen.findByTestId("microsite-doc-modal"),
      ).toBeInTheDocument();
    });
  });

  it("does not render the phone-OTP registration panel even when a draftToken is present", async () => {
    installDocMock();
    await withDraftToken("abc123", async () => {
      renderPage();
      await screen.findByTestId("microsite-upload-docs-btn");
      expect(
        screen.queryByTestId("registration-confirm-panel"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("registration-request-otp-btn"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("registration-code-input"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/Confirm your registration/i),
      ).not.toBeInTheDocument();
    });
  });

  it("blocks submit until consent is ticked, both ID files are chosen, and consent letter is uploaded", async () => {
    installDocMock();
    await withDraftToken("abc123", async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId("microsite-upload-docs-btn"));
      await screen.findByTestId("microsite-doc-modal");

      fireEvent.click(screen.getByTestId("microsite-doc-submit"));
      expect(
        await screen.findByTestId("microsite-doc-error"),
      ).toHaveTextContent(/parent consent/i);
      expect(
        global.fetch.mock.calls.some(([u]) => u === `${BASE}/documents`),
      ).toBe(false);

      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("microsite-doc-submit"));
      expect(
        await screen.findByTestId("microsite-doc-error"),
      ).toHaveTextContent(/Passport and Aadhaar/i);
      expect(
        global.fetch.mock.calls.some(([u]) => u === `${BASE}/documents`),
      ).toBe(false);

      fireEvent.change(screen.getByTestId("microsite-doc-passport"), {
        target: { files: [makeFile("passport.pdf", "application/pdf")] },
      });
      fireEvent.change(screen.getByTestId("microsite-doc-aadhaar"), {
        target: { files: [makeFile("aadhaar.png", "image/png")] },
      });
      fireEvent.click(screen.getByTestId("microsite-doc-submit"));
      expect(
        await screen.findByTestId("microsite-doc-error"),
      ).toHaveTextContent(/consent letter/i);
      expect(
        global.fetch.mock.calls.some(([u]) => u === `${BASE}/documents`),
      ).toBe(false);
    });
  });

  it("happy path: pick both files + consent -> POSTs multipart and shows the done state", async () => {
    installDocMock();
    await withDraftToken("abc123", async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId("microsite-upload-docs-btn"));
      await screen.findByTestId("microsite-doc-modal");

      fireEvent.change(screen.getByTestId("microsite-doc-passport"), {
        target: { files: [makeFile("passport.pdf", "application/pdf")] },
      });
      fireEvent.change(screen.getByTestId("microsite-doc-aadhaar"), {
        target: { files: [makeFile("aadhaar.png", "image/png")] },
      });
      fireEvent.change(screen.getByTestId("microsite-doc-consent-letter"), {
        target: { files: [makeFile("consent.pdf", "application/pdf")] },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("microsite-doc-submit"));

      expect(
        await screen.findByTestId("microsite-doc-modal-done"),
      ).toBeInTheDocument();

      const post = global.fetch.mock.calls.find(
        ([u, o]) => u === `${BASE}/documents` && o?.method === "POST",
      );
      expect(post).toBeTruthy();
      const fd = post[1].body;
      expect(fd).toBeInstanceOf(FormData);
      expect(fd.get("draftToken")).toBe("abc123");
      expect(fd.get("consent")).toBe("true");
      expect(fd.get("passport")).toBeInstanceOf(File);
      expect(fd.get("aadhaar")).toBeInstanceOf(File);
      expect(fd.get("consentLetter")).toBeInstanceOf(File);
    });
  });

  it("happy path with portal bridge: redirects to customer register after upload", async () => {
    installDocMock();
    await withLocation(
      `?draftToken=abc123&portalRedirect=${encodeURIComponent("/customer/register?tenantSlug=travel-stall&name=Rohan%20Iyer&email=rohan@example.com&next=%2Ftravel%2Fportal")}`,
      async () => {
        renderPage();
        fireEvent.click(await screen.findByTestId("microsite-upload-docs-btn"));
        await screen.findByTestId("microsite-doc-modal");

        fireEvent.change(screen.getByTestId("microsite-doc-passport"), {
          target: { files: [makeFile("passport.pdf", "application/pdf")] },
        });
        fireEvent.change(screen.getByTestId("microsite-doc-aadhaar"), {
          target: { files: [makeFile("aadhaar.png", "image/png")] },
        });
        fireEvent.change(screen.getByTestId("microsite-doc-consent-letter"), {
          target: { files: [makeFile("consent.pdf", "application/pdf")] },
        });
        fireEvent.click(screen.getByRole("checkbox"));
        fireEvent.click(screen.getByTestId("microsite-doc-submit"));

        expect(
          await screen.findByTestId("microsite-doc-modal-done"),
        ).toBeInTheDocument();
        expect(window.location.assign).toHaveBeenCalled();
        const redirectTarget = window.location.assign.mock.calls[0][0];
        expect(redirectTarget).toContain("/customer/register?tenantSlug=travel-stall");
        expect(redirectTarget).toContain("name=Rohan");
        expect(redirectTarget).toContain("email=rohan@example.com");
        expect(redirectTarget).toContain("next=");
      },
    );
  });

  it("surfaces a server error inside the modal without closing it", async () => {
    installDocMock({
      uploadResponse: jsonResponse(400, {
        error: "Draft token has expired",
        code: "DRAFT_EXPIRED",
      }),
    });
    await withDraftToken("abc123", async () => {
      renderPage();
      fireEvent.click(await screen.findByTestId("microsite-upload-docs-btn"));
      await screen.findByTestId("microsite-doc-modal");
      fireEvent.change(screen.getByTestId("microsite-doc-passport"), {
        target: { files: [makeFile("p.pdf", "application/pdf")] },
      });
      fireEvent.change(screen.getByTestId("microsite-doc-aadhaar"), {
        target: { files: [makeFile("a.pdf", "application/pdf")] },
      });
      fireEvent.change(screen.getByTestId("microsite-doc-consent-letter"), {
        target: { files: [makeFile("consent.pdf", "application/pdf")] },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("microsite-doc-submit"));

      expect(
        await screen.findByTestId("microsite-doc-error"),
      ).toHaveTextContent(/expired/i);
      expect(screen.getByTestId("microsite-doc-modal")).toBeInTheDocument();
      expect(
        screen.queryByTestId("microsite-doc-modal-done"),
      ).not.toBeInTheDocument();
    });
  });

  it('when all docs are already on record, the button reads "Update documents" and a single re-upload is allowed', async () => {
    installDocMock({
      draftSummary: {
        id: 7001,
        status: "OTP_VERIFIED",
        studentFirstName: "Aarav",
        parentFirstName: "Rohan",
        parentPhoneMasked: "masked-3210",
        parentPhoneLast4: "3210",
        parentEmailMasked: "masked@example.com",
        hasPassport: true,
        hasPassportDoc: true,
        hasAadhaarDoc: true,
        hasConsentLetterDoc: true,
        consentGiven: true,
      },
    });
    await withDraftToken("abc123", async () => {
      renderPage();
      const btn = await screen.findByTestId("microsite-upload-docs-btn");
      expect(btn).toHaveTextContent(/Update documents/i);
      fireEvent.click(btn);
      await screen.findByTestId("microsite-doc-modal");
      fireEvent.change(screen.getByTestId("microsite-doc-passport"), {
        target: { files: [makeFile("newpass.pdf", "application/pdf")] },
      });
      fireEvent.click(screen.getByRole("checkbox"));
      fireEvent.click(screen.getByTestId("microsite-doc-submit"));
      expect(
        await screen.findByTestId("microsite-doc-modal-done"),
      ).toBeInTheDocument();
      const post = global.fetch.mock.calls.find(
        ([u, o]) => u === `${BASE}/documents` && o?.method === "POST",
      );
      expect(post[1].body.get("passport")).toBeInstanceOf(File);
      expect(post[1].body.get("aadhaar")).toBeNull();
      expect(post[1].body.get("consentLetter")).toBeNull();
    });
  });
});
