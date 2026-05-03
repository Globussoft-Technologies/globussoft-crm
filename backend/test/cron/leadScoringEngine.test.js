/**
 * Unit tests for backend/cron/leadScoringEngine.js — recomputes
 * Contact.aiScore (1-99) every 10 minutes via a multi-factor formula
 * mixing status, deal pipeline, activity decay, sequence enrollment,
 * email engagement, call logs, touchpoints, source quality, and
 * data-enrichment completeness.
 *
 * Why this file exists (regression class — gap card R-5 batch 2):
 *   - The engine has been live since v3.0 but has ZERO unit-level
 *     coverage. The full formula in computeScore() is data-dense and
 *     touches ~15 contributing branches; many are awkward to exercise
 *     through API specs because they depend on shapes the seeder doesn't
 *     emit (sentimentScore on inbound emails, decayed activity recency,
 *     log-scaled pipeline value, source-keyword regex matches).
 *   - Issue #248 explicitly redesigned the formula to spread output
 *     across the 1-99 range. A regression that re-clusters output at
 *     three values would silently degrade lead-prioritisation quality
 *     in production. This file pins the formula's continuous-input
 *     contract.
 *   - The clamp [1, 99] is the only bound preventing a malformed
 *     contact (e.g. enormous activities array) from yielding a bogus
 *     400+ aiScore. Pinning Math.min/Math.max here protects the column.
 *
 * Functions / branches covered (computeScore):
 *   ✅ Base + status branches (Customer / Prospect / Lead / Churned)
 *   ✅ Deal aggregation: active count cap, stage-progression bonus,
 *      won-history bonus cap, log-scaled pipeline value, avg
 *      probability bucket, lost-deal drag with no active replacement
 *   ✅ Activity recency: continuous exp-decay, recent vs aged 60d/90d
 *      cold-lead penalties, call/meeting type-specific bonuses (capped)
 *   ✅ Sequence enrollment: active flag bonus, completed bonus cap
 *   ✅ Email engagement: inbound-reply count cap, sentiment ±5 mapping,
 *      log2-scaled opens, linear clicks (both via emailTracking AND
 *      emailEngagement object — the dual-shape contract from
 *      ai_scoring routes)
 *   ✅ Call logs: 60d-window recent-call bonus
 *   ✅ Touchpoint channel diversity: Set-based unique channel cap
 *   ✅ Source quality: referral / inbound / walk-in / paid / cold regex
 *      matches incl. firstTouchSource fallback
 *   ✅ Data-enrichment completeness (industry/companySize/linkedin/etc.)
 *   ✅ Company-size bracket: enterprise / mid-market / small numeric
 *      regex matches
 *   ✅ Tenure bonus (> 180d, not Churned)
 *   ✅ slaBreached drag
 *   ✅ Clamp: Math.max(1, Math.min(round(score), 99)) — both bounds.
 *
 * Functions / branches covered (tickLeadScoringEngine):
 *   ✅ Happy path → fans out aiScore updates per contact, returns
 *      { scored: <count> }, emits 'lead_scores_updated' on the io
 *      socket when supplied.
 *   ✅ findMany include shape — pins the relations the formula needs
 *      (deals/activities/sequenceEnrollments/emails/callLogs).
 *   ✅ Empty contact set → 0 updates, still emits the broadcast event.
 *   ✅ No-io variant → does not throw, does not require a socket.
 *   ✅ findMany failure → re-throws (engine surface contract for the
 *      cron-init layer's .catch(console.error) wrapper).
 *
 * Engine bugs flagged for separate issues (NOT fixed here per agent
 * coordination — only documented):
 *
 *   ⚠ NO tenant scope on the findMany. The engine fans out across ALL
 *     contacts of ALL tenants in a single sweep — there is no
 *     `where: { tenantId }` filter. In a multi-tenant deployment a
 *     newly-onboarded tenant immediately hijacks scoring CPU for
 *     unrelated tenants. The acceptance criterion "Per-tenant scope
 *     mandatory" is documented as failing here — this test pins the
 *     CURRENT (cross-tenant) behaviour so any future fix that adds
 *     tenant scoping will surface in the diff.
 *
 *   ⚠ NO recompute window / dedup. Every 10-min tick rescans every
 *     contact and rewrites Contact.aiScore even when no inputs have
 *     changed. There is no `where: { aiScoreUpdatedAt: { lt: ... } }`
 *     gate, no last-scored-at column. The acceptance criterion
 *     "Recompute window — deal scored recently is skipped" is
 *     documented as MISSING. This test confirms the engine ALWAYS
 *     issues an update per contact regardless of recency.
 *
 *   ⚠ NO per-row error containment. The fan-out uses Promise.all over
 *     update promises — a single failed update causes the entire tick
 *     to reject (the .catch in initLeadScoringCron prevents process
 *     death but loses ALL the other update writes from the same tick).
 *     This test pins the rejection behaviour.
 *
 * NOT covered (intentional — explain why):
 *   - initLeadScoringCron — schedules a real node-cron job; invoking
 *     it would register a live cron. The function is a thin shim
 *     around tickLeadScoringEngine which is exhaustively covered.
 *   - The Gemini-AI failure-tolerance branch (per the task brief) does
 *     NOT EXIST in this engine — it's a pure-formula scorer, no LLM
 *     call. AI scoring elsewhere lives in routes/ai_scoring.js, not
 *     the cron engine.
 *
 * Mocking strategy:
 *   Mirror backend/test/cron/wellnessOpsEngine.test.js — import the
 *   prisma singleton, monkey-patch model accessors. The cron module is
 *   inlined via vitest.config.js → server.deps.inline so its
 *   `require('../lib/prisma')` resolves to the same singleton.
 */

