import http from "node:http";
import { WebSocket } from "ws";
import { Server as SocketIOServer } from "socket.io";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createRequire } from "node:module";

const requireCJS = createRequire(import.meta.url);
const {
  CONNECTOR_PATH,
  attachTallyConnectorBridge,
  createConnectorCredentials,
  getConnectorStatus,
  hashToken,
  parseTallyResponse,
  sendTallyJob,
} = requireCJS("../../lib/tallyConnectorBridge");
const prisma = requireCJS("../../lib/prisma");
const { attachCallifiedAgentBridge } = requireCJS("../../lib/callifiedAgentBridge");

afterEach(() => vi.restoreAllMocks());

describe("Tally connector bridge", () => {
  test("coexists with Callified and Socket.IO WebSocket upgrades", async () => {
    const server = http.createServer();
    attachCallifiedAgentBridge(server);
    attachTallyConnectorBridge(server);
    const io = new SocketIOServer(server, { transports: ["websocket"] });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/socket.io/?EIO=4&transport=websocket`,
    );

    const handshake = await new Promise((resolve, reject) => {
      client.once("message", (data) => resolve(String(data)));
      client.once("error", reject);
    });
    expect(handshake).toMatch(/^0\{/);

    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    await new Promise((resolve) => io.close(resolve));
  });
  test("generates one-time credentials while storing only the token hash", () => {
    const credentials = createConnectorCredentials();
    expect(credentials.token).toMatch(/^[a-f0-9]{64}$/);
    expect(credentials.stored.connectorId).toMatch(/^tally_[a-f0-9]{24}$/);
    expect(credentials.stored.tokenHash).toBe(hashToken(credentials.token));
    expect(credentials.stored).not.toHaveProperty("token");
  });

  test("parses a successful Tally import response", () => {
    expect(parseTallyResponse(`
      <RESPONSE><CREATED>3</CREATED><ALTERED>1</ALTERED>
      <ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS><IGNORED>0</IGNORED></RESPONSE>
    `)).toMatchObject({ success: true, created: 3, altered: 1, errors: 0, exceptions: 0 });
  });

  test("treats line errors and exception counts as failed imports", () => {
    expect(parseTallyResponse("<RESPONSE><ERRORS>1</ERRORS><LINEERROR>Ledger does not exist</LINEERROR></RESPONSE>"))
      .toMatchObject({ success: false, errors: 1, lineError: "Ledger does not exist" });
    expect(parseTallyResponse("<RESPONSE><EXCEPTIONS>2</EXCEPTIONS></RESPONSE>").success).toBe(false);
    expect(parseTallyResponse("").success).toBe(false);
    expect(parseTallyResponse("<html>proxy error</html>").success).toBe(false);
  });

  test("reports offline and refuses jobs when no connector is attached", async () => {
    expect(CONNECTOR_PATH).toBe("/ws/tally-connector");
    expect(getConnectorStatus(987654)).toMatchObject({ online: false, machineId: null });
    await expect(sendTallyJob(987654, "<ENVELOPE></ENVELOPE>")).rejects.toMatchObject({ code: "TALLY_CONNECTOR_OFFLINE" });
  });

  test("rejects empty and oversized XML before looking for a connection", async () => {
    await expect(sendTallyJob(1, "")).rejects.toMatchObject({ code: "INVALID_TALLY_XML_SIZE" });
    await expect(sendTallyJob(1, "x".repeat(8 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: "INVALID_TALLY_XML_SIZE" });
  });

  test("authenticates a connector and completes a correlated XML job", async () => {
    const tenantId = 876543;
    const credentials = createConnectorCredentials();
    prisma.integration.findUnique = vi.fn().mockResolvedValue({
      token: credentials.stored.tokenHash,
      settings: JSON.stringify({ connectorId: credentials.stored.connectorId }),
      isActive: true,
    });

    const server = http.createServer();
    const wss = attachTallyConnectorBridge(server);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}${CONNECTOR_PATH}?customerId=${tenantId}&connectorId=${credentials.stored.connectorId}`,
      { headers: { Authorization: `Bearer ${credentials.token}` } },
    );
    await new Promise((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });

    client.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message.type !== "job") return;
      client.send(JSON.stringify({
        type: "job_result",
        jobId: message.jobId,
        status: "success",
        responseXml: "<RESPONSE><CREATED>1</CREATED><ERRORS>0</ERRORS></RESPONSE>",
      }));
    });
    const result = await sendTallyJob(tenantId, "<ENVELOPE></ENVELOPE>", { timeoutMs: 2000 });
    expect(result.tally).toMatchObject({ success: true, created: 1 });
    expect(getConnectorStatus(tenantId).online).toBe(true);

    client.close();
    await new Promise((resolve) => client.once("close", resolve));
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    delete prisma.integration.findUnique;
  });
});
