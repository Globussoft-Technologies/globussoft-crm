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
 * #421 — three architectural fixes verified by this suite (was: GAP
 * docs pinning the broken behaviour; flipped on #421 close):
 *
 *   ✅ Per-tenant iteration. The engine now loads active tenants first
 *     and runs the existing scoring inside a tenantId-filtered findMany,
 *     so a slow Contact table on tenant A can't stall scoring for
 *     tenants B + C. Mirrors the cron/wellnessOpsEngine.js pattern.
 *
 *   ✅ Recompute window (24h). The findMany filters out contacts whose
 *     aiScoreLastComputedAt is within the last 24h, using aiScoreLastComputedAt as a proxy for
 *     "last scored at" until a dedicated aiScoreLastComputedAt column
 *     is added. Eliminates the "100K updates per 10-min tick at scale"
 *     pathology Sentry was flagging.
 *
 *   ✅ Per-row error containment via Promise.allSettled. A single
 *     corrupted contact (deadlock, JSON-decode failure on
 *     customAttributes, FK violation) no longer rejects the whole tick
 *     — failures are logged with the contact id and the rest of the
 *     batch lands.
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

// CRITICAL: backend/cron/leadScoringEngine.js calls dotenv.config({override:true})
// at module top against the repo root .env, which carries a real GEMINI_API_KEY
// in dev/CI (post-PR #644 the engine attempts a Gemini fallback in
// tickLeadScoringEngine). Without intercepting the @google/generative-ai SDK
// BEFORE the engine's require() chain executes, every "tick" test would issue
// a live, billed Gemini API call (responses are non-deterministic and the
// upstream is slow → tests time out at the 5s vitest budget).
//
// Pattern mirrors backend/test/cron/sentimentEngine.test.js (commit 76bf2a4).
// vi.mock('@google/generative-ai') with an ESM factory does NOT intercept
// CJS require() chains under this vitest setup — workaround: load the real
// CJS module via createRequire INSIDE a vi.hoisted() block, monkey-patch
// the GoogleGenerativeAI constructor on its exports object BEFORE any ESM
// import statement evaluates. The engine's
// `const { GoogleGenerativeAI } = require("@google/generative-ai")` resolves
// to our stub class because the require cache is shared.
const { mockGenerateContent } = vi.hoisted(() => {
  // Set GEMINI_API_KEY BEFORE the engine import so the engine's
  // `if (GEMINI_KEY)` init branch fires and captures our stubbed model.
  // CI's unit_tests job has no real key set; without this line the engine
  // skips init entirely and aiModel stays null (which is fine for the
  // rules-only tests but not what we want for the orchestration tests
  // — they need a stubbed Gemini that resolves fast or rejects fast,
  // not real network I/O).
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-fake-key';

  const { createRequire } = require('node:module');
  const requireCJS = createRequire(__filename || process.cwd() + '/');
  const genAIModule = requireCJS('@google/generative-ai');

  const fn = vi.fn();
  // Must be a regular function (NOT an arrow) — engine calls
  // `new GoogleGenerativeAI(key)` and arrow functions are not constructors.
  function MockGoogleGenerativeAI() {
    this.getGenerativeModel = function () {
      return { generateContent: fn };
    };
  }
  genAIModule.GoogleGenerativeAI = MockGoogleGenerativeAI;
  return { mockGenerateContent: fn };
});

import {
  computeScore,
  tickLeadScoringEngine,
} from '../../cron/leadScoringEngine.js';

beforeAll(() => {
  prisma.contact = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
  // #421 — engine now iterates per tenant, so we must mock prisma.tenant
  // alongside prisma.contact. Default to a single active tenant so the
  // legacy single-tenant tests keep semantics; multi-tenant tests below
  // override this.
  prisma.tenant = {
    findMany: vi.fn(),
  };
});