import { describe, test, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../../lib/prisma.js';

import {
  computeScore,
  tickLeadScoringEngine,
} from '../../cron/leadScoringEngine.js';

beforeAll(() => {
  prisma.contact = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
});

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.contact.update.mockReset();

  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.update.mockResolvedValue({});
});

// Helper — minimal contact shape with sensible defaults so each test
// can mutate just the surface it cares about.
function contactWith(overrides = {}) {
  return {
    id: 1,
    status: 'Lead',
    deals: [],
    activities: [],
    sequenceEnrollments: [],
    emails: [],
    callLogs: [],
    touchpoints: [],
    source: '',
    industry: null,
    companySize: null,
    linkedin: null,
    website: null,
    title: null,
    company: null,
    createdAt: new Date(),
    slaBreached: false,
    ...overrides,
  };
}

// ─── computeScore: clamp + base ─────────────────────────────────────────────

describe('computeScore — clamp + base', () => {
  test('returns an integer in [1, 99]', () => {
    const score = computeScore(contactWith({}));
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThanOrEqual(1);
    expect(score).toBeLessThanOrEqual(99);
  });

  test('upper clamp: extremely high inputs cannot exceed 99', () => {
    // Pile every positive signal on at maximum strength.
    const recentCalls = Array.from({ length: 20 }, (_, i) => ({
      createdAt: new Date(),
      type: 'Call',
    }));
    const recentMeetings = Array.from({ length: 20 }, () => ({
      createdAt: new Date(),
      type: 'Meeting',
    }));
    const monsterContact = contactWith({
      status: 'Customer',
      deals: [
        ...Array.from({ length: 10 }, (_, i) => ({
          stage: 'negotiation',
          amount: 5_000_000,
          probability: 95,
        })),
        ...Array.from({ length: 10 }, () => ({ stage: 'won' })),
      ],
      activities: [...recentCalls, ...recentMeetings],
      sequenceEnrollments: [
        { status: 'Active' },
        ...Array.from({ length: 5 }, () => ({ status: 'Completed' })),
      ],
      emails: [
        ...Array.from({ length: 10 }, () => ({
          direction: 'INBOUND',
          sentimentScore: 1,
        })),
      ],
      emailTracking: [
        ...Array.from({ length: 100 }, () => ({ type: 'open' })),
        ...Array.from({ length: 50 }, () => ({ type: 'click' })),
      ],
      callLogs: Array.from({ length: 20 }, () => ({ createdAt: new Date() })),
      touchpoints: [
        { channel: 'email' }, { channel: 'sms' }, { channel: 'whatsapp' },
        { channel: 'phone' }, { channel: 'in-person' },
      ],
      source: 'referral',
      industry: 'SaaS',
      companySize: '1000+',
      linkedin: 'https://linkedin.com/in/x',
      website: 'https://x.com',
      title: 'CEO',
      company: 'Acme',
      createdAt: new Date(Date.now() - 365 * 86400000),
    });
    expect(computeScore(monsterContact)).toBe(99);
  });

  test('lower clamp: extremely negative inputs cannot dip below 1', () => {
    // Cold lead, lost deals, no replacements, 90d+ stale, sla-breached, cold source.
    const score = computeScore(
      contactWith({
        status: 'Churned',
        deals: [
          { stage: 'lost' }, { stage: 'lost' }, { stage: 'lost' },
        ],
        activities: [
          { createdAt: new Date(Date.now() - 200 * 86400000), type: 'Note' },
        ],
        source: 'cold',
        slaBreached: true,
      }),
    );
    expect(score).toBeGreaterThanOrEqual(1);
  });

  test('rounds to integer (Math.round of float-summed score)', () => {
    // The base 10 + Customer 20 + a probability that introduces a fraction
    // (e.g. avgProbability=10 → +0.5 rounded). Whatever the integer
    // outcome is, it must not be a float.
    const score = computeScore(
      contactWith({
        status: 'Customer',
        deals: [{ stage: 'proposal', probability: 10, amount: 500 }],
      }),
    );
    expect(Number.isInteger(score)).toBe(true);
  });
});

