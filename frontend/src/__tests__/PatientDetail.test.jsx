import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

vi.mock('../utils/api', () => ({
  fetchApi: vi.fn(),
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
});
