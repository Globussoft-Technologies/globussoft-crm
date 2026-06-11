/**
 * SequenceBuilder.test.jsx — vitest + RTL coverage for the explicit
 * step-list editor at /sequences/:id/builder (frontend/src/pages/
 * SequenceBuilder.jsx, the #9-rebuild surface that coexists with the
 * legacy ReactFlow Sequences canvas).
 *
 * Scope: pins the page-surface invariants for the builder — initial mount
 * fetch fan-out, sequence-not-found fallback, empty-state, step-row
 * rendering per kind, add-step POST shape per kind, toggle-active PATCH
 * shape, delete-step confirm + DELETE call, and StepEditor wait-delay
 * validation (#375 numeric-only guard).
 *
 *   1. Loading message renders while the initial /api/sequences fetch
 *      is in flight (pre-resolve).
 *   2. Sequence-not-found fallback ("Sequence not found") renders when
 *      /api/sequences responds with [] (no match for :id).
 *   3. Sequence name + isActive toggle button render once the sequence
 *      lookup hits — "Active" label when isActive=true, "Inactive"
 *      otherwise.
 *   4. Empty-state row "No steps yet. Add one to get started." renders
 *      when /api/sequences/:id/steps returns [].
 *   5. Step rows render per kind: position prefix (#N), kind label
 *      (Email / SMS / Wait / Condition), and the per-kind summary line
 *      (template name, smsBody slice, "Wait N min", conditional-branch).
 *   6. "Flow preview" timeline renders once steps.length > 0 (timeline
 *      list with "Step N: …" rows summarising email subject / SMS body /
 *      wait days / condition branch).
 *   7. Clicking "+ Email" fires POST /api/sequences/:id/steps with
 *      `{ kind: 'email', pauseOnReply: true }` body shape (and reloads).
 *   8. Clicking "+ Wait" fires POST with `{ kind: 'wait', delayMinutes:
 *      60, pauseOnReply: false }` body shape (the default-60 invariant).
 *   9. Clicking the toggle button fires PATCH /api/sequences/:id/toggle
 *      with `{ isActive: !current }` body shape.
 *  10. Clicking the Trash icon on a row + confirming fires DELETE
 *      /api/sequences/steps/:id; declining the confirm does NOT delete.
 *  11. Clicking a step row opens the StepEditor side panel; the kind-
 *      specific input renders (email <select>, sms <textarea>, wait
 *      <input type=number>, condition <textarea>).
 *  12. #375 — StepEditor wait Save with a non-numeric / negative delay
 *      surfaces notify.error('Delay must be a non-negative whole number
 *      of minutes.') and does NOT issue the PUT.
 *
 * Drift note: the underlying step-engine semantics (pause-on-reply
 * enrollment, condition-evaluator op set) are pinned by the backend
 * sequences-api specs. This file covers ONLY the page-chrome contract:
 * what the UI fetches, what it renders, what it POSTs/PUTs/PATCHes/
 * DELETEs in response to clicks.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

// Stable mock-object reference for useNotify — fresh objects per call
// would invalidate any useCallback dep-array dependants and trip a
// re-render loop (standing rule, ref: feedback_parallel_wave_discipline).
const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: notifyConfirm,
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import SequenceBuilder from '../pages/SequenceBuilder';

const SEQ_ID = 42;

const sampleSequence = {
  id: SEQ_ID,
  name: 'Welcome Drip',
  isActive: true,
};

const sampleTemplates = [
  { id: 7, name: 'Welcome email', subject: 'Welcome aboard!' },
  { id: 8, name: 'Day-3 nudge', subject: 'Settling in?' },
];

const sampleSteps = [
  {
    id: 100,
    position: 1,
    kind: 'email',
    emailTemplateId: 7,
    emailTemplate: sampleTemplates[0],
    pauseOnReply: true,
  },
  {
    id: 101,
    position: 2,
    kind: 'wait',
    delayMinutes: 1440,
  },
  {
    id: 102,
    position: 3,
    kind: 'sms',
    smsBody: 'Hi {{contact.name}}, quick reminder about your booking.',
    pauseOnReply: false,
  },
  {
    id: 103,
    position: 4,
    kind: 'condition',
    conditionJson: '[{"field":"contact.status","op":"eq","value":"Lead"}]',
  },
];

// S86 — flyer template pool the operator picks from. Three rows, distinct
// names, fixed ids so test assertions can pin specific selections + IDs.
const sampleFlyerTemplates = [
  { id: 201, name: 'Diwali Promo Flyer' },
  { id: 202, name: 'Umrah Package Flyer' },
  { id: 203, name: 'School Trip Brochure' },
];

function defaultFetchMock(url, opts) {
  const method = opts?.method || 'GET';
  if (url === '/api/sequences' && method === 'GET') {
    return Promise.resolve([sampleSequence]);
  }
  if (url === `/api/sequences/${SEQ_ID}/steps` && method === 'GET') {
    return Promise.resolve(sampleSteps);
  }
  if (url === '/api/email-templates' && method === 'GET') {
    return Promise.resolve(sampleTemplates);
  }
  // S86: flyer templates list endpoint. Backend returns `{templates,total,limit,offset}`.
  if (url === '/api/travel/flyer-templates' && method === 'GET') {
    return Promise.resolve({ templates: sampleFlyerTemplates, total: sampleFlyerTemplates.length, limit: 100, offset: 0 });
  }
  return Promise.resolve(null);
}

function renderBuilder() {
  return render(
    <MemoryRouter initialEntries={[`/sequences/${SEQ_ID}/builder`]}>
      <Routes>
        <Route path="/sequences/:id/builder" element={<SequenceBuilder />} />
        <Route path="/sequences" element={<div>Sequences list</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('<SequenceBuilder /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  it('shows "Loading…" before the initial fetch resolves', async () => {
    let resolveSequences;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') {
        return new Promise((r) => { resolveSequences = r; });
      }
      if (url === `/api/sequences/${SEQ_ID}/steps`) return Promise.resolve([]);
      if (url === '/api/email-templates') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderBuilder();
    expect(await screen.findByText(/Loading…/i)).toBeInTheDocument();
    // Clean up the dangling promise.
    resolveSequences([sampleSequence]);
  });

  it('renders "Sequence not found" when /api/sequences has no match for :id', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/sequences') return Promise.resolve([]);
      if (url === `/api/sequences/${SEQ_ID}/steps`) return Promise.resolve([]);
      if (url === '/api/email-templates') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    renderBuilder();
    expect(await screen.findByRole('heading', { name: /Sequence not found/i })).toBeInTheDocument();
  });

  it('renders the sequence name + "Active" toggle when isActive=true', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /Welcome Drip/i })).toBeInTheDocument();
    });
    // The toggle label reflects the current isActive (true → "Active").
    expect(screen.getByRole('button', { name: /^Active$/i })).toBeInTheDocument();
  });

  it('renders the "Inactive" toggle label when isActive=false', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences') {
        return Promise.resolve([{ ...sampleSequence, isActive: false }]);
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Inactive$/i })).toBeInTheDocument();
    });
  });

  it('renders the empty-state when /api/sequences/:id/steps returns []', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/sequences/${SEQ_ID}/steps`) return Promise.resolve([]);
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/No steps yet\. Add one to get started\./i)).toBeInTheDocument();
    });
    // Flow-preview panel is suppressed when steps.length === 0.
    expect(screen.queryByText(/Flow preview/i)).not.toBeInTheDocument();
  });

  it('renders one row per step with the position prefix + kind label + per-kind summary', async () => {
    renderBuilder();
    // Wait for the data to flow in.
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    // Position prefixes (#1..#4) render. Each appears in both the step row
    // and the StepEditor heading (when open) — so use getAllByText for the
    // ones that may collide and assert >= 1 occurrence.
    expect(screen.getAllByText('#1').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('#2').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('#3').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('#4').length).toBeGreaterThanOrEqual(1);
    // Kind labels render in the row (Email, SMS, Wait, Condition).
    // Also appear in the flow-preview ("Step 1: Email — …") and in the
    // add-step buttons — assert >= 1 occurrence for each.
    expect(screen.getAllByText(/^Email$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^SMS$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Wait$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/^Condition$/).length).toBeGreaterThanOrEqual(1);
    // Per-kind summary lines.
    expect(screen.getByText(/Wait 1440 min/i)).toBeInTheDocument();
    // SMS body slice (first 60 chars of the body) renders inside the row.
    expect(screen.getByText(/Hi \{\{contact\.name\}\}, quick reminder about your booking\./i)).toBeInTheDocument();
    // Condition row renders "Conditional branch" because conditionJson is non-empty.
    expect(screen.getByText(/Conditional branch/i)).toBeInTheDocument();
  });

  it('renders the "Flow preview" timeline once steps exist', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/Flow preview/i)).toBeInTheDocument();
    });
    // Step 1 references the email template's subject.
    expect(screen.getByText(/Step 1:/i)).toBeInTheDocument();
    // Step 2 is a 1-day wait (1440 / 1440 = 1d, integer formatting).
    expect(screen.getByText(/Wait 1d/i)).toBeInTheDocument();
    // Step 4 is a condition branch.
    expect(screen.getByText(/Condition branch/i)).toBeInTheDocument();
  });

  it('clicking "+ Email" POSTs /api/sequences/:id/steps with kind=email + pauseOnReply=true', async () => {
    // Track the POST.
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/sequences/${SEQ_ID}/steps` && opts?.method === 'POST') {
        return Promise.resolve({ id: 999, position: 5, kind: 'email', pauseOnReply: true });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome Drip')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();

    // Add-step buttons render with "+ Email" / "+ SMS" / etc. labels — pin
    // the Email button via its exact text.
    fireEvent.click(screen.getByRole('button', { name: /^Email$/ }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === `/api/sequences/${SEQ_ID}/steps` && o?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.kind).toBe('email');
      expect(body.pauseOnReply).toBe(true);
    });
    expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/Added Email step/i));
  });

  it('clicking "+ Wait" POSTs with kind=wait + delayMinutes=60 + pauseOnReply=false (the default-60 invariant)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/sequences/${SEQ_ID}/steps` && opts?.method === 'POST') {
        return Promise.resolve({ id: 998, position: 5, kind: 'wait', delayMinutes: 60 });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome Drip')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Wait$/ }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === `/api/sequences/${SEQ_ID}/steps` && o?.method === 'POST'
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.kind).toBe('wait');
      expect(body.delayMinutes).toBe(60);
      // Wait steps are NOT pause-on-reply (only email + sms are).
      expect(body.pauseOnReply).toBe(false);
    });
  });

  it('clicking the toggle button PATCHes /api/sequences/:id/toggle with the FLIPPED isActive', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/sequences/${SEQ_ID}/toggle` && opts?.method === 'PATCH') {
        return Promise.resolve({ id: SEQ_ID, isActive: false });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Active$/i })).toBeInTheDocument();
    });
    fetchApiMock.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Active$/i }));

    await waitFor(() => {
      const patchCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === `/api/sequences/${SEQ_ID}/toggle` && o?.method === 'PATCH'
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall[1].body);
      // Current isActive is true, so the toggle sends false.
      expect(body.isActive).toBe(false);
    });
  });

  it('clicking the Trash icon + confirming fires DELETE /api/sequences/steps/:id', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences/steps/100' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));

    // Multiple "Delete step" aria-label buttons (one per row); pick the first
    // (Step #1 — the email step with id 100).
    const deleteButtons = screen.getAllByRole('button', { name: /Delete step/i });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // Confirm body uses destructive: true + the step's position + kind.
    const confirmArg = notifyConfirm.mock.calls[0][0];
    expect(confirmArg.destructive).toBe(true);
    expect(confirmArg.message).toMatch(/Delete step #1 \(email\)/i);

    await waitFor(() => {
      const deleteCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sequences/steps/100' && o?.method === 'DELETE'
      );
      expect(deleteCall).toBeTruthy();
    });
  });

  it('declining the delete confirm does NOT fire the DELETE', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fetchApiMock.mockClear();
    notifyConfirm.mockImplementation(() => Promise.resolve(false));

    fireEvent.click(screen.getAllByRole('button', { name: /Delete step/i })[0]);

    await waitFor(() => {
      expect(notifyConfirm).toHaveBeenCalled();
    });
    // No DELETE ever fires.
    const deleteCall = fetchApiMock.mock.calls.find(
      ([, o]) => o?.method === 'DELETE'
    );
    expect(deleteCall).toBeUndefined();
  });

  it('clicking a step row opens the StepEditor side panel with the kind-specific input', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });

    // Click the email step (#1) — the StepEditor renders a <select> of templates.
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Email template/i)).toBeInTheDocument();
    // Each template renders as an <option>.
    expect(screen.getByRole('option', { name: 'Welcome email' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Day-3 nudge' })).toBeInTheDocument();

    // Click the wait step (#2) — the StepEditor swaps to a numeric input.
    fireEvent.click(screen.getByText(/Wait 1440 min/i));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #2/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Delay \(minutes\)/i)).toBeInTheDocument();
  });

  it('#375 — Save on a wait step with a negative delay surfaces an error toast and does NOT PUT', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/Wait 1440 min/i)).toBeInTheDocument();
    });

    // Open the wait step's editor.
    fireEvent.click(screen.getByText(/Wait 1440 min/i));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #2/i)).toBeInTheDocument();
    });

    // The input has an inline regex guard (`/^\d+$/`) so fireEvent.change
    // with "-5" is REJECTED at the change handler — the value stays 1440.
    // To exercise the submit-time guard we clear the input first (empty
    // string passes the change-handler regex's `v === ''` branch), then
    // click Save. Empty string fails the submit-time guard.
    const delayInput = screen.getByDisplayValue('1440');
    fireEvent.change(delayInput, { target: { value: '' } });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Delay must be a non-negative whole number of minutes\./i)
      );
    });
    // No PUT to /api/sequences/steps/:id fired.
    const putCall = fetchApiMock.mock.calls.find(
      ([, o]) => o?.method === 'PUT'
    );
    expect(putCall).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// S86 — operator flyer-picker for SequenceStep.attachmentRefsJson
// PRD_TRAVEL_MARKETING_FLYER FR-3.5 / AC-6.5
//
// Pinned contract:
//   - StepEditor renders an "Attach Flyer" toggle inside the email + sms
//     branches (not wait / condition — engine's resolveStepAttachments
//     short-circuits on those kinds).
//   - GET /api/travel/flyer-templates on mount populates the picker.
//   - Picker = template dropdown (5 sample rows by name) + format selector
//     (5 canonical formats from FlyerTemplates.jsx RENDER_FORMATS) + Add btn.
//   - Add appends a `{kind:'flyer',flyerId,format}` to the local attachments
//     list; same flyer+format combo can't be added twice.
//   - Remove-X drops an attachment.
//   - On Save, the patch body includes `attachmentRefsJson` — JSON.stringify
//     of the local array when non-empty; null when empty.
//   - Pre-fill: editing a step with existing attachmentRefsJson hydrates the
//     local attachments list.
// ─────────────────────────────────────────────────────────────────────────
describe('<SequenceBuilder /> — S86 flyer picker', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
    notifyConfirm.mockReset();
    notifyConfirm.mockImplementation(() => Promise.resolve(true));
  });

  it('GET /api/travel/flyer-templates fires on initial mount (flyer pool populated)', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome Drip')).toBeInTheDocument();
    });
    const flyerCall = fetchApiMock.mock.calls.find(
      ([u]) => u === '/api/travel/flyer-templates',
    );
    expect(flyerCall).toBeTruthy();
  });

  it('renders the "Attach Flyer" toggle inside the email step editor', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    // Open the email step editor (step #1).
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    // Section header — the empty-state row also contains "flyer attachments"
    // (lowercase) so use a case-sensitive match on the title-cased label to
    // disambiguate.
    expect(screen.getByText(/^Flyer attachments$/)).toBeInTheDocument();
    expect(screen.getByTestId('toggle-flyer-picker')).toBeInTheDocument();
    // Empty-state copy renders when there are no attachments + picker is closed.
    expect(screen.getByText(/No flyer attachments\./i)).toBeInTheDocument();
  });

  it('renders the "Attach Flyer" toggle inside the SMS step editor too', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/quick reminder about your booking/i)).toBeInTheDocument();
    });
    // Open the SMS step editor (step #3).
    fireEvent.click(screen.getByText(/quick reminder about your booking/i));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #3/i)).toBeInTheDocument();
    });
    expect(screen.getByTestId('toggle-flyer-picker')).toBeInTheDocument();
  });

  it('does NOT render the flyer picker on the wait step (engine ignores attachments on wait)', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/Wait 1440 min/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Wait 1440 min/i));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #2/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('toggle-flyer-picker')).not.toBeInTheDocument();
  });

  it('clicking "Attach Flyer" opens the picker panel with the template dropdown populated', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });

    // Panel hidden by default.
    expect(screen.queryByTestId('flyer-picker-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));

    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });
    // The flyer template dropdown lists the three sample rows.
    expect(screen.getByRole('option', { name: 'Diwali Promo Flyer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Umrah Package Flyer' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'School Trip Brochure' })).toBeInTheDocument();
    // Format selector lists the 5 canonical RENDER_FORMATS labels.
    expect(screen.getByRole('option', { name: /PDF — A4/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /PDF — A5/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Square PNG/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Instagram Story/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Facebook Cover/ })).toBeInTheDocument();
  });

  it('picking a template + format + clicking Add appends the attachment to the list', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('flyer-template-select'), { target: { value: '202' } });
    fireEvent.change(screen.getByTestId('flyer-format-select'), { target: { value: 'pdf-a5' } });
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));

    // Attachment row renders with the template name + format label.
    await waitFor(() => {
      const list = screen.getByTestId('attached-flyers-list');
      expect(list).toBeInTheDocument();
      expect(list.textContent).toMatch(/Umrah Package Flyer/);
      expect(list.textContent).toMatch(/PDF — A5/);
    });
  });

  it('attempting to add a duplicate (same flyer + same format) surfaces a notify.error and does NOT double-up', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });

    // First add — succeeds.
    fireEvent.change(screen.getByTestId('flyer-template-select'), { target: { value: '201' } });
    fireEvent.change(screen.getByTestId('flyer-format-select'), { target: { value: 'pdf-a4' } });
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('attached-flyers-list')).toBeInTheDocument();
    });
    // Second add — same flyer + same format. Should error.
    fireEvent.change(screen.getByTestId('flyer-template-select'), { target: { value: '201' } });
    fireEvent.change(screen.getByTestId('flyer-format-select'), { target: { value: 'pdf-a4' } });
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/already attached/i),
      );
    });
    // List length stayed at 1 — count the rendered <li> entries.
    const list = screen.getByTestId('attached-flyers-list');
    expect(list.querySelectorAll('li').length).toBe(1);
  });

  it('clicking the remove-X drops the attachment from the list', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('flyer-template-select'), { target: { value: '203' } });
    fireEvent.change(screen.getByTestId('flyer-format-select'), { target: { value: 'png-square' } });
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('attached-flyers-list')).toBeInTheDocument();
    });

    // One row added — index 0.
    fireEvent.click(screen.getByTestId('remove-attachment-0'));

    await waitFor(() => {
      // Empty-state copy returns (list element disappears).
      expect(screen.queryByTestId('attached-flyers-list')).not.toBeInTheDocument();
    });
  });

  it('Save on an email step with one flyer attachment PUTs attachmentRefsJson with the JSON-stringified array', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences/steps/100' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 100, position: 1, kind: 'email' });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });
    fireEvent.change(screen.getByTestId('flyer-template-select'), { target: { value: '202' } });
    fireEvent.change(screen.getByTestId('flyer-format-select'), { target: { value: 'png-portrait-ig' } });
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('attached-flyers-list')).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sequences/steps/100' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // Field is a string (JSON-encoded); parse it and assert shape.
      expect(typeof body.attachmentRefsJson).toBe('string');
      const refs = JSON.parse(body.attachmentRefsJson);
      expect(refs).toEqual([
        { kind: 'flyer', flyerId: 202, format: 'png-portrait-ig' },
      ]);
    });
  });

  it('Save on an email step with NO attachments PUTs attachmentRefsJson:null (engine short-circuit)', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/sequences/steps/100' && opts?.method === 'PUT') {
        return Promise.resolve({ id: 100, position: 1, kind: 'email' });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });

    fetchApiMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => {
      const putCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/sequences/steps/100' && o?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall[1].body);
      // No local attachments → null sent (engine treats null/empty as "no attachments").
      expect(body.attachmentRefsJson).toBeNull();
    });
  });

  it('editing a step with existing attachmentRefsJson pre-fills the local attachments list', async () => {
    // Override sampleSteps for this test so step 102 (SMS) ships with a
    // pre-existing attachmentRefsJson payload.
    const stepsWithFlyer = [
      ...sampleSteps.slice(0, 2),
      {
        ...sampleSteps[2],
        attachmentRefsJson: JSON.stringify([
          { kind: 'flyer', flyerId: 203, format: 'png-landscape-fb' },
        ]),
      },
      sampleSteps[3],
    ];
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === `/api/sequences/${SEQ_ID}/steps` && opts?.method !== 'POST' && opts?.method !== 'PUT' && opts?.method !== 'DELETE') {
        return Promise.resolve(stepsWithFlyer);
      }
      return defaultFetchMock(url, opts);
    });

    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText(/quick reminder about your booking/i)).toBeInTheDocument();
    });
    // Open the SMS step editor.
    fireEvent.click(screen.getByText(/quick reminder about your booking/i));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #3/i)).toBeInTheDocument();
    });

    // Pre-filled attachment row renders immediately — no toggle needed.
    const list = screen.getByTestId('attached-flyers-list');
    expect(list).toBeInTheDocument();
    expect(list.textContent).toMatch(/School Trip Brochure/);
    expect(list.textContent).toMatch(/Facebook Cover/);
  });

  it('Add without picking a flyer surfaces notify.error and does NOT add a row', async () => {
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByTestId('flyer-picker-panel')).toBeInTheDocument();
    });

    // No template picked.
    fireEvent.click(screen.getByTestId('add-flyer-attachment-btn'));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/Pick a flyer template/i),
      );
    });
    expect(screen.queryByTestId('attached-flyers-list')).not.toBeInTheDocument();
  });

  it('renders "No flyer templates available" fallback when the flyer pool is empty', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/flyer-templates') {
        return Promise.resolve({ templates: [], total: 0, limit: 100, offset: 0 });
      }
      return defaultFetchMock(url, opts);
    });
    renderBuilder();
    await waitFor(() => {
      expect(screen.getByText('Welcome email')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Welcome email'));
    await waitFor(() => {
      expect(screen.getByText(/Edit step #1/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('toggle-flyer-picker'));
    await waitFor(() => {
      expect(screen.getByText(/No flyer templates available/i)).toBeInTheDocument();
    });
  });
});
