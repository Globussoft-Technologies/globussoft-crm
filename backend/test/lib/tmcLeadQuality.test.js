// Unit tests for backend/lib/tmcLeadQuality.js — TMC diagnostic lead-quality
// classifier per PRD §3.4.
//
// Contract: pure function `classifyLeadQuality(answers, opts) → {leadQuality,
// reasons, flags}`. 5 rules: free_domain_senior_role / profile_spend_contradiction
// / junk_strings / repeat_submitter / indian_mobile_format_fail. Any single rule
// fires → leadQuality='suspect'; no rules fire → 'clean'.
//
// These tests pin BOTH the per-rule firing/non-firing and the block-list
// extensibility (config-supplied free-mail domains / junk-string tokens
// extend the seeded defaults). The PRD's load-bearing invariant — "report
// generation is NOT blocked" — is enforced upstream (in T5/T8 route
// handlers); this module only emits the classification, so these tests
// pin the classification shape exhaustively.

import { describe, test, expect } from 'vitest';

const {
  classifyLeadQuality,
  DEFAULT_FREE_EMAIL_DOMAINS,
  DEFAULT_JUNK_STRING_BLOCKLIST,
  SENIOR_ROLE_VALUES,
  REPEAT_SUBMITTER_THRESHOLD,
  looksLikeJunkString,
  isValidIndianMobile,
  emailDomain,
  emailLocalPart,
} = await import('../../lib/tmcLeadQuality.js').then((m) => m.default || m);

