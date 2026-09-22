'use strict';

const express = require('express');
const { verifyToken, verifyRole } = require('../middleware/auth');
const prisma = require('../lib/prisma');
const {
  encryptTravelHostingCredential,
  decryptTravelHostingCredential,
} = require('../lib/travelHostingCredentialEncryption');
const { writeAudit } = require('../lib/audit');
const {
  DEFAULT_REMOTE_PATH,
  SUPPORTED_PROTOCOLS,
  getDefaultPort,
  normalizeProtocol,
  normalizeRemotePath,
} = require('../services/travelPromotionalWebsitePublisher');

const router = express.Router();
const WEBSITE_KEY = 'travel.promotionalWebsite.url';
const SFTP_KEY = 'travel.promotionalWebsite.sftp';

function requireTravel(req, res) {
  if (String(req.user?.vertical || '').toLowerCase() === 'travel') return true;
  if (req.user?.tenantVertical === 'travel') return true;
  res.status(403).json({ error: 'Promotional website hosting is available for travel tenants only', code: 'TRAVEL_ONLY' });
  return false;
}

function normalizeWebsiteUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch (_err) { throw new Error('Promotional website must be a valid URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Promotional website must be an http(s) URL without credentials, query parameters, or a hash');
  }
  // The landing-page route is always rooted at /trips on the customer's
  // domain. Treat the setting as an origin, so a pasted homepage path cannot
  // silently turn into a different URL than the SFTP document-root mapping.
  return parsed.origin;
}

function parseStoredSftp(value) {
  if (!value) return null;
  const parsed = JSON.parse(decryptTravelHostingCredential(value));
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function maskConfig(websiteUrl, sftp) {
  const protocol = sftp ? normalizeProtocol(sftp.protocol) : 'sftp';
  return {
    websiteUrl: websiteUrl || '',
    configured: Boolean(websiteUrl && sftp?.host && sftp?.username && (protocol === 'sftp' ? (sftp?.password || sftp?.privateKey) : sftp?.password)),
    sftp: sftp ? {
      protocol,
      host: sftp.host || '',
      port: Number(sftp.port || getDefaultPort(protocol)),
      username: sftp.username || '',
      remotePath: normalizeRemotePath(sftp.remotePath || DEFAULT_REMOTE_PATH),
      hasPassword: Boolean(sftp.password),
      hasPrivateKey: protocol === 'sftp' && Boolean(sftp.privateKey),
      passphraseConfigured: protocol === 'sftp' && Boolean(sftp.passphrase),
      hostKeyFingerprint: protocol === 'sftp' ? (sftp.hostKeyFingerprint || '') : '',
    } : {
      protocol: 'sftp', host: '', port: 22, username: '', remotePath: DEFAULT_REMOTE_PATH,
      hasPassword: false, hasPrivateKey: false, passphraseConfigured: false, hostKeyFingerprint: '',
    },
  };
}

async function readConfig(tenantId) {
  const rows = await prisma.tenantSetting.findMany({
    where: { tenantId, key: { in: [WEBSITE_KEY, SFTP_KEY] } },
    select: { id: true, key: true, value: true },
  });
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const websiteUrl = byKey.get(WEBSITE_KEY)?.value || null;
  const sftp = parseStoredSftp(byKey.get(SFTP_KEY)?.value);
  return { websiteUrl, sftp, websiteRow: byKey.get(WEBSITE_KEY) || null, sftpRow: byKey.get(SFTP_KEY) || null };
}

function validateSftp(input) {
  const sftp = input && typeof input === 'object' ? input : {};
  const protocol = normalizeProtocol(sftp.protocol);
  const host = String(sftp.host || '').trim();
  const username = String(sftp.username || '').trim();
  const port = Number(sftp.port || getDefaultPort(protocol));
  const remotePath = normalizeRemotePath(sftp.remotePath || DEFAULT_REMOTE_PATH);
  if (!host || host.length > 253) throw new Error(`${protocol.toUpperCase()} host is required`);
  if (!username || username.length > 128) throw new Error(`${protocol.toUpperCase()} username is required`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Transfer port must be between 1 and 65535');
  if (sftp.password && String(sftp.password).length > 4096) throw new Error(`${protocol.toUpperCase()} password is too long`);
  if (sftp.privateKey && String(sftp.privateKey).length > 100000) throw new Error('SFTP private key is too long');
  if (protocol === 'sftp' && !sftp.password && !sftp.privateKey) throw new Error('SFTP password or private key is required');
  const hostKeyFingerprint = String(sftp.hostKeyFingerprint || '').trim();
  if (protocol === 'sftp' && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKeyFingerprint)) {
    throw new Error('SFTP host key fingerprint is required in SHA256 format');
  }
  if (protocol !== 'sftp' && !sftp.password) throw new Error(`${protocol.toUpperCase()} password is required`);
  return {
    protocol, host, username, port, remotePath,
    ...(sftp.password ? { password: String(sftp.password) } : {}),
    ...(protocol === 'sftp' && sftp.privateKey ? { privateKey: String(sftp.privateKey) } : {}),
    ...(protocol === 'sftp' && sftp.passphrase ? { passphrase: String(sftp.passphrase) } : {}),
    ...(protocol === 'sftp' ? { hostKeyFingerprint } : {}),
  };
}

router.get('/', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  if (!requireTravel(req, res)) return;
  try {
    const config = await readConfig(req.user.tenantId);
    res.json(maskConfig(config.websiteUrl, config.sftp));
  } catch (err) {
    console.error('[travel-promotional-website] GET failed:', err.message);
    const encryptionError = ['TRAVEL_HOSTING_ENCRYPTION_UNAVAILABLE', 'TRAVEL_HOSTING_CREDENTIAL_NOT_ENCRYPTED'].includes(err.code);
    res.status(encryptionError ? 503 : 500).json({
      error: encryptionError ? 'Travel hosting credentials cannot be decrypted safely' : 'Failed to load promotional website settings',
      code: encryptionError ? err.code : 'PROMOTIONAL_WEBSITE_READ_FAILED',
    });
  }
});

