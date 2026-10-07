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
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

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

  it('updates the root theme when another wellness palette is selected', () => {
    const onChange = vi.fn();

    render(
      <LandingPageWellnessEditor
        content={[]}
        onChange={onChange}
        page={PAGE}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Coral energy/i }));

    const updatedContent = onChange.mock.calls.at(-1)?.[0];
    expect(updatedContent?.[0]?.props?.themeId).toBe('coral');

    fireEvent.click(screen.getByRole('button', { name: /Immersive campaign/i }));

    const layoutContent = onChange.mock.calls.at(-1)?.[0];
    expect(layoutContent?.[0]?.props?.layoutId).toBe('immersive');
  });

  it('enables custom wellness colors and persists the edited color in the root block', () => {
    const onChange = vi.fn();
    function ControlledEditor() {
      const [content, setContent] = useState([]);
      return <LandingPageWellnessEditor content={content} onChange={(next) => { onChange(next); setContent(next); }} page={PAGE} />;
    }

    render(<ControlledEditor />);

    fireEvent.click(screen.getByLabelText('Use custom colors'));
    const customContent = onChange.mock.calls.at(-1)?.[0];
    expect(customContent?.[0]?.props?.themeId).toBe('custom');
    expect(customContent?.[0]?.props?.customColors?.primary).toBe('#2f6b50');

    fireEvent.change(screen.getByLabelText('Page background hex value'), { target: { value: '#fef2f2' } });
    const editedContent = onChange.mock.calls.at(-1)?.[0];
    expect(editedContent?.[0]?.props?.themeId).toBe('custom');
    expect(editedContent?.[0]?.props?.customColors?.bg).toBe('#fef2f2');
  });
});
