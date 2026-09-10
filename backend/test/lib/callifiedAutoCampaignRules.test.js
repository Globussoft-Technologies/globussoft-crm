import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const requireCJS = createRequire(import.meta.url);
const {
  normaliseMatchValue,
  ruleMatches,
} = requireCJS('../../lib/callifiedAutoCampaignRules');

const enabledRule = (column, value) => ({
  enabled: true,
  column,
  value,
  campaignId: 42,
});

describe('callifiedAutoCampaignRules', () => {
  test('normalises case, spaces, and punctuation', () => {
    expect(normaliseMatchValue('  Website-Form ')).toBe('websiteform');
  });

  test('matches Contact and custom-field values', () => {
    expect(ruleMatches(
      enabledRule('source', 'website form'),
      { source: 'Website-Form' },
      {},
    )).toBe(true);
    expect(ruleMatches(
      enabledRule('cf_interest', 'Enterprise'),
      {},
      { interest: 'enterprise' },
    )).toBe(true);
  });

  test('derives first and last name from Contact.name', () => {
    const lead = { name: 'Ada Lovelace Byron' };

    expect(ruleMatches(enabledRule('firstName', 'Ada'), lead, {})).toBe(true);
    expect(ruleMatches(enabledRule('lastName', 'Lovelace Byron'), lead, {})).toBe(true);
  });

  test('does not confuse a web-form name with the generic source value', () => {
    const lead = { source: 'website-form', webForm: 'Contact Us' };

    expect(ruleMatches(enabledRule('webForm', 'Contact Us'), lead, {})).toBe(true);
    expect(ruleMatches(enabledRule('webForm', 'website-form'), { source: 'website-form' }, {})).toBe(false);
  });
});