beforeEach(() => {
  prisma.contact.findMany.mockReset();
  prisma.contact.update.mockReset();
  prisma.tenant.findMany.mockReset();

  prisma.tenant.findMany.mockResolvedValue([{ id: 1 }]);
  prisma.contact.findMany.mockResolvedValue([]);
  prisma.contact.update.mockResolvedValue({});

  // DEFAULT: Gemini "fails" so tickLeadScoringEngine falls through to
  // computeScore (the rules-based path). The engine's scoreWithGemini()
  // catches the rejection and returns null → engine then calls computeScore.
  // Tests that want to exercise the Gemini happy path can queue a
  // mockResolvedValueOnce, which takes precedence over this default reject.
  mockGenerateContent.mockReset();
  mockGenerateContent.mockRejectedValue(new Error('test-default-no-gemini'));
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
  // PR #644 added a senior-title bonus (+6 for titles matching the regex
  // /director|vp|c-level|ceo|cto|cfo|president|head of|manager|lead/).
  // The fully-enriched contact below uses title='CEO' which now triggers
  // BOTH the +1 enrichment "title is set" bump AND the +6 seniority bump,
  // so the delta over the baseline is 7 (legacy enrichment) + 6 (new
  // seniority) = 13. To isolate the pure enrichment contribution, we use
  // a non-senior title ('Engineer') which only fires the +1 bump.
  test('each enrichment field adds: industry+1, companySize+1, linkedin+2, website+1, title+1 (non-senior), company+1', () => {
    const baseline = computeScore(contactWith({}));
    const fully = computeScore(
      contactWith({
        industry: 'SaaS',
        companySize: 'small', // not matching the bracket regex below
        linkedin: 'https://linkedin.com/in/x',
        website: 'https://x.com',
        title: 'Engineer', // non-senior — avoids the +6 seniority branch
        company: 'Acme',
      }),
    );
    expect(fully - baseline).toBe(7);
  });

  // Pin the new PR #644 seniority bonus separately so a future regression
  // that re-removes it would surface here, not silently inside the
  // enrichment-completeness test.
  test('senior title (CEO/director/vp/manager/etc.) adds +6 over a non-senior title', () => {
    const engineer = computeScore(contactWith({ title: 'Engineer' }));
    const ceo = computeScore(contactWith({ title: 'CEO' }));
    expect(ceo - engineer).toBe(6);
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

    // #421 — one findMany per active tenant. The default beforeEach mock
    // returns a single tenant, so we still expect exactly one call.
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

// ─── Engine-shape contracts (acceptance criteria — ENGINE FIXES VERIFIED) ──
//
// These three tests previously documented the GAP (the engine's
// architectural debt at the time of commit 53e3299). Issue #421 closed
// those gaps; the tests are now FIXED-state assertions that prove the
// per-tenant scope, recompute window, and per-row error containment are
// all in place. Any regression that re-removes one of these properties
// will fail the corresponding test loudly.

describe('tickLeadScoringEngine — engine-shape contracts (#421 fixes verified)', () => {
  test('FIXED: findMany IS tenant-scoped — iterates active tenants', async () => {
    // #421 gap 1 — per-tenant iteration. The engine now loads tenants
    // first, then runs the existing scoring per tenant inside a
    // tenantId-filtered findMany. A multi-tenant deployment is bounded
    // per tenant; cross-tenant noisy-neighbour outages can no longer
    // happen.
    prisma.tenant.findMany.mockResolvedValue([{ id: 7 }, { id: 11 }]);

    await tickLeadScoringEngine(null);

    // One contact.findMany call per active tenant.
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(2);
    // Each carries an explicit tenantId filter.
    const tenantIds = prisma.contact.findMany.mock.calls.map(
      ([arg]) => arg.where.tenantId,
    );
    expect(tenantIds.sort((a, b) => a - b)).toEqual([7, 11]);
    // Tenant lookup is itself scoped to active tenants only.
    expect(prisma.tenant.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.findMany.mock.calls[0][0].where).toEqual({
      isActive: true,
    });
  });

  test('FIXED: recompute window — findMany filters out recently-scored contacts', async () => {
    // #421 gap 2 — recompute window via aiScoreLastComputedAt proxy. The findMany
    // now carries an OR clause that excludes contacts whose aiScoreLastComputedAt
    // is within the last 24h. Production no longer pays 100K updates
    // per 10-min tick on stale data.
    await tickLeadScoringEngine(null);

    const arg = prisma.contact.findMany.mock.calls[0][0];
    expect(arg.where).toBeDefined();
    expect(arg.where.OR).toBeDefined();
    expect(Array.isArray(arg.where.OR)).toBe(true);

    // The two clauses: aiScoreLastComputedAt is null OR aiScoreLastComputedAt is older than 24h.
    const orClauses = arg.where.OR;
    const nullClause = orClauses.find(c => c.aiScoreLastComputedAt === null);
    const ltClause = orClauses.find(c => c.aiScoreLastComputedAt && c.aiScoreLastComputedAt.lt);
    expect(nullClause).toBeDefined();
    expect(ltClause).toBeDefined();

    // Cutoff is approximately 24h ago.
    const cutoff = ltClause.aiScoreLastComputedAt.lt;
    expect(cutoff).toBeInstanceOf(Date);
    const ageHours = (Date.now() - cutoff.getTime()) / 3600000;
    expect(ageHours).toBeGreaterThan(23);
    expect(ageHours).toBeLessThan(25);
  });

  test('FIXED: Promise.allSettled — one failed update no longer rejects the tick', async () => {
    // #421 gap 3 — per-row error containment. A single corrupted
    // contact (e.g. JSON-decode failure on customAttributes, deadlock,
    // FK violation) used to abort the whole tick. allSettled now lets
    // the other contacts land their score updates and the engine
    // resolves cleanly.
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1 }),
      contactWith({ id: 2 }),
      contactWith({ id: 3 }),
    ]);
    prisma.contact.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('write fail'))
      .mockResolvedValueOnce({});

    // Engine no longer rejects; returns a clean count of attempted
    // contacts (the per-row failure is logged, not propagated).
    const result = await tickLeadScoringEngine(null);
    expect(result).toEqual({ scored: 3 });
    // All three update calls were issued.
    expect(prisma.contact.update).toHaveBeenCalledTimes(3);
  });

  // ─── Edge cases added for the #421 fix ───────────────────────────────

  test('multi-tenant scoring sums across tenants in returned count', async () => {
    // Two tenants, two contacts each → engine reports 4 scored.
    prisma.tenant.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    prisma.contact.findMany
      .mockResolvedValueOnce([
        contactWith({ id: 100 }),
        contactWith({ id: 101 }),
      ])
      .mockResolvedValueOnce([
        contactWith({ id: 200 }),
        contactWith({ id: 201 }),
      ]);

    const result = await tickLeadScoringEngine(null);
    expect(result).toEqual({ scored: 4 });
    expect(prisma.contact.update).toHaveBeenCalledTimes(4);
  });

  test('recompute window: contact with aiScoreLastComputedAt=null still scored (new contact bootstrap)', async () => {
    // The OR clause is `aiScoreLastComputedAt: null OR aiScoreLastComputedAt < cutoff`. Brand-
    // new contacts with no aiScoreLastComputedAt are correctly included so they
    // pick up an initial aiScore on first tick.
    await tickLeadScoringEngine(null);
    const orClauses = prisma.contact.findMany.mock.calls[0][0].where.OR;
    const hasNullBranch = orClauses.some(
      c => Object.prototype.hasOwnProperty.call(c, 'aiScoreLastComputedAt') && c.aiScoreLastComputedAt === null,
    );
    expect(hasNullBranch).toBe(true);
  });

  test('partial-failure tick still emits lead_scores_updated to io', async () => {
    // Contract: even with mid-tick failures, the io broadcast still
    // fires so connected dashboards refresh on the contacts that DID
    // score successfully.
    prisma.contact.findMany.mockResolvedValue([
      contactWith({ id: 1 }),
      contactWith({ id: 2 }),
    ]);
    prisma.contact.update
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('row fail'));
    const io = { emit: vi.fn() };

    await tickLeadScoringEngine(io);

    expect(io.emit).toHaveBeenCalledWith(
      'lead_scores_updated',
      expect.objectContaining({ count: 2 }),
    );
  });

  test('zero active tenants: tick is a clean no-op', async () => {
    // Edge case: a fresh deployment with no active tenants. The engine
    // must not throw, must not call contact.findMany at all, and must
    // resolve with scored: 0.
    prisma.tenant.findMany.mockResolvedValue([]);
    const result = await tickLeadScoringEngine(null);
    expect(result).toEqual({ scored: 0 });
    expect(prisma.contact.findMany).not.toHaveBeenCalled();
    expect(prisma.contact.update).not.toHaveBeenCalled();
  });
});