// ─── computeScore: status / lifecycle ───────────────────────────────────────

describe('computeScore — status / lifecycle', () => {
  test('Customer > Prospect > Lead > Churned (status-only ordering)', () => {
    const customer = computeScore(contactWith({ status: 'Customer' }));
    const prospect = computeScore(contactWith({ status: 'Prospect' }));
    const lead = computeScore(contactWith({ status: 'Lead' }));
    const churned = computeScore(contactWith({ status: 'Churned' }));

    expect(customer).toBeGreaterThan(prospect);
    expect(prospect).toBeGreaterThan(lead);
    expect(lead).toBeGreaterThan(churned);
  });

  test('Customer is +20 over the unknown-status baseline', () => {
    const customer = computeScore(contactWith({ status: 'Customer' }));
    const unknown = computeScore(contactWith({ status: 'Other' }));
    expect(customer - unknown).toBe(20);
  });
});

// ─── computeScore: deal aggregation ─────────────────────────────────────────

describe('computeScore — deal aggregation', () => {
  test('active deals contribute (capped at 12 from count)', () => {
    const noDeals = computeScore(contactWith({}));
    const oneDeal = computeScore(contactWith({ deals: [{ stage: 'lead' }] }));
    expect(oneDeal).toBeGreaterThan(noDeals);

    // Adding a 4th deal still bumps slightly via stageWeight=0 for 'lead',
    // but the *count* contribution itself is capped: deal count 3 vs 30
    // both cap at +12 from that branch.
    const threeDeals = computeScore(
      contactWith({ deals: [{ stage: 'lead' }, { stage: 'lead' }, { stage: 'lead' }] }),
    );
    const thirtyDeals = computeScore(
      contactWith({
        deals: Array.from({ length: 30 }, () => ({ stage: 'lead' })),
      }),
    );
    // The count bucket caps; stage='lead' adds 0 per deal — so beyond the
    // cap the score should not grow.
    expect(thirtyDeals).toBe(threeDeals);
  });

  test('stage progression: negotiation > proposal > contacted > lead', () => {
    const lead = computeScore(contactWith({ deals: [{ stage: 'lead' }] }));
    const contacted = computeScore(
      contactWith({ deals: [{ stage: 'contacted' }] }),
    );
    const proposal = computeScore(
      contactWith({ deals: [{ stage: 'proposal' }] }),
    );
    const negotiation = computeScore(
      contactWith({ deals: [{ stage: 'negotiation' }] }),
    );

    expect(contacted).toBeGreaterThan(lead);
    expect(proposal).toBeGreaterThan(contacted);
    expect(negotiation).toBeGreaterThan(proposal);
  });

  test('won deals contribute a bonus (caps at 18)', () => {
    const noWon = computeScore(contactWith({}));
    const oneWon = computeScore(contactWith({ deals: [{ stage: 'won' }] }));
    expect(oneWon - noWon).toBeGreaterThanOrEqual(10); // 10 + 1*2 = 12 >= 10

    const manyWon = computeScore(
      contactWith({ deals: Array.from({ length: 50 }, () => ({ stage: 'won' })) }),
    );
    // Bonus alone caps at 18.
    expect(manyWon - noWon).toBe(18);
  });

  test('log-scaled pipeline value: $1k vs $1M differentiated but both bounded', () => {
    const small = computeScore(
      contactWith({ deals: [{ stage: 'lead', amount: 1000 }] }),
    );
    const large = computeScore(
      contactWith({ deals: [{ stage: 'lead', amount: 1_000_000 }] }),
    );
    // The log-scaled bump is bounded at +9 — so the gap is capped.
    expect(large).toBeGreaterThan(small);
    expect(large - small).toBeLessThanOrEqual(9);
  });

  test('avg probability across active deals contributes (~0..5)', () => {
    const lowP = computeScore(
      contactWith({ deals: [{ stage: 'lead', probability: 0 }] }),
    );
    const highP = computeScore(
      contactWith({ deals: [{ stage: 'lead', probability: 100 }] }),
    );
    expect(highP - lowP).toBe(5); // 100/20 = 5
  });

  test('lost-deal drag only when no active deal exists', () => {
    const lostOnly = computeScore(
      contactWith({ deals: [{ stage: 'lost' }] }),
    );
    const lostPlusActive = computeScore(
      contactWith({ deals: [{ stage: 'lost' }, { stage: 'lead' }] }),
    );
    // The active deal masks the lost-deal drag.
    expect(lostPlusActive).toBeGreaterThan(lostOnly);
  });
});