router.put('/', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  if (!requireTravel(req, res)) return;
  const tenantId = req.user.tenantId;
  try {
    const websiteUrl = normalizeWebsiteUrl(req.body?.websiteUrl);
    const current = await readConfig(tenantId);
    const inputSftp = req.body?.sftp && typeof req.body.sftp === 'object' ? req.body.sftp : {};
    const suppliedSecret = String(inputSftp.password || '').trim();
    const suppliedPrivateKey = String(inputSftp.privateKey || '').trim();
    const mergedSftp = {
      ...(current.sftp || {}),
      ...inputSftp,
      ...(suppliedSecret ? { password: suppliedSecret } : {}),
      ...(suppliedPrivateKey ? { privateKey: suppliedPrivateKey } : {}),
    };
    const sftp = websiteUrl ? validateSftp(mergedSftp) : null;
    const writes = [];
    if (websiteUrl) {
      // Encrypt before starting either database write so a missing/invalid
      // server key cannot leave a partially configured website URL behind.
      const encryptedSftp = encryptTravelHostingCredential(JSON.stringify(sftp));
      writes.push(prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: WEBSITE_KEY } },
        create: { tenantId, key: WEBSITE_KEY, value: websiteUrl, category: 'travel-hosting' },
        update: { value: websiteUrl, category: 'travel-hosting' },
      }));
      writes.push(prisma.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: SFTP_KEY } },
        create: { tenantId, key: SFTP_KEY, value: encryptedSftp, category: 'travel-hosting' },
        update: { value: encryptedSftp, category: 'travel-hosting' },
      }));
    } else {
      if (current.websiteRow) writes.push(prisma.tenantSetting.delete({ where: { tenantId_key: { tenantId, key: WEBSITE_KEY } } }));
      if (current.sftpRow) writes.push(prisma.tenantSetting.delete({ where: { tenantId_key: { tenantId, key: SFTP_KEY } } }));
    }
    const results = await Promise.all(writes);
    for (const row of results) {
      if (row?.id) await writeAudit('TenantSetting', current.websiteRow?.id === row.id || current.sftpRow?.id === row.id ? 'UPDATE' : 'CREATE', row.id, req.user.userId, tenantId, { key: row.key });
    }
    res.json(maskConfig(websiteUrl, sftp));
  } catch (err) {
    const encryptionUnavailable = err.code === 'TRAVEL_HOSTING_ENCRYPTION_UNAVAILABLE';
    const status = encryptionUnavailable ? 503 : (/required|valid URL|must be|too long|safe directory|fingerprint/i.test(err.message || '') ? 400 : 500);
    console.error('[travel-promotional-website] PUT failed:', err.message);
    res.status(status).json({
      error: encryptionUnavailable ? 'Travel hosting credential encryption is not configured' : (err.message || 'Failed to save promotional website settings'),
      code: encryptionUnavailable ? err.code : (status === 400 ? 'INVALID_PROMOTIONAL_WEBSITE_SETTINGS' : 'PROMOTIONAL_WEBSITE_SAVE_FAILED'),
    });
  }
});

router.post('/test', verifyToken, verifyRole(['ADMIN']), async (req, res) => {
  if (!requireTravel(req, res)) return;
  try {
    const current = await readConfig(req.user.tenantId);
    const input = req.body?.sftp && typeof req.body.sftp === 'object' ? req.body.sftp : {};
    const sftp = validateSftp({ ...(current.sftp || {}), ...input });
    const { withRemoteClient } = require('../services/travelPromotionalWebsitePublisher');
    // Connection testing only authenticates. Publishing verifies the already
    // existing transfer-account root and creates the numeric trip folder.
    await withRemoteClient(sftp, async () => undefined);
    res.json({ ok: true, protocol: sftp.protocol, remotePath: sftp.remotePath });
  } catch (err) {
    console.error('[travel-promotional-website] test failed:', err.message);
    const encryptionError = ['TRAVEL_HOSTING_ENCRYPTION_UNAVAILABLE', 'TRAVEL_HOSTING_CREDENTIAL_NOT_ENCRYPTED'].includes(err.code);
    const isValidationError = /required|too long|must be between|safe directory|protocol|fingerprint|private network/i.test(err.message || '');
    const status = encryptionError ? 503 : (isValidationError ? 400 : 502);
    res.status(status).json({
      error: encryptionError ? 'Travel hosting credentials cannot be decrypted safely' : (isValidationError ? err.message : 'Could not connect to the transfer server'),
      code: encryptionError ? err.code : (isValidationError ? 'INVALID_TRANSFER_SETTINGS' : 'TRANSFER_CONNECTION_FAILED'),
    });
  }
});

module.exports = {
  router,
  WEBSITE_KEY,
  SFTP_KEY,
  SUPPORTED_PROTOCOLS,
  normalizeWebsiteUrl,
  validateSftp,
  parseStoredSftp,
  maskConfig,
  readConfig,
};
