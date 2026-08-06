import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);

const prisma = requireCJS("../../lib/prisma");
const externalAuth = requireCJS("../../middleware/externalAuth.js");

let originalFindUnique;
let originalUpdate;
let findUniqueMock;
let updateMock;

beforeEach(() => {
  originalFindUnique = prisma.apiKey.findUnique;
  originalUpdate = prisma.apiKey.update;
  findUniqueMock = vi.fn();
  updateMock = vi.fn().mockResolvedValue({});
  prisma.apiKey.findUnique = findUniqueMock;
  prisma.apiKey.update = updateMock;
});

afterEach(() => {
  prisma.apiKey.findUnique = originalFindUnique;
  prisma.apiKey.update = originalUpdate;
});

function makeReqResNext({ headers = {} } = {}) {
  const lower = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  const req = {
    headers: lower,
    header(name) {
      return lower[String(name).toLowerCase()];
    },
  };
  let statusCode = 200;
  const res = {
    status: vi.fn(function (c) {
      statusCode = c;
      return this;
    }),
    json: vi.fn(function (data) {
      this.body = data;
      return this;
    }),
    get statusCode() {
      return statusCode;
    },
  };
  const next = vi.fn();
  return { req, res, next };
}

describe("externalAuth", () => {
  it("returns 401 when no X-API-Key header", async () => {
    const { req, res, next } = makeReqResNext();
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing X-API-Key header" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 on malformed key", async () => {
    const { req, res, next } = makeReqResNext({ headers: { "x-api-key": "not-a-key" } });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Malformed API key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 on bogus key", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { req, res, next } = makeReqResNext({
      headers: { "x-api-key": "glbs_" + "a".repeat(48) },
    });
    await externalAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  it("happy path populates req.user and calls next", async () => {
    const tenant = { id: 7, isActive: true, name: "Wellness" };
    const apiKey = {
      id: 99,
      tenantId: 7,
      userId: 4,
      keySecret: "glbs_" + "d".repeat(48),
      tenant,
    };
    findUniqueMock.mockResolvedValueOnce(apiKey);
    const { req, res, next } = makeReqResNext({
      headers: { "x-api-key": "glbs_" + "d".repeat(48) },
    });
    await externalAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.apiKey).toBe(apiKey);
    expect(req.tenant).toBe(tenant);
    expect(req.tenantId).toBe(7);
    expect(req.user).toEqual({ tenantId: 7, id: 4, apiKeyId: 99 });
  });
});
