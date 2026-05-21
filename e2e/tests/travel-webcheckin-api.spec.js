// @ts-check
/**
 * Gate spec — travel-vertical WebCheckin CRUD + auto-create on
 * Itinerary.accept (PRD §4.6).
 *
 * Covers:
 *   GET    /api/travel/webcheckins
 *   GET    /api/travel/webcheckins/upcoming
 *   GET    /api/travel/webcheckins/:id
 *   POST   /api/travel/webcheckins              (ADMIN+MGR)
 *   PATCH  /api/travel/webcheckins/:id          (ADMIN+MGR)
 *   POST   /api/travel/webcheckins/:id/upload-boarding-pass (multer)
 *   POST   /api/travel/webcheckins/:id/deliver
 *   DELETE /api/travel/webcheckins/:id          (ADMIN only)
 *
 * Plus:
 *   - Cross-vertical guard (generic admin → 403 WRONG_VERTICAL)
 *   - Auto-create wiring on POST /itineraries/:id/accept: a flight
 *     ItineraryItem with detailsJson { pnr, flightNumber, departureAt }
 *     spawns a WebCheckin row visible via GET /webcheckins.
 *
 * Auth deps: yasin@travelstall.in (travel ADMIN) + admin@globussoft.com
 * (generic ADMIN). Travel tenant + RFU bank seeded by seed-travel.js.
 */

const { test, expect } = require("@playwright/test");

test.describe.configure({ mode: "serial" });

const BASE_URL = process.env.BASE_URL || "https://crm.globusdemos.com";
const REQUEST_TIMEOUT = 60000;
const RUN_TAG = `E2E_TRAVEL_WC_${Date.now()}`;

let travelAdminToken = null;
let genericAdminToken = null;
let testContactId = null;

async function loginAs(request, email, password) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await request.post(`${BASE_URL}/api/auth/login`, {
        data: { email, password },
        headers: { "Content-Type": "application/json" },
        timeout: REQUEST_TIMEOUT,
      });
      if (r.ok()) return (await r.json()).token;
    } catch (_e) {
      if (attempt === 0) continue;
    }
  }
  return null;
}

async function getTravelAdmin(request) {
  if (!travelAdminToken) {
    travelAdminToken = await loginAs(request, "yasin@travelstall.in", "password123");
  }
  return travelAdminToken;
}
async function getGenericAdmin(request) {
  if (!genericAdminToken) {
    genericAdminToken = await loginAs(request, "admin@globussoft.com", "password123");
  }
  return genericAdminToken;
}

const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function retryOn5xx(fn) {
  let r;
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await fn();
    if (r.status() < 500) return r;
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  return r;
}

