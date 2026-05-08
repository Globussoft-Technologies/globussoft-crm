import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import Avatar, { getInitials, getColorFromName } from '../components/Avatar';

/**
 * frontend/src/components/Avatar.jsx
 *
 * What's tested
 *   - Initials extraction for first+last, single-name, empty/falsy inputs.
 *   - Color hashing stability — same name renders the same background colour
 *     across separate renders (deterministic palette pick).
 *   - Different names produce different colours when the palette has room
 *     (statistical sanity, not a strict guarantee).
 *   - Role-badge rendering — pip appears with the role's first letter and
 *     an aria-label naming the role.
 *   - Custom `color` prop overrides the hashed colour.
 *
 * Why
 *   Avatar is the new shared identity primitive used by the app header
 *   (#642 — role badge so the signed-in operator knows their role at a
 *   glance) and the wellness practitioner surfaces (#637 — distinguishable
 *   per-practitioner colours instead of one generic monochrome icon).
 *   Pinning initials + colour stability prevents future "icon" rewrites
 *   from quietly regressing either bug.
 */

describe('getInitials', () => {
  it('extracts first+last initials from a two-part name', () => {
    expect(getInitials('Sumit Sharma')).toBe('SS');
    expect(getInitials('alice cooper')).toBe('AC');
  });

  it('uses the first and last token when the name has 3+ parts', () => {
    expect(getInitials('Dr Harsh Kumar')).toBe('DK');
  });

  it('uppercases a single-token name to one letter', () => {
    expect(getInitials('alice')).toBe('A');
    expect(getInitials('   bob  ')).toBe('B');
  });

  it('falls back to ? for empty / null / non-string', () => {
    expect(getInitials('')).toBe('?');
    expect(getInitials('   ')).toBe('?');
    expect(getInitials(null)).toBe('?');
    expect(getInitials(undefined)).toBe('?');
    expect(getInitials(42)).toBe('?');
  });
});

describe('getColorFromName', () => {
  it('returns the same colour for the same name (stability)', () => {
    expect(getColorFromName('Sumit Sharma')).toBe(getColorFromName('Sumit Sharma'));
    expect(getColorFromName('Dr Harsh')).toBe(getColorFromName('Dr Harsh'));
  });

  it('produces a hex colour from the fixed palette', () => {
    const c = getColorFromName('Alice');
    expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  it('different names usually pick different colours (palette has 8 swatches)', () => {
    const sample = ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Frank', 'Grace', 'Hank'];
    const colours = new Set(sample.map(getColorFromName));
    // 8-swatch palette + 8 distinct names — at least 4 unique buckets is
    // a low-noise assertion that the hash is actually distributing.
    expect(colours.size).toBeGreaterThanOrEqual(4);
  });

  it('returns a fallback colour for falsy input rather than throwing', () => {
    expect(getColorFromName('')).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(getColorFromName(null)).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});

describe('<Avatar />', () => {
  it('renders initials for the given name', () => {
    render(<Avatar name="Sumit Sharma" />);
    expect(screen.getByText('SS')).toBeInTheDocument();
  });

  it('falls back to ? when no name is supplied', () => {
    render(<Avatar />);
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('does NOT render a role badge when roleBadge prop is omitted', () => {
    render(<Avatar name="Alice" />);
    expect(screen.queryByTestId('avatar-role-badge')).not.toBeInTheDocument();
  });

  it('renders a role badge with the role first letter when roleBadge is supplied', () => {
    render(<Avatar name="Alice" roleBadge="OWNER" />);
    const pip = screen.getByTestId('avatar-role-badge');
    expect(pip).toBeInTheDocument();
    expect(pip).toHaveTextContent('O');
    expect(pip).toHaveAttribute('aria-label', 'Role: OWNER');
  });

  it('badges ADMIN with A, MANAGER with M, USER with U', () => {
    const { rerender } = render(<Avatar name="X" roleBadge="ADMIN" />);
    expect(screen.getByTestId('avatar-role-badge')).toHaveTextContent('A');
    rerender(<Avatar name="X" roleBadge="MANAGER" />);
    expect(screen.getByTestId('avatar-role-badge')).toHaveTextContent('M');
    rerender(<Avatar name="X" roleBadge="USER" />);
    expect(screen.getByTestId('avatar-role-badge')).toHaveTextContent('U');
  });

  it('the same name renders the same background across separate renders', () => {
    const { unmount } = render(<Avatar name="Stable Name" />);
    const first = screen.getByTestId('avatar').style.background;
    unmount();
    render(<Avatar name="Stable Name" />);
    const second = screen.getByTestId('avatar').style.background;
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  it('honours an explicit `color` prop over the hashed palette', () => {
    render(<Avatar name="Anyone" color="rgb(10, 20, 30)" />);
    expect(screen.getByTestId('avatar').style.background).toBe('rgb(10, 20, 30)');
  });

  it('exposes name + role in data-attributes for downstream selectors', () => {
    render(<Avatar name="Alice" roleBadge="ADMIN" />);
    const el = screen.getByTestId('avatar');
    expect(el).toHaveAttribute('data-avatar-name', 'Alice');
    expect(el).toHaveAttribute('data-avatar-role', 'ADMIN');
  });
});
