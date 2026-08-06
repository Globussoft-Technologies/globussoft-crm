/**
 * Google Drive OAuth helper for the Travel CRM RAG knowledge base.
 *
 * Replaces the service-account-key flow with a user-facing OAuth consent screen:
 *   1. Admin clicks "Connect Google Drive" in the CRM.
 *   2. Google asks permission to read Drive files.
 *   3. Backend receives an authorization code and stores the refresh token in
 *      TenantSetting (key `travel.knowledgeBase.googleRefreshToken`).
 *   4. Sync engine uses the stored refresh token to create a Drive client.
 *
 * Scope: `https://www.googleapis.com/auth/drive.readonly` (see files + metadata).
 */

const { google } = require("googleapis");
const prisma = require("./prisma");

const CONFIG_KEY = "travel.knowledgeBase.googleRefreshToken";

function getClientConfig() {
  // Dedicated env vars for the Travel Knowledge Base so they don't collide with
  // the Google Calendar / SSO OAuth client (which uses GOOGLE_CLIENT_ID etc.).
  const clientId = process.env.GOOGLE_DRIVE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_DRIVE_REDIRECT_URI || process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri };
}

function createOAuthClient() {
  const cfg = getClientConfig();
  if (!cfg) {
    const err = new Error("Google OAuth is not configured (missing GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)");
    err.code = "OAUTH_NOT_CONFIGURED";
    throw err;
  }
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri);
}

function getAuthUrl(state) {
  const oauth2Client = createOAuthClient();
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
    state: state || "",
  });
}

async function exchangeCode(code) {
  const oauth2Client = createOAuthClient();
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
}

async function getStoredTokens(tenantId) {
  const row = await prisma.tenantSetting.findUnique({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
  });
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

async function storeTokens(tenantId, tokens) {
  const value = JSON.stringify({
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expiry_date: tokens.expiry_date,
    token_type: tokens.token_type || "Bearer",
  });
  await prisma.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: CONFIG_KEY } },
    create: {
      tenantId,
      key: CONFIG_KEY,
      value,
      category: "travel",
    },
    update: { value, category: "travel" },
  });
}

async function isConnected(tenantId) {
  const tokens = await getStoredTokens(tenantId);
  return Boolean(tokens?.refresh_token);
}

async function getDriveClient(tenantId) {
  const tokens = await getStoredTokens(tenantId);
  if (!tokens?.refresh_token) {
    const err = new Error("Google Drive is not connected. Please connect in Travel Knowledge settings.");
    err.code = "DRIVE_NOT_CONNECTED";
    throw err;
  }
  const oauth2Client = createOAuthClient();
  oauth2Client.setCredentials(tokens);
  // Auto-refresh when access token expires; update stored token if a new one is issued.
  oauth2Client.on("tokens", async (newTokens) => {
    if (newTokens.refresh_token || newTokens.access_token) {
      const current = await getStoredTokens(tenantId);
      await storeTokens(tenantId, { ...current, ...newTokens });
    }
  });
  return google.drive({ version: "v3", auth: oauth2Client });
}

async function disconnectTokens(tenantId) {
  await prisma.tenantSetting.deleteMany({
    where: { tenantId, key: CONFIG_KEY },
  });
}

async function getUserInfo(drive) {
  const res = await drive.about.get({ fields: "user(displayName,emailAddress,photoLink)" });
  return res.data.user || null;
}

async function listFolders(drive, parentId = "root") {
  const items = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "nextPageToken, files(id, name, createdTime, modifiedTime)",
      pageSize: 1000,
      orderBy: "name",
      pageToken: pageToken || undefined,
    });
    for (const f of res.data.files || []) items.push(f);
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

async function getFolderById(drive, folderId) {
  const res = await drive.files.get({
    fileId: folderId,
    fields: "id, name, parents, mimeType",
  });
  return res.data;
}

function isConfigured() {
  return !!getClientConfig();
}

module.exports = {
  isConfigured,
  createOAuthClient,
  getAuthUrl,
  exchangeCode,
  getStoredTokens,
  storeTokens,
  disconnectTokens,
  isConnected,
  getDriveClient,
  getUserInfo,
  listFolders,
  getFolderById,
};