async function get(request, token, path) {
  return retryOn5xx(() => request.get(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }));
}
async function post(request, token, path, body) {
  return retryOn5xx(() =>
    request.post(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function patch(request, token, path, body) {
  return retryOn5xx(() =>
    request.patch(`${BASE_URL}${path}`, { headers: headers(token), data: body ?? {}, timeout: REQUEST_TIMEOUT }),
  );
}
async function del(request, token, path) {
  return retryOn5xx(() =>
    request.delete(`${BASE_URL}${path}`, { headers: headers(token), timeout: REQUEST_TIMEOUT }),
  );
}

const created = { webcheckinIds: [], itineraryIds: [] };

test.beforeAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;

  // Contact owned by the travel tenant — tagged so demo-scrub can sweep.
  const cRes = await post(request, token, "/api/contacts", {
    name: `${RUN_TAG} WebCheckin Pilgrim`,
    email: `${RUN_TAG.toLowerCase()}-pilgrim@e2e.test`,
    phone: `+91${String(Date.now()).slice(-10)}`,
    subBrand: "rfu",
  });
  if (cRes.ok()) {
    testContactId = (await cRes.json()).id;
  }
  if (!testContactId) return;

  // Diagnostic prerequisite for the /itineraries POST in the auto-create
  // test (PRD §4.1).
  const banksRes = await get(request, token, "/api/travel/diagnostic-banks?subBrand=rfu&active=true");
  if (banksRes.ok()) {
    const banks = (await banksRes.json()).banks || [];
    const rfuBank = banks.find((b) => b.subBrand === "rfu");
    if (rfuBank) {
      await post(request, token, "/api/travel/diagnostics", {
        bankId: rfuBank.id,
        answers: { q1: "few", q2: "medium" },
        contactId: testContactId,
      }).catch(() => null);
    }
  }
});

test.afterAll(async ({ request }) => {
  const token = await getTravelAdmin(request);
  if (!token) return;
  // Delete webcheckins by id (ADMIN delete).
  for (const id of created.webcheckinIds) {
    await del(request, token, `/api/travel/webcheckins/${id}`).catch(() => {});
  }
  // Itineraries created via /accept may have spawned webcheckins too —
  // sweep them via the list-by-itinerary filter.
  for (const iid of created.itineraryIds) {
    const r = await get(request, token, `/api/travel/webcheckins?itineraryId=${iid}`).catch(() => null);
    if (r && r.ok()) {
      const body = await r.json().catch(() => null);
      for (const wc of body?.webcheckins || []) {
        await del(request, token, `/api/travel/webcheckins/${wc.id}`).catch(() => {});
      }
    }
    await del(request, token, `/api/travel/itineraries/${iid}`).catch(() => {});
  }
  if (testContactId) {
    await del(request, token, `/api/contacts/${testContactId}`).catch(() => {});
  }
});

// ─── Guards ──────────────────────────────────────────────────────────

test.describe("Travel WebCheckin API — guards", () => {
  test("GET /webcheckins without auth → 401/403", async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/travel/webcheckins`, { timeout: REQUEST_TIMEOUT });
    expect([401, 403]).toContain(res.status());
  });

  test("GET /webcheckins rejects generic admin → 403 WRONG_VERTICAL", async ({ request }) => {
    const token = await getGenericAdmin(request);
    if (!token) test.skip(true, "admin@globussoft.com not seeded");
    const res = await get(request, token, "/api/travel/webcheckins");
    expect(res.status()).toBe(403);
    expect((await res.json()).code).toBe("WRONG_VERTICAL");
  });

  test("POST /webcheckins without auth → 401/403", async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/travel/webcheckins`, {
      data: {}, headers: { "Content-Type": "application/json" }, timeout: REQUEST_TIMEOUT,
    });
    expect([401, 403]).toContain(res.status());
  });
});

// ─── CRUD ────────────────────────────────────────────────────────────

test.describe("Travel WebCheckin API — CRUD", () => {
  test("POST with missing fields → 400 MISSING_FIELDS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await post(request, token, "/api/travel/webcheckins", { contactId: testContactId });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("MISSING_FIELDS");
  });

  test("POST happy path → 201 with the right shape + computed windowOpenAt", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    const dep = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 days
    const res = await post(request, token, "/api/travel/webcheckins", {
      contactId: testContactId,
      pnr: `${RUN_TAG}-PNR1`,
      airlineCode: "6E",
      flightNumber: "6E-1234",
      departureAt: dep.toISOString(),
      passengerName: `${RUN_TAG} Pilgrim Anwar`,
      seatPref: "aisle",
      mealPref: "halal",
    });
    expect(res.status(), `create: ${await res.text()}`).toBe(201);
    const body = await res.json();
    expect(body.pnr).toBe(`${RUN_TAG}-PNR1`);
    expect(body.airlineCode).toBe("6E");
    expect(body.status).toBe("pending");
    // 6E (IndiGo) is in the AIRLINE_WINDOWS_HOURS table at 48h.
    const winMs = new Date(body.windowOpenAt).getTime();
    const expectedWinMs = dep.getTime() - 48 * 60 * 60 * 1000;
    expect(Math.abs(winMs - expectedWinMs)).toBeLessThan(1000); // within 1s
    created.webcheckinIds.push(body.id);
  });

  test("GET /webcheckins lists the new row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const res = await get(request, token, "/api/travel/webcheckins?limit=200");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.webcheckins)).toBe(true);
    const ids = body.webcheckins.map((w) => w.id);
    expect(ids).toContain(created.webcheckinIds[0]);
  });

  test("GET /webcheckins/upcoming returns rows whose window opens within next 48h", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    // Create a row whose departure is +49h: windowOpenAt = dep - 48h = +1h
    // from now → lands in the upcoming-48h window.
    const dep = new Date(Date.now() + 49 * 60 * 60 * 1000);
    const cr = await post(request, token, "/api/travel/webcheckins", {
      contactId: testContactId,
      pnr: `${RUN_TAG}-UPCOMING`,
      airlineCode: "6E",
      flightNumber: "6E-9999",
      departureAt: dep.toISOString(),
      passengerName: `${RUN_TAG} Pilgrim Upcoming`,
    });
    expect(cr.status()).toBe(201);
    const upRow = await cr.json();
    created.webcheckinIds.push(upRow.id);

    const res = await get(request, token, "/api/travel/webcheckins/upcoming");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.webcheckins)).toBe(true);
    const ids = body.webcheckins.map((w) => w.id);
    expect(ids).toContain(upRow.id);
  });

  test("PATCH amends assignedAgentId + seatPref", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    const res = await patch(request, token, `/api/travel/webcheckins/${id}`, {
      seatPref: "window",
      assignedAgentId: null,
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.seatPref).toBe("window");
    expect(body.assignedAgentId).toBeNull();
  });

  test("PATCH with invalid status → 400 INVALID_STATUS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    const res = await patch(request, token, `/api/travel/webcheckins/${id}`, {
      status: "bogus-state",
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("INVALID_STATUS");
  });

  test("PATCH empty body → 400 EMPTY_BODY", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    const res = await patch(request, token, `/api/travel/webcheckins/${id}`, {});
    expect(res.status()).toBe(400);
    expect((await res.json()).code).toBe("EMPTY_BODY");
  });

  test("GET /webcheckins/:id returns the row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    const res = await get(request, token, `/api/travel/webcheckins/${id}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).id).toBe(id);
  });

  test("GET /webcheckins/:id unknown id → 404", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token) test.skip(true, "no token");
    const res = await get(request, token, "/api/travel/webcheckins/9999999");
    expect(res.status()).toBe(404);
  });
});