// ─── #571 — Static-feature scoring + non-uniform distribution ──────────────
//
// Acceptance criteria for issue #571 (Lead Scoring engine produces no
// variation — all 100 cold leads scored 7/100). These tests pin the
// new static-feature contributions (corporate-domain email, identity
// completeness) AND assert that scoring 100 synthetic contacts with
// varied profile + age produces a non-uniform distribution spanning
// at least 3 of the 5 score buckets.

describe('#571 — corporate-domain email scoring (+18 net vs personal, post-PR #644)', () => {
  // PR #644 added a SECOND corporate-email branch (+8) alongside the
  // existing #571 branch (+10). Both fire on the same condition (non-
  // personal-domain email), so a corporate inbox now scores +18 over a
  // personal-domain baseline (10 + 8 = 18). The duplication is visible
  // in computeScore around lines 124-128 (#571 branch, regex against
  // domain prefix) AND lines 246-250 (PR #644 branch, endsWith against
  // a personal-domain list named misleadingly `corporateDomains`).
  //
  // Filed as TODOS follow-up: the duplication should likely be folded
  // into a single branch. Leaving the test pinned to current observed
  // +18 so this test goes red if either branch is removed without an
  // accompanying constant update on the surviving branch.
  test('corporate domain adds +18 over personal-domain baseline (#571 +10 + PR #644 +8)', () => {
    const personal = computeScore(contactWith({ name: 'A', email: 'alice@gmail.com' }));
    const corporate = computeScore(contactWith({ name: 'A', email: 'alice@acme.com' }));
    expect(corporate - personal).toBe(18);
  });

  // PR #644's personal-domain list (engine line 248) is a strict subset
  // of the #571 personal-domain regex (engine line 126). Domains in
  // #571's regex but NOT in PR #644's list (icloud/protonmail/live/msn/
  // me/mail/ymail) only catch the #571 -10 path; PR #644's +8 still
  // fires for those because endsWith() doesn't recognise them as
  // personal — so they net +8 vs corporate's +18, a +10 delta. The
  // domains common to BOTH lists (gmail/yahoo/hotmail/outlook/aol)
  // catch both penalties → +18 delta. Pin both behaviours so a future
  // unifier surfaces here.
  test('domains in both engine personal-lists score full +18 below corporate', () => {
    const corp = computeScore(contactWith({ email: 'a@acme.com' }));
    for (const personal of [
      'a@gmail.com', 'a@yahoo.com', 'a@hotmail.com', 'a@outlook.com', 'a@aol.com',
    ]) {
      const score = computeScore(contactWith({ email: personal }));
      expect(corp - score).toBe(18);
    }
  });

  test('domains in #571 list but NOT PR #644 list score +10 below corporate (only one branch fires)', () => {
    const corp = computeScore(contactWith({ email: 'a@acme.com' }));
    for (const personal of [
      'a@icloud.com', 'a@protonmail.com',
    ]) {
      const score = computeScore(contactWith({ email: personal }));
      expect(corp - score).toBe(10);
    }
  });

  test('no email present: corporate-domain branch is a no-op', () => {
    const noEmail = computeScore(contactWith({}));
    const empty = computeScore(contactWith({ email: '' }));
    expect(empty).toBe(noEmail);
  });
});

