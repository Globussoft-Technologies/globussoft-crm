// @ts-check

import { describe, test, expect, beforeEach, vi } from "vitest";
import prisma from "../../lib/prisma.js";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const { ensurePatientContact } = requireCJS("../../lib/patientContactLink");

beforeEach(() => {
  prisma.contact = {
    findFirst: vi.fn().mockResolvedValue(null),
    create: vi.fn(),
    update: vi.fn(),
  };
  prisma.patient = {
    update: vi.fn(),
  };
});

describe("ensurePatientContact", () => {
  test("creates a canonical Lead and back-links a newly registered patient", async () => {
    prisma.contact.create.mockImplementation(({ data }) => ({ id: 81, ...data }));

    const contact = await ensurePatientContact(
      {
        id: 501,
        name: "Mickey",
        email: "mickey@example.com",
        phone: "+919876500001",
      },
      45,
    );

    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: {
        name: "Mickey",
        email: "mickey@example.com",
        phone: "+919876500001",
        tenantId: 45,
        status: "Lead",
        source: "wellness-customer-registration",
      },
    });
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 501 },
      data: { contactId: 81 },
    });
    expect(contact.id).toBe(81);
  });

  test("reuses an existing tenant contact instead of creating a duplicate", async () => {
    const existing = {
      id: 82,
      name: "Mickey",
      email: "mickey@example.com",
      phone: "+919876500001",
      status: "Lead",
    };
    prisma.contact.findFirst.mockResolvedValue(existing);

    const contact = await ensurePatientContact(
      {
        id: 502,
        name: "Mickey",
        email: "mickey@example.com",
        phone: "+919876500001",
      },
      45,
    );

    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 45,
        deletedAt: null,
        OR: [
          { email: "mickey@example.com" },
          { phone: "+919876500001" },
        ],
      },
    });
    expect(prisma.contact.create).not.toHaveBeenCalled();
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 502 },
      data: { contactId: 82 },
    });
    expect(contact).toBe(existing);
  });

  test("does not cross tenant boundaries when resolving an existing link", async () => {
    const patient = {
      id: 503,
      name: "Mickey",
      email: "mickey@example.com",
      phone: null,
      contactId: 99,
    };
    prisma.contact.findUnique = vi.fn().mockResolvedValue({
      id: 99,
      tenantId: 88,
      name: "Other Tenant",
      email: "other@example.com",
      phone: null,
    });
    prisma.contact.create.mockImplementation(({ data }) => ({ id: 100, ...data }));

    await ensurePatientContact(patient, 45);

    expect(prisma.contact.findUnique).toHaveBeenCalledWith({
      where: { id: 99 },
    });
    expect(prisma.contact.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 45,
        deletedAt: null,
        OR: [{ email: "mickey@example.com" }],
      },
    });
    expect(prisma.contact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: 45, status: "Lead" }),
    });
  });
});
