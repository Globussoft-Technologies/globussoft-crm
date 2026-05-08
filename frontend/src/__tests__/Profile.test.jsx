/**
 * Profile.jsx — Practitioner section conditional render (#641).
 *
 * Issue context
 * ─────────────
 *   Wellness Demo User (user@wellness.demo, RBAC role=USER) was rendered
 *   a phantom "Practitioner" badge + section on /profile, even though
 *   they had no clinical privileges. Root cause: the seed had quietly
 *   assigned wellnessRole='professional' to the demo account AND the
 *   Profile page rendered the practitioner block unconditionally.
 *   Both sides need pinning so a future seed flip OR an unconditional
 *   render regression breaks the test, not the demo.
 *
 * Contracts pinned here
 * ─────────────────────
 *   1. When /api/auth/me returns wellnessRole=null, Profile DOES NOT
 *      render the practitioner section (data-testid="profile-practitioner-section")
 *      AND DOES NOT render the wellnessRole badge (data-testid="profile-wellness-role-badge").
 *   2. Same for wellnessRole='helper' or 'telecaller' — non-clinical
 *      wellness roles still must NOT see the practitioner block.
 *   3. When wellnessRole='doctor' OR 'professional', Profile renders
 *      both the practitioner section AND the wellness-role badge.
 *   4. The role badge text matches the wellnessRole value (capitalised
 *      via CSS, asserted on raw text).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => ({
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    confirm: () => Promise.resolve(true),
    prompt: () => Promise.resolve(''),
  }),
}));

import { AuthContext } from '../App';
import Profile from '../pages/Profile';

function renderProfile(meResponse) {
  fetchApiMock.mockReset();
  fetchApiMock.mockImplementation((url) => {
    if (url === '/api/auth/me') return Promise.resolve(meResponse);
    return Promise.resolve({});
  });
  return render(
    <AuthContext.Provider value={{
      user: { ...meResponse, userId: meResponse.id },
      setUser: vi.fn(),
      token: 'tk', tenant: { id: 1 }, loading: false,
    }}>
      <Profile />
    </AuthContext.Provider>
  );
}

describe('<Profile /> — practitioner section gating (#641)', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it('does NOT render the practitioner section when wellnessRole=null (Demo User regression pin)', async () => {
    renderProfile({
      id: 99, name: 'Demo User', email: 'user@wellness.demo',
      role: 'USER', wellnessRole: null, createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Demo User')).toBeInTheDocument());

    expect(screen.queryByTestId('profile-practitioner-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('profile-wellness-role-badge')).not.toBeInTheDocument();
  });

  it('does NOT render the practitioner section for helper / telecaller', async () => {
    for (const wellnessRole of ['helper', 'telecaller']) {
      renderProfile({
        id: 100, name: 'Support Staff', email: 'staff@x.com',
        role: 'USER', wellnessRole, createdAt: '2026-01-01T00:00:00Z',
      });
      await waitFor(() => expect(screen.getByText('Support Staff')).toBeInTheDocument());

      expect(screen.queryByTestId('profile-practitioner-section')).not.toBeInTheDocument();
      // The wellnessRole badge SHOULD appear (the role is set), but the
      // practitioner section must NOT — these two render conditions are
      // intentionally different (badge = "is wellnessRole truthy", section
      // = "is wellnessRole clinical").
      expect(screen.getByTestId('profile-wellness-role-badge')).toBeInTheDocument();
      // Tear down between iterations so the next render starts from a
      // clean DOM (otherwise getByTestId trips on duplicate matches).
      cleanup();
    }
  });

  it('renders the practitioner section when wellnessRole=doctor', async () => {
    renderProfile({
      id: 101, name: 'Dr. Harsh Kumar', email: 'drharsh@enhancedwellness.in',
      role: 'USER', wellnessRole: 'doctor', createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Dr. Harsh Kumar')).toBeInTheDocument());

    expect(screen.getByTestId('profile-practitioner-section')).toBeInTheDocument();
    const badge = screen.getByTestId('profile-wellness-role-badge');
    expect(badge.textContent).toMatch(/doctor/i);
  });

  it('renders the practitioner section when wellnessRole=professional', async () => {
    renderProfile({
      id: 102, name: 'Priya Pro', email: 'priya@enhancedwellness.in',
      role: 'USER', wellnessRole: 'professional', createdAt: '2026-01-01T00:00:00Z',
    });
    await waitFor(() => expect(screen.getByText('Priya Pro')).toBeInTheDocument());

    expect(screen.getByTestId('profile-practitioner-section')).toBeInTheDocument();
    expect(screen.getByTestId('profile-wellness-role-badge').textContent).toMatch(/professional/i);
  });
});
