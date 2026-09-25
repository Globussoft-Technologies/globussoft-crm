import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createRequire } from "node:module";
import fs from "node:fs";
import prisma from "../../lib/prisma.js";

const requireCJS = createRequire(import.meta.url);
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";
const originalConnectorPublicUrl = process.env.TALLY_CONNECTOR_PUBLIC_URL;
const SAFE_VOUCHER_XML = '<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><VOUCHER ACTION="Create"><VOUCHERNUMBER>TEST-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
const SAFE_COST_CENTRE_XML = '<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE><COSTCENTRE NAME="TRIP-1" ACTION="Create"><NAME>TRIP-1</NAME></COSTCENTRE></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

prisma.tenant = prisma.tenant || {};
prisma.tenant.findUnique = vi.fn();
prisma.user = prisma.user || {};
prisma.user.findUnique = vi.fn();
prisma.revokedToken = prisma.revokedToken || {};
prisma.revokedToken.findUnique = vi.fn();
prisma.integration = { findUnique: vi.fn(), upsert: vi.fn() };
prisma.auditLog = { create: vi.fn(), findFirst: vi.fn() };
prisma.travelTallySyncLog = { findMany: vi.fn(), create: vi.fn() };

const connectorRouter = requireCJS("../../routes/travel_tally_connector");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/travel/tally/connector", connectorRouter);
  return app;
}

function auth() {
  const token = jwt.sign({ userId: 7, tenantId: 1, role: "ADMIN", email: "admin@test.local" }, JWT_SECRET, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  delete process.env.TALLY_CONNECTOR_PUBLIC_URL;
  prisma.tenant.findUnique.mockReset().mockResolvedValue({ id: 1, vertical: "travel", name: "Travel Test", slug: "travel-test" });
  prisma.user.findUnique.mockReset().mockResolvedValue({ id: 7, role: "ADMIN", deactivatedAt: null, sessionVersion: 0 });
  prisma.revokedToken.findUnique.mockReset().mockResolvedValue(null);
  prisma.integration.findUnique.mockReset().mockResolvedValue(null);
  prisma.integration.upsert.mockReset().mockResolvedValue({ id: 10 });
  prisma.auditLog.create.mockReset().mockResolvedValue({ id: 1 });
  prisma.auditLog.findFirst.mockReset().mockResolvedValue(null);
  prisma.travelTallySyncLog.findMany.mockReset().mockResolvedValue([]);
  prisma.travelTallySyncLog.create.mockReset().mockResolvedValue({ id: 1 });
});

afterEach(() => {
  if (originalConnectorPublicUrl === undefined) delete process.env.TALLY_CONNECTOR_PUBLIC_URL;
  else process.env.TALLY_CONNECTOR_PUBLIC_URL = originalConnectorPublicUrl;
});

