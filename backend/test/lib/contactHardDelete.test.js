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
});
