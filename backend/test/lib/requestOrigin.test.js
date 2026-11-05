const { describe, expect, it, afterEach } = require("vitest");
const { getFrontendUrlFromRequest } = require("../../lib/requestOrigin");

describe("getFrontendUrlFromRequest", () => {
  const originalFrontendUrl = process.env.FRONTEND_URL;

  afterEach(() => {
    if (originalFrontendUrl === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = originalFrontendUrl;
  });

  it("keeps TMC links on the branded host despite the generic frontend override", () => {
    process.env.FRONTEND_URL = "https://globuscrm.com";

    expect(getFrontendUrlFromRequest({
      protocol: "https",
      hostname: "app.themodernclassroom.in",
      get: () => "app.themodernclassroom.in",
    })).toBe("https://app.themodernclassroom.in");
  });

  it("keeps local TMC links on tmc.localhost including its development port", () => {
    process.env.FRONTEND_URL = "https://globuscrm.com";

    expect(getFrontendUrlFromRequest({
      protocol: "http",
      hostname: "tmc.localhost",
      get: (name) => name === "host" ? "tmc.localhost:5173" : "",
    })).toBe("http://tmc.localhost:5173");
  });

  it("uses the approved TMC frontend-origin header when a dev proxy rewrites Host", () => {
    process.env.FRONTEND_URL = "https://globuscrm.com";

    expect(getFrontendUrlFromRequest({
      protocol: "http",
      hostname: "localhost",
      get: (name) => name === "host"
        ? "localhost:5000"
        : name === "x-frontend-origin" ? "http://tmc.localhost:5173" : "",
    })).toBe("http://tmc.localhost:5173");
  });

  it("continues using FRONTEND_URL for non-TMC hosts", () => {
    process.env.FRONTEND_URL = "https://globuscrm.com";

    expect(getFrontendUrlFromRequest({
      protocol: "https",
      hostname: "globuscrm.com",
      get: () => "globuscrm.com",
    })).toBe("https://globuscrm.com");
  });
});
