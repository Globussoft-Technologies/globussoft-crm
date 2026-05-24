/**
 * CustomObjects.test.jsx — vitest + RTL coverage for the platform/customization
 * "Custom Objects Builder" page. Surface lets the operator define new
 * CustomEntity record types (e.g. operator-defined "Property" / "Course" /
 * "Vehicle" record types beyond the standard Contact/Lead/Deal taxonomy)
 * and the per-entity field schema (Text/Number/Date/Boolean).
 *
 * Source: frontend/src/pages/CustomObjects.jsx (137 LOC). 7-invariant surface:
 *
 *   1. Page renders heading "Custom Objects Builder" + "Create Entity" CTA.
 *   2. Initial mount fires GET /api/custom_objects/entities; the loading
 *      placeholder "Building Entity Abstraction Map..." renders before the
 *      response settles.
 *   3. Renders one card per entity returned by the fetch — entity name +
 *      description + each field's name+type chip + the Access-Dataset CTA
 *      labelled with the record count.
 *   4. Empty state "Schema Definitions Missing" renders when the entities
 *      array is empty.
 *   5. Clicking "Create Entity" opens the modal with Entity-Name input + the
 *      pre-seeded "DefaultProperty" Text field row.
 *   6. Clicking "Insert Schema Property" inside the modal appends a new
 *      "NewProperty" / "Text" field row.
 *   7. Submitting the create form fires POST /api/custom_objects/entities
 *      with the JSON body shape { name, description, fields: [...] }, then
 *      re-fetches the entity list. Submitting with empty name short-circuits
 *      (no POST).
 *   8. POST failure surfaces a notify.error call referencing the EAV
 *      boundary-constraint message; modal stays open so the user can retry.
 *   9. Clicking the per-entity "Access Dataset Records" CTA navigates to
 *      /objects/<name> via window.location.href assignment.
 *
 * Drift notes (verified against CustomObjects.jsx at HEAD as of this commit):
 *   - There is NO field-builder TYPE edit, NO field-delete confirmation,
 *     NO role-gate check, and NO debounced search. Don't pin what isn't there.
 *   - The "click-through to CustomObjectView" is implemented via
 *     `window.location.href=...` (hard nav), NOT react-router Link/navigate.
 *     So we stub location.href to capture the assignment rather than
 *     wrapping in MemoryRouter expecting a route change.
 *   - The error toast string is the verbatim
 *     "Failed to generate EAV dynamic database boundary constraints" copy
 *     from CustomObjects.jsx:34. Pinned as substring match.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyObj = {
  error: notifyError,
  info: vi.fn(),
  success: notifySuccess,
  confirm: () => Promise.resolve(true),
};
vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import CustomObjects from '../pages/CustomObjects';

const sampleEntities = [
  {
    id: 1,
    name: 'Property',
    description: 'Real-estate listing record',
    fields: [
      { id: 11, name: 'Address', type: 'Text' },
      { id: 12, name: 'SquareFeet', type: 'Number' },
    ],
    records: [{ id: 100 }, { id: 101 }, { id: 102 }],
  },
  {
    id: 2,
    name: 'Course',
    description: '',
    fields: [{ id: 21, name: 'Title', type: 'Text' }],
    records: [],
  },
];

function defaultFetchMock(url, opts) {
  if (url === '/api/custom_objects/entities' && (!opts || !opts.method || opts.method === 'GET')) {
    return Promise.resolve(sampleEntities);
  }
  if (url === '/api/custom_objects/entities' && opts?.method === 'POST') {
    return Promise.resolve({ id: 3, name: 'Vehicle', description: '', fields: [] });
  }
  return Promise.resolve(null);
}

describe('<CustomObjects /> — page surface', () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
    fetchApiMock.mockImplementation(defaultFetchMock);
    notifyError.mockReset();
    notifySuccess.mockReset();
  });

  it('renders the heading "Custom Objects Builder" + "Create Entity" CTA', async () => {
    render(<CustomObjects />);
    expect(
      screen.getByRole('heading', { name: /Custom Objects Builder/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Create Entity/i }),
    ).toBeInTheDocument();
  });

  it('initial mount fetches GET /api/custom_objects/entities', async () => {
    render(<CustomObjects />);
    await waitFor(() => {
      const initialCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/custom_objects/entities' && (!o || !o.method || o.method === 'GET'),
      );
      expect(initialCall).toBeTruthy();
    });
  });

  it('shows the loading placeholder before the initial fetch resolves', async () => {
    let resolveEntities;
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/custom_objects/entities') {
        return new Promise((r) => { resolveEntities = r; });
      }
      return Promise.resolve(null);
    });
    render(<CustomObjects />);
    // While the entities fetch is in-flight, the loading copy renders.
    expect(
      await screen.findByText(/Building Entity Abstraction Map/i),
    ).toBeInTheDocument();
    // Clean teardown.
    resolveEntities([]);
  });

  it('renders one card per entity with name, description, fields, and records count CTA', async () => {
    render(<CustomObjects />);
    // Entity names render in card headings.
    expect(await screen.findByText('Property')).toBeInTheDocument();
    expect(screen.getByText('Course')).toBeInTheDocument();
    // Description renders verbatim when present.
    expect(screen.getByText('Real-estate listing record')).toBeInTheDocument();
    // Empty description falls back to the placeholder copy.
    expect(
      screen.getByText(/Natively defined backend matrix array limit parameters/i),
    ).toBeInTheDocument();
    // Field chips render with both name + type.
    expect(screen.getByText('Address')).toBeInTheDocument();
    expect(screen.getByText('SquareFeet')).toBeInTheDocument();
    // "Text" appears as a field-type chip in the rendered cards (and may
    // also appear inside the Create-Entity modal once it's open — for
    // mount state, the modal is closed so the multi-collision is from
    // multiple cards' field chips).
    expect(screen.getAllByText('Text').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Number')).toBeInTheDocument();
    // Access-Dataset CTA renders the records-array length per card.
    expect(
      screen.getByRole('button', { name: /Access Dataset Records \(3\)/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Access Dataset Records \(0\)/i }),
    ).toBeInTheDocument();
  });

  it('renders the empty-state "Schema Definitions Missing" copy when no entities returned', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/custom_objects/entities') return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<CustomObjects />);
    await waitFor(() => {
      expect(screen.getByText(/Schema Definitions Missing/i)).toBeInTheDocument();
    });
    // Empty-state body copy mentions the EAV-mint hint.
    expect(
      screen.getByText(/mint independent EAV schemas/i),
    ).toBeInTheDocument();
  });

  it('clicking "Create Entity" opens the modal with Entity-Name input + the seeded DefaultProperty field row', async () => {
    render(<CustomObjects />);
    await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Entity/i }));

    // Modal heading.
    expect(
      screen.getByRole('heading', { name: /Formulate Schema Boundaries/i }),
    ).toBeInTheDocument();
    // Entity-Name input renders with the "Properties" placeholder.
    expect(screen.getByPlaceholderText(/e\.g\. Properties/i)).toBeInTheDocument();
    // Pre-seeded "DefaultProperty" field row renders as the first field input.
    const fieldNameInput = screen.getByDisplayValue('DefaultProperty');
    expect(fieldNameInput).toBeInTheDocument();
    // "Insert Schema Property" affordance renders inside the modal.
    expect(
      screen.getByRole('button', { name: /Insert Schema Property/i }),
    ).toBeInTheDocument();
    // Submit button renders.
    expect(screen.getByRole('button', { name: /Create Schema/i })).toBeInTheDocument();
  });

  it('clicking "Insert Schema Property" appends a new "NewProperty" / "Text" field row', async () => {
    render(<CustomObjects />);
    await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Create Entity/i }));

    // Pre-state: one row visible (DefaultProperty).
    expect(screen.getAllByDisplayValue('DefaultProperty').length).toBe(1);
    expect(screen.queryByDisplayValue('NewProperty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Insert Schema Property/i }));

    // Post-state: a new "NewProperty" row appears.
    expect(screen.getByDisplayValue('NewProperty')).toBeInTheDocument();
  });

  it('submitting the form fires POST /api/custom_objects/entities with the form-state body shape, then re-fetches', async () => {
    render(<CustomObjects />);
    await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Entity/i }));

    // Fill name + description.
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Properties/i), {
      target: { value: 'Vehicle' },
    });
    fireEvent.change(
      screen.getByPlaceholderText(/Architectural notes/i),
      { target: { value: 'Fleet tracking entity' } },
    );

    // Snapshot the initial GET count so we can detect the post-POST reload.
    const initialGetCount = fetchApiMock.mock.calls.filter(
      ([u, o]) => u === '/api/custom_objects/entities' && (!o || !o.method || o.method === 'GET'),
    ).length;

    fireEvent.click(screen.getByRole('button', { name: /Create Schema/i }));

    await waitFor(() => {
      const postCall = fetchApiMock.mock.calls.find(
        ([u, o]) => u === '/api/custom_objects/entities' && o?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall[1].body);
      expect(body.name).toBe('Vehicle');
      expect(body.description).toBe('Fleet tracking entity');
      // Pre-seeded DefaultProperty field carried through.
      expect(Array.isArray(body.fields)).toBe(true);
      expect(body.fields[0]).toEqual({ name: 'DefaultProperty', type: 'Text' });
    });

    // After POST resolves, loadEntities re-fires the GET.
    await waitFor(() => {
      const postReloadGetCount = fetchApiMock.mock.calls.filter(
        ([u, o]) => u === '/api/custom_objects/entities' && (!o || !o.method || o.method === 'GET'),
      ).length;
      expect(postReloadGetCount).toBeGreaterThan(initialGetCount);
    });
  });

  it('submitting the form with an empty name short-circuits — no POST fires', async () => {
    render(<CustomObjects />);
    await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Entity/i }));

    // Name input intentionally left blank. Native HTML5 `required` would
    // block at the form level, but the handler also has an early-return
    // guard: `if (!newEntity.name) return;`. The handler-level guard is
    // load-bearing because it doesn't depend on browser form-submission
    // semantics. We dispatch the submit event directly on the <form> to
    // bypass any HTML5 short-circuit and verify the handler guard fires.
    const form = document.querySelector('form');
    expect(form).toBeTruthy();
    fetchApiMock.mockClear();
    fireEvent.submit(form);

    // Give any async tail a tick to settle.
    await new Promise((r) => setTimeout(r, 30));

    const postCall = fetchApiMock.mock.calls.find(
      ([u, o]) => u === '/api/custom_objects/entities' && o?.method === 'POST',
    );
    expect(postCall).toBeUndefined();
  });

  it('POST failure surfaces notify.error referencing the EAV boundary-constraint copy; modal stays open', async () => {
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/custom_objects/entities' && opts?.method === 'POST') {
        return Promise.reject(new Error('500 backend explosion'));
      }
      if (url === '/api/custom_objects/entities') return Promise.resolve(sampleEntities);
      return Promise.resolve(null);
    });

    render(<CustomObjects />);
    await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /Create Entity/i }));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Properties/i), {
      target: { value: 'Vehicle' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Create Schema/i }));

    await waitFor(() => {
      expect(notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/EAV dynamic database boundary constraints/i),
      );
    });
    // Modal stays open on POST failure so the user can correct + retry.
    // The Entity-Name input is still in the document.
    expect(screen.getByPlaceholderText(/e\.g\. Properties/i)).toBeInTheDocument();
  });

  it('clicking the per-entity Access-Dataset CTA navigates via window.location.href to /objects/<name>', async () => {
    // The handler writes `window.location.href = ...`. jsdom's default
    // `location` object doesn't permit reassignment via `window.location =`,
    // but `window.location.href = ...` is intercept-able by stubbing the
    // `href` property on the existing location object.
    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      enumerable: true,
      value: {
        ...originalLocation,
        get href() { return originalLocation.href; },
        set href(v) { hrefSetter(v); },
      },
    });

    try {
      render(<CustomObjects />);
      await waitFor(() => expect(screen.getByText('Property')).toBeInTheDocument());

      fireEvent.click(
        screen.getByRole('button', { name: /Access Dataset Records \(3\)/i }),
      );

      expect(hrefSetter).toHaveBeenCalledWith('/objects/Property');
    } finally {
      // Restore the original location object so other tests aren't affected.
      Object.defineProperty(window, 'location', {
        configurable: true,
        enumerable: true,
        value: originalLocation,
      });
    }
  });
});