// ─── computeScore: activity recency + decay ─────────────────────────────────

describe('computeScore — activity recency + decay', () => {
  test('recent activity boosts score', () => {
    const stale = computeScore(contactWith({}));
    const recent = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Note' }],
      }),
    );
    expect(recent).toBeGreaterThan(stale);
  });

  test('cold-lead penalty: > 90d since last activity → -8', () => {
    const recent = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Note' }],
      }),
    );
    const cold = computeScore(
      contactWith({
        activities: [
          { createdAt: new Date(Date.now() - 100 * 86400000), type: 'Note' },
        ],
      }),
    );
    expect(cold).toBeLessThan(recent);
  });

  test('lukewarm penalty: 60-90d → -4 (less harsh than > 90d)', () => {
    const cold = computeScore(
      contactWith({
        activities: [
          { createdAt: new Date(Date.now() - 100 * 86400000), type: 'Note' },
        ],
      }),
    );
    const lukewarm = computeScore(
      contactWith({
        activities: [
          { createdAt: new Date(Date.now() - 75 * 86400000), type: 'Note' },
        ],
      }),
    );
    expect(lukewarm).toBeGreaterThan(cold);
  });

  test('Call activities outweigh notes', () => {
    const note = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Note' }],
      }),
    );
    const call = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Call' }],
      }),
    );
    expect(call).toBeGreaterThan(note);
  });

  test('Meeting activities outweigh calls', () => {
    const call = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Call' }],
      }),
    );
    const meeting = computeScore(
      contactWith({
        activities: [{ createdAt: new Date(), type: 'Meeting' }],
      }),
    );
    expect(meeting).toBeGreaterThan(call);
  });
});

// ─── computeScore: sequence enrollment ──────────────────────────────────────

describe('computeScore — sequence enrollment', () => {
  test('active enrollment +4', () => {
    const baseline = computeScore(contactWith({}));
    const active = computeScore(
      contactWith({ sequenceEnrollments: [{ status: 'Active' }] }),
    );
    expect(active - baseline).toBe(4);
  });

  test('completed enrollments contribute (+2 each, capped at 6)', () => {
    const oneCompleted = computeScore(
      contactWith({ sequenceEnrollments: [{ status: 'Completed' }] }),
    );
    const baseline = computeScore(contactWith({}));
    expect(oneCompleted - baseline).toBe(2);

    const fiveCompleted = computeScore(
      contactWith({
        sequenceEnrollments: Array.from({ length: 5 }, () => ({
          status: 'Completed',
        })),
      }),
    );
    expect(fiveCompleted - baseline).toBe(6); // capped
  });
});

// ─── computeScore: email engagement ─────────────────────────────────────────