// ─── Multipart upload + deliver ──────────────────────────────────────

test.describe("Travel WebCheckin API — boarding pass + deliver", () => {
  test("POST /upload-boarding-pass with PDF buffer → 200 + status='done' + url set", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    // Tiny PDF: %PDF-1.4 header is enough to make application/pdf
    // mime-type sniff correct on the server side.
    const pdfBuf = Buffer.from("%PDF-1.4\n%fake boarding pass\n%%EOF\n", "utf-8");
    const res = await request.post(`${BASE_URL}/api/travel/webcheckins/${id}/upload-boarding-pass`, {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        file: { name: "bp.pdf", mimeType: "application/pdf", buffer: pdfBuf },
      },
      timeout: REQUEST_TIMEOUT,
    });
    expect(res.status(), `upload: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.url).toBe("string");
    expect(body.url.startsWith("/uploads/boarding-passes/")).toBe(true);
    expect(body.webcheckin.status).toBe("done");
    expect(body.webcheckin.boardingPassUrl).toBe(body.url);
  });

  test("POST /upload-boarding-pass without file → 400", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0];
    const res = await request.post(`${BASE_URL}/api/travel/webcheckins/${id}/upload-boarding-pass`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: REQUEST_TIMEOUT,
    });
    // Multer may surface either MISSING_FILE (handler) or a more generic
    // 400/415 (multer's "boundary not found"). Both indicate the same
    // contract: file is required.
    expect([400, 415]).toContain(res.status());
  });

  test("POST /deliver sets deliveredAt + returns updated row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || created.webcheckinIds.length === 0) test.skip(true, "no rows");
    const id = created.webcheckinIds[0]; // already has boardingPassUrl from upload test
    const res = await post(request, token, `/api/travel/webcheckins/${id}/deliver`);
    expect(res.status(), `deliver: ${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.deliveredAt).toBeTruthy();
    // wati-stub log is server-side (console.log) — not observable from
    // the spec, but the DB-side mutation is the contract surface.
  });

  test("POST /deliver without boardingPassUrl → 409 NO_BOARDING_PASS", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    // Create a fresh row without uploading a boarding pass.
    const dep = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const cr = await post(request, token, "/api/travel/webcheckins", {
      contactId: testContactId,
      pnr: `${RUN_TAG}-NOBP`,
      airlineCode: "AI",
      flightNumber: "AI-101",
      departureAt: dep.toISOString(),
      passengerName: `${RUN_TAG} Pilgrim NoBP`,
    });
    const newRow = await cr.json();
    created.webcheckinIds.push(newRow.id);

    const res = await post(request, token, `/api/travel/webcheckins/${newRow.id}/deliver`);
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("NO_BOARDING_PASS");
  });
});

