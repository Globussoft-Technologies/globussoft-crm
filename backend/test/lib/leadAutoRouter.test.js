// Unit tests for backend/lib/leadAutoRouter.js
//
// Mocking strategy: monkey-patch the prisma singleton (vi.mock doesn't
// intercept CJS require in this vitest setup).
import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';
import router from '../../lib/leadAutoRouter.js';

const {
  pickAssignee,
  detectCategory,
  // Travel multichannel (G007 + G008)
  scoreRule,
  resolveRoutingRule,
  bumpRrCursor,
  loadTeamForRule,
  pickRoutingAssignee,
} = router;

beforeAll(() => {
  prisma.user = { findMany: vi.fn(), findFirst: vi.fn() };
  prisma.leadRoutingRule = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.user.findMany.mockReset();
  prisma.user.findFirst.mockReset();
  prisma.leadRoutingRule.findMany.mockReset();
  prisma.leadRoutingRule.update.mockReset();
});

describe('lib/leadAutoRouter — module shape', () => {
  test('exports pickAssignee and detectCategory', () => {
    expect(typeof pickAssignee).toBe('function');
    expect(typeof detectCategory).toBe('function');
  });
});

describe('lib/leadAutoRouter — detectCategory (pure)', () => {
  test('returns null for empty input', () => {
    expect(detectCategory(null)).toBeNull();
    expect(detectCategory('')).toBeNull();
  });

  test('detects hair → "hair"', () => {
    expect(detectCategory('hair transplant')).toBe('hair');
    expect(detectCategory('FUE booking')).toBe('hair');
    expect(detectCategory('PRP scalp')).toBe('hair');
  });

  test('detects aesthetics', () => {
    expect(detectCategory('botox')).toBe('aesthetics');
    expect(detectCategory('filler')).toBe('aesthetics');
  });

  test('detects laser', () => {
    expect(detectCategory('laser hair removal')).toBe('laser');
  });

  test('detects skin', () => {
    expect(detectCategory('acne treatment')).toBe('skin');
  });

  test('detects body', () => {
    expect(detectCategory('liposuction')).toBe('body');
  });

  test('detects ayurveda', () => {
    expect(detectCategory('shirodhara')).toBe('ayurveda');
  });

  test('detects salon', () => {
    expect(detectCategory('haircut')).toBe('salon');
  });

  test('returns null for non-matching text', () => {
    expect(detectCategory('hello world')).toBeNull();
  });
});

describe('lib/leadAutoRouter — pickAssignee', () => {
  test('keyword match → assigns to specialist (doctor for hair)', async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: 11, name: 'Dr. Harsh' },
      { id: 12, name: 'Dr. Priya' },
    ]);
    const out = await pickAssignee({ tenantId: 1, note: 'hair transplant inquiry' });
    expect([11, 12]).toContain(out.userId);
    expect(out.reason).toMatch(/hair.*doctor/i);
    const arg = prisma.user.findMany.mock.calls[0][0];
    expect(arg.where.wellnessRole).toBe('doctor');
  });

  test('keyword match → assigns to professional (laser)', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 21, name: 'Pro' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'laser hair removal' });
    expect(out.userId).toBe(21);
    expect(out.reason).toMatch(/laser.*professional/i);
  });

  test('aesthetics → doctor', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 31, name: 'Dr. A' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'botox booking' });
    expect(out.userId).toBe(31);
    expect(out.reason).toMatch(/aesthetics.*doctor/i);
  });

  test('skin → doctor', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 32, name: 'Dr. S' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'acne' });
    expect(out.reason).toMatch(/skin.*doctor/i);
  });

  test('ayurveda → professional', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 33, name: 'Practitioner' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'shirodhara therapy' });
    expect(out.reason).toMatch(/ayurveda.*professional/i);
  });

  test('falls back to telecaller round-robin when no specialist found', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 41, name: 'TC1' }, { id: 42, name: 'TC2' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'hair transplant' });
    expect([41, 42]).toContain(out.userId);
    expect(out.reason).toMatch(/round-robin telecaller/i);
  });

  test('falls back to telecaller when no category detected', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 51, name: 'TC' }]);
    const out = await pickAssignee({ tenantId: 1, note: 'just a generic question' });
    expect(out.userId).toBe(51);
    expect(out.reason).toMatch(/round-robin telecaller/i);
  });

  test('falls back to manager when no telecaller exists', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]); // telecallers empty
    prisma.user.findFirst.mockResolvedValueOnce({ id: 99 }); // manager exists
    const out = await pickAssignee({ tenantId: 1, note: 'plain question' });
    expect(out.userId).toBe(99);
    expect(out.reason).toMatch(/manager/i);
  });

  test('returns null userId when no staff at all', async () => {
    prisma.user.findMany.mockResolvedValueOnce([]); // telecallers
    prisma.user.findFirst.mockResolvedValueOnce(null); // no manager
    const out = await pickAssignee({ tenantId: 1, note: 'plain' });
    expect(out.userId).toBeNull();
    expect(out.reason).toMatch(/no available staff/i);
  });

  test('combines name + source + note in keyword detection haystack', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 1, name: 'Dr. X' }]);
    const out = await pickAssignee({
      tenantId: 1,
      name: 'Rishu',
      source: 'indiamart',
      note: 'wants liposuction',
    });
    expect(out.reason).toMatch(/body.*doctor/i);
  });

  test('round-robin distributes across telecallers across calls', async () => {
    prisma.user.findMany
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }])
      .mockResolvedValueOnce([{ id: 100 }, { id: 101 }, { id: 102 }]);
    const a = await pickAssignee({ tenantId: 1, note: 'plain' });
    const b = await pickAssignee({ tenantId: 1, note: 'plain' });
    const c = await pickAssignee({ tenantId: 1, note: 'plain' });
    const ids = [a.userId, b.userId, c.userId];
    const distinct = new Set(ids);
    expect(distinct.size).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Travel multichannel router (G007 + G008) — PRD §3.3
