import { describe, expect, it } from "vitest";
import { getDynamicTallyConnectorUrl } from "./tallyConnectorConfig";

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
});
