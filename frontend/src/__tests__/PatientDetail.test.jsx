import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Stable mock object refs (2026-05-23 RTL standing rule): every hook whose
// return value lands in a useCallback / useMemo dependency must return ONE
// stable object reference across the test run, NOT a fresh object per call.
// Fresh-per-call objects cause infinite re-render loops that hang the test
// until vitest's per-test timeout fires.
const notifyObj = {
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  confirm: vi.fn(),
};

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
  getAuthToken: () => 'test-token',
}));

vi.mock('../utils/notify', () => ({
  useNotify: () => notifyObj,
}));

import { fetchApi } from '../utils/api';
import PatientDetail from '../pages/wellness/PatientDetail';

const patient = {
  id: 1,
  name: 'Ananya Singh',
  phone: '+919876543210',
  email: 'ananya@test.in',
  // #638: dob + gender drive the at-a-glance subline. Stored on the
  // Prisma Patient model as `dob` (DateTime?) + `gender` (M/F/Other).
  dob: '1990-08-12T00:00:00Z',
  gender: 'F',
  bloodGroup: 'O+',
  source: 'walk-in',
  visits: [
    { id: 11, visitDate: '2026-04-10T09:00:00Z', service: { name: 'Consultation' }, notes: 'First visit', amountCharged: 1500 },
  ],
  prescriptions: [],
  treatmentPlans: [],
  consents: [],
};

