/**
 * DiagnosticEmbedFormsPanel.jsx — styling admin for the third-party-
 * embeddable diagnostic widget (2026-09-08 overhaul).
 *
 * Pins the contract fixed in this rewrite:
 *   - Config loads from GET .../embed-settings?subBrand= (NOT localStorage)
 *   - No fake "Diagnostic template" picker — a read-only status line
 *     reflects the real active bank + publish state instead
 *   - Save is dirty-gated and PUTs {subBrand, config} to .../embed-settings
 *   - The generated iframe/script snippets never include a `config=` /
 *     `data-config=` param — the widget fetches config live instead
 *   - Branding colors: each ColorField pairs the native swatch with a
 *     typeable hex text input (2026-09-08 fix — the swatch alone only
 *     opens the OS color picker, which has no way to type an exact code)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

import { AuthContext } from '../App';
import DiagnosticEmbedFormsPanel from '../pages/travel/DiagnosticEmbedFormsPanel';

const notifyObj = {
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
};

const BANK = { id: 5, subBrand: 'tmc', version: 3, templateName: 'TMC Template', questionsJson: '{"questions":[]}' };

function mockLoad({ config = {}, banks = [BANK], isPublished = true } = {}) {
  fetchApiMock.mockImplementation((url) => {
    const u = String(url);
    if (u.includes('/embed-settings')) return Promise.resolve({ config });
    if (u.includes('/diagnostic-banks')) return Promise.resolve({ banks });
    if (u.includes('/diagnostic-public-forms')) return Promise.resolve({ form: { isPublished } });
    return Promise.resolve({});
  });
}

function renderPanel() {
  return render(
    <AuthContext.Provider value={{ tenant: { id: 1, slug: 'travelstall' } }}>
      <DiagnosticEmbedFormsPanel subBrand="tmc" notify={notifyObj} />
    </AuthContext.Provider>,
  );
}

beforeEach(() => {
  fetchApiMock.mockReset();
  notifyObj.error.mockReset();
  notifyObj.success.mockReset();
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(() => Promise.resolve()) },
    configurable: true,
  });
});

describe('DiagnosticEmbedFormsPanel — loading', () => {
  it('loads embed settings, banks, and public-form status on mount', async () => {
    mockLoad();
    renderPanel();
    await waitFor(() => {
      expect(fetchApiMock.mock.calls.some(([u]) => String(u).includes('embed-settings?subBrand=tmc'))).toBe(true);
      expect(fetchApiMock.mock.calls.some(([u]) => String(u).includes('diagnostic-banks?subBrand=tmc'))).toBe(true);
      expect(fetchApiMock.mock.calls.some(([u]) => String(u).includes('diagnostic-public-forms/tmc'))).toBe(true);
    });
  });

  it('shows the active template + published status, not a template picker', async () => {
    mockLoad({ isPublished: true });
    renderPanel();
    expect(await screen.findByText(/TMC Template/)).toBeInTheDocument();
    expect(screen.getByText(/Published/)).toBeInTheDocument();
    expect(screen.queryByText(/Diagnostic template/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /template/i })).not.toBeInTheDocument();
  });

  it('warns when the public form is not published yet', async () => {
    mockLoad({ isPublished: false });
    renderPanel();
    expect(await screen.findByText(/isn.t published yet/i)).toBeInTheDocument();
  });

  it('warns when no bank exists yet for the sub-brand', async () => {
    mockLoad({ banks: [] });
    renderPanel();
    expect(await screen.findByText(/No diagnostic template exists yet/i)).toBeInTheDocument();
  });
});

describe('DiagnosticEmbedFormsPanel — title/subtitle/powered-by (2026-09-08 fixes)', () => {
  it('shows a fallback title/subtitle by default, and "Powered by" reflects the checkbox in the preview', async () => {
    mockLoad({ config: {} });
    renderPanel();
    await screen.findByText(/TMC Template/);

    expect(screen.getByText('Travel diagnostic')).toBeInTheDocument();
    expect(screen.getByText('Answer a few questions to receive your result.')).toBeInTheDocument();
    // poweredBy defaults to true — the preview must actually show this,
    // not silently do nothing (the bug this test pins).
    expect(screen.getByText('Powered by Globussoft Travel CRM')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /Show "Powered by Globussoft Travel CRM"/i }));
    expect(screen.queryByText('Powered by Globussoft Travel CRM')).not.toBeInTheDocument();
  });

  it('"No title at all" hides the title even though the text field is empty (falls back otherwise)', async () => {
    mockLoad({ config: {} });
    renderPanel();
    await screen.findByText(/TMC Template/);

    expect(screen.getByText('Travel diagnostic')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /No title at all/i }));
    expect(screen.queryByText('Travel diagnostic')).not.toBeInTheDocument();
  });

  it('"No subtitle at all" hides the subtitle even though the text field is empty (falls back otherwise)', async () => {
    mockLoad({ config: {} });
    renderPanel();
    await screen.findByText(/TMC Template/);

    expect(screen.getByText('Answer a few questions to receive your result.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /No subtitle at all/i }));
    expect(screen.queryByText('Answer a few questions to receive your result.')).not.toBeInTheDocument();
  });
});

describe('DiagnosticEmbedFormsPanel — editing + save', () => {
  it('Save is disabled until a field changes, then PUTs {subBrand, config}', async () => {
    mockLoad({ config: { title: 'Original title' } });
    renderPanel();
    const titleInput = await screen.findByDisplayValue('Original title');

    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    expect(saveBtn.disabled).toBe(true);

    fireEvent.change(titleInput, { target: { value: 'New title' } });
    expect(saveBtn.disabled).toBe(false);

    fetchApiMock.mockImplementation((url, opts) => {
      if (opts?.method === 'PUT') return Promise.resolve({ config: JSON.parse(opts.body).config });
      const u = String(url);
      if (u.includes('/embed-settings')) return Promise.resolve({ config: { title: 'Original title' } });
      if (u.includes('/diagnostic-banks')) return Promise.resolve({ banks: [BANK] });
      if (u.includes('/diagnostic-public-forms')) return Promise.resolve({ form: { isPublished: true } });
      return Promise.resolve({});
    });

    fireEvent.click(saveBtn);
    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(([, o]) => o?.method === 'PUT');
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      expect(body.subBrand).toBe('tmc');
      expect(body.config.title).toBe('New title');
    });
    await waitFor(() => expect(notifyObj.success).toHaveBeenCalled());
  });
});

describe('DiagnosticEmbedFormsPanel — branding colors', () => {
  it('the Primary color field has a typeable hex text input next to the swatch', async () => {
    mockLoad({ config: { primary: '#4f46e5' } });
    renderPanel();
    await screen.findByRole('button', { name: /Branding/i });

    fireEvent.click(screen.getByRole('button', { name: /Branding/i }));
    // Every ColorField shares the same "#4f46e5" placeholder, so scope to
    // the "Primary color" label's own text field rather than matching by
    // placeholder/value globally (the swatch, a type=color input, also
    // carries the same "#4f46e5" value).
    const primaryLabel = await screen.findByText('Primary color');
    const hexInput = primaryLabel.closest('label').querySelector('input[type="text"]');
    expect(hexInput.value).toBe('#4f46e5');

    fireEvent.change(hexInput, { target: { value: '#00ff00' } });
    expect(hexInput.value).toBe('#00ff00');

    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    expect(saveBtn.disabled).toBe(false);
  });
});

describe('DiagnosticEmbedFormsPanel — preview parity with the real widget (2026-09-08)', () => {
  it('the Questions preview shows a progress bar, and the Name/Email/Phone identity fields + submit button', async () => {
    mockLoad({ config: {} });
    renderPanel();
    await screen.findByText(/TMC Template/);

    // Progress bar defaults on (config.progress defaults true).
    expect(document.querySelector('div[style*="border-radius: 999px"]')).toBeTruthy();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Phone')).toBeInTheDocument();
    expect(screen.getByText('See my result')).toBeInTheDocument();
  });

  it('the Result preview shows the "Recommendations heading" text, not just the sample cards', async () => {
    mockLoad({ config: { recommendationTitle: 'Trips picked for your school' } });
    renderPanel();
    await screen.findByText(/TMC Template/);

    fireEvent.click(screen.getByRole('button', { name: /^Result$/i }));
    expect(await screen.findByText('Trips picked for your school')).toBeInTheDocument();
  });

  it('the Result preview does not apply an embed-only recommendation cap', async () => {
    mockLoad({ config: { maxRecommendations: 2 } });
    renderPanel();
    await screen.findByText(/TMC Template/);

    // Switch off the "General" admin tab first — its own "Show progress
    // bar" / "Show Powered by" / hideTitle / hideSubtitle checkboxes stay
    // mounted otherwise (the tab list and the preview are independent —
    // the preview is always rendered, not per-tab), and would inflate the
    // checkbox count this assertion cares about.
    fireEvent.click(screen.getByRole('button', { name: /Get the code/i }));
    fireEvent.click(screen.getByRole('button', { name: /^Result$/i }));
    await screen.findByText(/Day trips/i);
    const checkboxes = screen.getAllByRole('checkbox');
    // The saved legacy value is intentionally ignored. Recommendation count
    // comes from shared Recommendation Settings when a real form is submitted.
    expect(checkboxes).toHaveLength(8);
  });
});

describe('DiagnosticEmbedFormsPanel — get the code', () => {
  it('generates an iframe/script snippet with no config= param', async () => {
    mockLoad({ config: { title: 'Ready' } });
    renderPanel();
    await screen.findByDisplayValue('Ready');

    fireEvent.click(screen.getByRole('button', { name: /Get the code/i }));

    const iframeBox = await screen.findByDisplayValue(/<iframe/i);
    expect(iframeBox.value).not.toMatch(/config=/);
    expect(iframeBox.value).toMatch(/embed\/diagnostic\.html\?tenant=travelstall&subBrand=tmc/);

    const scriptBoxes = screen.getAllByDisplayValue(/<script|diagnostic-form/i);
    const scriptTag = scriptBoxes.find((el) => String(el.value).includes('diagnostic.js'));
    expect(scriptTag.value).not.toMatch(/data-config=/);
  });

  it('copies the iframe snippet to the clipboard', async () => {
    mockLoad({ config: { title: 'Ready' } });
    renderPanel();
    await screen.findByDisplayValue('Ready');
    fireEvent.click(screen.getByRole('button', { name: /Get the code/i }));
    fireEvent.click(screen.getByRole('button', { name: /Copy iframe snippet/i }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalled());
    expect(await screen.findByText(/^Copied$/i)).toBeInTheDocument();
  });
});