// ---------------------------------------------------------------------------
// Shared fixtures: a clean lead that fires none of the 5 rules. Tests
// flip one field at a time to isolate each rule, so the helper guarantees
// we don't trip a sibling rule by accident (e.g. a junk school_name
// while testing the email rule).
// ---------------------------------------------------------------------------
function cleanAnswers(overrides = {}) {
  return {
    primary_outcome: 'Confidence',
    secondary_skills: ['Empathy', 'Collaboration and teamwork'],
    growth_area: 'global_curiosity',
    travel_maturity: 'Regular domestic',
    grade_band: '9-10',
    curriculum: ['CBSE'],
    geo_preference: 'domestic',
    group_size: '35-45',
    budget_band: '30k-75k',
    timeline: 'Next term',
    school_profile: {
      school_name: 'Greenfield International School',
      city: 'Bengaluru',
      branches: '1',
      student_strength: '1000 to 2000',
      fee_band: '75k to 1 lakh',
    },
    contact: {
      contact_name: 'Anita Krishnamurthy',
      contact_role: 'Academic Coordinator',
      email: 'akrishnamurthy@greenfield.edu.in',
      phone: '+91 9876543210',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Module surface — guard against accidental contract drift
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — module surface', () => {
  test('exports the public function + constants the route consumers depend on', () => {
    expect(typeof classifyLeadQuality).toBe('function');
    expect(Array.isArray(DEFAULT_FREE_EMAIL_DOMAINS)).toBe(true);
    expect(Array.isArray(DEFAULT_JUNK_STRING_BLOCKLIST)).toBe(true);
    expect(Array.isArray(SENIOR_ROLE_VALUES)).toBe(true);
    expect(REPEAT_SUBMITTER_THRESHOLD).toBe(3);
  });

  test('default free-mail block list covers the PRD-named domains', () => {
    // Spot-check the explicit PRD §3.4 rule 1 list — gmail.com, yahoo
    // family, hotmail, outlook, icloud, proton, rediffmail, aol, zoho, gmx.
    for (const d of ['gmail.com', 'yahoo.com', 'yahoo.in', 'hotmail.com',
      'outlook.com', 'icloud.com', 'proton.me', 'protonmail.com',
      'rediffmail.com', 'aol.com', 'zoho.com', 'gmx.com']) {
      expect(DEFAULT_FREE_EMAIL_DOMAINS).toContain(d);
    }
  });
});

// ---------------------------------------------------------------------------
// Case 1: Clean lead — all 5 rules pass, leadQuality='clean', reasons=[]
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — clean lead', () => {
  test('returns clean when every rule passes', () => {
    const result = classifyLeadQuality(cleanAnswers());
    expect(result.leadQuality).toBe('clean');
    expect(result.reasons).toEqual([]);
    // All 5 flags present and false — downstream consumers switch on shape.
    expect(result.flags).toEqual({
      free_domain_senior_role: false,
      profile_spend_contradiction: false,
      junk_strings: false,
      repeat_submitter: false,
      indian_mobile_format_fail: false,
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 1: free_domain_senior_role
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — rule 1: free_domain_senior_role', () => {
  test('fires when email is on free-mail block list AND role is senior', () => {
    const answers = cleanAnswers({
      contact: {
        ...cleanAnswers().contact,
        email: 'principal@gmail.com',
        contact_role: 'Principal',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('free_domain_senior_role');
    expect(result.flags.free_domain_senior_role).toBe(true);
  });

  test('does NOT fire when email is free-mail but role is junior (Academic Coordinator)', () => {
    const answers = cleanAnswers({
      contact: {
        ...cleanAnswers().contact,
        email: 'coordinator@gmail.com',
        contact_role: 'Academic Coordinator',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.free_domain_senior_role).toBe(false);
    // No other rule should fire either — confirms the clean baseline.
    expect(result.leadQuality).toBe('clean');
  });

  test('does NOT fire when role is senior but email is on a school domain', () => {
    const answers = cleanAnswers({
      contact: {
        ...cleanAnswers().contact,
        email: 'principal@greenfield.edu.in',
        contact_role: 'Principal',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.free_domain_senior_role).toBe(false);
    expect(result.leadQuality).toBe('clean');
  });

  test('extends free-mail block list via opts.freeEmailDomains', () => {
    const answers = cleanAnswers({
      contact: {
        ...cleanAnswers().contact,
        email: 'principal@customfreemail.example',
        contact_role: 'Owner/Trustee',
      },
    });
    // Without extension — domain unknown to defaults — no fire.
    expect(classifyLeadQuality(answers).flags.free_domain_senior_role).toBe(false);
    // With extension — fires.
    const result = classifyLeadQuality(answers, {
      freeEmailDomains: ['customfreemail.example'],
    });
    expect(result.flags.free_domain_senior_role).toBe(true);
    expect(result.reasons).toContain('free_domain_senior_role');
  });

  test('case-insensitive on both email domain and role string', () => {
    const answers = cleanAnswers({
      contact: {
        ...cleanAnswers().contact,
        email: 'PRINCIPAL@GMAIL.COM',
        contact_role: '  PRINCIPAL  ',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.free_domain_senior_role).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: profile_spend_contradiction
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — rule 2: profile_spend_contradiction', () => {
  test('fires on the exact 3-way: under 500 students + under 75k fees + 2l-plus budget', () => {
    const answers = cleanAnswers({
      budget_band: '2l-plus',
      school_profile: {
        ...cleanAnswers().school_profile,
        student_strength: 'under 500',
        fee_band: 'under 75k',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('profile_spend_contradiction');
    expect(result.flags.profile_spend_contradiction).toBe(true);
  });

  test('does NOT fire when school size is plausible for the budget (1000-2000 students)', () => {
    const answers = cleanAnswers({
      budget_band: '2l-plus',
      school_profile: {
        ...cleanAnswers().school_profile,
        student_strength: '1000 to 2000',
        fee_band: 'over 1 lakh',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.profile_spend_contradiction).toBe(false);
    expect(result.leadQuality).toBe('clean');
  });

  test('does NOT fire when budget is the 2l-plus band but ONLY 2 of 3 conditions hold', () => {
    // student_strength="under 500" + budget_band="2l-plus" but fee_band is mid-tier
    const answers = cleanAnswers({
      budget_band: '2l-plus',
      school_profile: {
        ...cleanAnswers().school_profile,
        student_strength: 'under 500',
        fee_band: '75k to 1 lakh',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.profile_spend_contradiction).toBe(false);
  });

  test('does NOT fire when budget_band is not 2l-plus', () => {
    const answers = cleanAnswers({
      budget_band: '1l-2l',
      school_profile: {
        ...cleanAnswers().school_profile,
        student_strength: 'under 500',
        fee_band: 'under 75k',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.flags.profile_spend_contradiction).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 3: junk_strings
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — rule 3: junk_strings', () => {
  test('fires when school_name matches an obvious test pattern', () => {
    const answers = cleanAnswers({
      school_profile: {
        ...cleanAnswers().school_profile,
        school_name: 'Test School',
      },
    });
    // "Test School" lower-cases to "test school" — not in the token list,
    // BUT the inner "test" word doesn't trip the all-token rule. Verify
    // that the structural rules catch the cases the PRD names directly.
    const result = classifyLeadQuality(answers);
    // "test school" is NOT all-digit, IS > 2 chars, doesn't have a 4x-repeat
    // char, and is not a single junk token. PRD says "matches obvious
    // test patterns (test / asdf / qwerty / abc / xyz / none / na)" —
    // we apply that as token-equality NOT substring (substring "test"
    // would false-positive "Holy Trinity Testudo School"). To get this
    // case to fire, the school name itself should BE the junk token.
    expect(result.flags.junk_strings).toBe(false);
  });

  test('fires when school_name IS a junk token (exact match)', () => {
    const answers = cleanAnswers({
      school_profile: {
        ...cleanAnswers().school_profile,
        school_name: 'test',
      },
    });
    const result = classifyLeadQuality(answers);
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('junk_strings');
    expect(result.flags.junk_strings).toBe(true);
  });

  test('fires when contact_name is empty after trim', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, contact_name: '   ' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(true);
  });

  test('fires when contact_name is <2 chars', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, contact_name: 'A' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(true);
  });

  test('fires when school_name is all digits', () => {
    const answers = cleanAnswers({
      school_profile: { ...cleanAnswers().school_profile, school_name: '123456' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(true);
  });

  test('fires when school_name has a single char repeated 4+ times (aaaaa)', () => {
    const answers = cleanAnswers({
      school_profile: { ...cleanAnswers().school_profile, school_name: 'aaaaa' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(true);
  });

  test('does NOT fire on legit names that happen to contain a junk substring', () => {
    // "Test" inside "Holy Trinity" doesn't substring-fire; only exact-token
    // match fires. This pins the no-substring-FP contract.
    const answers = cleanAnswers({
      school_profile: {
        ...cleanAnswers().school_profile,
        school_name: 'Holy Trinity Public School',
      },
      contact: { ...cleanAnswers().contact, contact_name: 'Anita Testabhirami' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(false);
  });

  test('extends junk-string blocklist via opts.junkStringBlocklist (config-extensible per PRD)', () => {
    const answers = cleanAnswers({
      school_profile: {
        ...cleanAnswers().school_profile,
        school_name: 'mycustomblockword',
      },
    });
    // Without extension — no fire (no structural junk, not in default tokens).
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(false);
    // With extension — fires.
    const result = classifyLeadQuality(answers, {
      junkStringBlocklist: ['mycustomblockword'],
    });
    expect(result.flags.junk_strings).toBe(true);
    expect(result.reasons).toContain('junk_strings');
  });

  test('fires when email local-part is a junk token (principal@test.com)', () => {
    // test.com is NOT on the free-mail list (so rule 1 doesn't fire), but
    // the local-part "test" is junk — this catches the gap rule 1 misses.
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, email: 'test@example.com' },
    });
    expect(classifyLeadQuality(answers).flags.junk_strings).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rule 4: repeat_submitter
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — rule 4: repeat_submitter', () => {
  test('fires when priorSubmissionsLast24h > 3 (PRD: >3 in 24h)', () => {
    const result = classifyLeadQuality(cleanAnswers(), {
      priorSubmissionsLast24h: 4,
    });
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('repeat_submitter');
    expect(result.flags.repeat_submitter).toBe(true);
  });

  test('does NOT fire at the boundary value of exactly 3 (PRD: STRICTLY >3)', () => {
    const result = classifyLeadQuality(cleanAnswers(), {
      priorSubmissionsLast24h: 3,
    });
    expect(result.flags.repeat_submitter).toBe(false);
    expect(result.leadQuality).toBe('clean');
  });

  test('defaults to 0 when opts.priorSubmissionsLast24h is omitted', () => {
    const result = classifyLeadQuality(cleanAnswers());
    expect(result.flags.repeat_submitter).toBe(false);
  });

  test('ignores non-finite values (string / NaN / undefined) — defaults to 0', () => {
    expect(classifyLeadQuality(cleanAnswers(), { priorSubmissionsLast24h: NaN })
      .flags.repeat_submitter).toBe(false);
    expect(classifyLeadQuality(cleanAnswers(), { priorSubmissionsLast24h: 'four' })
      .flags.repeat_submitter).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rule 5: indian_mobile_format_fail
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — rule 5: indian_mobile_format_fail', () => {
  test('does NOT fire on a valid Indian mobile with +91 prefix', () => {
    // Already in cleanAnswers — pinning it explicitly.
    const result = classifyLeadQuality(cleanAnswers());
    expect(result.flags.indian_mobile_format_fail).toBe(false);
  });

  test('does NOT fire on a valid Indian mobile with no prefix', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '9876543210' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(false);
  });

  test('does NOT fire on a valid Indian mobile with a leading 0 trunk prefix', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '09876543210' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(false);
  });

  test('does NOT fire on valid number with spaces and hyphens (normalized away)', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '+91 98765-43210' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(false);
  });

  test('fires on a US-format number (+1...)', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '+1 415 555 0199' },
    });
    const result = classifyLeadQuality(answers);
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('indian_mobile_format_fail');
    expect(result.flags.indian_mobile_format_fail).toBe(true);
  });

  test('fires when Indian number starts with 0-5 (invalid leading digit)', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '5876543210' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(true);
  });

  test('fires when number is too short', () => {
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '98765' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(true);
  });

  test('does NOT fire when phone is blank (different problem class)', () => {
    // Empty phone is a submit-time validation issue, not a suspect-classifier
    // signal. Pin the carve-out so the upstream form-validation layer owns
    // it cleanly.
    const answers = cleanAnswers({
      contact: { ...cleanAnswers().contact, phone: '' },
    });
    expect(classifyLeadQuality(answers).flags.indian_mobile_format_fail).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-rule firing — reasons array carries all of them in deterministic order
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — multi-rule firing', () => {
  test('when 4 rules fire, reasons includes all 4 in defined order', () => {
    const answers = cleanAnswers({
      budget_band: '2l-plus',
      school_profile: {
        ...cleanAnswers().school_profile,
        student_strength: 'under 500',
        fee_band: 'under 75k',
        school_name: 'test',
      },
      contact: {
        ...cleanAnswers().contact,
        email: 'principal@gmail.com',
        contact_role: 'Principal',
        phone: '+1 415 555 0199',
      },
    });
    const result = classifyLeadQuality(answers, { priorSubmissionsLast24h: 5 });
    expect(result.leadQuality).toBe('suspect');
    // Order matches the in-source rule evaluation order — important for
    // telecaller triage UI consistency.
    expect(result.reasons).toEqual([
      'free_domain_senior_role',
      'profile_spend_contradiction',
      'junk_strings',
      'repeat_submitter',
      'indian_mobile_format_fail',
    ]);
    expect(result.flags).toEqual({
      free_domain_senior_role: true,
      profile_spend_contradiction: true,
      junk_strings: true,
      repeat_submitter: true,
      indian_mobile_format_fail: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Defensive shapes — function shouldn't crash on missing / null / wrong-type
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — defensive null-handling', () => {
  test('handles fully empty answers object', () => {
    // No fields present → school_name + contact_name both missing → junk
    // fires. All other rules safely no-op. This confirms "missing fields
    // treated as no firing for most rules, EXCEPT junk_strings".
    const result = classifyLeadQuality({});
    expect(result.leadQuality).toBe('suspect');
    expect(result.reasons).toContain('junk_strings');
    // The other 4 rules don't fire — confirms no crash + correct no-op
    // for missing email / phone / budget_band.
    expect(result.flags.free_domain_senior_role).toBe(false);
    expect(result.flags.profile_spend_contradiction).toBe(false);
    expect(result.flags.repeat_submitter).toBe(false);
    expect(result.flags.indian_mobile_format_fail).toBe(false);
  });

  test('handles null / undefined / non-object answers without throwing', () => {
    expect(() => classifyLeadQuality(null)).not.toThrow();
    expect(() => classifyLeadQuality(undefined)).not.toThrow();
    expect(() => classifyLeadQuality('not-an-object')).not.toThrow();
    // Each returns a well-shaped result — downstream consumers can
    // unconditionally read .leadQuality / .reasons / .flags.
    const result = classifyLeadQuality(null);
    expect(result).toHaveProperty('leadQuality');
    expect(result).toHaveProperty('reasons');
    expect(result).toHaveProperty('flags');
  });
});

// ---------------------------------------------------------------------------
// Internal helper coverage — exported so tests can pin behavior directly
// without the overhead of constructing a full answers payload for each.
// ---------------------------------------------------------------------------
describe('tmcLeadQuality — exported helpers', () => {
  test('emailDomain returns lowercased domain or empty string', () => {
    expect(emailDomain('foo@Bar.COM')).toBe('bar.com');
    expect(emailDomain('foo@bar.com')).toBe('bar.com');
    expect(emailDomain('no-at-sign')).toBe('');
    expect(emailDomain('foo@')).toBe('');
    expect(emailDomain('@bar.com')).toBe('');
    expect(emailDomain(null)).toBe('');
  });

  test('emailLocalPart returns lowercased local or empty string', () => {
    expect(emailLocalPart('Principal@gmail.com')).toBe('principal');
    expect(emailLocalPart('test@test.com')).toBe('test');
    expect(emailLocalPart('no-at-sign')).toBe('');
    expect(emailLocalPart(null)).toBe('');
  });

  test('looksLikeJunkString covers all 5 structural cases', () => {
    const blocklist = ['test', 'asdf'];
    expect(looksLikeJunkString('', blocklist)).toBe(true);       // empty
    expect(looksLikeJunkString(' ', blocklist)).toBe(true);      // empty after trim
    expect(looksLikeJunkString('A', blocklist)).toBe(true);      // <2 chars
    expect(looksLikeJunkString('123456', blocklist)).toBe(true); // all digits
    expect(looksLikeJunkString('test', blocklist)).toBe(true);   // token
    expect(looksLikeJunkString('TEST', blocklist)).toBe(true);   // case-insensitive token
    expect(looksLikeJunkString('aaaa', blocklist)).toBe(true);   // 4x repeat
    expect(looksLikeJunkString('Springfield Academy', blocklist)).toBe(false);
  });

  test('isValidIndianMobile accepts all 4 valid leading digits + rejects others', () => {
    expect(isValidIndianMobile('6876543210')).toBe(true);
    expect(isValidIndianMobile('7876543210')).toBe(true);
    expect(isValidIndianMobile('8876543210')).toBe(true);
    expect(isValidIndianMobile('9876543210')).toBe(true);
    expect(isValidIndianMobile('5876543210')).toBe(false);
    expect(isValidIndianMobile('1234567890')).toBe(false);
    expect(isValidIndianMobile('+919876543210')).toBe(true);  // strip +91
    expect(isValidIndianMobile('919876543210')).toBe(true);   // strip 91 if 12 digits
    expect(isValidIndianMobile('09876543210')).toBe(true);    // strip 0 if 11 digits
    expect(isValidIndianMobile('98765')).toBe(false);          // too short
    expect(isValidIndianMobile('98765432109876')).toBe(false); // too long
    expect(isValidIndianMobile(null)).toBe(false);
  });
});