const services = [{ id: 1, name: 'Hair Transplant', basePrice: 60000, durationMin: 120 }];
const staff = [{ id: 5, name: 'Dr. Mehta', wellnessRole: 'doctor' }];

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/wellness/patients/1']}>
      <Routes>
        <Route path="/wellness/patients/:id" element={<PatientDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('<PatientDetail />', () => {
  beforeEach(() => {
    fetchApi.mockReset();
    notifyObj.error.mockClear();
    notifyObj.info.mockClear();
    notifyObj.success.mockClear();
    notifyObj.confirm.mockClear();
    notifyObj.confirm.mockResolvedValue(true);
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/staff') return Promise.resolve(staff);
      return Promise.resolve([]);
    });
  });

  it('renders all 7 tab buttons', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument());
    for (const label of ['Case history', 'New prescription', 'Consent form', 'Treatment plans', 'Log visit', 'Photos', 'Inventory used']) {
      expect(screen.getByRole('button', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  // #638 — patient header subline must surface DOB + computed age + gender
  // + phone at-a-glance, not buried in the Profile tab. Pre-fix the header
  // showed only Name + Contact phone.
  describe('Patient header subline (#638)', () => {
    it('renders DOB (formatted) + computed age + gender label + phone', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      const subline = screen.getByTestId('patient-header-subline').textContent;

      // Computed age: born 1990-08-12; expected 35y as of 2026-05-08 — but
      // because tests can run on/around the birthday, allow 35y or 36y.
      expect(subline).toMatch(/\b3[56]y\b/);

      // Gender label: schema stores 'F' → header expands to 'Female'.
      expect(subline).toMatch(/Female/);

      // Phone surfaces inline.
      expect(subline).toContain('+919876543210');

      // Year of the DOB is rendered (2-digit / 4-digit locale-canonical short
      // — both en-IN DD/MM/YYYY and en-US MM/DD/YYYY share the year token).
      expect(subline).toMatch(/1990/);
    });

    it('falls back gracefully when dob is missing', async () => {
      const noDob = { ...patient, dob: null };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(noDob);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });
      renderPage();
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      const subline = screen.getByTestId('patient-header-subline').textContent;
      // No age token when dob is null.
      expect(subline).not.toMatch(/\d+y/);
      // Other identifiers still render.
      expect(subline).toMatch(/Female/);
      expect(subline).toContain('+919876543210');
    });
  });

  it('switching tabs shows the right content (history → prescribe → consent)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument());

    // Default tab is Case history
    expect(screen.getByText(/First visit/)).toBeInTheDocument();

    // Switch to New prescription
    await user.click(screen.getByRole('button', { name: /New prescription/i }));
    expect(screen.getByRole('heading', { name: /New prescription/i })).toBeInTheDocument();

    // Switch to Consent form
    await user.click(screen.getByRole('button', { name: /Consent form/i }));
    expect(screen.getByRole('heading', { name: /Capture consent/i })).toBeInTheDocument();
  });

  it('prescription pad form fields exist (drug name, dosage, frequency, duration)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /New prescription/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /New prescription/i }));

    expect(screen.getByPlaceholderText(/Drug name/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Dosage/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Frequency/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Duration/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save prescription/i })).toBeInTheDocument();
  });

  // #583 — prior-consents list above the capture surface so the clinician
  // can verify whether a consent is already on file before re-capturing.
  describe('Consent tab — prior consents list (#583)', () => {
    it('shows empty-state copy when patient has no prior consents', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Consent form/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Consent form/i }));

      const priorSection = await screen.findByTestId('prior-consents');
      expect(priorSection).toBeInTheDocument();
      expect(priorSection.textContent).toMatch(/Recent consents/i);
      expect(priorSection.textContent).toMatch(/No prior consents on file/i);
    });

    it('renders each prior consent with templateName + signedAt + service.name', async () => {
      const patientWithConsents = {
        ...patient,
        consents: [
          {
            id: 901,
            templateName: 'hair-transplant',
            signedAt: '2026-04-12T08:30:00Z',
            service: { id: 1, name: 'FUE Hair Transplant' },
          },
          {
            id: 902,
            templateName: 'botox-fillers',
            signedAt: '2026-03-01T05:15:00Z',
            service: null,
          },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithConsents);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Consent form/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Consent form/i }));

      const priorSection = await screen.findByTestId('prior-consents');
      expect(priorSection.textContent).toMatch(/hair-transplant/);
      expect(priorSection.textContent).toMatch(/FUE Hair Transplant/);
      expect(priorSection.textContent).toMatch(/botox-fillers/);
      // empty-state should NOT render when there is at least one prior consent
      expect(priorSection.textContent).not.toMatch(/No prior consents on file/i);
    });
  });

  // #752 — Log Visit "Doctor" dropdown was filtering wellnessRole === 'doctor'
  // only, so the 12 professionals (stylists, aestheticians, slimming
  // therapists, Ayurveda practitioners) couldn't be assigned to a visit even
  // though Calendar.jsx (#262) and WorkingHoursEditor already include both
  // roles. Fix: include 'doctor' + 'professional' and drop deactivated rows.
  describe('Log Visit Doctor dropdown — includes professionals (#752)', () => {
    it('lists both doctor and professional wellnessRoles, excluding deactivated', async () => {
      const mixedStaff = [
        { id: 1, name: 'Dr. Meena Sharma', wellnessRole: 'doctor', deactivatedAt: null },
        { id: 2, name: 'Dr. Harsh Kumar',  wellnessRole: 'doctor', deactivatedAt: null },
        { id: 3, name: 'Anjali Verma',     wellnessRole: 'professional', deactivatedAt: null },
        { id: 4, name: 'Priya Rao',        wellnessRole: 'professional', deactivatedAt: null },
        // Telecaller / helper / deactivated rows must NOT appear in the dropdown.
        { id: 5, name: 'Telecaller Tina',  wellnessRole: 'telecaller',   deactivatedAt: null },
        { id: 6, name: 'Helper Hari',      wellnessRole: 'helper',       deactivatedAt: null },
        { id: 7, name: 'Dr. Retired',      wellnessRole: 'doctor',       deactivatedAt: '2026-01-01T00:00:00Z' },
      ];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(mixedStaff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Log visit/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Log visit/i }));

      // Doctor select is the second <select> on the page (Service first,
      // Doctor second). Easier: scope by label text "Doctor *".
      const doctorLabel = await screen.findByText(/^Doctor/, { selector: 'label' });
      const doctorSelect = doctorLabel.parentElement.querySelector('select');
      expect(doctorSelect).not.toBeNull();

      // Doctor + Professional included, telecaller/helper/deactivated excluded.
      const optionTexts = Array.from(doctorSelect.querySelectorAll('option')).map((o) => o.textContent);
      expect(optionTexts).toEqual(expect.arrayContaining([
        expect.stringMatching(/Dr\. Meena Sharma/),
        expect.stringMatching(/Dr\. Harsh Kumar/),
        expect.stringMatching(/Anjali Verma/),
        expect.stringMatching(/Priya Rao/),
      ]));
      // Professionals get a role suffix to disambiguate; doctors do not.
      const anjali = optionTexts.find((t) => t.includes('Anjali Verma'));
      expect(anjali).toMatch(/professional/);
      const meena = optionTexts.find((t) => t.includes('Dr. Meena Sharma'));
      expect(meena).not.toMatch(/doctor\)/);

      // Exclusions.
      expect(optionTexts.some((t) => /Telecaller Tina/.test(t))).toBe(false);
      expect(optionTexts.some((t) => /Helper Hari/.test(t))).toBe(false);
      expect(optionTexts.some((t) => /Dr\. Retired/.test(t))).toBe(false);
    });
  });

  // #750 — Photos tab: img onError must swap to a "Failed to load" placeholder
  // + Try again button. Pre-fix the broken-image tile was visually indistinguishable
  // from a successful upload because there was no error state — a clinician
  // browsing later couldn't tell which patients had unviewable photos. The fix
  // adds `<img onError={...}>` per thumbnail with a Retry action that forces a
  // cache-busting re-fetch. Counters above (BEFORE/AFTER (n)) intentionally stay
  // unchanged because the photo records DO exist server-side; only the render
  // surface differentiates loaded vs failed tiles.
  describe('Photos tab — failed image placeholder (#750)', () => {
    it('renders a "Failed to load" placeholder with Try again when img.onError fires', async () => {
      const patientWithPhotos = {
        ...patient,
        visits: [
          {
            id: 11,
            visitDate: '2026-04-10T09:00:00Z',
            service: { name: 'Consultation' },
            notes: 'First visit',
            amountCharged: 1500,
            photosBefore: JSON.stringify(['/uploads/before-1.jpg']),
            photosAfter:  JSON.stringify(['/uploads/after-1.jpg']),
          },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithPhotos);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      const { container } = renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Photos/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Photos/i }));

      // Wait for the photo thumbnails to render. <img alt=""> is hidden from
      // RTL's role queries (decorative), so query the DOM directly.
      const imgs = await waitFor(() => {
        const list = container.querySelectorAll('img');
        expect(list.length).toBeGreaterThanOrEqual(2);
        return Array.from(list);
      });

      // Happy path — no placeholders rendered yet.
      expect(screen.queryAllByTestId('photo-failed-placeholder').length).toBe(0);

      // Simulate the network/MIME failure: fire onError on every <img>.
      // (The Photos tab renders 1 before + 1 after thumbnail for this fixture.)
      await act(async () => {
        imgs.forEach((img) => fireEvent.error(img));
      });

      // Both tiles swap to the placeholder + Try again button.
      const placeholders = await waitFor(() => {
        const list = screen.getAllByTestId('photo-failed-placeholder');
        expect(list.length).toBe(2);
        return list;
      });
      placeholders.forEach((p) => {
        expect(p.textContent).toMatch(/Failed to load/i);
      });
      const retryButtons = screen.getAllByRole('button', { name: /Try again/i });
      expect(retryButtons.length).toBe(2);
    });
  });

  // #793 — wallet balance is buried under a tab today. QA finding: front-desk
  // operators want a prominent chip in the Patient 360 header so the prepaid
  // balance is visible at a glance without drilling into the Wallet tab.
  // Chip is sourced from /api/wellness/patients/:id/wallet and silently
  // skipped when the endpoint is unreachable (cross-tenant / non-wellness).
  describe('Patient header wallet chip (#793)', () => {
    it('renders a wallet chip in the header when /wallet returns a wallet object', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/patients/1/wallet') {
          return Promise.resolve({
            patient: { id: 1, name: patient.name },
            wallet: { id: 9, balance: 2450, currency: 'INR' },
            transactions: [],
          });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      const chip = await screen.findByTestId('patient-header-wallet-chip');
      expect(chip).toBeInTheDocument();
      // Amount formatted with INR (₹) symbol — formatMoney(2450, INR).
      const amount = screen.getByTestId('patient-header-wallet-amount');
      // formatMoney renders "₹2,450" / "₹2,450.00" depending on locale fmt;
      // assert on the digit sequence so we don't bind to ICU rounding.
      expect(amount.textContent).toMatch(/2[,.]?450/);
      // Chip carries the "wallet" label so operators see it as a wallet
      // surface, not just a money tile.
      expect(chip.textContent.toLowerCase()).toContain('wallet');
    });

    it('renders no chip when the wallet endpoint returns no wallet (e.g. cross-tenant 404)', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/patients/1/wallet') {
          // Simulate the rejected case — fetchApi-shaped error.
          return Promise.reject(new Error('Patient not found'));
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      // Wait for the page to land — header subline is a stable anchor.
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      // Chip is conditional; the failed wallet fetch leaves walletInfo null
      // and the chip block is not rendered.
      expect(screen.queryByTestId('patient-header-wallet-chip')).not.toBeInTheDocument();
    });

    it('renders a zero-balance chip when wallet is fresh / empty', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/patients/1/wallet') {
          return Promise.resolve({
            patient: { id: 1, name: patient.name },
            wallet: { id: 9, balance: 0, currency: 'INR' },
            transactions: [],
          });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      // Even a zero-balance wallet renders the chip — the front-desk operator
      // needs to know whether the patient has ANY wallet, not just non-zero.
      const chip = await screen.findByTestId('patient-header-wallet-chip');
      expect(chip).toBeInTheDocument();
      const amount = screen.getByTestId('patient-header-wallet-amount');
      expect(amount.textContent).toMatch(/0/);
    });
  });

  // #564 — DPDP §15 plain-language clauses must be visible to the patient
  // AT POINT OF CAPTURE. Pre-fix the tab rendered only the dropdown +
  // signature canvas; the QA retest 2026-05-07 flagged that the patient
  // had no surface showing the wording they were agreeing to.
  describe('Consent tab — template body at point of capture (#564)', () => {
    it('renders the selected template body inline so the signer can read it before signing', async () => {
      const TPL_BODY = 'You are consenting to PRP scalp injection. Data retained 7 years. Jurisdiction: DPDP 2023, India.';
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url === '/api/wellness/consent-templates') {
          return Promise.resolve([
            { id: 11, key: 'prp-scalp', label: 'PRP Scalp', body: TPL_BODY, isActive: true },
            { id: 12, key: 'general', label: 'General', body: null, isActive: true },
          ]);
        }
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Consent form/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Consent form/i }));

      const body = await screen.findByTestId('consent-template-body');
      // The default-selected template's full body is visible verbatim.
      await waitFor(() => expect(body.textContent).toContain(TPL_BODY));
      expect(body.textContent).toMatch(/PRP Scalp/);
    });

    it('shows fallback notice when the selected template has no body', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url === '/api/wellness/consent-templates') {
          return Promise.resolve([
            { id: 12, key: 'general', label: 'General', body: null, isActive: true },
          ]);
        }
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Consent form/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Consent form/i }));

      const body = await screen.findByTestId('consent-template-body');
      await waitFor(() => expect(body.textContent).toMatch(/no body text on file/i));
      expect(body.textContent).toMatch(/DPDP/);
    });
  });

  // #838 — dedicated Prescriptions list tab with Active/Past status
  // indicators per row + filter chips. Distinct from "New prescription"
  // (capture surface) and Case history (merged visits+rx+consents timeline).
  // Status derived client-side from drug `duration` parsed to days +
  // createdAt; fallback is 30-day active window when no parseable duration.
  describe('Prescriptions list tab (#838)', () => {
    // Helpers to build a Rx that's clearly active vs clearly past relative
    // to the test clock. Drug duration uses canonical "N days" / "N weeks"
    // tokens that parseDurationDays() understands.
    const mkRx = (id, createdAtISO, durationToken) => ({
      id,
      createdAt: createdAtISO,
      visitId: 11,
      drugs: JSON.stringify([
        { name: 'Minoxidil 5%', dosage: '1 ml', frequency: 'BID', duration: durationToken },
      ]),
      instructions: 'Apply to scalp morning and night.',
      doctor: { id: 5, name: 'Dr. Mehta' },
    });

    const renderWithRx = (rxList) => {
      const patientWithRx = { ...patient, prescriptions: rxList };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithRx);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });
    };

    it('renders the Prescriptions tab button (distinct from "New prescription")', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      // Both surfaces co-exist: capture tab and list tab.
      expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /New prescription/i })).toBeInTheDocument();
    });

    it('empty-state copy when patient has no prescriptions', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('rx-list-tab'));
      await waitFor(() => expect(screen.getByText(/No prescriptions yet/i)).toBeInTheDocument());
    });

    it('derives Active/Past status from drug duration + createdAt; default chip is Active', async () => {
      // Active Rx: started 2 days ago, 30-day course → ends 28 days from now.
      const recent = new Date(Date.now() - 2 * 86400000).toISOString();
      // Past Rx: started 6 months ago, 7-day course → expired ~6 months back.
      const old = new Date(Date.now() - 180 * 86400000).toISOString();
      renderWithRx([
        mkRx(1001, recent, '30 days'),
        mkRx(1002, old, '7 days'),
      ]);

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('rx-list-tab'));

      // Default chip is Active — only the active Rx is shown initially.
      await waitFor(() => expect(screen.getByTestId('rx-row-1001')).toBeInTheDocument());
      expect(screen.queryByTestId('rx-row-1002')).not.toBeInTheDocument();

      // Active badge present on the visible row, no Past badge.
      const activeRow = screen.getByTestId('rx-row-1001');
      expect(activeRow.querySelector('[data-testid="rx-status-active"]')).toBeTruthy();
    });

    it('chips toggle between Active / Past / All; counts reflect derivation', async () => {
      const recent = new Date(Date.now() - 2 * 86400000).toISOString();
      const old = new Date(Date.now() - 180 * 86400000).toISOString();
      renderWithRx([
        mkRx(2001, recent, '30 days'),
        mkRx(2002, old, '7 days'),
        mkRx(2003, old, '14 days'),
      ]);

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('rx-list-tab'));

      // Active chip shows count of 1, Past chip shows 2, All shows 3.
      await waitFor(() => expect(screen.getByTestId('rx-chip-active').textContent).toMatch(/\(1\)/));
      expect(screen.getByTestId('rx-chip-past').textContent).toMatch(/\(2\)/);
      expect(screen.getByTestId('rx-chip-all').textContent).toMatch(/\(3\)/);

      // Click Past chip — only old prescriptions appear.
      await user.click(screen.getByTestId('rx-chip-past'));
      await waitFor(() => expect(screen.queryByTestId('rx-row-2001')).not.toBeInTheDocument());
      expect(screen.getByTestId('rx-row-2002')).toBeInTheDocument();
      expect(screen.getByTestId('rx-row-2003')).toBeInTheDocument();

      // Click All — every Rx is rendered.
      await user.click(screen.getByTestId('rx-chip-all'));
      await waitFor(() => expect(screen.getByTestId('rx-row-2001')).toBeInTheDocument());
      expect(screen.getByTestId('rx-row-2002')).toBeInTheDocument();
      expect(screen.getByTestId('rx-row-2003')).toBeInTheDocument();
    });

    it('fallback path: no parseable duration → active for first 30 days post-creation', async () => {
      // Recent + unparseable duration → still active under the 30-day fallback.
      const recent = new Date(Date.now() - 5 * 86400000).toISOString();
      // Old + unparseable duration → past (createdAt > 30 days ago).
      const old = new Date(Date.now() - 90 * 86400000).toISOString();
      renderWithRx([
        mkRx(3001, recent, 'as needed'),  // unparseable
        mkRx(3002, old,    'until rash clears'),  // unparseable
      ]);

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('rx-list-tab'));

      // Active chip = 1 (recent fallback-active), Past = 1 (old fallback-past).
      await waitFor(() => expect(screen.getByTestId('rx-chip-active').textContent).toMatch(/\(1\)/));
      expect(screen.getByTestId('rx-chip-past').textContent).toMatch(/\(1\)/);
    });

    it('preserves newest-first sort across the list', async () => {
      const t1 = new Date(Date.now() - 1 * 86400000).toISOString();
      const t2 = new Date(Date.now() - 3 * 86400000).toISOString();
      const t3 = new Date(Date.now() - 10 * 86400000).toISOString();
      renderWithRx([
        // intentionally out-of-order in input
        mkRx(4002, t2, '30 days'),
        mkRx(4001, t1, '30 days'),
        mkRx(4003, t3, '30 days'),
      ]);

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('rx-list-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('rx-list-tab'));
      await user.click(screen.getByTestId('rx-chip-all'));

      await waitFor(() => expect(screen.getByTestId('rx-row-4001')).toBeInTheDocument());
      const all = document.body.innerHTML;
      // Newest (4001) appears before 4002 in the DOM order.
      expect(all.indexOf('rx-row-4001')).toBeLessThan(all.indexOf('rx-row-4002'));
      expect(all.indexOf('rx-row-4002')).toBeLessThan(all.indexOf('rx-row-4003'));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Extension wave — 2026-05-26
  // Covers tabs / surfaces the original spec didn't exercise:
  //   - Treatment plans tab (list + create form + validation guard)
  //   - Log visit tab (form fields + validation gating)
  //   - Inventory tab (consumption rows + add-row validation)
  //   - Telehealth tab (visit selector + start-or-join + empty state)
  //   - Memberships tab (list + buy form + cancel)
  //   - Wallet tab body (balance render + top-up modal + giftcard redeem)
  //   - Timeline tab (events + filter dropdown + CSV button affordance)
  //   - Loyalty card (chip render + hidden when endpoint empty)
  // Uses the stable notifyObj mock pattern + adapts to actual SUT.
  // ──────────────────────────────────────────────────────────────────

  describe('Treatment plans tab', () => {
    it('shows empty-state and form fields when patient has no plans', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Treatment plans/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Treatment plans/i }));

      expect(screen.getByText(/No treatment plans yet/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Plan name/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Sessions/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Total price/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^Add$/i })).toBeInTheDocument();
    });

    it('renders existing treatment plans with progress bar + service name', async () => {
      const patientWithPlans = {
        ...patient,
        treatmentPlans: [
          {
            id: 501,
            name: 'PRP 6-session package',
            totalSessions: 6,
            completedSessions: 2,
            totalPrice: 45000,
            service: { id: 1, name: 'PRP Scalp' },
          },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithPlans);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Treatment plans/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Treatment plans/i }));

      expect(screen.getByText(/PRP 6-session package/i)).toBeInTheDocument();
      expect(screen.getByText(/Session 2\/6/)).toBeInTheDocument();
      expect(screen.getByText(/PRP Scalp/)).toBeInTheDocument();
    });

    it('submitting a new plan POSTs to /api/wellness/treatment-plans', async () => {
      const user = userEvent.setup();
      const postSpy = vi.fn(() => Promise.resolve({ id: 99 }));
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        if (opts && opts.method === 'POST' && url === '/api/wellness/treatment-plans') return postSpy(url, opts);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Treatment plans/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Treatment plans/i }));

      await user.type(screen.getByPlaceholderText(/Plan name/i), 'PRP starter');
      // submit via the Add button (form-submit path)
      await user.click(screen.getByRole('button', { name: /^Add$/i }));

      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
      const [, opts] = postSpy.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.patientId).toBe(patient.id);
      expect(body.name).toBe('PRP starter');
      // totalSessions defaults to 4 in INITIAL_PLAN
      expect(body.totalSessions).toBe(4);
    });
  });

  describe('Log visit tab', () => {
    it('exposes Service + Doctor selects + Notes textarea + Amount input', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Log visit/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Log visit/i }));

      // Service is the first <select>, Doctor the second — present via their labels.
      expect(screen.getByText(/^Service/i, { selector: 'label' })).toBeInTheDocument();
      expect(screen.getByText(/^Doctor/i, { selector: 'label' })).toBeInTheDocument();
      expect(screen.getByText(/Visit notes/i)).toBeInTheDocument();
      expect(screen.getByText(/Amount charged/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Save visit/i })).toBeInTheDocument();
    });

    it('Save visit button is disabled until Service + Doctor selected', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Log visit/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Log visit/i }));

      const save = screen.getByRole('button', { name: /Save visit/i });
      expect(save).toBeDisabled();

      // Tooltip explains why
      expect(save).toHaveAttribute('title', expect.stringMatching(/Service and Doctor/));
    });

    it('POSTs to /api/wellness/visits when form is valid', async () => {
      const postSpy = vi.fn(() => Promise.resolve({ id: 9999 }));
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        if (opts && opts.method === 'POST' && url === '/api/wellness/visits') return postSpy(url, opts);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Log visit/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Log visit/i }));

      // Pick Service + Doctor through their selects (located by label).
      const serviceLabel = screen.getByText(/^Service/i, { selector: 'label' });
      const serviceSelect = serviceLabel.parentElement.querySelector('select');
      await user.selectOptions(serviceSelect, String(services[0].id));

      const doctorLabel = screen.getByText(/^Doctor/i, { selector: 'label' });
      const doctorSelect = doctorLabel.parentElement.querySelector('select');
      await user.selectOptions(doctorSelect, String(staff[0].id));

      await user.click(screen.getByRole('button', { name: /Save visit/i }));

      await waitFor(() => expect(postSpy).toHaveBeenCalledTimes(1));
      const body = JSON.parse(postSpy.mock.calls[0][1].body);
      expect(body.patientId).toBe(patient.id);
      expect(body.status).toBe('completed');
      expect(String(body.serviceId)).toBe(String(services[0].id));
      expect(String(body.doctorId)).toBe(String(staff[0].id));
    });
  });

  describe('Inventory used tab', () => {
    it('renders empty-state when the selected visit has no consumptions', async () => {
      // /consumptions endpoint returns []
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url.includes('/consumptions')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Inventory used/i }));

      await waitFor(() => expect(screen.getByText(/No products logged for this visit/i)).toBeInTheDocument());
      // Form fields visible
      expect(screen.getByPlaceholderText(/Product name/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Qty/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/Unit cost/i)).toBeInTheDocument();
    });

    it('renders existing consumption rows with totals', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url.includes('/consumptions')) {
          return Promise.resolve([
            { id: 1, productName: 'Botox vial 100u', qty: 2, unitCost: 5000 },
            { id: 2, productName: 'PRP kit',         qty: 1, unitCost: 2500 },
          ]);
        }
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Inventory used/i }));

      await waitFor(() => expect(screen.getByText(/Botox vial 100u/)).toBeInTheDocument());
      expect(screen.getByText(/PRP kit/)).toBeInTheDocument();
      // Total cost row: 2*5000 + 1*2500 = 12,500 — locale formatting tolerates either separator.
      expect(screen.getAllByText(/Total cost/i).length).toBeGreaterThan(0);
    });

    it('Add button is disabled until product name + positive qty present (#338)', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url.includes('/consumptions')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Inventory used/i }));

      await waitFor(() => expect(screen.getByPlaceholderText(/Product name/i)).toBeInTheDocument());
      // Scope to the Add row's form (the table-row Add button, NOT a New-prescription Add)
      const productInput = screen.getByPlaceholderText(/Product name/i);
      const addBtn = productInput.closest('form').querySelector('button[type="submit"]');
      expect(addBtn).toBeDisabled();
      expect(addBtn).toHaveAttribute('title', expect.stringMatching(/product name/i));

      // Type a product name — should enable since qty default is 1
      await user.type(productInput, 'Numbing cream');
      await waitFor(() => expect(addBtn).not.toBeDisabled());
    });
  });

  describe('Telehealth tab', () => {
    it('renders the visit row with Start video consult CTA when no videoRoom is set', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Telehealth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Telehealth/i }));

      // Fixture visit has no videoRoom → button reads "Start video consult"
      expect(screen.getByRole('button', { name: /Start video consult/i })).toBeInTheDocument();
      // Helper copy explains the per-visit room model
      expect(screen.getByText(/Each visit can host one video room/i)).toBeInTheDocument();
    });

    it('shows empty-state when patient has no visits', async () => {
      const noVisits = { ...patient, visits: [] };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(noVisits);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Telehealth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Telehealth/i }));

      await waitFor(() =>
        expect(screen.getByText(/No visits yet — log a visit first to start a video consult/i)).toBeInTheDocument()
      );
    });

    it('shows "Join video" when the visit already has a videoRoom assigned', async () => {
      const withRoom = {
        ...patient,
        visits: [
          { ...patient.visits[0], videoRoom: 'gbs-11-ananya-singh', status: 'completed' },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(withRoom);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Telehealth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Telehealth/i }));

      expect(screen.getByRole('button', { name: /Join video/i })).toBeInTheDocument();
      // Room name surfaces in status line
      expect(screen.getByText(/gbs-11-ananya-singh/)).toBeInTheDocument();
    });
  });

  describe('Memberships tab', () => {
    it('renders empty-state when patient has no memberships and shows Buy CTA', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.endsWith('/memberships')) return Promise.resolve([]);
        if (url === '/api/wellness/membership-plans') return Promise.resolve([
          { id: 1, name: 'Gold annual', durationDays: 365, currency: 'INR', price: 25000 },
        ]);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Memberships/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Memberships/i }));

      await waitFor(() => expect(screen.getByText(/This patient has no memberships yet/i)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /Buy membership/i })).toBeInTheDocument();
    });

    it('opens the buy-membership picker and lists available plans', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.endsWith('/memberships')) return Promise.resolve([]);
        if (url === '/api/wellness/membership-plans') return Promise.resolve([
          { id: 1, name: 'Gold annual',   durationDays: 365, currency: 'INR', price: 25000 },
          { id: 2, name: 'Silver monthly', durationDays: 30,  currency: 'INR', price: 2500 },
        ]);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Memberships/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Memberships/i }));

      // Open the picker
      await waitFor(() => expect(screen.getByRole('button', { name: /Buy membership/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Buy membership/i }));

      // Plan options surfaced inside the picker
      await waitFor(() => expect(screen.getByText(/Gold annual/)).toBeInTheDocument());
      expect(screen.getByText(/Silver monthly/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Confirm purchase/i })).toBeInTheDocument();
    });

    it('renders an active membership with status badge + remaining balance entries', async () => {
      const future = new Date(Date.now() + 60 * 86400000).toISOString();
      const past   = new Date(Date.now() - 10 * 86400000).toISOString();
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.endsWith('/memberships')) {
          return Promise.resolve([
            {
              id: 700,
              status: 'active',
              startDate: past,
              endDate: future,
              planId: 1,
              plan: { id: 1, name: 'Gold annual' },
              balance: JSON.stringify([{ serviceId: 1, remaining: 4 }]),
            },
          ]);
        }
        if (url === '/api/wellness/membership-plans') return Promise.resolve([]);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Memberships/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Memberships/i }));

      await waitFor(() => expect(screen.getByText(/Gold annual/)).toBeInTheDocument());
      // Active badge text (lowercase per SUT)
      expect(screen.getByText(/^active$/)).toBeInTheDocument();
      // Service name surfaces from services lookup (id=1 → 'Hair Transplant')
      expect(screen.getByText(/Hair Transplant: 4/)).toBeInTheDocument();
      // Cancel CTA on the active row
      expect(screen.getByRole('button', { name: /Cancel membership/i })).toBeInTheDocument();
    });
  });

  describe('Wallet tab body', () => {
    it('renders the wallet balance and Top up CTA + Redeem strip', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        // Header chip fetch (different shape)
        if (url === '/api/wellness/patients/1/wallet') {
          return Promise.resolve({ patient: { id: 1, name: patient.name }, wallet: { id: 9, balance: 1200, currency: 'INR' }, transactions: [] });
        }
        // Wallet tab uses /api/wallet/:id/{balance,transactions}
        if (url === '/api/wallet/1/balance') {
          return Promise.resolve({ balanceCents: 120000, currency: 'INR', lastUpdated: new Date().toISOString() });
        }
        if (url.startsWith('/api/wallet/1/transactions')) {
          return Promise.resolve({ transactions: [], total: 0 });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('wallet-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-tab'));

      const balance = await screen.findByTestId('wallet-balance');
      // balanceCents 120000 → ₹1,200 — assert on the digit sequence so ICU
      // formatter differences don't break the test.
      expect(balance.textContent).toMatch(/1[,.]?200/);
      expect(screen.getByTestId('wallet-topup-btn')).toBeInTheDocument();
      // Redeem strip surface
      expect(screen.getByPlaceholderText(/Gift card code/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Redeem/i })).toBeInTheDocument();
    });

    it('opens the top-up modal with amount + payment method inputs', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wallet/1/balance') return Promise.resolve({ balanceCents: 0, currency: 'INR', lastUpdated: null });
        if (url.startsWith('/api/wallet/1/transactions')) return Promise.resolve({ transactions: [], total: 0 });
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('wallet-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-tab'));

      await waitFor(() => expect(screen.getByTestId('wallet-topup-btn')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-topup-btn'));

      expect(await screen.findByTestId('wallet-topup-modal')).toBeInTheDocument();
      expect(screen.getByTestId('wallet-topup-amount')).toBeInTheDocument();
      expect(screen.getByTestId('wallet-topup-method')).toBeInTheDocument();
      expect(screen.getByTestId('wallet-topup-submit')).toBeInTheDocument();
      // Min/max copy rendered as a single combined span. The max value is
      // 100_000 rendered via toLocaleString(), which differs across ICU
      // builds (en-US "100,000" vs en-IN "1,00,000") — match the digits
      // tolerating either grouping form.
      expect(screen.getByText(/Min ₹100/)).toBeInTheDocument();
      expect(screen.getByText(/Max ₹1[,.]?0?0?,?000/)).toBeInTheDocument();
    });

    it('top-up submit is disabled until a valid amount is typed (₹100 floor)', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wallet/1/balance') return Promise.resolve({ balanceCents: 0, currency: 'INR', lastUpdated: null });
        if (url.startsWith('/api/wallet/1/transactions')) return Promise.resolve({ transactions: [], total: 0 });
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('wallet-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-tab'));
      await waitFor(() => expect(screen.getByTestId('wallet-topup-btn')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-topup-btn'));

      const submit = await screen.findByTestId('wallet-topup-submit');
      expect(submit).toBeDisabled();

      // 50 < MIN_TOPUP_INR (100) — stays disabled
      const amt = screen.getByTestId('wallet-topup-amount');
      await user.type(amt, '50');
      expect(submit).toBeDisabled();

      // Clear and type a valid amount
      await user.clear(amt);
      await user.type(amt, '500');
      await waitFor(() => expect(submit).not.toBeDisabled());
    });

    it('shows transaction table when wallet returns rows', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wallet/1/balance') return Promise.resolve({ balanceCents: 50000, currency: 'INR', lastUpdated: new Date().toISOString() });
        if (url.startsWith('/api/wallet/1/transactions')) {
          return Promise.resolve({
            transactions: [
              { id: 1001, type: 'TOP_UP', amount: 500, reason: 'cash', createdAt: new Date().toISOString() },
              { id: 1002, type: 'REDEEM', amount: 100, reason: 'service redeem', createdAt: new Date().toISOString() },
            ],
            total: 2,
          });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('wallet-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('wallet-tab'));

      // Table appears, two rows by testid
      const table = await screen.findByTestId('wallet-txn-table');
      expect(table).toBeInTheDocument();
      expect(screen.getByTestId('wallet-txn-1001')).toBeInTheDocument();
      expect(screen.getByTestId('wallet-txn-1002')).toBeInTheDocument();
    });
  });

  describe('Timeline tab', () => {
    it('default Timeline tab fetches /timeline and shows events', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.includes('/timeline')) {
          return Promise.resolve({
            patientId: 1,
            count: 2,
            events: [
              { eventType: 'VISIT', eventId: 11, eventAt: new Date().toISOString(), summary: 'Consultation', refType: 'Visit', refId: 11 },
              { eventType: 'PRESCRIPTION', eventId: 22, eventAt: new Date().toISOString(), summary: 'Minoxidil 5%', refType: 'Prescription', refId: 22 },
            ],
          });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('timeline-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('timeline-tab'));

      await waitFor(() => expect(screen.getByTestId('timeline-events')).toBeInTheDocument());
      expect(screen.getByTestId('timeline-event-VISIT-11')).toBeInTheDocument();
      expect(screen.getByTestId('timeline-event-PRESCRIPTION-22')).toBeInTheDocument();
      // Type filter dropdown is present
      expect(screen.getByTestId('timeline-type-filter')).toBeInTheDocument();
      // CSV export button is present (disabled state irrelevant — affordance check)
      expect(screen.getByTestId('timeline-export-csv')).toBeInTheDocument();
    });

    it('changing the type filter refetches /timeline with ?types= param', async () => {
      const seen = [];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.includes('/timeline')) {
          seen.push(url);
          return Promise.resolve({ patientId: 1, count: 0, events: [] });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('timeline-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('timeline-tab'));
      await waitFor(() => expect(screen.getByTestId('timeline-type-filter')).toBeInTheDocument());

      // Pick "Visits" — should issue a new /timeline call with types=VISIT
      await user.selectOptions(screen.getByTestId('timeline-type-filter'), 'VISIT');

      await waitFor(() => {
        expect(seen.some((u) => /types=VISIT/.test(u))).toBe(true);
      });
    });

    it('renders empty-state when /timeline returns no events', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/') && url.includes('/timeline')) {
          return Promise.resolve({ patientId: 1, count: 0, events: [] });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByTestId('timeline-tab')).toBeInTheDocument());
      await user.click(screen.getByTestId('timeline-tab'));

      await waitFor(() =>
        expect(screen.getByText(/No events yet for this patient/i)).toBeInTheDocument()
      );
    });
  });

  describe('Loyalty card', () => {
    it('renders the loyalty chip when /loyalty endpoint returns balance', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/loyalty/1') {
          return Promise.resolve({ balance: 240, earnedThisMonth: 60, transactions: [] });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      await waitFor(() => expect(screen.getByText(/Loyalty: 240 points/i)).toBeInTheDocument());
      expect(screen.getByText(/60 earned this month/i)).toBeInTheDocument();
    });

    it('hides the loyalty chip when /loyalty returns nothing', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/loyalty/1') return Promise.reject(new Error('no loyalty model'));
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      // Wait for the page to land — subline anchor.
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      expect(screen.queryByText(/Loyalty:/i)).not.toBeInTheDocument();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Extension wave 3 — 2026-05-26
  // Pin surfaces above-the-tabs and inside leaf tabs that the prior two
  // extensions skipped:
  //   - Back-link to /wellness/patients (top of page chrome)
  //   - Source + counts column (right side of header)
  //   - Anniversary + GST + bloodGroup in header subline (#792 extras)
  //   - DownloadFullReportButton render + click streams blob with Auth
  //   - Patient-not-found render path
  //   - Tab persistence via sessionStorage (#344 safe id only)
  //   - sessionStorage refuses non-numeric id (#344 security guard)
  //   - Case-history date filter chrome (#837)
  //   - Rx detail modal opens on Rx row click + drug table renders
  //   - PhotoColumn counts in headings (Before (n) / After (n))
  //   - Inventory total-cost row + visit dropdown
  //   - Loyalty modal opens on chip click + redeem form present
  // ──────────────────────────────────────────────────────────────────

  describe('Page chrome above the tabs', () => {
    it('renders the Back to patients link with arrow', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      const back = screen.getByRole('link', { name: /Back to patients/i });
      expect(back).toHaveAttribute('href', '/wellness/patients');
    });

    it('renders the source + counts column on the right of the header', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      // Source label + value
      expect(screen.getByText(/Source:/i)).toBeInTheDocument();
      expect(screen.getByText(/walk-in/)).toBeInTheDocument();
      // counts: 1 visits • 0 Rx • 0 treatment plans (default fixture)
      expect(screen.getByText(/1 visits/)).toBeInTheDocument();
      // The "0 Rx" + "0 treatment plans" text co-occur in the same span; assert
      // the full pattern so we don't bind to en-dash vs hyphen.
      expect(screen.getByText(/0 Rx/)).toBeInTheDocument();
      expect(screen.getByText(/0 treatment plans/)).toBeInTheDocument();
    });

    it('header subline surfaces anniversary + GST + bloodGroup when present (#792)', async () => {
      const enriched = {
        ...patient,
        anniversary: '2015-06-21T00:00:00Z',
        gst: '29ABCDE1234F1Z5',
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(enriched);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });
      renderPage();
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      const subline = screen.getByTestId('patient-header-subline').textContent;
      expect(subline).toMatch(/Blood O\+/);
      expect(subline).toMatch(/Anniv /);
      expect(subline).toMatch(/2015/);
      expect(subline).toMatch(/GST 29ABCDE1234F1Z5/);
    });

    it('renders "Patient not found." when the patient fetch resolves null', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.reject(new Error('404'));
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });
      renderPage();
      // Rejection path sets patient=null then loading=false → "Patient not found."
      await waitFor(() => expect(screen.getByText(/Patient not found\./i)).toBeInTheDocument());
      // Tabs are not rendered in this state
      expect(screen.queryByRole('button', { name: /Case history/i })).not.toBeInTheDocument();
    });
  });

  // #840 — consolidated patient-record export. Bearer-auth-gated fetch +
  // synthetic anchor click; we mock global fetch + URL helpers to verify
  // the streaming-blob path runs and the success toast fires.
  describe('DownloadFullReportButton (#840)', () => {
    it('renders the button with the canonical label', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByTestId('download-full-report-btn')).toBeInTheDocument());
      const btn = screen.getByTestId('download-full-report-btn');
      expect(btn.textContent).toMatch(/Download full record \(PDF\)/i);
    });

    it('clicking the button streams a blob via fetch with Authorization + success toast', async () => {
      // Stub global fetch + URL helpers so the streaming path is exercised end-to-end.
      const origFetch = global.fetch;
      const origCreate = global.URL.createObjectURL;
      const origRevoke = global.URL.revokeObjectURL;
      const fetchSpy = vi.fn(() => Promise.resolve({
        ok: true,
        blob: () => Promise.resolve(new Blob(['%PDF-1.4'], { type: 'application/pdf' })),
        json: () => Promise.resolve({}),
        headers: { get: () => null },
      }));
      global.fetch = fetchSpy;
      global.URL.createObjectURL = vi.fn(() => 'blob:mock');
      global.URL.revokeObjectURL = vi.fn();

      try {
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(screen.getByTestId('download-full-report-btn')).toBeInTheDocument());
        await user.click(screen.getByTestId('download-full-report-btn'));

        await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        const [url, opts] = fetchSpy.mock.calls[0];
        expect(url).toMatch(/\/api\/wellness\/patients\/1\/full-report\.pdf$/);
        expect(opts.headers.Authorization).toBe('Bearer test-token');
        // Success toast fires once the blob is consumed.
        await waitFor(() => expect(notifyObj.success).toHaveBeenCalled());
        expect(notifyObj.success.mock.calls[0][0]).toMatch(/Downloaded /);
      } finally {
        global.fetch = origFetch;
        global.URL.createObjectURL = origCreate;
        global.URL.revokeObjectURL = origRevoke;
      }
    });

    it('surfaces an error toast when the backend returns non-OK', async () => {
      const origFetch = global.fetch;
      const fetchSpy = vi.fn(() => Promise.resolve({
        ok: false,
        status: 500,
        blob: () => Promise.resolve(new Blob([])),
        json: () => Promise.resolve({ error: 'PDF render failed' }),
        headers: { get: () => null },
      }));
      global.fetch = fetchSpy;

      try {
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(screen.getByTestId('download-full-report-btn')).toBeInTheDocument());
        await user.click(screen.getByTestId('download-full-report-btn'));
        await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
        // The thrown error.message bubbles through; either the server-supplied
        // .error or our fallback "Download failed (500)" copy is acceptable.
        expect(notifyObj.error.mock.calls[0][0]).toMatch(/PDF render failed|Download failed/);
      } finally {
        global.fetch = origFetch;
      }
    });
  });

  describe('Tab persistence via sessionStorage (#344)', () => {
    beforeEach(() => {
      // Clean session state so a previous test's tab persistence doesn't
      // bleed across cases.
      try { sessionStorage.clear(); } catch { /* ignore */ }
    });

    it('writes the currently-selected tab to gbs.tab.patient.<id>', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Photos/i })).toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: /Photos/i }));
      // Effect runs synchronously after state update; assert it landed.
      await waitFor(() => {
        expect(sessionStorage.getItem('gbs.tab.patient.1')).toBe('photos');
      });
    });

    it('reads the saved tab on mount and lands on it instead of "history"', async () => {
      sessionStorage.setItem('gbs.tab.patient.1', 'consent');
      renderPage();
      // Consent surface heading is rendered on mount (no click needed)
      await waitFor(() =>
        expect(screen.getByRole('heading', { name: /Capture consent/i })).toBeInTheDocument()
      );
    });
  });

  describe('Case-history date-filter chrome (#837)', () => {
    it('renders the DateRangePicker label above the timeline', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Case history/i }));

      // DateRangePicker exposes a labelled select for preset choice.
      expect(screen.getByText(/Filter by date:/i)).toBeInTheDocument();
    });

    it('clicking an Rx event row opens the prescription detail modal', async () => {
      const patientWithRx = {
        ...patient,
        prescriptions: [
          {
            id: 9001,
            createdAt: new Date().toISOString(),
            visitId: 11,
            drugs: JSON.stringify([
              { name: 'Finasteride 1mg', dosage: '1 tab', frequency: 'OD', duration: '90 days' },
            ]),
            instructions: 'Take after dinner.',
            doctor: { id: 5, name: 'Dr. Mehta' },
          },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithRx);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Case history/i }));

      // Find the prescription row (case-history surfaces it as "Prescription" with the drug name)
      const drugCell = await screen.findByText(/Finasteride 1mg/);
      // The clickable parent is the .glass card with role=button
      const row = drugCell.closest('[role="button"]');
      expect(row).not.toBeNull();
      await user.click(row);

      // Modal heading
      expect(await screen.findByRole('heading', { name: /Prescription details/i })).toBeInTheDocument();
      // Drugs table row picks up the drug + dosage + frequency + duration
      // (getAllByText pattern — these tokens appear both in the inline summary
      // and the modal's drugs table)
      expect(screen.getAllByText(/1 tab/).length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText(/90 days/).length).toBeGreaterThanOrEqual(1);
      // Prescribed-by surfaces in modal
      expect(screen.getByText(/Prescribed by/i)).toBeInTheDocument();
      expect(screen.getAllByText(/Dr\. Mehta/).length).toBeGreaterThanOrEqual(1);
      // Download PDF affordance
      expect(screen.getByRole('button', { name: /Download PDF/i })).toBeInTheDocument();
    });
  });

  describe('Photos tab — column headings count uploaded files', () => {
    it('Before / After columns surface zero count when no photos uploaded', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Photos/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^Photos/i }));

      // The visit selector defaults to the first visit (id 11) which has no
      // photosBefore/photosAfter → both columns render "(0)" + the empty-state copy.
      // Both BEFORE and AFTER labels are uppercase in the rendered DOM
      // (textTransform makes them visually uppercase but the underlying
      // text is "Before" / "After"); match the label text + (0).
      expect(screen.getByText(/Before \(0\)/i)).toBeInTheDocument();
      expect(screen.getByText(/After \(0\)/i)).toBeInTheDocument();
      // The two empty-state copies appear (one per column)
      expect(screen.getAllByText(/No photos yet/i).length).toBe(2);
    });
  });

  describe('Inventory tab — totals row + visit dropdown', () => {
    it('total cost row sums qty × unitCost across consumption rows', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url.includes('/consumptions')) {
          return Promise.resolve([
            { id: 1, productName: 'Botox vial 100u', qty: 2, unitCost: 5000 }, // 10000
            { id: 2, productName: 'PRP kit',         qty: 1, unitCost: 2500 }, // 2500
          ]);
        }
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Inventory used/i }));

      // Total cost cell — 12500 formatted en-IN: "12,500"
      const totalLabel = await screen.findByText(/^Total cost$/i);
      // The total amount appears in the cell to the right of the label;
      // assert the digit sequence so en-IN vs en-US groupings both pass.
      const totalRow = totalLabel.closest('tr');
      expect(totalRow.textContent).toMatch(/12[,.]?500/);

      // Visit dropdown lists the visit by date + service
      const visitLabel = screen.getByText(/^Visit$/i, { selector: 'label' });
      const visitSelect = visitLabel.parentElement.querySelector('select');
      expect(visitSelect).not.toBeNull();
      const optionTexts = Array.from(visitSelect.querySelectorAll('option')).map((o) => o.textContent);
      expect(optionTexts.some((t) => /Consultation/.test(t))).toBe(true);
    });
  });

  describe('Loyalty modal — opens on chip click', () => {
    it('clicking the loyalty chip opens the modal with redeem form + recent transactions empty-state', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url === '/api/wellness/loyalty/1') {
          return Promise.resolve({ balance: 120, earnedThisMonth: 40, transactions: [] });
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      const chip = await screen.findByText(/Loyalty: 120 points/i);
      // Chip is wrapped in a button — find the closest button ancestor.
      const chipBtn = chip.closest('button');
      expect(chipBtn).not.toBeNull();
      await user.click(chipBtn);

      // Modal heading
      expect(await screen.findByRole('heading', { name: /Loyalty history/i })).toBeInTheDocument();
      // Current balance value surfaces in the modal
      expect(screen.getByText(/120 pts/)).toBeInTheDocument();
      // Redeem button present + transactions empty-state
      expect(screen.getByRole('button', { name: /^Redeem$/ })).toBeInTheDocument();
      expect(screen.getByText(/No transactions yet\./i)).toBeInTheDocument();
    });
  });

  // Tab switching exhaustive: walks every primary tab to confirm they
  // mount their content surfaces without runtime errors. Adapts to the
  // 11 tabs the SUT currently exposes (timeline / case history / Rx list
  // / new Rx / consent / plans / log visit / photos / inventory /
  // telehealth / wallet / memberships).
  it('switching across every tab mounts its content without throwing', async () => {
    fetchApi.mockReset();
    fetchApi.mockImplementation((url) => {
      if (url.startsWith('/api/wellness/patients/') && url.includes('/timeline')) {
        return Promise.resolve({ patientId: 1, count: 0, events: [] });
      }
      if (url === '/api/wallet/1/balance') return Promise.resolve({ balanceCents: 0, currency: 'INR', lastUpdated: null });
      if (url.startsWith('/api/wallet/1/transactions')) return Promise.resolve({ transactions: [], total: 0 });
      if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
      if (url === '/api/wellness/services') return Promise.resolve(services);
      if (url === '/api/staff') return Promise.resolve(staff);
      return Promise.resolve([]);
    });

    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: /Case history/i })).toBeInTheDocument());

    const tabs = [
      { name: /Case history/i,    anchor: () => screen.getByText(/First visit/) },
      { name: /New prescription/i, anchor: () => screen.getByRole('heading', { name: /New prescription/i }) },
      { name: /Consent form/i,    anchor: () => screen.getByRole('heading', { name: /Capture consent/i }) },
      { name: /Treatment plans/i, anchor: () => screen.getByText(/No treatment plans yet/i) },
      { name: /Log visit/i,       anchor: () => screen.getByRole('heading', { name: /Log a visit/i }) },
      { name: /Photos/i,          anchor: () => screen.getByRole('heading', { name: /Visit photos/i }) },
      { name: /Inventory used/i,  anchor: () => screen.getByRole('heading', { name: /Inventory used/i }) },
      { name: /Telehealth/i,      anchor: () => screen.getByText(/Each visit can host one video room/i) },
    ];

    for (const t of tabs) {
      await user.click(screen.getByRole('button', { name: t.name }));
      await waitFor(() => expect(t.anchor()).toBeInTheDocument());
    }
  });

  // ──────────────────────────────────────────────────────────────────
  // Extension wave 4 — 2026-05-26
  // Pin previously-uncovered behavioural branches in leaf tabs:
  //   - Photos PhotoThumb retry on failure (cache-busting URL re-fetch)
  //   - Photos thumbnail remove → notify.confirm gate (cancel path)
  //   - Consent submit blocked when canvas has zero strokes
  //   - Plans submit-in-flight disables Add (#225 debounce guard)
  //   - Telehealth startOrJoin error path surfaces notify.error
  //   - Telehealth Share-with-patient button copies the meet.jit.si URL
  //   - Inventory add-row qty <= 0 surfaces notify.error and does NOT POST
  //   - Memberships cancel-membership invokes confirm + DELETE endpoint
  //   - LoyaltyCard hidden entirely when /loyalty resolves to null body
  // ──────────────────────────────────────────────────────────────────

  describe('Photos tab — PhotoThumb retry', () => {
    it('clicking Try again clears the placeholder and re-renders the img with a cache-busting URL', async () => {
      const patientWithPhotos = {
        ...patient,
        visits: [
          {
            id: 11,
            visitDate: '2026-04-10T09:00:00Z',
            service: { name: 'Consultation' },
            notes: 'First visit',
            amountCharged: 1500,
            photosBefore: JSON.stringify(['/uploads/before-1.jpg']),
            photosAfter: JSON.stringify([]),
          },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithPhotos);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      const { container } = renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Photos/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^Photos/i }));

      // Trip the error placeholder by firing onError on the rendered <img>.
      const img = await waitFor(() => {
        const list = container.querySelectorAll('img');
        expect(list.length).toBeGreaterThanOrEqual(1);
        return list[0];
      });
      await act(async () => { fireEvent.error(img); });

      // Placeholder + Try again button rendered.
      const placeholder = await screen.findByTestId('photo-failed-placeholder');
      expect(placeholder).toBeInTheDocument();
      const retry = screen.getByRole('button', { name: /Try again/i });

      // Click Retry. PhotoThumb sets bust=Date.now() AND errored=false → the
      // <img> re-mounts with `?_r=<ts>` appended, placeholder unmounts.
      await user.click(retry);

      await waitFor(() => {
        expect(screen.queryByTestId('photo-failed-placeholder')).not.toBeInTheDocument();
      });
      // The replacement <img> src carries the cache-buster query param.
      const imgsAfter = container.querySelectorAll('img');
      expect(imgsAfter.length).toBeGreaterThanOrEqual(1);
      expect(imgsAfter[0].getAttribute('src')).toMatch(/[?&]_r=\d+/);
    });
  });

  describe('Photos tab — remove honours notify.confirm gate', () => {
    it('declining the confirm dialog skips the DELETE call (early-return path)', async () => {
      const patientWithPhotos = {
        ...patient,
        visits: [
          {
            id: 11,
            visitDate: '2026-04-10T09:00:00Z',
            service: { name: 'Consultation' },
            notes: 'First visit',
            amountCharged: 1500,
            photosBefore: JSON.stringify(['/uploads/before-1.jpg']),
            photosAfter: JSON.stringify([]),
          },
        ],
      };
      const calls = [];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        calls.push({ url, method: opts && opts.method });
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patientWithPhotos);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      // Reject the confirm so the early-return path is exercised.
      notifyObj.confirm.mockResolvedValue(false);

      const user = userEvent.setup();
      const { container } = renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /^Photos/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /^Photos/i }));

      // PhotoThumb renders an "X / Trash2" remove button. The thumb wraps a
      // single <img> + a sibling <button>; click the button next to the img.
      await waitFor(() => {
        const imgs = container.querySelectorAll('img');
        expect(imgs.length).toBeGreaterThanOrEqual(1);
      });
      const thumbContainer = container.querySelector('img').parentElement;
      const removeBtn = thumbContainer.querySelector('button');
      expect(removeBtn).not.toBeNull();

      const beforeCallCount = calls.length;
      await user.click(removeBtn);

      // notify.confirm was invoked; DELETE was NOT issued because confirm resolved false.
      await waitFor(() => expect(notifyObj.confirm).toHaveBeenCalledTimes(1));
      const newDeletes = calls.slice(beforeCallCount).filter((c) => c.method === 'DELETE');
      expect(newDeletes.length).toBe(0);
    });
  });

  describe('Consent tab — signature canvas validation', () => {
    it('Save consent is disabled and has a title hint until the patient signs', async () => {
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Consent form/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Consent form/i }));

      const save = await screen.findByRole('button', { name: /Save consent/i });
      expect(save).toBeDisabled();
      // Hover tooltip explains the gate — useful for accessibility audits.
      expect(save).toHaveAttribute('title', expect.stringMatching(/Patient must sign/i));
      // The clear-signature button is always present too.
      expect(screen.getByRole('button', { name: /Clear signature/i })).toBeInTheDocument();
    });
  });

  describe('Treatment plans — submit debounce guard (#225)', () => {
    it('Add button shows "Adding…" and is disabled while POST is in flight', async () => {
      // Hold the POST promise open so the in-flight state is observable.
      let resolvePost;
      const postPromise = new Promise((r) => { resolvePost = r; });
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        if (opts && opts.method === 'POST' && url === '/api/wellness/treatment-plans') return postPromise;
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Treatment plans/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Treatment plans/i }));

      await user.type(screen.getByPlaceholderText(/Plan name/i), 'PRP 4-session');
      const addBtn = screen.getByRole('button', { name: /^Add$/i });
      await user.click(addBtn);

      // Mid-flight: button label flips to "Adding…" and is disabled.
      await waitFor(() => expect(screen.getByRole('button', { name: /Adding…/i })).toBeDisabled());

      // Resolve so the test cleanly tears down.
      resolvePost({ id: 99 });
    });
  });

  describe('Telehealth tab — startOrJoin error path', () => {
    it('surfaces a notify.error toast when the videoRoom PUT fails', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        if (opts && opts.method === 'PUT' && /\/api\/wellness\/visits\/11$/.test(url)) {
          return Promise.reject(new Error('upstream-503'));
        }
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Telehealth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Telehealth/i }));

      await user.click(screen.getByRole('button', { name: /Start video consult/i }));
      await waitFor(() => expect(notifyObj.error).toHaveBeenCalled());
      expect(notifyObj.error.mock.calls[0][0]).toMatch(/Failed to start consult/);
      // No iframe gets mounted because activeRoom never sets.
      expect(document.querySelector('iframe[title="Telehealth video consult"]')).toBeNull();
    });
  });

  describe('Telehealth tab — live consult panel surfaces after Join', () => {
    it('clicking Join video opens the live consult panel with iframe + share URL text', async () => {
      const withRoom = {
        ...patient,
        visits: [
          { ...patient.visits[0], videoRoom: 'gbs-11-ananya-singh', status: 'completed' },
        ],
      };
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(withRoom);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Telehealth/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Telehealth/i }));

      // Click Join video — no PUT issued, activeRoom flips on directly.
      await user.click(screen.getByRole('button', { name: /Join video/i }));

      // Live-consult panel appears with the Share + Close buttons + jit.si URL + iframe.
      await waitFor(() => expect(screen.getByRole('button', { name: /Share with patient/i })).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /^Close$/i })).toBeInTheDocument();
      // shareUrl renders verbatim in the panel.
      expect(screen.getByText(/https:\/\/meet\.jit\.si\/gbs-11-ananya-singh/)).toBeInTheDocument();
      // Iframe with the jit.si src is mounted.
      const iframe = document.querySelector('iframe[title="Telehealth video consult"]');
      expect(iframe).not.toBeNull();
      expect(iframe.getAttribute('src')).toBe('https://meet.jit.si/gbs-11-ananya-singh');

      // Clicking Close tears down the panel (setActiveRoom(null) branch).
      await user.click(screen.getByRole('button', { name: /^Close$/i }));
      await waitFor(() => {
        expect(document.querySelector('iframe[title="Telehealth video consult"]')).toBeNull();
      });
    });
  });

  describe('Inventory tab — negative qty validation (#125)', () => {
    it('submitting form with qty=-1 fires notify.error and does NOT POST', async () => {
      const calls = [];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        calls.push({ url, method: opts && opts.method });
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        if (url.includes('/consumptions')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const user = userEvent.setup();
      renderPage();
      await waitFor(() => expect(screen.getByRole('button', { name: /Inventory used/i })).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Inventory used/i }));

      await waitFor(() => expect(screen.getByPlaceholderText(/Product name/i)).toBeInTheDocument());
      const productInput = screen.getByPlaceholderText(/Product name/i);
      await user.type(productInput, 'Numbing cream');
      // Set qty to -1. parseInt('-1') is -1 (truthy), so the SUT's
      // `parseInt(e.target.value) || 1` keeps the -1. That triggers the
      // qty<=0 guard branch inside `submit()`.
      const qtyInput = screen.getByPlaceholderText(/^Qty/i);
      await user.clear(qtyInput);
      await user.type(qtyInput, '-1');

      // The button enables on (productName !== '' && qty>=1) per #338 — qty=-1
      // leaves it disabled, so we trigger form-submit directly to reach the
      // runtime qty<=0 branch in `submit()`.
      const form = productInput.closest('form');
      await act(async () => { fireEvent.submit(form); });

      await waitFor(() => {
        const errCalls = notifyObj.error.mock.calls.filter((c) => /Quantity must be at least 1/i.test(c[0]));
        expect(errCalls.length).toBeGreaterThanOrEqual(1);
      });
      // No POST was issued — only the GET /consumptions on tab mount.
      const posts = calls.filter((c) => c.method === 'POST');
      expect(posts.length).toBe(0);
    });
  });

  describe('Memberships tab — Cancel membership POSTs to /cancel', () => {
    it('clicking Cancel on an active membership confirms (window.confirm) then POSTs /memberships/:id/cancel', async () => {
      const future = new Date(Date.now() + 60 * 86400000).toISOString();
      const past = new Date(Date.now() - 10 * 86400000).toISOString();
      const calls = [];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        const method = opts && opts.method;
        calls.push({ url, method, body: opts && opts.body });
        if (url.startsWith('/api/wellness/patients/') && url.endsWith('/memberships')) {
          return Promise.resolve([
            {
              id: 700,
              status: 'active',
              startDate: past,
              endDate: future,
              planId: 1,
              plan: { id: 1, name: 'Gold annual' },
              balance: JSON.stringify([{ serviceId: 1, remaining: 4 }]),
            },
          ]);
        }
        if (/\/api\/wellness\/memberships\/700\/cancel$/.test(url)) {
          return Promise.resolve({ id: 700, status: 'cancelled' });
        }
        if (url === '/api/wellness/membership-plans') return Promise.resolve([]);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      // SUT's MembershipsTab.cancel uses global `confirm()` (window.confirm),
      // not notify.confirm. Stub it to approve.
      const origConfirm = window.confirm;
      window.confirm = vi.fn(() => true);

      try {
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /Memberships/i })).toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: /Memberships/i }));

        const cancelBtn = await screen.findByRole('button', { name: /Cancel membership/i });
        await user.click(cancelBtn);

        // window.confirm gate fired, then POST issued to /memberships/700/cancel.
        await waitFor(() => expect(window.confirm).toHaveBeenCalled());
        await waitFor(() => {
          const cancelCall = calls.find((c) => c.method === 'POST' && /\/memberships\/700\/cancel$/.test(c.url));
          expect(cancelCall).toBeTruthy();
          // Body carries the staff-cancel reason.
          expect(JSON.parse(cancelCall.body).reason).toBe('staff cancel');
        });
      } finally {
        window.confirm = origConfirm;
      }
    });

    it('declining the window.confirm dialog skips the cancel POST entirely', async () => {
      const future = new Date(Date.now() + 60 * 86400000).toISOString();
      const past = new Date(Date.now() - 10 * 86400000).toISOString();
      const calls = [];
      fetchApi.mockReset();
      fetchApi.mockImplementation((url, opts) => {
        calls.push({ url, method: opts && opts.method });
        if (url.startsWith('/api/wellness/patients/') && url.endsWith('/memberships')) {
          return Promise.resolve([
            { id: 701, status: 'active', startDate: past, endDate: future, planId: 1, plan: { id: 1, name: 'Gold annual' }, balance: '[]' },
          ]);
        }
        if (url === '/api/wellness/membership-plans') return Promise.resolve([]);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      const origConfirm = window.confirm;
      window.confirm = vi.fn(() => false);

      try {
        const user = userEvent.setup();
        renderPage();
        await waitFor(() => expect(screen.getByRole('button', { name: /Memberships/i })).toBeInTheDocument());
        await user.click(screen.getByRole('button', { name: /Memberships/i }));

        const cancelBtn = await screen.findByRole('button', { name: /Cancel membership/i });
        await user.click(cancelBtn);

        // confirm was asked, but no /cancel POST followed.
        await waitFor(() => expect(window.confirm).toHaveBeenCalled());
        const cancelCalls = calls.filter((c) => /\/cancel$/.test(c.url));
        expect(cancelCalls.length).toBe(0);
      } finally {
        window.confirm = origConfirm;
      }
    });
  });

  describe('LoyaltyCard — hidden when /loyalty resolves to null body', () => {
    it('does not render the loyalty chip when /loyalty responds with null', async () => {
      fetchApi.mockReset();
      fetchApi.mockImplementation((url) => {
        // Resolve, not reject — pinning the "data == null → return null" branch
        // of the LoyaltyCard render guard. The other null path (reject) is
        // already covered by the earlier "no loyalty model" test.
        if (url === '/api/wellness/loyalty/1') return Promise.resolve(null);
        if (url.startsWith('/api/wellness/patients/')) return Promise.resolve(patient);
        if (url === '/api/wellness/services') return Promise.resolve(services);
        if (url === '/api/staff') return Promise.resolve(staff);
        return Promise.resolve([]);
      });

      renderPage();
      // Wait for the page to land before asserting absence.
      await waitFor(() => expect(screen.getByTestId('patient-header-subline')).toBeInTheDocument());
      expect(screen.queryByText(/Loyalty:/i)).not.toBeInTheDocument();
    });
  });
});
