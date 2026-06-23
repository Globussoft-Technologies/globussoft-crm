// Unit tests for backend/lib/travelRegistrationPresets.js. Also asserts
// the frontend ESM mirror (frontend/src/utils/travelRegistrationPresets.js)
// resolves to identical preset data — both files MUST stay in sync.
import { describe, test, expect } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const requireCJS = createRequire(import.meta.url);
const presets = requireCJS('../../lib/travelRegistrationPresets');

describe('travelRegistrationPresets', () => {
  test('PRESETS exports the 6 known audiences', () => {
    const keys = Object.keys(presets.PRESETS).sort();
    expect(keys).toEqual(['custom', 'inquiry', 'rfu', 'tmc', 'travelStall', 'visaSure']);
  });

  test('every preset has audience + label + fields + submitText + thankYou', () => {
    for (const [key, preset] of Object.entries(presets.PRESETS)) {
      expect(preset.audience, `${key} audience`).toBe(key);
      expect(typeof preset.label).toBe('string');
      expect(preset.label.length).toBeGreaterThan(0);
      expect(Array.isArray(preset.fields)).toBe(true);
      expect(preset.fields.length).toBeGreaterThan(0);
      expect(typeof preset.submitText).toBe('string');
      expect(typeof preset.thankYou).toBe('string');
      for (const f of preset.fields) {
        expect(typeof f.label).toBe('string');
        expect(typeof f.name).toBe('string');
        expect(['text', 'email', 'tel', 'number', 'url', 'date']).toContain(f.type);
        expect(typeof f.required).toBe('boolean');
      }
    }
  });

  test('the 4 sub-brand presets carry a non-null subBrand key', () => {
    expect(presets.PRESETS.tmc.subBrand).toBe('tmc');
    expect(presets.PRESETS.rfu.subBrand).toBe('rfu');
    expect(presets.PRESETS.travelStall.subBrand).toBe('travelStall');
    expect(presets.PRESETS.visaSure.subBrand).toBe('visaSure');
  });

  test('inquiry + custom carry a null subBrand (not vertical-specific)', () => {
    expect(presets.PRESETS.inquiry.subBrand).toBeNull();
    expect(presets.PRESETS.custom.subBrand).toBeNull();
  });

  test('TMC preset matches the screenshot the product team showed: parent name + phone + school + email', () => {
    const tmc = presets.PRESETS.tmc;
    const names = tmc.fields.map((f) => f.name);
    expect(names).toEqual(['name', 'phone', 'school', 'email']);
    // Required-ness must match what the visual mock implies.
    const required = tmc.fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(['name', 'phone', 'school', 'email']);
  });

  describe('getPreset()', () => {
    test('returns the preset for a known audience', () => {
      expect(presets.getPreset('rfu').audience).toBe('rfu');
    });

    test('returns null for unknown / empty / non-string input', () => {
      expect(presets.getPreset('not-a-preset')).toBeNull();
      expect(presets.getPreset('')).toBeNull();
      expect(presets.getPreset(null)).toBeNull();
      expect(presets.getPreset(undefined)).toBeNull();
      expect(presets.getPreset(42)).toBeNull();
    });
  });

  describe('listPresets()', () => {
    test('returns one summary per preset with audience/subBrand/label/description', () => {
      const list = presets.listPresets();
      expect(list).toHaveLength(6);
      for (const item of list) {
        expect(item).toHaveProperty('audience');
        expect(item).toHaveProperty('subBrand');
        expect(item).toHaveProperty('label');
        expect(item).toHaveProperty('description');
        // Summary should NOT leak the fields array (admin needs to
        // commit to a preset before seeing the field layout).
        expect(item).not.toHaveProperty('fields');
      }
    });
  });

  describe('defaultPropsFor()', () => {
    test('returns a fully-populated default-props block for a known audience', () => {
      const props = presets.defaultPropsFor('tmc');
      expect(props.audience).toBe('tmc');
      expect(props.subBrand).toBe('tmc');
      expect(props.title).toBe('TMC');
      expect(props.fields).toHaveLength(4);
      expect(props.submitText).toMatch(/brochure/i);
      expect(props.enableCaptcha).toBe(false);
      expect(props.leadRoutingRuleId).toBe('');
      expect(props.successRedirectUrl).toBe('');
    });

    test('falls back to inquiry preset for unknown audience', () => {
      const props = presets.defaultPropsFor('not-a-preset');
      expect(props.audience).toBe('inquiry');
    });

    test('returns a deep copy of fields (mutation does not affect the preset)', () => {
      const props = presets.defaultPropsFor('tmc');
      props.fields[0].label = 'Mutated';
      const next = presets.defaultPropsFor('tmc');
      expect(next.fields[0].label).not.toBe('Mutated');
    });
  });

  describe('frontend ESM mirror is in sync', () => {
    test('frontend/src/utils/travelRegistrationPresets.js exports the same preset data', () => {
      // We can't import an ESM file directly from a vitest CJS-style
      // require, so parse the file as text and pull the PRESETS object
      // through a regex-bounded eval. This is intentionally brittle —
      // if the frontend file's shape changes, this test reds and the
      // author has to update the mirror or both files together.
      const frontendPath = path.resolve(
        __dirname,
        '../../../frontend/src/utils/travelRegistrationPresets.js'
      );
      const src = fs.readFileSync(frontendPath, 'utf8');
      // Strip ESM exports + transform into a plain expression. We
      // tolerate the trailing semicolon on the PRESETS declaration.
      const match = src.match(/export const PRESETS = (\{[\s\S]*?\n\});/);
      expect(match, 'frontend PRESETS export not found').not.toBeNull();
      const frontendPresets = new Function('return ' + match[1])();
      // Compare the same shape backend exports — audience/subBrand/
      // label/fields/submitText/thankYou tuple per preset.
      for (const key of Object.keys(presets.PRESETS)) {
        expect(frontendPresets[key], `frontend missing preset: ${key}`).toBeDefined();
        expect(frontendPresets[key].audience).toBe(presets.PRESETS[key].audience);
        expect(frontendPresets[key].subBrand).toBe(presets.PRESETS[key].subBrand);
        expect(frontendPresets[key].label).toBe(presets.PRESETS[key].label);
        expect(frontendPresets[key].submitText).toBe(presets.PRESETS[key].submitText);
        expect(frontendPresets[key].thankYou).toBe(presets.PRESETS[key].thankYou);
        expect(frontendPresets[key].fields).toEqual(presets.PRESETS[key].fields);
      }
      // And no extras on the frontend side.
      expect(Object.keys(frontendPresets).sort()).toEqual(
        Object.keys(presets.PRESETS).sort()
      );
    });
  });
});
