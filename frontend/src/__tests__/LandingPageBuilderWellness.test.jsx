/**
 * LandingPageBuilderWellness.test.jsx - RTL coverage for the wellness
 * landing-page editor bootstrap.
 *
 * Scope:
 *   1. A wellness landing page with empty content should still mount the
 *      wellness editor instead of showing the waiting message.
 *   2. The scaffold should derive its hero copy from the page input,
 *      not from any hard-coded campaign like blood donation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const confirmMock = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: notifyInfo,
  success: notifySuccess,
  confirm: (...args) => confirmMock(...args),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));
vi.mock('../utils/api', () => ({
  getAuthToken: () => 'h.' + btoa(JSON.stringify({ tenantId: 1 })) + '.s',
}));

import LandingPageWellnessEditor from '../pages/LandingPageWellnessEditor';

const PAGE = {
  id: 57,
  title: 'Hair Treatment',
  slug: 'hair-treatment',
  status: 'DRAFT',
  templateType: 'generic-site-hair-treatment',
  businessName: 'Glow Hair Studio',
  audience: 'people exploring hair treatment solutions',
};

function renderEditor() {
  return render(
    <LandingPageWellnessEditor
      content={[]}
      onChange={vi.fn()}
      page={PAGE}
    />,
  );
}

describe('<LandingPageWellnessEditor /> - wellness bootstrap', () => {
  beforeEach(() => {
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyInfo.mockReset();
    confirmMock.mockReset();
    confirmMock.mockImplementation(() => Promise.resolve(true));
  });

  it('boots the wellness editor from empty content without showing the waiting message', () => {
    renderEditor();

    expect(screen.getByText('Wellness Landing Page Editor')).toBeInTheDocument();
    expect(screen.getByLabelText('Headline line 1')).toBeInTheDocument();
    expect(screen.getByLabelText('Brand line')).toHaveValue('Glow Hair Studio');
    expect(screen.queryByLabelText('Secondary CTA')).not.toBeInTheDocument();
    expect(screen.queryByText(/Blood Donation/i)).not.toBeInTheDocument();
  });
});