//
// Specificity scoring → most-specific-rule resolver → round-robin with
// race-safe cursor → isAvailable fallback → fallbackUserId.
// ─────────────────────────────────────────────────────────────────────

describe('lib/leadAutoRouter — scoreRule (pure)', () => {
  test('rule with NULL channel + NULL subBrand is wildcard (eligible, specificity 0)', () => {
    const r = { channel: null, subBrand: null };
    expect(scoreRule(r, { channel: 'whatsapp', subBrand: 'rfu' })).toEqual({ eligible: true, specificity: 0 });
    expect(scoreRule(r, { channel: null, subBrand: null })).toEqual({ eligible: true, specificity: 0 });
  });

  test('channel-only rule: matches when channel equals intake (case-insensitive); specificity=2', () => {
    const r = { channel: 'whatsapp', subBrand: null };
    expect(scoreRule(r, { channel: 'WhatsApp', subBrand: 'rfu' })).toEqual({ eligible: true, specificity: 2 });
    expect(scoreRule(r, { channel: 'voice', subBrand: 'rfu' })).toEqual({ eligible: false, specificity: 0 });
  });

  test('subBrand-only rule: matches when subBrand equals intake (case-insensitive); specificity=1', () => {
    const r = { channel: null, subBrand: 'rfu' };
    expect(scoreRule(r, { channel: 'voice', subBrand: 'RFU' })).toEqual({ eligible: true, specificity: 1 });
    expect(scoreRule(r, { channel: 'voice', subBrand: 'tmc' })).toEqual({ eligible: false, specificity: 0 });
  });

  test('combined channel+subBrand rule: specificity=3 (beats both single-field forms)', () => {
    const r = { channel: 'whatsapp', subBrand: 'rfu' };
    expect(scoreRule(r, { channel: 'whatsapp', subBrand: 'rfu' })).toEqual({ eligible: true, specificity: 3 });
  });
});

describe('lib/leadAutoRouter — resolveRoutingRule', () => {
  test('most-specific-rule wins: channel+subBrand (3) beats channel-only (2)', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: 'whatsapp', subBrand: null, priority: 10, isActive: true },
      { id: 2, channel: 'whatsapp', subBrand: 'rfu', priority: 10, isActive: true },
      { id: 3, channel: null, subBrand: null, priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule.id).toBe(2);
  });

  test('most-specific-rule wins: channel-only (2) beats subBrand-only (1)', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: null, subBrand: 'rfu', priority: 10, isActive: true },
      { id: 2, channel: 'whatsapp', subBrand: null, priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule.id).toBe(2);
  });

  test('most-specific-rule wins: subBrand-only (1) beats wildcard (0)', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: null, subBrand: null, priority: 10, isActive: true },
      { id: 2, channel: null, subBrand: 'rfu', priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule.id).toBe(2);
  });

  test('priority tiebreaker: lower priority wins when specificity ties', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: 'whatsapp', subBrand: 'rfu', priority: 100, isActive: true },
      { id: 2, channel: 'whatsapp', subBrand: 'rfu', priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule.id).toBe(2);
  });

  test('id tiebreaker: lower id wins when specificity AND priority tie', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 10, channel: 'whatsapp', subBrand: 'rfu', priority: 10, isActive: true },
      { id: 5, channel: 'whatsapp', subBrand: 'rfu', priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule.id).toBe(5);
  });

  test('returns null when no rule matches', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: 'voice', subBrand: 'tmc', priority: 10, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(rule).toBeNull();
  });

  test('wildcard rule matches when intake channel/subBrand are null', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 1, channel: null, subBrand: null, priority: 100, isActive: true },
    ]);
    const rule = await resolveRoutingRule({ tenantId: 1, channel: null, subBrand: null });
    expect(rule.id).toBe(1);
  });

  test('passes tenant-scoped + isActive filter to findMany', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([]);
    await resolveRoutingRule({ tenantId: 42, channel: 'whatsapp', subBrand: 'rfu' });
    expect(prisma.leadRoutingRule.findMany).toHaveBeenCalledWith({
      where: { tenantId: 42, isActive: true },
    });
  });
});

