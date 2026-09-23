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

export async function downloadTallyConnectorPackage(credentials) {
  const token = getAuthToken();
  const activeTenantId = getActiveTenantId();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (activeTenantId != null) headers["X-Active-Tenant"] = String(activeTenantId);

  const response = await fetch("/api/travel/tally/connector/binary", {
    credentials: "include",
    headers,
  });
  if (!response.ok) {
    const details = await response.json().catch(() => ({}));
    throw new Error(details.error || "Could not download the Tally connector executable.");
  }

  const executable = new Uint8Array(await response.arrayBuffer());
  const packageBlob = createStoredZip([
    { name: "TallyConnector.exe", data: executable },
    { name: "config.json", data: JSON.stringify(buildTallyConnectorConfig(credentials), null, 2) },
  ]);
  const packageUrl = URL.createObjectURL(packageBlob);
  const anchor = document.createElement("a");
  anchor.href = packageUrl;
  anchor.download = "TallyConnector.zip";
  anchor.click();
  URL.revokeObjectURL(packageUrl);
}
