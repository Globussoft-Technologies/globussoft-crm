/**
 * themeColorInjection.test.js — unit tests for the dynamic theme-color
 * injection logic in App.jsx (the useEffect that runs on tenant.themeColor).
 *
 * The injection sets CSS custom properties directly on document.body:
 *   --accent-color, --accent-hover, --accent-glow, --subtle-bg, --subtle-bg-3,
 *   --sidebar-bg, --sidebar-bg-deep, --accent-bg, --accent-text,
 *   --accent-peach, --accent-peach-hover
 *
 * We re-implement the same algorithm here (the canonical source is App.jsx)
 * and test its observable surface: which variables get set, their values,
 * and that they are removed on reset. This keeps tests fast and decoupled
 * from React's render tree.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Pure injection helper — mirrors App.jsx's useEffect body exactly ─────────
function applyThemeColor(raw) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(raw || '');
  const el = document.body;
  if (valid) {
    const r = parseInt(raw.slice(1, 3), 16);
    const g = parseInt(raw.slice(3, 5), 16);
    const b = parseInt(raw.slice(5, 7), 16);
    const darken = (c) => Math.round(c * 0.88).toString(16).padStart(2, '0');
    const toHex = (c) => c.toString(16).padStart(2, '0');

    el.style.setProperty('--accent-color', raw);
    el.style.setProperty('--accent-hover', `#${darken(r)}${darken(g)}${darken(b)}`);
    el.style.setProperty('--accent-glow', `rgba(${r},${g},${b},0.35)`);
    el.style.setProperty('--subtle-bg', `rgba(${r},${g},${b},0.06)`);
    el.style.setProperty('--subtle-bg-3', `rgba(${r},${g},${b},0.12)`);

    const deepR = Math.round(r * 0.85);
    const deepG = Math.round(g * 0.85);
    const deepB = Math.round(b * 0.85);
    el.style.setProperty('--sidebar-bg', raw);
    el.style.setProperty('--sidebar-bg-deep', `#${toHex(deepR)}${toHex(deepG)}${toHex(deepB)}`);
    el.style.setProperty('--accent-bg', raw);

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    el.style.setProperty('--accent-text', luminance < 160 ? '#F5F1E8' : '#1F2220');

    const peachR = Math.round(r + (255 - r) * 0.4);
    const peachG = Math.round(g + (255 - g) * 0.4);
    const peachB = Math.round(b + (255 - b) * 0.4);
    el.style.setProperty('--accent-peach', `#${toHex(peachR)}${toHex(peachG)}${toHex(peachB)}`);
    el.style.setProperty('--accent-peach-hover', `#${darken(peachR)}${darken(peachG)}${darken(peachB)}`);
  } else {
    [
      '--accent-color', '--accent-hover', '--accent-glow',
      '--subtle-bg', '--subtle-bg-3',
      '--sidebar-bg', '--sidebar-bg-deep', '--accent-bg', '--accent-text',
      '--accent-peach', '--accent-peach-hover',
    ].forEach((v) => el.style.removeProperty(v));
  }
}

function get(prop) {
  return document.body.style.getPropertyValue(prop);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
afterEach(() => applyThemeColor(null));

describe('themeColor CSS injection (App.jsx useEffect contract)', () => {
  // 1 — valid hex sets --sidebar-bg and --accent-bg to the raw color
  it('sets --sidebar-bg + --accent-bg to the theme color for a dark hex', () => {
    applyThemeColor('#A07C4A');
    expect(get('--sidebar-bg')).toBe('#A07C4A');
    expect(get('--accent-bg')).toBe('#A07C4A');
  });

  // 2 — --sidebar-bg-deep is a 15%-darkened hex
  it('sets --sidebar-bg-deep to a 15%-darkened hex', () => {
    applyThemeColor('#A07C4A');
    const deep = get('--sidebar-bg-deep');
    expect(deep).toMatch(/^#[0-9a-fA-F]{6}$/);
    // Parse both and confirm deep < raw for each channel
    const parse = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
    const rawR = parse('#A07C4A', 1);
    const deepR = parse(deep, 1);
    expect(deepR).toBeLessThan(rawR);
  });

  // 3 — --accent-text is white (#F5F1E8) for dark colors
  it('sets --accent-text to #F5F1E8 for a dark color (luminance < 160)', () => {
    applyThemeColor('#1F2220'); // dark charcoal
    expect(get('--accent-text')).toBe('#F5F1E8');
  });

  // 4 — --accent-text is dark (#1F2220) for light colors
  it('sets --accent-text to #1F2220 for a light color (luminance >= 160)', () => {
    applyThemeColor('#E8D5A0'); // light cream-gold
    expect(get('--accent-text')).toBe('#1F2220');
  });

  // 5 — --accent-color is set to the raw value
  it('sets --accent-color to the raw hex', () => {
    applyThemeColor('#C9A063');
    expect(get('--accent-color')).toBe('#C9A063');
  });

  // 6 — --accent-peach is a lighter tint (40% blend toward white)
  it('sets --accent-peach to a lighter tint of the theme color', () => {
    applyThemeColor('#C9A063');
    const peach = get('--accent-peach');
    expect(peach).toMatch(/^#[0-9a-fA-F]{6}$/);
    // Peach R channel must be >= raw R (it was blended toward 255)
    const rawR = parseInt('C9', 16); // 201
    const peachR = parseInt(peach.slice(1, 3), 16);
    expect(peachR).toBeGreaterThanOrEqual(rawR);
  });

  // 7 — null / empty clears all injected variables
  it('removes all injected CSS vars when called with null', () => {
    applyThemeColor('#C9A063');
    expect(get('--sidebar-bg')).toBe('#C9A063');
    applyThemeColor(null);
    expect(get('--sidebar-bg')).toBe('');
    expect(get('--accent-bg')).toBe('');
    expect(get('--accent-text')).toBe('');
    expect(get('--accent-color')).toBe('');
    expect(get('--accent-peach')).toBe('');
    expect(get('--sidebar-bg-deep')).toBe('');
  });

  // 8 — invalid hex (not 6 digits) also clears
  it('removes all vars for an invalid hex string', () => {
    applyThemeColor('#C9A063');
    applyThemeColor('not-a-hex');
    expect(get('--sidebar-bg')).toBe('');
    expect(get('--accent-color')).toBe('');
  });

  // 9 — 3-digit hex (invalid) does NOT inject
  it('does NOT inject for a 3-digit hex (invalid format)', () => {
    applyThemeColor('#C9A');
    expect(get('--sidebar-bg')).toBe('');
  });

  // 10 — uppercase and mixed-case hex both work
  it('accepts uppercase hex and sets variables correctly', () => {
    applyThemeColor('#C9A063');
    expect(get('--accent-color')).toBe('#C9A063');
    applyThemeColor(null);
    applyThemeColor('#c9a063');
    expect(get('--accent-color')).toBe('#c9a063');
  });

  // 11 — gold default palette (#C9A063): luminance check.
  // R=201 G=160 B=99 → 0.2126*201 + 0.7152*160 + 0.0722*99 ≈ 164 ≥ 160 → dark text
  it('Dr. Enhance gold #C9A063 gets dark accent-text (luminance ≥ 160)', () => {
    applyThemeColor('#C9A063');
    expect(get('--accent-text')).toBe('#1F2220');
  });

  // 12 — --accent-hover is darker than the raw color
  it('--accent-hover is an 88% darkened version of the theme color', () => {
    applyThemeColor('#C9A063');
    const hover = get('--accent-hover');
    expect(hover).toMatch(/^#[0-9a-fA-F]{6}$/);
    const rawR = parseInt('C9', 16);
    const hoverR = parseInt(hover.slice(1, 3), 16);
    expect(hoverR).toBeLessThanOrEqual(rawR);
  });
});