describe('lib/leadAutoRouter — bumpRrCursor (race-safe atomic increment)', () => {
  test('atomic increment via Prisma { rrCursor: { increment: 1 } }', async () => {
    prisma.leadRoutingRule.update.mockResolvedValue({ rrCursor: 7 });
    const next = await bumpRrCursor(42);
    expect(next).toBe(7);
    expect(prisma.leadRoutingRule.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { rrCursor: { increment: 1 } },
      select: { rrCursor: true },
    });
  });

  test('returns null if the update throws (rule deleted mid-flight)', async () => {
    prisma.leadRoutingRule.update.mockRejectedValue(new Error('record not found'));
    const next = await bumpRrCursor(42);
    expect(next).toBeNull();
  });
});

describe('lib/leadAutoRouter — pickRoutingAssignee (G007 + G008 integration)', () => {
  test('round_robin: bumps cursor + picks the indexed user; isAvailable=true', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 50, channel: 'whatsapp', subBrand: 'rfu', priority: 10, assignType: 'round_robin', rrCursor: 0, isActive: true },
    ]);
    prisma.leadRoutingRule.update.mockResolvedValue({ rrCursor: 1 });
    prisma.user.findMany.mockResolvedValue([
      { id: 100, isAvailable: true },
      { id: 101, isAvailable: true },
      { id: 102, isAvailable: true },
    ]);
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(out.matchedRuleId).toBe(50);
    expect([100, 101, 102]).toContain(out.userId);
    expect(out.reason).toMatch(/round_robin.*rule 50/);
  });

  test('round_robin: cursor advances across consecutive calls (race-safe semantics)', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 50, channel: 'whatsapp', subBrand: null, priority: 10, assignType: 'round_robin', rrCursor: 0, isActive: true },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 200, isAvailable: true },
      { id: 201, isAvailable: true },
      { id: 202, isAvailable: true },
    ]);
    let cursor = 0;
    prisma.leadRoutingRule.update.mockImplementation(() => {
      cursor += 1;
      return Promise.resolve({ rrCursor: cursor });
    });

    const a = await pickRoutingAssignee({ tenantId: 1, channel: 'whatsapp', subBrand: null });
    const b = await pickRoutingAssignee({ tenantId: 1, channel: 'whatsapp', subBrand: null });
    const c = await pickRoutingAssignee({ tenantId: 1, channel: 'whatsapp', subBrand: null });

    // The first three picks span the full team (no double-assign in the
    // wrap-around window).
    const ids = [a.userId, b.userId, c.userId];
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => [200, 201, 202].includes(id))).toBe(true);
  });

  test('round_robin: wraps at team size after consumption', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 50, channel: null, subBrand: null, priority: 10, assignType: 'round_robin', rrCursor: 0, isActive: true },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 300, isAvailable: true },
      { id: 301, isAvailable: true },
    ]);
    let cursor = 0;
    prisma.leadRoutingRule.update.mockImplementation(() => {
      cursor += 1;
      return Promise.resolve({ rrCursor: cursor });
    });

    const picks = [];
    for (let i = 0; i < 4; i++) {
      const out = await pickRoutingAssignee({ tenantId: 1, channel: 'x', subBrand: 'y' });
      picks.push(out.userId);
    }
    // 4 picks against a 2-person team — each user picked exactly twice.
    expect(picks.filter((id) => id === 300).length).toBe(2);
    expect(picks.filter((id) => id === 301).length).toBe(2);
  });

  test('round_robin: unavailable user is skipped; cursor advances to next eligible', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 60, channel: null, subBrand: null, priority: 10, assignType: 'round_robin', rrCursor: 0, isActive: true },
    ]);
    prisma.leadRoutingRule.update.mockResolvedValue({ rrCursor: 1 });
    prisma.user.findMany.mockResolvedValue([
      { id: 400, isAvailable: false }, // skipped
      { id: 401, isAvailable: true },
      { id: 402, isAvailable: true },
    ]);
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'x', subBrand: 'y' });
    expect([401, 402]).toContain(out.userId);
    expect(out.matchedRuleId).toBe(60);
  });

  test('round_robin: ALL team unavailable + fallbackUserId set → fallback wins', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 70,
        channel: null,
        subBrand: null,
        priority: 10,
        assignType: 'round_robin',
        rrCursor: 0,
        isActive: true,
        fallbackUserId: 999,
      },
    ]);
    prisma.leadRoutingRule.update.mockResolvedValue({ rrCursor: 1 });
    prisma.user.findMany.mockResolvedValue([
      { id: 500, isAvailable: false },
      { id: 501, isAvailable: false },
    ]);
    prisma.user.findFirst.mockResolvedValue({ id: 999, isAvailable: true });

    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'x', subBrand: 'y' });
    expect(out.userId).toBe(999);
    expect(out.matchedRuleId).toBe(70);
    expect(out.reason).toMatch(/fallback.*rule 70.*all assignees unavailable/);
  });

  test('round_robin: ALL team unavailable + no fallback → unassigned with reason', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 71,
        channel: null,
        subBrand: null,
        priority: 10,
        assignType: 'round_robin',
        rrCursor: 0,
        isActive: true,
        fallbackUserId: null,
      },
    ]);
    prisma.leadRoutingRule.update.mockResolvedValue({ rrCursor: 1 });
    prisma.user.findMany.mockResolvedValue([
      { id: 600, isAvailable: false },
    ]);
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'x', subBrand: 'y' });
    expect(out.userId).toBeNull();
    expect(out.matchedRuleId).toBe(71);
    expect(out.reason).toMatch(/all_assignees_unavailable/);
  });

  test('specific_user: available target wins', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 80,
        channel: 'voice',
        subBrand: null,
        priority: 10,
        assignType: 'specific_user',
        assignTo: 777,
        isActive: true,
      },
    ]);
    prisma.user.findFirst.mockResolvedValue({ id: 777, isAvailable: true });
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'voice', subBrand: null });
    expect(out.userId).toBe(777);
    expect(out.matchedRuleId).toBe(80);
    expect(out.reason).toMatch(/specific_user.*rule 80/);
  });

  test('specific_user: unavailable target + fallback present → fallback wins', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      {
        id: 81,
        channel: 'voice',
        subBrand: null,
        priority: 10,
        assignType: 'specific_user',
        assignTo: 777,
        fallbackUserId: 888,
        isActive: true,
      },
    ]);
    prisma.user.findFirst
      .mockResolvedValueOnce({ id: 777, isAvailable: false })   // primary lookup
      .mockResolvedValueOnce({ id: 888, isAvailable: true });   // fallback lookup
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'voice', subBrand: null });
    expect(out.userId).toBe(888);
    expect(out.matchedRuleId).toBe(81);
    expect(out.reason).toMatch(/fallback.*rule 81.*specific user unavailable/);
  });

  test('no matching rule → unassigned: no_matching_rule', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 90, channel: 'sms', subBrand: 'tmc', priority: 10, isActive: true },
    ]);
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'whatsapp', subBrand: 'rfu' });
    expect(out.userId).toBeNull();
    expect(out.matchedRuleId).toBeNull();
    expect(out.reason).toMatch(/no_matching_rule/);
  });

  test('empty team on matched round_robin rule → empty_team_on_matched_rule', async () => {
    prisma.leadRoutingRule.findMany.mockResolvedValue([
      { id: 95, channel: null, subBrand: null, priority: 10, assignType: 'round_robin', isActive: true },
    ]);
    prisma.user.findMany.mockResolvedValue([]);
    const out = await pickRoutingAssignee({ tenantId: 1, channel: 'x', subBrand: 'y' });
    expect(out.userId).toBeNull();
    expect(out.matchedRuleId).toBe(95);
    expect(out.reason).toMatch(/empty_team_on_matched_rule/);
  });
});

describe('lib/leadAutoRouter — loadTeamForRule', () => {
  test('specific_user: returns single-item list of the assignTo user', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 77, isAvailable: true });
    const team = await loadTeamForRule({ assignType: 'specific_user', assignTo: 77 }, 1);
    expect(team).toHaveLength(1);
    expect(team[0].id).toBe(77);
  });

  test('specific_user with no assignTo: empty team', async () => {
    const team = await loadTeamForRule({ assignType: 'specific_user', assignTo: null }, 1);
    expect(team).toEqual([]);
  });

  test('round_robin: returns active staff (deactivatedAt: null filter)', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 1, isAvailable: true },
      { id: 2, isAvailable: false },
    ]);
    const team = await loadTeamForRule({ assignType: 'round_robin' }, 1);
    expect(team).toHaveLength(2);
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { tenantId: 1, deactivatedAt: null },
      orderBy: { id: 'asc' },
      select: { id: true, isAvailable: true, deactivatedAt: true },
    });
  });
});
