// @ts-check
/**
 * Wellness — Orchestrator depth + no-show risk widget.
 *
 * Covers two PRD gaps:
 *   §6.7 — Orchestrator must compute occupancy gap + stale-lead escalation
 *          beyond the legacy hand-crafted rules.
 *   §6.8 — Owner dashboard must surface no-show risk for upcoming visits.
 *
 * Run: cd e2e && BASE_URL=https://crm.globusdemos.com \
 *        npx playwright test tests/wellness-orchestrator-depth.spec.js --project=chromium
 */
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://crm.globusdemos.com';
const API = `${BASE_URL}/api`;

const RISHU = { email: 'rishu@enhancedwellness.in', password: 'password123' };
let TOKEN = '';

async function getToken(request) {
  if (TOKEN) return TOKEN;
  const r = await request.post(`${API}/auth/login`, { data: RISHU });
  TOKEN = (await r.json()).token;
  return TOKEN;
}
const auth = () => ({ Authorization: `Bearer ${TOKEN}` });

// ═══════════════════════════════════════════════════════════════════
// Gap A — PRD §6.7: orchestrator depth
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('Orchestrator depth (PRD §6.7)', () => {
  test.beforeAll(async ({ request }) => { await getToken(request); });

  test('1. /orchestrator/run summary references utilisation, not just occupancy', async ({ request }) => {
    const r = await request.post(`${API}/wellness/orchestrator/run`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const result = await r.json();
    expect(typeof result.contextSummary).toBe('string');
    // Extended summary now includes utilisation% (booked-min / capacity-min)
    // and SLA-breach lead count — both are new context surfaces for §6.7.
    expect(result.contextSummary.toLowerCase()).toContain('utilisation');
    expect(result.contextSummary.toLowerCase()).toMatch(/sla|past sla/);
  });

  test('2. campaign_boost cards from occupancy gap include serviceId + suggestedDailyBudget', async ({ request }) => {
    await request.post(`${API}/wellness/orchestrator/run`, { headers: auth() });
    const recs = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    const boostCards = recs.filter((r) => r.type === 'campaign_boost');
    if (boostCards.length === 0) test.skip(true, 'no campaign_boost cards available right now');
    let foundConcrete = false;
    for (const c of boostCards) {
      if (!c.payload) continue;
      let p; try { p = JSON.parse(c.payload); } catch { continue; }
      if (typeof p.serviceId === 'number' && typeof p.suggestedDailyBudget === 'number' && p.suggestedDailyBudget >= 300) {
        foundConcrete = true;
        break;
      }
    }
    expect(foundConcrete).toBeTruthy();
  });

  test('3. lead_followup cards from SLA breach carry leadIds + reassignToUserId', async ({ request }) => {
    await request.post(`${API}/wellness/orchestrator/run`, { headers: auth() });
    const recs = await (await request.get(`${API}/wellness/recommendations?status=pending`, { headers: auth() })).json();
    const slaCards = recs.filter((r) => r.type === 'lead_followup' && /SLA/i.test(r.title || ''));
    if (slaCards.length === 0) test.skip(true, 'no SLA-breach lead_followup card right now');
    const card = slaCards[0];
    const payload = JSON.parse(card.payload || '{}');
    expect(Array.isArray(payload.leadIds)).toBeTruthy();
    expect(payload.leadIds.length).toBeGreaterThan(0);
    expect(payload.slaMinutes).toBeGreaterThan(0);
    // reassignToUserId may be null in tenants without a telecaller seeded,
    // so just assert the key exists and goalContext is set as PRD §6.7.
    expect(payload).toHaveProperty('reassignToUserId');
    expect(card.goalContext).toMatch(/zero missed leads/i);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Gap B — PRD §6.8: no-show risk widget
// ═══════════════════════════════════════════════════════════════════

test.describe.serial('No-show risk widget (PRD §6.8)', () => {
  test.beforeAll(async ({ request }) => { await getToken(request); });

  test('4. GET /wellness/dashboard exposes today.noShowRisk with count + totalUpcoming + topRisks', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, { headers: auth() });
    expect(r.ok()).toBeTruthy();
    const data = await r.json();
    expect(data.today).toHaveProperty('noShowRisk');
    expect(data.today.noShowRisk).toHaveProperty('count');
    expect(data.today.noShowRisk).toHaveProperty('totalUpcoming');
    expect(Array.isArray(data.today.noShowRisk.topRisks)).toBeTruthy();
    expect(data.today.noShowRisk.topRisks.length).toBeLessThanOrEqual(5);
  });

  test('5. Each topRisk row carries visitId/patientName/score/scheduledAt with sane bounds', async ({ request }) => {
    const r = await request.get(`${API}/wellness/dashboard`, { headers: auth() });
    const data = await r.json();
    const top = data.today?.noShowRisk?.topRisks || [];
    if (top.length === 0) test.skip(true, 'no upcoming visits in next 24h');
    for (const row of top) {
      expect(typeof row.visitId).toBe('number');
      expect(typeof row.patientName).toBe('string');
      expect(typeof row.score).toBe('number');
      expect(row.score).toBeGreaterThanOrEqual(0);
      expect(row.score).toBeLessThanOrEqual(100);
      expect(row.scheduledAt).toBeTruthy();
    }
    // Sorted descending by score
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1].score).toBeGreaterThanOrEqual(top[i].score);
    }
    // count = number of topRisks (or any) scoring ≥40 — assert never
    // exceeds totalUpcoming.
    expect(data.today.noShowRisk.count).toBeLessThanOrEqual(data.today.noShowRisk.totalUpcoming);
  });

  test('6. Owner Dashboard renders the No-show risk StatCard', async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.getByRole('button', { name: /Demo Admin/i }).click();
    await page.waitForURL(/\/wellness/, { timeout: 15000 });
    // The card label is "No-show risk".
    await expect(page.getByText(/No-show risk/i).first()).toBeVisible({ timeout: 15000 });
    // Sub-line shows "of N upcoming"
    await expect(page.getByText(/of \d+ upcoming/i).first()).toBeVisible();
  });
});
