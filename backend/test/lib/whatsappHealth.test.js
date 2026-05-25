// Unit tests for backend/lib/whatsappHealth.js
//
// Pure function over a WhatsAppConfig row → status object. Pins the
// decision-precedence ordering and the human-readable label per state.
// Used by GET /api/whatsapp/onboard/status and the frontend Channels.jsx
// integration badge.

import { describe, test, expect } from 'vitest';
import { computeStatus } from '../../lib/whatsappHealth.js';

const future30d = () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const future3d  = () => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
const past1d    = () => new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);

describe('computeStatus', () => {
  test('null config → NOT_CONNECTED', () => {
    expect(computeStatus(null).status).toBe('NOT_CONNECTED');
  });

  test('disconnectedAt set → DISCONNECTED (precedence over expiry checks)', () => {
    const s = computeStatus({ disconnectedAt: past1d(), isActive: false });
    expect(s.status).toBe('DISCONNECTED');
    expect(s.severity).toBe('warn');
  });

  test('isActive=false without disconnectedAt → NOT_CONNECTED', () => {
    const s = computeStatus({ disconnectedAt: null, isActive: false });
    expect(s.status).toBe('NOT_CONNECTED');
  });

  test('token expired → TOKEN_EXPIRED', () => {
    const s = computeStatus({ disconnectedAt: null, isActive: true, tokenExpiresAt: past1d() });
    expect(s.status).toBe('TOKEN_EXPIRED');
    expect(s.severity).toBe('error');
    expect(s.daysUntilExpiry).toBeLessThanOrEqual(0);
  });

  test('businessRestricted true → BUSINESS_RESTRICTED', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future30d(),
      businessRestricted: true,
    });
    expect(s.status).toBe('BUSINESS_RESTRICTED');
    expect(s.severity).toBe('error');
  });

  test('qualityRating RED → QUALITY_RED (precedence over webhook+expiry warnings)', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future30d(),
      businessRestricted: false, qualityRating: 'RED',
    });
    expect(s.status).toBe('QUALITY_RED');
  });

  test('onboarded but webhook not verified → WEBHOOK_FAILED', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future30d(),
      businessRestricted: false, qualityRating: null,
      webhookVerified: false, onboardedAt: past1d(),
    });
    expect(s.status).toBe('WEBHOOK_FAILED');
  });

  test('token expires in 3 days → EXPIRING_SOON', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future3d(),
      businessRestricted: false, qualityRating: null,
      webhookVerified: true, onboardedAt: past1d(),
    });
    expect(s.status).toBe('EXPIRING_SOON');
    expect(s.severity).toBe('warn');
    expect(s.daysUntilExpiry).toBe(3);
  });

  test('qualityRating YELLOW (otherwise healthy) → QUALITY_YELLOW', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future30d(),
      businessRestricted: false, qualityRating: 'YELLOW',
      webhookVerified: true, onboardedAt: past1d(),
    });
    expect(s.status).toBe('QUALITY_YELLOW');
  });

  test('healthy CONNECTED — happy path', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: future30d(),
      businessRestricted: false, qualityRating: 'GREEN',
      webhookVerified: true, onboardedAt: past1d(),
    });
    expect(s.status).toBe('CONNECTED');
    expect(s.severity).toBe('ok');
  });

  test('never-expires token (tokenExpiresAt=null) on healthy row → CONNECTED', () => {
    const s = computeStatus({
      disconnectedAt: null, isActive: true, tokenExpiresAt: null,
      businessRestricted: false, qualityRating: null,
      webhookVerified: true, onboardedAt: past1d(),
    });
    expect(s.status).toBe('CONNECTED');
    expect(s.tokenExpiresAt).toBe(null);
  });
});
