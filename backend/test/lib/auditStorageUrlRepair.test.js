import { describe, expect, test } from 'vitest';
import audit from '../../lib/audit.js';
import repair from '../../lib/auditStorageUrlRepair.js';

const { computeHash } = audit;
const { assessStorageUrlRepair } = repair;

const oldBase = 'https://old-bucket.s3.example.com';
const newBase = 'https://objectstorage.example.com/n/ns/b/bucket/o';

function buildRow(detailsAtWrite, detailsNow = detailsAtWrite) {
  const row = {
    id: 10,
    tenantId: 73,
    entity: 'BrandKit',
    action: 'UPLOAD',
    entityId: 0,
    userId: 145,
    details: detailsNow,
    createdAt: new Date('2026-07-13T14:40:38.244Z'),
    prevHash: 'a'.repeat(64),
  };
  row.hash = computeHash(row.prevHash, {
    tenantId: row.tenantId,
    entity: row.entity,
    action: row.action,
    entityId: row.entityId,
    userId: row.userId,
    details: detailsAtWrite,
    createdAt: row.createdAt.toISOString(),
  });
  return row;
}

describe('auditStorageUrlRepair', () => {
  test('proves a reversible URL migration against the existing hash', () => {
    const original = JSON.stringify({ logoUrl: `${oldBase}/brand-kits/logo.png` });
    const migrated = original.replace(oldBase, newBase);
    const result = assessStorageUrlRepair(buildRow(original, migrated), { oldBase, newBase });

    expect(result.status).toBe('repairable');
    expect(result.restoredDetails).toBe(original);
  });

  test('does not reverse a legitimate OCI URL that was hashed at creation', () => {
    const details = JSON.stringify({ logoUrl: `${newBase}/brand-kits/logo.png` });
    const result = assessStorageUrlRepair(buildRow(details), { oldBase, newBase });

    expect(result).toEqual({ status: 'already-valid' });
  });

  test('refuses a reverse replacement that does not recreate the stored hash', () => {
    const original = JSON.stringify({ logoUrl: `${oldBase}/brand-kits/logo.png`, name: 'A' });
    const migratedAndTampered = JSON.stringify({
      logoUrl: `${newBase}/brand-kits/logo.png`,
      name: 'B',
    });
    const result = assessStorageUrlRepair(
      buildRow(original, migratedAndTampered),
      { oldBase, newBase },
    );

    expect(result).toEqual({ status: 'unverified-conflict' });
  });

  test('refuses unrelated hash conflicts', () => {
    const row = buildRow('{"name":"A"}', '{"name":"B"}');
    const result = assessStorageUrlRepair(row, { oldBase, newBase });

    expect(result).toEqual({ status: 'unverified-conflict' });
  });
});
