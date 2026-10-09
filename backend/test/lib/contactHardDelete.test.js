import { describe, expect, test, vi } from "vitest";

import {
  CONTACT_ID_CHILDREN,
  hardDeleteContact,
  hardDeleteContacts,
} from "../../lib/contactHardDelete.js";

function buildTransactionMock() {
  const tx = {
    contact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    tmcParentTrip: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    tmcTrip: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    transportPerson: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    plotBroker: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    billingPerson: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
  };
  for (const [model] of CONTACT_ID_CHILDREN) {
    tx[model] = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) };
  }
  return tx;
}

describe("contactHardDelete", () => {
  test("deduplicates IDs, cleans owned rows, and deletes the Contact rows in one transaction", async () => {
    const tx = buildTransactionMock();
    const db = {
      $transaction: vi.fn(async (callback) => callback(tx)),
    };

    const deleted = await hardDeleteContacts(db, [42, "42", 0, "invalid", 43]);

    expect(deleted).toBe(2);
    expect(db.$transaction).toHaveBeenCalledOnce();
    expect(tx.tmcParentTrip.deleteMany).toHaveBeenCalledWith({
      where: { OR: [{ parentContactId: 42 }, { teacherContactId: 42 }] },
    });
    expect(tx.tmcTrip.updateMany).toHaveBeenCalledWith({
      where: { teacherContactId: 42 },
      data: { teacherContactId: null },
    });
    expect(tx.activity.deleteMany).toHaveBeenCalledWith({ where: { contactId: 42 } });
    expect(tx.tmcParentDocument.deleteMany).toHaveBeenCalledWith({ where: { parentContactId: 42 } });
    expect(tx.contact.deleteMany).toHaveBeenNthCalledWith(1, { where: { id: 42 } });
    expect(tx.contact.deleteMany).toHaveBeenNthCalledWith(2, { where: { id: 43 } });
  });

  test("returns zero without opening a transaction for an empty ID list", async () => {
    const db = { $transaction: vi.fn() };

    await expect(hardDeleteContacts(db, [null, "not-a-number", 0])).resolves.toBe(0);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  test("single-contact helper delegates to the same hard-delete path", async () => {
    const tx = buildTransactionMock();
    const db = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(hardDeleteContact(db, 91)).resolves.toBe(1);
    expect(tx.contact.deleteMany).toHaveBeenCalledWith({ where: { id: 91 } });
  });

  test("removes the deleted customer from transport, broker, and billing assignment JSON", async () => {
    const tx = buildTransactionMock();
    tx.transportPerson.findMany.mockResolvedValue([{
      id: 11,
      customerIdsJson: "[61,62]",
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":62,"plotSiteId":31}]',
      assignmentStatusJson: '{"customer-61-plot-30":{"status":"COMPLETED"},"customer-62-plot-31":{"status":"ASSIGNED"}}',
    }]);
    tx.plotBroker.findMany.mockResolvedValue([{
      id: 12,
      customerIdsJson: "[61]",
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30}]',
      workflowStatusJson: '{"customer-61":{"status":"INTEREST_CONFIRMED"}}',
    }]);
    tx.billingPerson.findMany.mockResolvedValue([{
      id: 13,
      customerIdsJson: "[61,63]",
      assignmentPairsJson: '[{"customerId":61,"plotSiteId":30},{"customerId":63,"plotSiteId":32}]',
    }]);
    const db = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await hardDeleteContact(db, 61);

    expect(tx.transportPerson.update).toHaveBeenCalledWith({ where: { id: 11 }, data: {
      customerIdsJson: "[62]",
      assignmentPairsJson: '[{"customerId":62,"plotSiteId":31}]',
      assignmentStatusJson: '{"customer-62-plot-31":{"status":"ASSIGNED"}}',
    } });
    expect(tx.plotBroker.update).toHaveBeenCalledWith({ where: { id: 12 }, data: {
      customerIdsJson: null, assignmentPairsJson: null, workflowStatusJson: null,
    } });
    expect(tx.billingPerson.update).toHaveBeenCalledWith({ where: { id: 13 }, data: {
      customerIdsJson: "[63]", assignmentPairsJson: '[{"customerId":63,"plotSiteId":32}]',
    } });
  });

  test("deletes the contact when optional TMC relations are absent from an older Prisma client", async () => {
    const tx = buildTransactionMock();
    delete tx.tmcParentTrip;
    const validationError = new Error("Unknown argument `teacherContactId`.");
    validationError.name = "PrismaClientValidationError";
    tx.tmcTrip.updateMany.mockRejectedValueOnce(validationError);
    const db = { $transaction: vi.fn(async (callback) => callback(tx)) };

    await expect(hardDeleteContact(db, 38)).resolves.toBe(1);
    expect(tx.contact.deleteMany).toHaveBeenCalledWith({ where: { id: 38 } });
  });
});
