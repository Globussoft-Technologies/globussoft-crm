import { describe, expect, test } from "vitest";
import jwt from "jsonwebtoken";

import {
  buildTmcParentRegistrationUrl,
  createTmcParentRegistrationToken,
  getTmcRegistrationContext,
  setTmcRegistrationContext,
  verifyTmcRegistrationToken,
  clearTmcRegistrationContext,
} from "../../lib/tmcRegistrationContext.js";
import { JWT_SECRET } from "../../config/secrets.js";

describe("tmcRegistrationContext", () => {
  test("builds a stable non-expiring parent link for one teacher and trip", () => {
    const params = { tenantId: 7, teacherContactId: 4, tripId: 12, baseUrl: "http://localhost:5173/" };
    const first = buildTmcParentRegistrationUrl(params);
    const second = buildTmcParentRegistrationUrl(params);
    const token = first.split("token=")[1];

    expect(first).toBe(second);
    expect(first).toContain("/tmc/register/parent?token=");
    expect(jwt.decode(decodeURIComponent(token))).toMatchObject({
      registrationType: "PARENT",
      subBrand: "tmc",
      tenantId: 7,
      teacherContactId: 4,
      tripId: 12,
    });
    expect(jwt.decode(createTmcParentRegistrationToken(params))).not.toHaveProperty("exp");
  });

  test("accepts a signed teacher registration context", () => {
    const token = jwt.sign(
      { type: "TMC_REGISTRATION", registrationType: "TEACHER", subBrand: "tmc", tenantId: 7 },
      JWT_SECRET,
      { expiresIn: "15m" },
    );

    expect(verifyTmcRegistrationToken(token)).toMatchObject({
      registrationType: "TEACHER",
      subBrand: "tmc",
      tenantId: 7,
    });
  });

  test("allows the permanent teacher route to omit a tenant until the form selection", () => {
    const token = jwt.sign(
      { type: "TMC_REGISTRATION", registrationType: "TEACHER", subBrand: "tmc" },
      JWT_SECRET,
      { expiresIn: "1h" },
    );
    expect(verifyTmcRegistrationToken(token)).toMatchObject({
      registrationType: "TEACHER",
      tenantId: null,
    });
  });

  test("rejects a non-TMC or incomplete context", () => {
    const token = jwt.sign(
      { type: "TMC_REGISTRATION", registrationType: "PARENT", subBrand: "rfu", tenantId: 7 },
      JWT_SECRET,
      { expiresIn: "15m" },
    );
    expect(verifyTmcRegistrationToken(token)).toBeNull();
    expect(verifyTmcRegistrationToken("not-a-token")).toBeNull();
  });

  test("reads, sets, and clears the HttpOnly registration cookie", () => {
    const token = jwt.sign(
      { registrationType: "PARENT", subBrand: "tmc", tenantId: 7, teacherContactId: 4, tripId: 12 },
      JWT_SECRET,
      { expiresIn: "15m" },
    );
    const cookies = {};
    const response = {
      cookie(name, value, options) { cookies[name] = { value, options }; },
      clearCookie(name, options) { cookies[name] = { cleared: true, options }; },
    };

    setTmcRegistrationContext(response, token);
    expect(getTmcRegistrationContext({ cookies: { tmc_registration_context: token } })).toMatchObject({
      registrationType: "PARENT",
      tenantId: 7,
      teacherContactId: 4,
      tripId: 12,
    });
    expect(cookies.tmc_registration_context.options.httpOnly).toBe(true);
    clearTmcRegistrationContext(response);
    expect(cookies.tmc_registration_context.cleared).toBe(true);
  });
});