describe("travel Tally connector routes", () => {
  test("builds a read-only filtered voucher-presence request", () => {
    const xml = connectorRouter.__testHooks.buildVoucherPresenceRequest(
      "Travel & Tours",
      new Set(["Sales\u0000INV-1", "Receipt\u0000REC-INV-1"]),
    );

    expect(xml).toContain("<TALLYREQUEST>Export</TALLYREQUEST>");
    expect(xml).toContain("<TYPE>Collection</TYPE>");
    expect(xml).toContain("<SVCURRENTCOMPANY>Travel &amp; Tours</SVCURRENTCOMPANY>");
    expect(xml).toContain("$Reference = &quot;INV-1&quot;");
    expect(xml).not.toContain("ACTION=");
  });

  test("recreates only history entries that are missing from live Tally", () => {
    const exportedKeys = new Set(["Sales\u0000INV-1", "Receipt\u0000REC-INV-1"]);
    const legacyCoverage = new Map([["OLD-INV", 100]]);
    const legacyFingerprints = new Map([["purchase-fingerprint", 1]]);
    const legacyFingerprintKeys = new Map([["purchase-fingerprint", ["Purchase\u0000TRV-0001"]]]);
    const liveVoucherKeys = new Set(["Sales\u0000INV-1"]);

    connectorRouter.__testHooks.retainOnlyLiveVoucherHistory(
      exportedKeys,
      legacyCoverage,
      legacyFingerprints,
      legacyFingerprintKeys,
      liveVoucherKeys,
    );

    expect([...exportedKeys]).toEqual(["Sales\u0000INV-1"]);
    expect(legacyCoverage.size).toBe(0);
    expect(legacyFingerprints.size).toBe(0);
  });

  test("updates live vouchers by exact Tally Master ID and leaves deleted vouchers as Create", () => {
    const tallyExport = '<ENVELOPE><VOUCHER><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>INV-1</REFERENCE><MASTERID>501</MASTERID></VOUCHER></ENVELOPE>';
    const presence = connectorRouter.__testHooks.liveVoucherPresence(tallyExport);
    const incoming = '<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Sales" ACTION="Create"><DATE>20260924</DATE><VOUCHERTYPENAME>Sales</VOUCHERTYPENAME><REFERENCE>INV-1</REFERENCE></VOUCHER></TALLYMESSAGE><TALLYMESSAGE><VOUCHER VCHTYPE="Receipt" ACTION="Create"><DATE>20260924</DATE><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><REFERENCE>REC-INV-1</REFERENCE></VOUCHER></TALLYMESSAGE></ENVELOPE>';

    const result = connectorRouter.__testHooks.markLiveVouchersForAlter(incoming, presence);

    expect(result.altered).toBe(1);
    expect(result.xml).toContain('VCHTYPE="Sales" TAGNAME="Master ID" TAGVALUE="501" ACTION="Alter"');
    expect(result.xml).toContain('<VOUCHER VCHTYPE="Receipt" ACTION="Create">');
  });

  test("pushes newly added trip vouchers without prompting about older vouchers", () => {
    const existing = new Set(["Sales\u0000INV-1", "Receipt\u0000REC-INV-1"]);

    expect(connectorRouter.__testHooks.shouldOfferExistingVoucherUpdate(existing, { included: 1, skipped: 2 })).toBe(false);
    expect(connectorRouter.__testHooks.shouldOfferExistingVoucherUpdate(existing, { included: 0, skipped: 2 })).toBe(true);
  });

  test("keeps full trip context in voucher sync history after filtering", () => {
    const filteredReceipt = "<ENVELOPE><VOUCHER><REFERENCE>REC-2</REFERENCE></VOUCHER></ENVELOPE>";
    const fullTripXml = "<ENVELOPE><VOUCHER><NAME>QUOTE-3</NAME><REFERENCE>INV-1</REFERENCE></VOUCHER><VOUCHER><REFERENCE>REC-2</REFERENCE></VOUCHER></ENVELOPE>";

    expect(connectorRouter.__testHooks.syncLogRequestPayload("vouchers", filteredReceipt, fullTripXml)).toBe(fullTripXml);
    expect(connectorRouter.__testHooks.syncLogRequestPayload("masters", "<MASTERS />", fullTripXml)).toBe("<MASTERS />");
  });

  test("recognizes a legacy GST journal after its generated reference changes", () => {
    const legacy = '<ENVELOPE><TALLYMESSAGE><VOUCHER VCHTYPE="Journal" ACTION="Create"><DATE>20260901</DATE><VOUCHERNUMBER>JRN-0007</VOUCHERNUMBER><REFERENCE>JRN-0007</REFERENCE><LEDGERENTRIES.LIST><LEDGERNAME>Sales Ledger</LEDGERNAME><AMOUNT>-19999.44</AMOUNT><COSTCENTREALLOCATIONS.LIST><NAME>QUOTE-3</NAME></COSTCENTREALLOCATIONS.LIST></LEDGERENTRIES.LIST><LEDGERENTRIES.LIST><LEDGERNAME>GST Payable</LEDGERNAME><AMOUNT>19999.44</AMOUNT></LEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></ENVELOPE>';
    const current = legacy.replaceAll("JRN-0007", "SALES-LEDGER-quote-3");
    const [entry] = connectorRouter.__testHooks.legacyPurchasePaymentEntries(legacy);
    const fingerprints = new Map([[entry.fingerprint, 1]]);

    const filtered = connectorRouter.__testHooks.omitPreviouslyExportedVouchers(current, new Set(), new Map(), fingerprints);

    expect(filtered.included).toBe(0);
    expect(filtered.skipped).toBe(1);
  });

  test("requires authentication and the travel vertical", async () => {
    expect((await request(makeApp()).get("/api/travel/tally/connector/status")).status).toBeGreaterThanOrEqual(401);
    prisma.tenant.findUnique.mockResolvedValue({ id: 1, vertical: "generic", name: "Generic", slug: "generic" });
    const wrongVertical = await request(makeApp()).get("/api/travel/tally/connector/status").set(auth());
    expect(wrongVertical.status).toBe(403);
    expect(wrongVertical.body.code).toBe("WRONG_VERTICAL");
  });

  test("returns safe status without exposing the stored token hash", async () => {
    prisma.integration.findUnique.mockResolvedValue({
      isActive: true,
      settings: JSON.stringify({ connectorId: "tally_public_id", createdAt: "2026-09-09T00:00:00.000Z" }),
    });
    const response = await request(makeApp()).get("/api/travel/tally/connector/status").set(auth());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ configured: true, online: false, credentials: { connectorId: "tally_public_id" } });
    expect(JSON.stringify(response.body)).not.toContain("tokenHash");
    expect(response.body).not.toHaveProperty("token");
  });

  test("derives the connector URL from forwarded deployment headers", async () => {
    const response = await request(makeApp())
      .get("/api/travel/tally/connector/status")
      .set(auth())
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-Host", "tenant.example.test");

    expect(response.status).toBe(200);
    expect(response.body.connectorUrl).toBe("wss://tenant.example.test/ws/tally-connector");
  });

  test("supports a deployment-provided connector URL without a source-code hostname", async () => {
    process.env.TALLY_CONNECTOR_PUBLIC_URL = "https://connector.example.test";
    const response = await request(makeApp())
      .get("/api/travel/tally/connector/status")
      .set(auth());

    expect(response.status).toBe(200);
    expect(response.body.connectorUrl).toBe("wss://connector.example.test/ws/tally-connector");
  });

  test("protects the binary route and reports a missing executable without rotating credentials", async () => {
    const existsSpy = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    try {
      const unauthenticated = await request(makeApp()).get("/api/travel/tally/connector/binary");
      expect(unauthenticated.status).toBeGreaterThanOrEqual(401);

      const unavailable = await request(makeApp())
        .get("/api/travel/tally/connector/binary")
        .set(auth());
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe("TALLY_CONNECTOR_BINARY_UNAVAILABLE");
      expect(prisma.integration.upsert).not.toHaveBeenCalled();
    } finally {
      existsSpy.mockRestore();
    }
  });

  test("generates a one-time token and stores only its hash", async () => {
    const response = await request(makeApp()).post("/api/travel/tally/connector/credentials").set(auth()).send({});
    expect(response.status).toBe(201);
    expect(response.body.token).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.customerId).toBe(1);
    const args = prisma.integration.upsert.mock.calls[0][0];
    expect(args.create.token).toMatch(/^[a-f0-9]{64}$/);
    expect(args.create.token).not.toBe(response.body.token);
    expect(args.create.settings).not.toContain(response.body.token);
  });

  test("rejects malformed XML and reports an offline connector safely", async () => {
    const malformed = await request(makeApp()).post("/api/travel/tally/connector/push").set(auth()).send({ vouchersXml: "<bad />" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe("INVALID_TALLY_XML");

    const offline = await request(makeApp()).post("/api/travel/tally/connector/push").set(auth()).send({ vouchersXml: SAFE_VOUCHER_XML });
    expect(offline.status).toBe(503);
    expect(offline.body.code).toBe("TALLY_CONNECTOR_OFFLINE");
  });

  test("accepts cost centres as safe master objects", async () => {
    const response = await request(makeApp())
      .post("/api/travel/tally/connector/push")
      .set(auth())
      .send({ mastersXml: SAFE_COST_CENTRE_XML, vouchersXml: SAFE_VOUCHER_XML });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("TALLY_CONNECTOR_OFFLINE");
  });

  test.each([
    ["delete action", SAFE_VOUCHER_XML.replace('ACTION="Create"', 'ACTION="Delete"')],
    ["alter action", SAFE_VOUCHER_XML.replace('ACTION="Create"', 'ACTION="Alter"')],
    ["DTD declaration", SAFE_VOUCHER_XML.replace("<ENVELOPE>", '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ENVELOPE>')],
    ["TDL operation", SAFE_VOUCHER_XML.replace("<REQUESTDATA>", "<REQUESTDATA><TDL><TDLMESSAGE /></TDL>")],
    ["master object in voucher payload", SAFE_VOUCHER_XML.replace("<VOUCHER ACTION=\"Create\"><VOUCHERNUMBER>TEST-1</VOUCHERNUMBER></VOUCHER>", '<LEDGER NAME="Bad" ACTION="Create"><NAME>Bad</NAME></LEDGER>')],
  ])("rejects unsafe Tally XML: %s", async (_label, vouchersXml) => {
    const response = await request(makeApp())
      .post("/api/travel/tally/connector/push")
      .set(auth())
      .send({ vouchersXml });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("UNSAFE_TALLY_XML");
    expect(prisma.travelTallySyncLog.create).not.toHaveBeenCalled();
  });
});