// ─── Auto-create on Itinerary.accept (PRD §4.6) ──────────────────────

test.describe("Travel WebCheckin API — auto-create on Itinerary.accept", () => {
  test("Accepting an itinerary with a flight item spawns a WebCheckin row", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");

    // 1. Create an itinerary with one flight ItineraryItem whose
    //    detailsJson carries the pnr / flightNumber / departureAt the
    //    auto-create logic looks for.
    const dep = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000); // +21 days
    const uniquePnr = `${RUN_TAG}-AUTOPNR`;
    const itinRes = await post(request, token, "/api/travel/itineraries", {
      subBrand: "rfu",
      contactId: testContactId,
      destination: `${RUN_TAG} auto-create-target`,
      status: "sent",
      items: [
        {
          itemType: "flight",
          description: "BLR-JED economy",
          detailsJson: JSON.stringify({
            pnr: uniquePnr,
            flightNumber: "6E-1234",
            airlineCode: "6E",
            departureAt: dep.toISOString(),
            passengerName: `${RUN_TAG} Auto Pilgrim`,
            seatPref: "aisle",
            mealPref: "halal",
          }),
          unitCost: 35000,
          totalPrice: 40000,
        },
      ],
    });
    expect(itinRes.status(), `itin create: ${await itinRes.text()}`).toBe(201);
    const itinId = (await itinRes.json()).id;
    created.itineraryIds.push(itinId);

    // 2. POST /accept. Auto-create runs as a fire-and-forget after
    //    response — give it a beat to land.
    const acceptRes = await post(request, token, `/api/travel/itineraries/${itinId}/accept`);
    expect(acceptRes.status()).toBe(200);
    expect((await acceptRes.json()).status).toBe("accepted");

    // 3. Poll the webcheckins list for the spawned row (best-effort
    //    fire-and-forget; tolerate up to 5s while the DB-write lands).
    let spawned = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !spawned) {
      const listRes = await get(request, token, `/api/travel/webcheckins?itineraryId=${itinId}`);
      if (listRes.ok()) {
        const list = await listRes.json();
        spawned = (list.webcheckins || []).find((w) => w.pnr === uniquePnr);
      }
      if (!spawned) await new Promise((r) => setTimeout(r, 250));
    }
    expect(spawned, "WebCheckin auto-create did not land within 5s").toBeTruthy();
    expect(spawned.airlineCode).toBe("6E");
    expect(spawned.flightNumber).toBe("6E-1234");
    expect(spawned.status).toBe("pending");
    expect(spawned.passengerName).toContain(RUN_TAG);
    // 6E (IndiGo) → T-48h window
    const winMs = new Date(spawned.windowOpenAt).getTime();
    const expectedWinMs = dep.getTime() - 48 * 60 * 60 * 1000;
    expect(Math.abs(winMs - expectedWinMs)).toBeLessThan(2000); // within 2s
  });
});

// ─── DELETE ──────────────────────────────────────────────────────────

test.describe("Travel WebCheckin API — DELETE role gate", () => {
  test("DELETE as ADMIN → 204", async ({ request }) => {
    const token = await getTravelAdmin(request);
    if (!token || !testContactId) test.skip(true, "deps missing");
    // Fresh row so we don't interfere with cleanup tracking.
    const dep = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    const cr = await post(request, token, "/api/travel/webcheckins", {
      contactId: testContactId,
      pnr: `${RUN_TAG}-DELME`,
      airlineCode: "6E",
      flightNumber: "6E-7777",
      departureAt: dep.toISOString(),
      passengerName: `${RUN_TAG} Pilgrim DelMe`,
    });
    expect(cr.status()).toBe(201);
    const id = (await cr.json()).id;

    const res = await del(request, token, `/api/travel/webcheckins/${id}`);
    expect(res.status()).toBe(204);
    // No body on 204; just ensure the row is gone.
    const after = await get(request, token, `/api/travel/webcheckins/${id}`);
    expect(after.status()).toBe(404);
  });
});
