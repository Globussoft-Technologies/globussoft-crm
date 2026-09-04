/**
 * BrochureEngine.test.jsx — vitest + RTL coverage for the Travel-vertical
 * TMC School Brochure Engine page (frontend/src/pages/travel/BrochureEngine.jsx).
 *
 * The page is now a 5-step wizard with itinerary import.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fetchApiMock = vi.fn();
vi.mock('../utils/api', () => ({
  fetchApi: (...args) => fetchApiMock(...args),
  getAuthToken: () => 'test-token',
}));

const notifyError = vi.fn();
const notifySuccess = vi.fn();
const notifyInfo = vi.fn();
const notifyConfirm = vi.fn(() => Promise.resolve(true));
const notifyObj = { error: notifyError, info: notifyInfo, success: notifySuccess, confirm: notifyConfirm };
vi.mock('../utils/notify', () => ({ useNotify: () => notifyObj }));

import BrochureEngine from '../pages/travel/BrochureEngine';
import { summarizeImportedHotels, summarizeImportedTransfers } from '../utils/brochureEditorial';

const MODELS_FIXTURE = {
  tiers: ['reasoning', 'balanced', 'fast', 'writing'],
  strategies: ['recommended', 'cheapest', 'smartest', 'custom'],
  defaults: { reasoning: 'a', balanced: 'a', fast: 'a', writing: 'a' },
  models: [
    { id: 'a', label: 'Cheap Model', provider: 'groq', blurb: 'cheap', available: true, intelligence: 4, costEff: 5, inputPer1M: 0.15, outputPer1M: 0.75 },
    { id: 'b', label: 'Smart Model', provider: 'openai', blurb: 'smart', available: true, intelligence: 5, costEff: 2, inputPer1M: 2.5, outputPer1M: 15 },
  ],
};

function wireFetch() {
  fetchApiMock.mockImplementation((url, opts) => {
    if (url === '/api/travel/brochures/sectors') {
      return Promise.resolve({ sectors: [{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-school'] }] });
    }
    if (url === '/api/travel/brochures/models') return Promise.resolve(MODELS_FIXTURE);
    if (url === '/api/travel/brochures/runs' && opts?.method === 'POST') {
      return Promise.resolve({ runId: 'br_test123', brochureId: 7, status: 'running' });
    }
    if (url === '/api/travel/brochures') return Promise.resolve({ brochures: [] });
    if (url === '/api/travel/brochures/brand-profiles') return Promise.resolve({ profiles: [] });
    if (url === '/api/brand-kits?fields=summary&isActive=true') return Promise.resolve({ brandKits: [] });
    if (url === '/api/travel/itineraries?fields=summary') return Promise.resolve({ itineraries: [] });
    return Promise.resolve({});
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <BrochureEngine />
    </MemoryRouter>,
  );
}

async function fillStep1() {
  // Brand & School step
  fireEvent.change(screen.getByTestId('input-schoolName'), { target: { value: 'Delhi Public School' } });
  fireEvent.change(screen.getByTestId('tmc-brand-kit-id'), { target: { value: 'tmc-default' } });
}

async function fillStep2() {
  // Trip Details step
  fireEvent.click(screen.getByTestId('step-2'));
  await waitFor(() => expect(screen.getByTestId('input-tripTitle')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('input-tripTitle'), { target: { value: 'Japan STEM Tour 2026' } });
  fireEvent.change(screen.getByTestId('input-destinationCountry'), { target: { value: 'Japan' } });
  fireEvent.change(screen.getByTestId('input-travelDates-from'), { target: { value: '2026-04-01' } });
  fireEvent.change(screen.getByTestId('input-travelDates-to'), { target: { value: '2026-04-07' } });
  fireEvent.change(screen.getByTestId('input-durationDays'), { target: { value: '7' } });
  fireEvent.change(screen.getByTestId('input-durationNights'), { target: { value: '6' } });
  fireEvent.change(screen.getByTestId('input-targetGrades'), { target: { value: 'Grades 9–12' } });
  fireEvent.change(screen.getByTestId('input-tripSummary'), { target: { value: 'A seven-day STEM and cultural immersion in Japan.' } });
  fireEvent.change(screen.getByTestId('input-primaryObjective'), { target: { value: 'Explore robotics, sustainability and cultural heritage.' } });
  fireEvent.change(screen.getByTestId('input-learningOutcomes-0'), { target: { value: 'Understand robotics fundamentals' } });
  fireEvent.change(screen.getByTestId('input-learningOutcomes-1'), { target: { value: 'Experience sustainable city design' } });
  fireEvent.change(screen.getByTestId('input-learningOutcomes-2'), { target: { value: 'Appreciate Japanese culture' } });
  // Route cities — type each city and press Enter
  const routeInput = screen.getByTestId('input-routeCities');
  fireEvent.change(routeInput, { target: { value: 'Tokyo' } });
  fireEvent.keyDown(routeInput, { key: 'Enter', code: 'Enter' });
  fireEvent.change(routeInput, { target: { value: 'Kyoto' } });
  fireEvent.keyDown(routeInput, { key: 'Enter', code: 'Enter' });
  fireEvent.change(routeInput, { target: { value: 'Osaka' } });
  fireEvent.keyDown(routeInput, { key: 'Enter', code: 'Enter' });
  // Overnight cities — type and add
  const overnightInput = screen.getByPlaceholderText('Search and add a city');
  fireEvent.change(overnightInput, { target: { value: 'Tokyo' } });
  fireEvent.keyDown(overnightInput, { key: 'Enter', code: 'Enter' });
}

async function fillStep3() {
  // Day by Day step
  fireEvent.click(screen.getByTestId('step-3'));
  await waitFor(() => expect(screen.getByTestId('input-days[0]-route')).toBeInTheDocument());
  for (let i = 0; i < 7; i += 1) {
    fireEvent.change(screen.getByTestId(`input-days[${i}]-route`), { target: { value: 'Route line' } });
    fireEvent.change(screen.getByTestId(`input-days[${i}]-activities`), { target: { value: 'Activities' } });
    fireEvent.change(screen.getByTestId(`input-days[${i}]-overnightCity`), { target: { value: 'Tokyo' } });
  }
}

async function fillStep4() {
  // Logistics & Pricing step
  fireEvent.click(screen.getByTestId('step-4'));
  await waitFor(() => expect(screen.getByTestId('input-currency')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('input-currency'), { target: { value: 'INR' } });
  fireEvent.change(screen.getByTestId('input-pricePerPerson'), { target: { value: '250000' } });
  fireEvent.change(screen.getByTestId('input-occupancyBasis'), { target: { value: 'Twin sharing' } });
  fireEvent.change(screen.getByTestId('input-deposit-amount'), { target: { value: '50000' } });
  fireEvent.change(screen.getByTestId('input-deposit-dueDate'), { target: { value: '2026-01-31' } });
  fireEvent.change(screen.getByTestId('input-travelSeason'), { target: { value: 'Summer 2026' } });
  fireEvent.change(screen.getByTestId('input-inclusions-0'), { target: { value: 'Flights' } });
  fireEvent.change(screen.getByTestId('input-exclusions-0'), { target: { value: 'Visa' } });
}

async function fillStep5() {
  // Contact & Generate step
  fireEvent.click(screen.getByTestId('step-5'));
  await waitFor(() => expect(screen.getByTestId('input-primaryPhone')).toBeInTheDocument());
  fireEvent.change(screen.getByTestId('input-primaryPhone'), { target: { value: '+91 98765 43210' } });
  fireEvent.change(screen.getByTestId('input-email'), { target: { value: 'hello@school.edu' } });
  fireEvent.change(screen.getByTestId('input-website'), { target: { value: 'https://school.edu' } });
  fireEvent.change(screen.getByTestId('input-callToAction'), { target: { value: 'Book by 31 Jan 2026' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  wireFetch();
  localStorage.clear();
  global.EventSource = class {
    constructor(url) { this.url = url; this.onmessage = null; this.onerror = null; }
    close() {}
  };
});

describe('brochure itinerary editorial normalization', () => {
  it('collapses repetitive airport and hotel-transfer rows into readable logistics', () => {
    expect(summarizeImportedTransfers([
      { description: 'Airport transfer to hotel in Goa' },
      { description: 'Airport transfer to hotel' },
      { description: 'Return transfer to airport' },
      { description: 'Transfer back to the airport for departure' },
      { description: 'Transfer to hotel in South Goa' },
      { description: 'Transfer to hotel in North Goa' },
    ])).toEqual({
      airportTransfers: 'Airport-hotel transfers on arrival and departure',
      intercityTransport: 'Hotel transfers between South Goa and North Goa',
      railJourneys: '',
    });
  });

  it('removes checkout movements and groups equivalent accommodation stays', () => {
    expect(summarizeImportedHotels([
      { name: 'Stay at a beach resort in South Goa', city: 'Goa, India', nights: 1 },
      { name: 'Check-in at beach resort in South Goa', city: 'Goa, India', nights: 2 },
      { name: 'Check-out and transfer to North Goa', city: 'Goa, India', nights: 1 },
      { name: 'Taj Fort Aguada Resort', city: 'North Goa', category: '5-star', nights: 2, _structuredName: true },
    ])).toEqual([
      { name: 'Beach resort', city: 'South Goa', category: '', nights: 3 },
      { name: 'Taj Fort Aguada Resort', city: 'North Goa', category: '5-star', nights: 2 },
    ]);
  });
});

describe('BrochureEngine page (wizard)', () => {
  it('renders the header, tabs, and 5-step progress bar', async () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /Brochure Engine/i })).toBeInTheDocument();
    expect(screen.getByTestId('tab-generate')).toBeInTheDocument();
    expect(screen.getByTestId('tab-history')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('step-1')).toBeInTheDocument());
    expect(screen.getByTestId('step-2')).toBeInTheDocument();
    expect(screen.getByTestId('step-3')).toBeInTheDocument();
    expect(screen.getByTestId('step-4')).toBeInTheDocument();
    expect(screen.getByTestId('step-5')).toBeInTheDocument();
  });

  it('fetches models, itineraries and history on mount', async () => {
    renderPage();
    await waitFor(() => {
      const urls = fetchApiMock.mock.calls.map((c) => c[0]);
      expect(urls).toContain('/api/travel/brochures/models');
      expect(urls).toContain('/api/travel/brochures');
      expect(urls).toContain('/api/travel/itineraries?fields=summary');
    });
  });

  it('model picker defaults to the default reasoning model', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('step-5'));
    expect(await screen.findByTestId('reasoning-model-select')).toHaveValue('a');
  });

  it('Generate is disabled when AI provider is errored', async () => {
    fetchApiMock.mockImplementation((url) => {
      if (url === '/api/travel/brochures/models') return Promise.resolve({ code: 'AI_NOT_CONFIGURED', error: 'AI not configured' });
      if (url === '/api/travel/brochures/sectors') return Promise.resolve({ sectors: [{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-school'] }] });
      if (url === '/api/travel/brochures') return Promise.resolve({ brochures: [] });
      if (url === '/api/travel/brochures/brand-profiles') return Promise.resolve({ profiles: [] });
      if (url === '/api/brand-kits?fields=summary&isActive=true') return Promise.resolve({ brandKits: [] });
      if (url === '/api/travel/itineraries?fields=summary') return Promise.resolve({ itineraries: [] });
      return Promise.resolve({});
    });
    renderPage();
    fireEvent.click(screen.getByTestId('step-5'));
    expect(await screen.findByTestId('ai-provider-error')).toBeInTheDocument();
    expect(screen.getByTestId('generate-brochure')).toBeDisabled();
  });

  it('shows validation summary and blocks Generate until required fields are valid', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('step-5'));
    const btn = screen.getByTestId('generate-brochure');
    fireEvent.click(btn);
    expect(await screen.findByTestId('validation-summary')).toBeInTheDocument();
    expect(notifyError).toHaveBeenCalledWith(expect.stringMatching(/required field/));
  });

  it('Generate posts /runs with tripInput, brand and models.reasoning', async () => {
    renderPage();
    await fillStep1();
    await fillStep2();
    await fillStep3();
    await fillStep4();
    await fillStep5();

    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/brochures/brand-images/upload' && opts?.method === 'POST') {
        return Promise.resolve({ urls: ['data:image/png;base64,AAA'] });
      }
      if (url === '/api/travel/brochures/sectors') {
        return Promise.resolve({ sectors: [{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-school'] }] });
      }
      if (url === '/api/travel/brochures/models') return Promise.resolve(MODELS_FIXTURE);
      if (url === '/api/travel/brochures') return Promise.resolve({ brochures: [] });
      if (url === '/api/travel/brochures/brand-profiles') return Promise.resolve({ profiles: [] });
      if (url === '/api/brand-kits?fields=summary&isActive=true') return Promise.resolve({ brandKits: [] });
      if (url === '/api/travel/itineraries?fields=summary') return Promise.resolve({ itineraries: [] });
      if (url === '/api/travel/brochures/runs' && opts?.method === 'POST') {
        return Promise.resolve({ runId: 'br_test123', brochureId: 7, status: 'running' });
      }
      return Promise.resolve({});
    });

    // Go back to step 1 to upload school logo
    fireEvent.click(screen.getByTestId('step-1'));
    await waitFor(() => expect(screen.getByTestId('school-logo-input')).toBeInTheDocument());
    const file = new File(['(⌐□_□)'], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('school-logo-input'), { target: { files: [file] } });
    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledWith('/api/travel/brochures/brand-images/upload', expect.objectContaining({ method: 'POST' }));
    });
    fireEvent.click(screen.getByTestId('school-logo-approved'));

    // Go to final step and generate
    fireEvent.click(screen.getByTestId('step-5'));
    await waitFor(() => expect(screen.getByTestId('generate-brochure')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('generate-brochure'));

    await waitFor(() => {
      const post = fetchApiMock.mock.calls.find((c) => c[0] === '/api/travel/brochures/runs' && c[1]?.method === 'POST');
      expect(post).toBeTruthy();
      const body = JSON.parse(post[1].body);
      expect(body.sectorKey).toBe('travel');
      expect(body.styleKey).toBe('tmc-school');
      expect(body.tripInput).toBeTruthy();
      expect(body.tripInput.tripTitle).toBe('Japan STEM Tour 2026');
      expect(body.brand.schoolName).toBe('Delhi Public School');
      expect(body.brand.tmcBrandKitId).toBe('tmc-default');
      expect(body.models).toEqual({ reasoning: 'a' });
    });
  }, 15000);

  it('allows adding and removing itinerary days', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('step-3'));
    await waitFor(() => expect(screen.getAllByText(/Day \d+/).length).toBe(7));
    fireEvent.click(screen.getByRole('button', { name: /Add day/i }));
    await waitFor(() => expect(screen.getAllByText(/Day \d+/).length).toBe(8));
    const removeBtns = screen.getAllByRole('button', { name: /Remove day/i });
    fireEvent.click(removeBtns[removeBtns.length - 1]);
    await waitFor(() => expect(screen.getAllByText(/Day \d+/).length).toBe(7));
  });

  it('keeps theme colour toggles in aligned rows below the preceding fields', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('step-4'));

    const preferences = await screen.findByTestId('theme-colour-preferences');
    const preferredColours = screen.getByRole('checkbox', { name: /Preferred colours/i });
    const coloursToAvoid = screen.getByRole('checkbox', { name: /Colours to avoid/i });

    expect(preferences).toHaveStyle({ marginTop: '4px', rowGap: '12px' });
    expect(preferredColours.closest('label')).toHaveStyle({ flexDirection: 'row', alignItems: 'center' });
    expect(coloursToAvoid.closest('label')).toHaveStyle({ flexDirection: 'row', alignItems: 'center' });
  });

  it('imports itinerary data when Fill form is clicked', async () => {
    const itineraryFixture = {
      id: 42,
      destination: 'Japan',
      startDate: '2026-04-01T00:00:00.000Z',
      endDate: '2026-04-07T00:00:00.000Z',
      pax: 40,
      totalAmount: '1000000.00',
      currency: 'INR',
      contact: { name: 'Greenfield Academy', email: 'info@greenfield.edu', phone: '+91 99999 88888' },
      items: [
        { id: 1, itemType: 'flight', dayNumber: 1, description: 'AI 301', startTime: '10:00', endTime: '14:00', locationName: 'Tokyo', position: 1 },
        { id: 2, itemType: 'hotel', dayNumber: 1, description: 'Tokyo Hilton', locationName: 'Tokyo', position: 2 },
        { id: 3, itemType: 'activity', dayNumber: 2, description: 'Robot museum visit', locationName: 'Tokyo', position: 3 },
      ],
    };
    fetchApiMock.mockImplementation((url, opts) => {
      if (url === '/api/travel/itineraries?fields=summary') return Promise.resolve({ itineraries: [itineraryFixture] });
      if (url === '/api/travel/itineraries/42') return Promise.resolve({ itinerary: itineraryFixture });
      if (url === '/api/travel/brochures/sectors') return Promise.resolve({ sectors: [{ key: 'travel', name: 'Travel Brochure', styles: ['tmc-school'] }] });
      if (url === '/api/travel/brochures/models') return Promise.resolve(MODELS_FIXTURE);
      if (url === '/api/travel/brochures') return Promise.resolve({ brochures: [] });
      if (url === '/api/travel/brochures/brand-profiles') return Promise.resolve({ profiles: [] });
      if (url === '/api/brand-kits?fields=summary&isActive=true') return Promise.resolve({ brandKits: [] });
      return Promise.resolve({});
    });

    renderPage();
    await waitFor(() => expect(screen.getByTestId('itinerary-select')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('itinerary-select'), { target: { value: '42' } });
    fireEvent.click(screen.getByTestId('import-itinerary'));
    await waitFor(() => expect(notifySuccess).toHaveBeenCalledWith(expect.stringMatching(/filled from itinerary/i)));

    // Verify imported data is on step 2
    fireEvent.click(screen.getByTestId('step-2'));
    await waitFor(() => expect(screen.getByTestId('input-tripTitle')).toHaveValue('Japan School Trip'));
    expect(screen.getByTestId('input-destinationCountry')).toHaveValue('Japan');
    expect(screen.getByTestId('input-expectedStudents')).toHaveValue(40);

    // Currency and price are on step 4
    fireEvent.click(screen.getByTestId('step-4'));
    await waitFor(() => expect(screen.getByTestId('input-currency')).toBeInTheDocument());
    expect(screen.getByTestId('input-currency')).toHaveValue('INR');
    expect(screen.getByTestId('input-pricePerPerson')).toHaveValue(25000);
  });

  it('does not lose an edit made just before navigating away, within the autosave debounce window', async () => {
    // Reproduces the reported bug: pick a brochure accent colour, then leave
    // the page (here: unmount, standing in for a route change) well inside
    // the 600ms autosave debounce — before this fix, the pending edit was
    // never flushed to the draft and silently vanished on return.
    const { unmount } = renderPage();
    await waitFor(() => expect(screen.getByTestId('input-schoolName')).toBeInTheDocument());

    const hexInput = screen.getByTestId('input-brochureAccent');
    fireEvent.change(hexInput, { target: { value: '#2a00fa' } });
    await waitFor(() => expect(screen.getByTestId('input-brochureAccent')).toHaveValue('#2a00fa'));

    unmount(); // navigate away — no fake timers advanced, no 600ms has passed

    const saved = JSON.parse(localStorage.getItem('tmc-brochure-engine-draft-v1'));
    expect(saved?.brand?.accent).toBe('#2a00fa');

    // Coming back (a fresh mount) restores exactly what was picked.
    renderPage();
    await waitFor(() => expect(screen.getByTestId('input-schoolName')).toBeInTheDocument());
    expect(screen.getByTestId('input-brochureAccent')).toHaveValue('#2a00fa');
  });
});
