const fs = require("fs");
const path = require("path");

const runtimeConnectorBinaryPath = path.resolve(
  __dirname,
  "..",
  "runtime-assets",
  "TallyConnector.exe",
);
const sourceConnectorBinaryPath = path.resolve(
  __dirname,
  "..",
  "..",
  "tally-connector",
  "dist",
  "TallyConnector.exe",
);

function connectorBinaryCandidates() {
  const configuredPath = String(process.env.TALLY_CONNECTOR_EXE_PATH || "").trim();
  return [...new Set([
    ...(configuredPath ? [path.resolve(configuredPath)] : []),
    runtimeConnectorBinaryPath,
    sourceConnectorBinaryPath,
  ])];
}

function resolveConnectorBinaryPath() {
  return connectorBinaryCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

function isConnectorBinaryAvailable() {
  return Boolean(resolveConnectorBinaryPath());
}

module.exports = {
  connectorBinaryCandidates,
  isConnectorBinaryAvailable,
  resolveConnectorBinaryPath,
  runtimeConnectorBinaryPath,
  sourceConnectorBinaryPath,
};