describe('#571 — identity completeness (name + email + phone +3 each)', () => {
  test('each identity field adds +3 (name + email + phone = +9)', () => {
    const baseline = computeScore(contactWith({}));
    const fullyId = computeScore(contactWith({
      name: 'Jane Doe', email: 'jane@gmail.com', phone: '+1-415-5550000',
    }));
    // baseline has no name/email/phone (contactWith defaults to none).
    // fullyId adds +3 +3 +3 from identity. email is personal-domain so no
    // corporate bump. So delta is exactly +9.
    expect(fullyId - baseline).toBe(9);
  });
});

describe('#571 — lead-funnel age decay (status=Lead only, ≤180d)', () => {
  test('Lead aged 7-30 days loses 3 points', () => {
    const fresh = computeScore(contactWith({ status: 'Lead', createdAt: new Date() }));
    const aged20d = computeScore(contactWith({
      status: 'Lead', createdAt: new Date(Date.now() - 20 * 86400000),
    }));
    expect(aged20d - fresh).toBe(-3);
  });

  test('Lead aged 30-180 days loses 6 points', () => {
    const fresh = computeScore(contactWith({ status: 'Lead', createdAt: new Date() }));
    const aged90d = computeScore(contactWith({
      status: 'Lead', createdAt: new Date(Date.now() - 90 * 86400000),
    }));
    expect(aged90d - fresh).toBe(-6);
  });

  test('Customer status: age decay is suppressed (only applies to Leads)', () => {
    const freshCustomer = computeScore(contactWith({ status: 'Customer', createdAt: new Date() }));
    const aged90dCustomer = computeScore(contactWith({
      status: 'Customer', createdAt: new Date(Date.now() - 90 * 86400000),
    }));
    expect(aged90dCustomer).toBe(freshCustomer);
  });
});

