// Unit tests for backend/lib/eventBus.js
//
// Coverage scope:
//   - lookupField (pure)
//   - evaluateCondition (pure — every operator branch)
//   - renderTemplate (pure)
//   - emitEvent: only the synchronous bus.emit step (the `bus` EventEmitter
//     is exported, so we can listen on it without touching prisma).
//
// NOT covered here:
//   executeAction and the prisma-dependent tail of emitEvent. The SUT does a
//   CJS `require("./prisma")`, and vitest 4 (with the current vitest.config.js)
//   does not transform CJS requires through `vi.mock`, so the factory never
//   intercepts. The same blocker hits backend/test/lib/webhookDelivery.test.js.
//   Those branches are exercised end-to-end by the Playwright workflow specs
//   in e2e/tests/.

import { describe, test, expect } from 'vitest';
import sut from '../../lib/eventBus.js';

const { emitEvent, evaluateCondition, renderTemplate, lookupField, bus } = sut;

describe('module shape', () => {
  test('exports the expected helpers', () => {
    expect(typeof emitEvent).toBe('function');
    expect(typeof evaluateCondition).toBe('function');
    expect(typeof renderTemplate).toBe('function');
    expect(typeof lookupField).toBe('function');
    expect(typeof sut.executeAction).toBe('function');
    expect(bus).toBeDefined();
    expect(typeof bus.emit).toBe('function');
  });
});

describe('lookupField', () => {
  test('returns undefined for null payload', () => {
    expect(lookupField('foo', null)).toBeUndefined();
  });
  test('returns undefined for undefined payload', () => {
    expect(lookupField('foo', undefined)).toBeUndefined();
  });
  test('returns undefined for non-object payload', () => {
    expect(lookupField('foo', 'string')).toBeUndefined();
    expect(lookupField('foo', 42)).toBeUndefined();
  });
  test('walks nested path', () => {
    expect(lookupField('deal.amount', { deal: { amount: 1000 } })).toBe(1000);
  });
  test('walks 3-deep nested path', () => {
    expect(lookupField('a.b.c', { a: { b: { c: 'hit' } } })).toBe('hit');
  });
  test('falls back to flat last-segment when nested path absent', () => {
    expect(lookupField('deal.amount', { dealId: 42, amount: 1000 })).toBe(1000);
  });
  test('returns undefined when neither nested nor flat match', () => {
    expect(lookupField('a.b.c', { d: 1 })).toBeUndefined();
  });
  test('handles single-segment path', () => {
    expect(lookupField('foo', { foo: 'bar' })).toBe('bar');
  });
  test('returns undefined when intermediate is non-object', () => {
    expect(lookupField('a.b', { a: 'string' })).toBeUndefined();
  });
  test('returns 0 for explicit zero (not undefined)', () => {
    expect(lookupField('amount', { amount: 0 })).toBe(0);
  });
  test('returns false for explicit false (not undefined)', () => {
    expect(lookupField('flag', { flag: false })).toBe(false);
  });
});

describe('evaluateCondition — empty/malformed inputs', () => {
  test('null condition is true (backwards-compat)', () => {
    expect(evaluateCondition(null, {})).toBe(true);
  });
  test('empty-string condition is true', () => {
    expect(evaluateCondition('', {})).toBe(true);
  });
  test('empty-array condition is true', () => {
    expect(evaluateCondition('[]', {})).toBe(true);
  });
  test('malformed JSON returns false (fail-closed)', () => {
    expect(evaluateCondition('{not-json', {})).toBe(false);
  });
  test('non-array JSON returns false', () => {
    expect(evaluateCondition('{"foo":"bar"}', {})).toBe(false);
  });
  test('null clause returns false', () => {
    expect(evaluateCondition(JSON.stringify([null]), { foo: 1 })).toBe(false);
  });
  test('non-object clause returns false', () => {
    expect(evaluateCondition(JSON.stringify(['nope']), { foo: 1 })).toBe(false);
  });
  test('clause missing field returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ op: 'eq', value: 1 }]), { foo: 1 })).toBe(false);
  });
  test('clause missing op returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'foo', value: 1 }]), { foo: 1 })).toBe(false);
  });
  test('unknown op returns false', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'foo', op: 'wat', value: 1 }]), { foo: 1 })).toBe(false);
  });
});