describe('computeScore — email engagement', () => {
  test('inbound replies score (capped at 12 ≈ 4 replies)', () => {
    const baseline = computeScore(contactWith({}));
    const oneReply = computeScore(
      contactWith({ emails: [{ direction: 'INBOUND' }] }),
    );
    expect(oneReply - baseline).toBe(3);

    const tenReplies = computeScore(
      contactWith({
        emails: Array.from({ length: 10 }, () => ({ direction: 'INBOUND' })),
      }),
    );
    expect(tenReplies - baseline).toBe(12); // capped
  });

  test('inbound sentiment averaged → ±5 contribution', () => {
    const positive = computeScore(
      contactWith({
        emails: [{ direction: 'INBOUND', sentimentScore: 1 }],
      }),
    );
    const negative = computeScore(
      contactWith({
        emails: [{ direction: 'INBOUND', sentimentScore: -1 }],
      }),
    );
    expect(positive - negative).toBe(10); // +5 vs -5
  });

  test('emailTracking opens log-scaled, clicks linear (capped)', () => {
    const baseline = computeScore(contactWith({}));
    const opensOnly = computeScore(
      contactWith({
        emailTracking: Array.from({ length: 4 }, () => ({ type: 'open' })),
      }),
    );
    // log2(4+1)*2 = 4.6 → round 5
    expect(opensOnly).toBeGreaterThan(baseline);

    const clicksCap = computeScore(
      contactWith({
        emailTracking: Array.from({ length: 100 }, () => ({ type: 'click' })),
      }),
    );
    // 100*2 = 200, capped at 10
    expect(clicksCap - baseline).toBeLessThanOrEqual(10 + 8); // opens(0)+clicks(10) since log2(0+1)=0
  });

  test('emailEngagement object branch (alternate input shape)', () => {
    // When emailTracking is NOT an array but emailEngagement is set, the
    // engine takes the alternate shape (route ai_scoring.js path).
    const baseline = computeScore(contactWith({}));
    const viaEngagement = computeScore(
      contactWith({
        emailEngagement: { opens: 4, clicks: 2 },
      }),
    );
    expect(viaEngagement).toBeGreaterThan(baseline);
  });
});

// ─── computeScore: call logs ────────────────────────────────────────────────

describe('computeScore — call logs', () => {
  test('recent (60d) call logs add up to +8', () => {
    const baseline = computeScore(contactWith({}));
    const fiveCalls = computeScore(
      contactWith({
        callLogs: Array.from({ length: 5 }, () => ({ createdAt: new Date() })),
      }),
    );
    expect(fiveCalls - baseline).toBe(8); // 5*2 = 10, capped at 8
  });

  test('aged (>60d) call logs do NOT contribute', () => {
    const baseline = computeScore(contactWith({}));
    const oldCalls = computeScore(
      contactWith({
        callLogs: Array.from({ length: 5 }, () => ({
          createdAt: new Date(Date.now() - 100 * 86400000),
        })),
      }),
    );
    expect(oldCalls).toBe(baseline);
  });
});

// ─── computeScore: touchpoint diversity ─────────────────────────────────────

describe('computeScore — touchpoint diversity', () => {
  test('unique channels add +2 each (capped at 8)', () => {
    const baseline = computeScore(contactWith({}));
    const twoChannels = computeScore(
      contactWith({
        touchpoints: [{ channel: 'email' }, { channel: 'sms' }],
      }),
    );
    expect(twoChannels - baseline).toBe(4);

    const fiveChannels = computeScore(
      contactWith({
        touchpoints: [
          { channel: 'email' }, { channel: 'sms' }, { channel: 'whatsapp' },
          { channel: 'phone' }, { channel: 'in-person' },
        ],
      }),
    );
    expect(fiveChannels - baseline).toBe(8); // capped
  });

  test('duplicate channels collapse via Set', () => {
    const baseline = computeScore(contactWith({}));
    const dupes = computeScore(
      contactWith({
        touchpoints: [
          { channel: 'email' }, { channel: 'email' }, { channel: 'email' },
        ],
      }),
    );
    expect(dupes - baseline).toBe(2); // single unique channel
  });
});

// ─── computeScore: source quality ───────────────────────────────────────────