describe('#571 — empty-activities array no longer triggers cold penalty', () => {
  test('contact with NO activities is not penalised as cold (was -8 cliff)', () => {
    // Pre-#571 the engine compared mostRecentDays = Infinity > 90 and
    // applied -8 to every contact with an empty activities array — so
    // every brand-new lead with no events collapsed to score 7. After
    // #571 the penalty fires only when activities.length > 0.
    const empty = computeScore(contactWith({ activities: [] }));
    const oneRecent = computeScore(contactWith({
      activities: [{ createdAt: new Date(), type: 'Note' }],
    }));
    // The recent-activity contact is still higher (engagement weight),
    // but the gap should reflect the activity-recency contribution, NOT
    // an extra -8 cold-penalty cliff. Pre-#571 gap was ~10 (8 penalty +
    // ~2 weight); post-#571 gap should be ~2.
    expect(oneRecent - empty).toBeLessThanOrEqual(4);
    expect(oneRecent).toBeGreaterThan(empty);
  });
});

describe('#571 — non-uniform distribution across 100 synthetic contacts', () => {
  test('100 varied contacts produce scores spanning at least 3 buckets', () => {
    // Mirror the seed strategy: 20% hot, 20% warm, 60% cold-tail with
    // varied profile completeness, email quality, and age.
    const buckets = [0, 0, 0, 0, 0]; // 0-20, 21-40, 41-60, 61-80, 81-100
    const corpDomains = ['acme.com', 'techflow.io', 'novacrest.com', 'bigco.de'];
    const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com'];

    for (let i = 0; i < 100; i++) {
      const tier = i < 20 ? 'hot' : i < 40 ? 'warm' : 'cold';
      const usePersonal = i % 5 === 0;
      const domain = usePersonal ? personalDomains[i % 3] : corpDomains[i % 4];
      const overrides = {
        name: `Contact ${i}`,
        email: `contact${i}@${domain}`,
        phone: i % 7 === 0 ? null : `+1-555-${1000 + i}`,
        company: `Company ${i}`,
        title: i % 3 === 0 ? 'CEO' : 'Manager',
        industry: i % 4 === 0 ? null : 'SaaS',
        companySize: i % 5 === 0 ? '1000+' : i % 3 === 0 ? '51-200' : null,
        source: tier === 'hot' ? 'referral' : tier === 'warm' ? 'website-form' : i % 4 === 0 ? 'cold' : 'organic',
        createdAt: tier === 'hot'
          ? new Date(Date.now() - (i % 5) * 86400000)
          : tier === 'warm'
            ? new Date(Date.now() - (15 + i) * 86400000)
            : new Date(Date.now() - (60 + i) * 86400000),
        status: tier === 'hot' ? 'Prospect' : 'Lead',
        activities: tier === 'hot'
          ? [{ createdAt: new Date(Date.now() - 2 * 86400000), type: 'Meeting' },
             { createdAt: new Date(Date.now() - 5 * 86400000), type: 'Call' }]
          : tier === 'warm'
            ? [{ createdAt: new Date(Date.now() - 25 * 86400000), type: 'Note' }]
            : [],
        emails: tier === 'hot'
          ? Array.from({ length: 3 + (i % 3) }, () => ({ direction: 'INBOUND', sentimentScore: 0.7 }))
          : [],
        callLogs: tier === 'hot'
          ? Array.from({ length: 1 + (i % 3) }, () => ({ createdAt: new Date(Date.now() - 10 * 86400000) }))
          : [],
        touchpoints: tier === 'hot'
          ? [{ channel: 'email' }, { channel: 'social' }, { channel: 'search' }]
          : tier === 'warm'
            ? [{ channel: 'email' }]
            : [],
        deals: tier === 'hot'
          ? [{ stage: 'proposal', amount: 50000, probability: 60 }]
          : [],
      };
      const score = computeScore(contactWith(overrides));
      const bucket = Math.min(4, Math.floor(score / 21));
      buckets[bucket]++;
    }

    // Acceptance: NOT all in 0-20 bucket; spans ≥ 3 of the 5 buckets.
    expect(buckets[0]).toBeLessThan(95); // pre-fix: all 100 in [0,20]
    const populatedBuckets = buckets.filter(c => c > 0).length;
    expect(populatedBuckets).toBeGreaterThanOrEqual(3);

    // No score should equal exactly 7 for every contact (the bug).
    // After the fix, the empty-baseline floor varies with status/source
    // so no synthetic contact should land on the exact pre-fix "7".
    const allSeven = Array.from({ length: 100 }).every((_, i) => {
      const ov = { name: `c${i}`, email: `c${i}@gmail.com`, status: 'Lead' };
      return computeScore(contactWith(ov)) === 7;
    });
    expect(allSeven).toBe(false);
  });

  test('hot prospects do reach the 70+ band', () => {
    // Build a maxed-out warm-bordering-hot contact and confirm scoring
    // gets it past 70. Pre-fix, NO seeded contact crossed 70 — the
    // demo's "Top Hot Leads" panel showed "No hot leads yet".
    const hot = computeScore(contactWith({
      status: 'Prospect',
      name: 'Sarah Chen', email: 'sarah@techflow.io', phone: '+1-415-5551234',
      company: 'TechFlow', title: 'VP Engineering',
      industry: 'SaaS', companySize: '1000+',
      linkedin: 'https://linkedin.com/in/sarahchen', website: 'https://techflow.io',
      source: 'referral',
      createdAt: new Date(Date.now() - 14 * 86400000),
      activities: [
        { createdAt: new Date(Date.now() - 1 * 86400000), type: 'Meeting' },
        { createdAt: new Date(Date.now() - 3 * 86400000), type: 'Call' },
      ],
      emails: [
        { direction: 'INBOUND', sentimentScore: 0.8 },
        { direction: 'INBOUND', sentimentScore: 0.7 },
        { direction: 'INBOUND', sentimentScore: 0.6 },
      ],
      callLogs: [{ createdAt: new Date() }, { createdAt: new Date() }],
      touchpoints: [{ channel: 'email' }, { channel: 'social' }, { channel: 'search' }],
      deals: [{ stage: 'proposal', amount: 100000, probability: 60 }],
    }));
    expect(hot).toBeGreaterThanOrEqual(70);
  });
});