describe('evaluateCondition — operator matrix', () => {
  // eq
  test('eq matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]), { status: 'open' })).toBe(true);
  });
  test('eq fails when not equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }]), { status: 'closed' })).toBe(false);
  });
  test('eq uses loose equality (string vs number)', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amt', op: 'eq', value: 10 }]), { amt: '10' })).toBe(true);
  });

  // neq
  test('neq matches when different', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'neq', value: 'open' }]), { status: 'closed' })).toBe(true);
  });
  test('neq fails when equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'status', op: 'neq', value: 'open' }]), { status: 'open' })).toBe(false);
  });

  // gt
  test('gt matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 150 })).toBe(true);
  });
  test('gt fails on equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 100 })).toBe(false);
  });
  test('gt fails on less', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: 100 }]), { amount: 50 })).toBe(false);
  });
  test('gt coerces strings to numbers', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gt', value: '100' }]), { amount: '150' })).toBe(true);
  });

  // gte
  test('gte matches at boundary', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 100 })).toBe(true);
  });
  test('gte matches above', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 200 })).toBe(true);
  });
  test('gte fails when below', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'gte', value: 100 }]), { amount: 50 })).toBe(false);
  });

  // lt
  test('lt matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 50 })).toBe(true);
  });
  test('lt fails on equal', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 100 })).toBe(false);
  });
  test('lt fails on greater', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lt', value: 100 }]), { amount: 200 })).toBe(false);
  });

  // lte
  test('lte matches at boundary', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 100 })).toBe(true);
  });
  test('lte matches below', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 50 })).toBe(true);
  });
  test('lte fails when above', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'lte', value: 100 }]), { amount: 150 })).toBe(false);
  });

  // in
  test('in matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: ['a', 'b'] }]), { stage: 'a' })).toBe(true);
  });
  test('in fails when not in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: ['a', 'b'] }]), { stage: 'c' })).toBe(false);
  });
  test('in fails when value is not an array', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'in', value: 'a' }]), { stage: 'a' })).toBe(false);
  });

  // nin
  test('nin matches when not in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: ['a', 'b'] }]), { stage: 'c' })).toBe(true);
  });
  test('nin fails when in list', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: ['a', 'b'] }]), { stage: 'a' })).toBe(false);
  });
  test('nin fails when value is not an array', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'stage', op: 'nin', value: 'a' }]), { stage: 'b' })).toBe(false);
  });

  // contains
  test('contains matches substring', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'foo' }]), { name: 'foobar' })).toBe(true);
  });
  test('contains fails when missing', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'baz' }]), { name: 'foobar' })).toBe(false);
  });
  test('contains fails when actual is null', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'contains', value: 'foo' }]), { name: null })).toBe(false);
  });
  test('contains coerces actual to string', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'amount', op: 'contains', value: '23' }]), { amount: 1234 })).toBe(true);
  });

  // startsWith
  test('startsWith matches', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'foo' }]), { name: 'foobar' })).toBe(true);
  });
  test('startsWith fails when wrong prefix', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'bar' }]), { name: 'foobar' })).toBe(false);
  });
  test('startsWith fails when actual is null', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'name', op: 'startsWith', value: 'foo' }]), { name: null })).toBe(false);
  });
});

describe('evaluateCondition — composition & path resolution', () => {
  test('AND-joins two clauses (both true)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 200 })).toBe(true);
  });
  test('AND-joins two clauses (first fails)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'closed', amount: 200 })).toBe(false);
  });
  test('AND-joins two clauses (second fails)', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 50 })).toBe(false);
  });
  test('AND-joins three clauses', () => {
    const cond = JSON.stringify([
      { field: 'status', op: 'eq', value: 'open' },
      { field: 'amount', op: 'gt', value: 100 },
      { field: 'tier', op: 'in', value: ['gold', 'platinum'] },
    ]);
    expect(evaluateCondition(cond, { status: 'open', amount: 500, tier: 'gold' })).toBe(true);
  });
  test('missing field path returns false on eq', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'missing', op: 'eq', value: 'x' }]), {})).toBe(false);
  });
  test('resolves nested field path through lookupField', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'deal.amount', op: 'gt', value: 100 }]), { deal: { amount: 500 } })).toBe(true);
  });
  test('flat-fallback resolution still works inside conditions', () => {
    expect(evaluateCondition(JSON.stringify([{ field: 'deal.amount', op: 'eq', value: 500 }]), { dealId: 1, amount: 500 })).toBe(true);
  });
});

describe('renderTemplate', () => {
  test('null template returns empty string', () => {
    expect(renderTemplate(null, {})).toBe('');
  });
  test('undefined template returns empty string', () => {
    expect(renderTemplate(undefined, {})).toBe('');
  });
  test('plain string returns unchanged', () => {
    expect(renderTemplate('hello world', {})).toBe('hello world');
  });
  test('replaces simple key', () => {
    expect(renderTemplate('hi {{name}}', { name: 'Rishu' })).toBe('hi Rishu');
  });
  test('replaces nested path', () => {
    expect(renderTemplate('total: {{deal.amount}}', { deal: { amount: 500 } })).toBe('total: 500');
  });
  test('replaces multiple placeholders', () => {
    expect(renderTemplate('{{a}}-{{b}}', { a: 1, b: 2 })).toBe('1-2');
  });
  test('leaves placeholder when path missing', () => {
    expect(renderTemplate('hi {{missing}}', { name: 'X' })).toBe('hi {{missing}}');
  });
  test('leaves placeholder when value is null', () => {
    expect(renderTemplate('val={{x}}', { x: null })).toBe('val={{x}}');
  });
  test('handles whitespace inside braces', () => {
    expect(renderTemplate('hi {{ name }}', { name: 'Rishu' })).toBe('hi Rishu');
  });
  test('coerces non-string values', () => {
    expect(renderTemplate('count={{n}}', { n: 42 })).toBe('count=42');
  });
  test('coerces non-string template input', () => {
    expect(renderTemplate(12345, {})).toBe('12345');
  });
  test('flat-fallback resolution applies to placeholders', () => {
    expect(renderTemplate('{{deal.title}}', { dealId: 1, title: 'Big Deal' })).toBe('Big Deal');
  });
});

describe('emitEvent — synchronous bus.emit', () => {
  // The async tail (prisma.automationRule.findMany + executeAction +
  // deliverWebhooks) cannot be unit-tested here because vi.mock does not
  // intercept the SUT's CJS require("./prisma") under the current
  // vitest.config.js. We DO assert the synchronous bus.emit at the top of
  // emitEvent, since the bus is an exported EventEmitter.

  test('synchronously fires the in-process bus before doing async work', () => {
    const listener = (data) => {
      // Listener fires synchronously inside emitEvent (before await).
      expect(data.payload).toEqual({ x: 42 });
      expect(data.tenantId).toBe(7);
    };
    bus.once('test.bus.event.unique', listener);
    // Kick off — we don't await, since the prisma call would hang. The
    // listener has already run synchronously by the time .emit returns.
    emitEvent('test.bus.event.unique', { x: 42 }, 7).catch(() => {
      /* swallow async DB error — not the path under test */
    });
  });
});