describe('computeScore — source quality', () => {
  test('referral +8', () => {
    expect(
      computeScore(contactWith({ source: 'referral' }))
        - computeScore(contactWith({})),
    ).toBe(8);
  });

  test('inbound / website-form +5', () => {
    expect(
      computeScore(contactWith({ source: 'website-form' }))
        - computeScore(contactWith({})),
    ).toBe(5);
  });

  test('walk-in +6', () => {
    expect(
      computeScore(contactWith({ source: 'walk-in' }))
        - computeScore(contactWith({})),
    ).toBe(6);
  });

  test('paid +3', () => {
    expect(
      computeScore(contactWith({ source: 'google-ads' }))
        - computeScore(contactWith({})),
    ).toBe(3);
  });

  test('cold / scraped −5', () => {
    expect(
      computeScore(contactWith({ source: 'cold' }))
        - computeScore(contactWith({})),
    ).toBe(-5);
  });

  test('firstTouchSource fallback when source is empty', () => {
    expect(
      computeScore(
        contactWith({ source: '', firstTouchSource: 'referral' }),
      ) - computeScore(contactWith({})),
    ).toBe(8);
  });
});

// ─── computeScore: enrichment + company-size ────────────────────────────────

describe('computeScore — enrichment completeness', () => {
  test('each enrichment field adds: industry+1, companySize+1, linkedin+2, website+1, title+1, company+1', () => {
    const baseline = computeScore(contactWith({}));
    const fully = computeScore(
      contactWith({
        industry: 'SaaS',
        companySize: 'small', // not matching the bracket regex below
        linkedin: 'https://linkedin.com/in/x',
        website: 'https://x.com',
        title: 'CEO',
        company: 'Acme',
      }),
    );
    expect(fully - baseline).toBe(7);
  });

  test('enterprise companySize bracket bumps an extra +6', () => {
    const baseline = computeScore(contactWith({}));
    const enterprise = computeScore(
      contactWith({ companySize: '1000+' }),
    );
    // +1 for completeness AND +6 for the enterprise bracket = +7
    expect(enterprise - baseline).toBe(7);
  });

  test('mid-market 200-500 bracket bumps +4', () => {
    const baseline = computeScore(contactWith({}));
    const mid = computeScore(contactWith({ companySize: '201-500' }));
    expect(mid - baseline).toBe(5); // +1 completeness + +4 bracket
  });

  test('small 51-100 bracket bumps +2', () => {
    const baseline = computeScore(contactWith({}));
    const small = computeScore(contactWith({ companySize: '51-100' }));
    expect(small - baseline).toBe(3); // +1 completeness + +2 bracket
  });
});

// ─── computeScore: tenure + slaBreached ─────────────────────────────────────

describe('computeScore — tenure + sla', () => {
  test('contact > 180d old (and not Churned) gains +2 tenure bonus', () => {
    const recent = computeScore(
      contactWith({
        createdAt: new Date(),
        status: 'Lead',
      }),
    );
    const aged = computeScore(
      contactWith({
        createdAt: new Date(Date.now() - 200 * 86400000),
        status: 'Lead',
      }),
    );
    expect(aged - recent).toBe(2);
  });

  test('aged Churned contact does NOT gain tenure bonus', () => {
    const recent = computeScore(
      contactWith({ createdAt: new Date(), status: 'Churned' }),
    );
    const aged = computeScore(
      contactWith({
        createdAt: new Date(Date.now() - 200 * 86400000),
        status: 'Churned',
      }),
    );
    expect(aged).toBe(recent);
  });

  test('slaBreached drag −3', () => {
    const baseline = computeScore(contactWith({ slaBreached: false }));
    const breached = computeScore(contactWith({ slaBreached: true }));
    expect(breached - baseline).toBe(-3);
  });
});

// ─── tickLeadScoringEngine: orchestration ───────────────────────────────────

