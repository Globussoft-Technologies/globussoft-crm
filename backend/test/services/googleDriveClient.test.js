// Unit tests for backend/services/googleDriveClient.js
//
// What this module does:
//   Stub-mode wrapper for Google Drive folder creation on TMC trip
//   confirmation. Real OAuth + drive.files.create wires in when Q1
//   Workspace admin creds drop (GOOGLE_WORKSPACE_CLIENT_ID/_SECRET/
//   _REFRESH_TOKEN). Three functions:
//     - driveEnabled()                              — true iff all 3 env vars set
//     - buildFolderName({ tripCode, destination, departDate }) → string
//     - createTripFolder({ tripCode, destination, departDate }) →
//         { folderId, folderUrl, folderName }
//
// Surface area covered:
//   - module shape (all three functions exported)
//   - driveEnabled
//       - false when no env vars set
//       - false when only 2 of 3 env vars set (partial config)
//       - true when all 3 env vars set
//   - buildFolderName
//       - all-fields-present matches the placeholder convention
//       - "TBD" fallback for missing destination
//       - "TBD" fallback for null/missing departDate
//       - "TBD" fallback for unparseable departDate string
//       - YYYY-MM zero-pads single-digit month
//       - accepts both Date object + ISO string for departDate
//   - createTripFolder
//       - throws when tripCode is missing
//       - returns deterministic folderId for same tripCode (hash-derived)
//       - different tripCodes yield different folderIds
//       - folderUrl is a drive.google.com URL containing folderId
//       - folderName matches buildFolderName output
//       - folderId matches the synthetic prefix shape
//
// Pin the contract the REAL implementation MUST honour when the stub
// gets swapped — routes/travel_trips.js POST + PATCH handlers depend
// on the { folderId, folderUrl, folderName } envelope.

import { describe, test, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);

const ORIGINAL_CLIENT_ID = process.env.GOOGLE_WORKSPACE_CLIENT_ID;
const ORIGINAL_CLIENT_SECRET = process.env.GOOGLE_WORKSPACE_CLIENT_SECRET;
const ORIGINAL_REFRESH_TOKEN = process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN;

afterEach(() => {
  // Restore env between tests so driveEnabled() flip-flops cleanly.
  if (ORIGINAL_CLIENT_ID === undefined) delete process.env.GOOGLE_WORKSPACE_CLIENT_ID;
  else process.env.GOOGLE_WORKSPACE_CLIENT_ID = ORIGINAL_CLIENT_ID;
  if (ORIGINAL_CLIENT_SECRET === undefined) delete process.env.GOOGLE_WORKSPACE_CLIENT_SECRET;
  else process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = ORIGINAL_CLIENT_SECRET;
  if (ORIGINAL_REFRESH_TOKEN === undefined) delete process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN;
  else process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN = ORIGINAL_REFRESH_TOKEN;
});

function loadClient() {
  delete requireCjs.cache[requireCjs.resolve('../../services/googleDriveClient.js')];
  return requireCjs('../../services/googleDriveClient.js');
}

describe('googleDriveClient — module shape', () => {
  test('exports driveEnabled, buildFolderName, createTripFolder', () => {
    const client = loadClient();
    expect(typeof client.driveEnabled).toBe('function');
    expect(typeof client.buildFolderName).toBe('function');
    expect(typeof client.createTripFolder).toBe('function');
  });
});

describe('driveEnabled', () => {
  test('returns false when no env vars are set', () => {
    delete process.env.GOOGLE_WORKSPACE_CLIENT_ID;
    delete process.env.GOOGLE_WORKSPACE_CLIENT_SECRET;
    delete process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN;
    const client = loadClient();
    expect(client.driveEnabled()).toBe(false);
  });

  test('returns false when only CLIENT_ID + CLIENT_SECRET are set (no refresh token)', () => {
    process.env.GOOGLE_WORKSPACE_CLIENT_ID = 'real-id';
    process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = 'real-secret';
    delete process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN;
    const client = loadClient();
    expect(client.driveEnabled()).toBe(false);
  });

  test('returns false when only REFRESH_TOKEN is set', () => {
    delete process.env.GOOGLE_WORKSPACE_CLIENT_ID;
    delete process.env.GOOGLE_WORKSPACE_CLIENT_SECRET;
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN = 'refresh-token';
    const client = loadClient();
    expect(client.driveEnabled()).toBe(false);
  });

  test('returns true when all three env vars are set', () => {
    process.env.GOOGLE_WORKSPACE_CLIENT_ID = 'real-id';
    process.env.GOOGLE_WORKSPACE_CLIENT_SECRET = 'real-secret';
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN = 'refresh-token';
    const client = loadClient();
    expect(client.driveEnabled()).toBe(true);
  });
});

