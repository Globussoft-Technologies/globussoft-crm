import { afterEach, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const originalConnectorExePath = process.env.TALLY_CONNECTOR_EXE_PATH;
const {
  connectorBinaryCandidates,
  isConnectorBinaryAvailable,
  resolveConnectorBinaryPath,
  runtimeConnectorBinaryPath,
  sourceConnectorBinaryPath,
} = requireCJS("../../lib/tallyConnectorBinary");

afterEach(() => {
  vi.restoreAllMocks();
  if (originalConnectorExePath === undefined) delete process.env.TALLY_CONNECTOR_EXE_PATH;
  else process.env.TALLY_CONNECTOR_EXE_PATH = originalConnectorExePath;
});

describe("Tally connector binary resolution", () => {
  test("prefers the deployment override, then the backend runtime asset", () => {
    process.env.TALLY_CONNECTOR_EXE_PATH = "./custom/TallyConnector.exe";

    expect(connectorBinaryCandidates()).toEqual([
      expect.stringMatching(/[\\/]custom[\\/]TallyConnector\.exe$/),
      runtimeConnectorBinaryPath,
      sourceConnectorBinaryPath,
    ]);
  });

  test("falls back to the staged backend asset when the override is stale", () => {
    process.env.TALLY_CONNECTOR_EXE_PATH = "/obsolete/TallyConnector.exe";
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => candidate === runtimeConnectorBinaryPath);

    expect(resolveConnectorBinaryPath()).toBe(runtimeConnectorBinaryPath);
    expect(isConnectorBinaryAvailable()).toBe(true);
  });

  test("reports unavailable only when every candidate is missing", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(resolveConnectorBinaryPath()).toBeNull();
    expect(isConnectorBinaryAvailable()).toBe(false);
  });
});