describe('tickLeadScoringEngine — orchestration', () => {
  test('happy path: fans out aiScore updates per contact + returns count', async () => {
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1, status: 'Customer' }),
      contactWith({ id: 2, status: 'Lead' }),
      contactWith({ id: 3, status: 'Prospect' }),
    ]);

    const result = await tickLeadScoringEngine(null);

    expect(result).toEqual({ scored: 3 });
    expect(prisma.contact.update).toHaveBeenCalledTimes(3);
    // Each call carries an integer aiScore and the right where:{id}.
    for (const call of prisma.contact.update.mock.calls) {
      const arg = call[0];
      expect(arg.where).toHaveProperty('id');
      expect(arg.data).toHaveProperty('aiScore');
      expect(Number.isInteger(arg.data.aiScore)).toBe(true);
      expect(arg.data.aiScore).toBeGreaterThanOrEqual(1);
      expect(arg.data.aiScore).toBeLessThanOrEqual(99);
    }
  });

  test('findMany include shape: pulls deals/activities/sequences/emails/callLogs', async () => {
    await tickLeadScoringEngine(null);

    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.include).toHaveProperty('deals', true);
    expect(arg.include).toHaveProperty('activities', true);
    expect(arg.include).toHaveProperty('sequenceEnrollments', true);
    expect(arg.include).toHaveProperty('emails');
    expect(arg.include).toHaveProperty('callLogs');
    // emails is selected for direction/sentimentScore/createdAt only.
    expect(arg.include.emails.select).toEqual({
      direction: true,
      sentimentScore: true,
      createdAt: true,
    });
    // callLogs is selected for createdAt.
    expect(arg.include.callLogs.select).toEqual({ createdAt: true });
  });

  test('empty contact set: 0 updates, still returns { scored: 0 }', async () => {
    prisma.contact.findMany.mockResolvedValue([]);
    const result = await tickLeadScoringEngine(null);
    expect(result).toEqual({ scored: 0 });
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });

  test('emits lead_scores_updated on the io socket when supplied', async () => {
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1 }),
      contactWith({ id: 2 }),
    ]);
    const io = { emit: vi.fn() };
    await tickLeadScoringEngine(io);

    expect(io.emit).toHaveBeenCalledTimes(1);
    const [event, payload] = io.emit.mock.calls[0];
    expect(event).toBe('lead_scores_updated');
    expect(payload.count).toBe(2);
    expect(payload.ts).toBeInstanceOf(Date);
  });

  test('no-io variant: works without throwing when io is null', async () => {
    prisma.contact.findMany.mockResolvedValue([contactWith({ id: 1 })]);
    await expect(tickLeadScoringEngine(null)).resolves.toEqual({ scored: 1 });
  });

  test('findMany failure: re-throws (cron-init wrapper handles via .catch)', async () => {
    const dbErr = new Error('DB unreachable');
    prisma.contact.findMany.mockRejectedValueOnce(dbErr);
    await expect(tickLeadScoringEngine(null)).rejects.toThrow('DB unreachable');
  });
});

// ─── Engine-shape contracts (acceptance criteria — ENGINE BUGS DOCUMENTED) ──

describe('tickLeadScoringEngine — engine-shape contracts (gap docs)', () => {
  test('GAP: findMany has NO tenant scope — sweeps all tenants in one tick', async () => {
    // Documented engine bug. Acceptance criterion "Per-tenant scope
    // mandatory" is NOT met. This test pins the current cross-tenant
    // behaviour. If a future fix adds a `where: { tenantId }` filter,
    // this test will fail loudly and force the maintainer to rewrite
    // it as a positive tenant-scope assertion.
    await tickLeadScoringEngine(null);
    const arg = prisma.contact.findMany.mock.calls[0][0] || {};
    expect(arg.where).toBeUndefined();
  });

  test('GAP: no recompute window — every contact rescored every tick', async () => {
    // Documented engine bug. Acceptance criterion "Recompute window
    // — deal scored recently is skipped" is NOT met. The findMany
    // has no aiScoreUpdatedAt or last-scored gate.
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1, aiScore: 50 }),
      contactWith({ id: 2, aiScore: 70 }),
      contactWith({ id: 3, aiScore: 30 }),
    ]);
    await tickLeadScoringEngine(null);
    // ALL three contacts get an update issued, including ones whose
    // computed score equals the existing aiScore.
    expect(prisma.contact.update).toHaveBeenCalledTimes(3);
  });

  test('GAP: Promise.all means one failed update rejects the whole tick', async () => {
    // Documented engine bug. Acceptance criterion "Per-row error
    // containment" is NOT met. A single mid-tick prisma failure aborts
    // the remaining writes from this tick (the cron-init wrapper just
    // logs and waits 10 minutes for the next tick — those writes are
    // simply lost for that interval).
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1 }),
      contactWith({ id: 2 }),
      contactWith({ id: 3 }),
    ]);
    prisma.contact.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('write fail'))
      .mockResolvedValueOnce({});

    await expect(tickLeadScoringEngine(null)).rejects.toThrow('write fail');
  });
});