describe('buildFolderName', () => {
  test('matches the placeholder convention with all fields present', () => {
    const client = loadClient();
    const name = client.buildFolderName({
      tripCode: 'bali2026',
      destination: 'Bali, Indonesia',
      departDate: '2026-09-15',
    });
    expect(name).toBe('TMC Trip — bali2026 — Bali, Indonesia — 2026-09');
  });

  test('substitutes "TBD" for missing destination', () => {
    const client = loadClient();
    const name = client.buildFolderName({
      tripCode: 'trip1',
      destination: null,
      departDate: '2026-03-10',
    });
    expect(name).toBe('TMC Trip — trip1 — TBD — 2026-03');
  });

  test('substitutes "TBD" for null departDate', () => {
    const client = loadClient();
    const name = client.buildFolderName({
      tripCode: 'trip2',
      destination: 'Goa',
      departDate: null,
    });
    expect(name).toBe('TMC Trip — trip2 — Goa — TBD');
  });

  test('substitutes "TBD" for unparseable departDate', () => {
    const client = loadClient();
    const name = client.buildFolderName({
      tripCode: 'trip3',
      destination: 'Goa',
      departDate: 'not-a-date',
    });
    expect(name).toBe('TMC Trip — trip3 — Goa — TBD');
  });

  test('zero-pads single-digit month in YYYY-MM', () => {
    const client = loadClient();
    const name = client.buildFolderName({
      tripCode: 'jan',
      destination: 'Delhi',
      departDate: '2026-01-05',
    });
    expect(name).toContain('— 2026-01');
  });

  test('accepts both Date object + ISO string for departDate', () => {
    const client = loadClient();
    const fromString = client.buildFolderName({
      tripCode: 'trip-x',
      destination: 'Mumbai',
      departDate: '2026-07-20',
    });
    const fromDate = client.buildFolderName({
      tripCode: 'trip-x',
      destination: 'Mumbai',
      departDate: new Date('2026-07-20'),
    });
    expect(fromString).toBe(fromDate);
    expect(fromString).toContain('— 2026-07');
  });
});

describe('createTripFolder', () => {
  test('throws when tripCode is missing', async () => {
    const client = loadClient();
    await expect(client.createTripFolder({ destination: 'x', departDate: '2026-01-01' }))
      .rejects.toThrow(/tripCode required/);
  });

  test('throws when tripCode is empty string', async () => {
    const client = loadClient();
    await expect(client.createTripFolder({ tripCode: '', destination: 'x', departDate: '2026-01-01' }))
      .rejects.toThrow(/tripCode required/);
  });

  test('returns deterministic folderId for the same tripCode (hash-derived)', async () => {
    const client = loadClient();
    const a = await client.createTripFolder({
      tripCode: 'same-code',
      destination: 'A',
      departDate: '2026-08-01',
    });
    const b = await client.createTripFolder({
      tripCode: 'same-code',
      destination: 'B', // different destination — folderId still derives only from tripCode
      departDate: '2026-12-31',
    });
    expect(a.folderId).toBe(b.folderId);
    expect(a.folderId).toMatch(/^stub-folder-[0-9a-f]{24}$/);
  });

  test('different tripCodes yield different folderIds', async () => {
    const client = loadClient();
    const a = await client.createTripFolder({
      tripCode: 'trip-a',
      destination: 'X',
      departDate: '2026-06-01',
    });
    const b = await client.createTripFolder({
      tripCode: 'trip-b',
      destination: 'X',
      departDate: '2026-06-01',
    });
    expect(a.folderId).not.toBe(b.folderId);
  });

  test('folderUrl is a drive.google.com URL containing folderId', async () => {
    const client = loadClient();
    const out = await client.createTripFolder({
      tripCode: 'url-test',
      destination: 'Goa',
      departDate: '2026-04-12',
    });
    expect(out.folderUrl).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    expect(out.folderUrl).toContain(out.folderId);
  });

  test('returned folderName matches buildFolderName output', async () => {
    const client = loadClient();
    const out = await client.createTripFolder({
      tripCode: 'name-test',
      destination: 'Manali',
      departDate: '2026-11-22',
    });
    const expected = client.buildFolderName({
      tripCode: 'name-test',
      destination: 'Manali',
      departDate: '2026-11-22',
    });
    expect(out.folderName).toBe(expected);
    expect(out.folderName).toContain('TMC Trip — name-test — Manali — 2026-11');
  });

  test('folderId carries the synthetic stub prefix', async () => {
    const client = loadClient();
    const out = await client.createTripFolder({
      tripCode: 'prefix-test',
      destination: 'd',
      departDate: '2026-05-05',
    });
    expect(out.folderId.startsWith('stub-folder-')).toBe(true);
  });
});
