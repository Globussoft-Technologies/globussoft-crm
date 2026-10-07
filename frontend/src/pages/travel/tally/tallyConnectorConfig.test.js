import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadTallyConnectorPackage,
  fetchTallyConnectorBinary,
  fetchTallyConnectorDeploymentFiles,
  getDynamicTallyConnectorUrl,
} from "./tallyConnectorConfig";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getDynamicTallyConnectorUrl", () => {
  it("uses the public page origin without leaking the backend fallback port", () => {
    const result = new URL(getDynamicTallyConnectorUrl("ws://localhost:5000/ws/tally-connector"));

    expect(result.hostname).toBe(window.location.hostname);
    expect(result.port).toBe(window.location.port);
    expect(result.pathname).toBe("/ws/tally-connector");
    expect(result.protocol).toBe(window.location.protocol === "https:" ? "wss:" : "ws:");
  });

  it("removes an internal port reported on a public tunnel hostname", () => {
    const result = getDynamicTallyConnectorUrl("ws://localhost:5000/ws/tally-connector", {
      protocol: "https:",
      hostname: "15205pw4-5173.inc1.devtunnels.ms",
      port: "5000",
    });

    expect(result).toBe("wss://15205pw4-5173.inc1.devtunnels.ms/ws/tally-connector");
  });

  it("keeps the Vite port for local development", () => {
    const result = getDynamicTallyConnectorUrl("", {
      protocol: "http:",
      hostname: "localhost",
      port: "5173",
    });

    expect(result).toBe("ws://localhost:5173/ws/tally-connector");
  });

  it("keeps a deployment-provided public connector URL", () => {
    const result = getDynamicTallyConnectorUrl("https://connector.example.test/ws/tally-connector");

    expect(result).toBe("wss://connector.example.test/ws/tally-connector");
  });

  it("fails before packaging when the executable is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      json: vi.fn().mockResolvedValue({ error: "Connector binary is unavailable" }),
    }));

    await expect(fetchTallyConnectorBinary()).rejects.toThrow("Connector binary is unavailable");
  });

  it("rejects incomplete deployment files before creating the ZIP", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ files: [{ name: "run-hidden.vbs", data: "test" }] }),
    }));

    await expect(fetchTallyConnectorDeploymentFiles()).rejects.toThrow("incomplete");
  });

  it("includes the install, uninstall, launcher, and instructions in the downloaded ZIP", async () => {
    const files = ["run-hidden.vbs", "install-startup.ps1", "uninstall-startup.ps1", "README.md"]
      .map((name) => ({ name, data: `contents of ${name}` }));
    const createObjectURL = vi.fn(() => "blob:tally-connector");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      downloadTallyConnectorPackage({
        connectorUrl: "wss://crm.example.test/ws/tally-connector",
        customerId: 1,
        connectorId: "tally-test",
        token: "test-token",
      }, new Uint8Array([1, 2, 3]), files);

      const blob = createObjectURL.mock.calls[0][0];
      const bytes = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(new Uint8Array(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(blob);
      });
      const names = [];
      const view = new DataView(bytes.buffer);
      const decoder = new TextDecoder();
      for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
        const nameLength = view.getUint16(offset + 26, true);
        const size = view.getUint32(offset + 18, true);
        names.push(decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)));
        offset += 30 + nameLength + size;
      }
      expect(names).toEqual(["TallyConnector.exe", "config.json", ...files.map((file) => file.name)]);
    } finally {
      click.mockRestore();
    }
  });
});
