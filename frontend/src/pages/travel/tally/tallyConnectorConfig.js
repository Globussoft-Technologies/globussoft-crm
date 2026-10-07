import { getActiveTenantId, getAuthToken } from "../../../utils/api";

const zipCrcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(files) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  files.forEach(({ name, data }) => {
    const nameBytes = encoder.encode(name);
    const bytes = data instanceof Uint8Array ? data : encoder.encode(String(data));
    const checksum = crc32(bytes);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, bytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + bytes.length;
  });

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...localParts, ...centralParts, end], { type: "application/zip" });
}

export function getDynamicTallyConnectorUrl(fallbackUrl = "", pageLocation = globalThis.window?.location) {
  try {
    const configured = new URL(fallbackUrl);
    const configuredProtocol = configured.protocol === "https:" ? "wss:" : configured.protocol === "http:" ? "ws:" : configured.protocol;
    const configuredIsLocal = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(configured.hostname);
    if (["ws:", "wss:"].includes(configuredProtocol) && !configuredIsLocal) {
      configured.protocol = configuredProtocol;
      return configured.toString();
    }
  } catch (_) {
    // Fall through to the browser origin when the backend URL is absent or
    // references an internal/local address that the connector cannot reach.
  }

  if (!pageLocation?.hostname) return fallbackUrl;
  try {
    const protocol = pageLocation.protocol === "https:" ? "wss" : "ws";
    const hostname = pageLocation.hostname;
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    const port = isLocalhost && pageLocation.port ? `:${pageLocation.port}` : "";
    return `${protocol}://${hostname}${port}/ws/tally-connector`;
  } catch (_) {
    return fallbackUrl;
  }
}

export function buildTallyConnectorConfig(credentials) {
  return {
    serverUrl: getDynamicTallyConnectorUrl(credentials.connectorUrl),
    customerId: credentials.customerId,
    connectorId: credentials.connectorId,
    token: credentials.token,
    machineId: "office-pc-1",
    localTallyUrl: "http://127.0.0.1:9000",
    requestTimeoutMs: 45000,
    rejectUnauthorized: true,
  };
}

function connectorRequestHeaders() {
  const token = getAuthToken();
  const activeTenantId = getActiveTenantId();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (activeTenantId != null) headers["X-Active-Tenant"] = String(activeTenantId);
  return headers;
}

export async function fetchTallyConnectorBinary() {
  const response = await fetch("/api/travel/tally/connector/binary", {
    credentials: "include",
    headers: connectorRequestHeaders(),
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || "Could not download the Tally connector executable.");
  }

  return new Uint8Array(await response.arrayBuffer());
}

const deploymentFileNames = ["run-hidden.vbs", "install-startup.ps1", "uninstall-startup.ps1", "README.md"];

export async function fetchTallyConnectorDeploymentFiles() {
  const response = await fetch("/api/travel/tally/connector/deployment-files", {
    credentials: "include",
    headers: connectorRequestHeaders(),
  });
  const details = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(details.error || "Could not download the Tally connector deployment files.");
  }
  const files = details.files;
  if (!Array.isArray(files) || deploymentFileNames.some((name) => !files.some((file) => file.name === name && typeof file.data === "string" && file.data.length > 0))) {
    throw new Error("The Tally connector deployment files are incomplete.");
  }
  return deploymentFileNames.map((name) => files.find((file) => file.name === name));
}

export function downloadTallyConnectorPackage(credentials, executable, deploymentFiles) {
  if (!(executable instanceof Uint8Array) || executable.length === 0) {
    throw new Error("The Tally connector executable is empty.");
  }
  if (!Array.isArray(deploymentFiles) || deploymentFileNames.some((name) => !deploymentFiles.some((file) => file.name === name && typeof file.data === "string" && file.data.length > 0))) {
    throw new Error("The Tally connector deployment files are incomplete.");
  }
  const packageBlob = createStoredZip([
    { name: "TallyConnector.exe", data: executable },
    { name: "config.json", data: JSON.stringify(buildTallyConnectorConfig(credentials), null, 2) },
    ...deploymentFileNames.map((name) => deploymentFiles.find((file) => file.name === name)),
  ]);
  const packageUrl = URL.createObjectURL(packageBlob);
  const anchor = document.createElement("a");
  anchor.href = packageUrl;
  anchor.download = "TallyConnector.zip";
  anchor.click();
  URL.revokeObjectURL(packageUrl);
}
