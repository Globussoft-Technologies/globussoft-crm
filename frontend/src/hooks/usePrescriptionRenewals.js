import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchApi } from '../utils/api';

/**
 * Patient-side renewal-request state, shared by the two surfaces that offer
 * "ask for a repeat":
 *   - /wellness/my-prescriptions         — the action ON the prescription card
 *   - /wellness/my-prescription-requests — the page that tracks what was asked
 *
 * Split out of the composer component so that file exports only a component
 * (react-refresh/only-export-components), and so a third surface can reuse the
 * gate without importing UI. Same reason hooks/useLeadCalling.js exists next to
 * components/wellness/LeadCallAction.jsx.
 */

// A request in either state is still with the clinic, so its prescription
// cannot be requested again — the backend answers a second one with 409
// REQUEST_ALREADY_OPEN. Callers disable the control instead of letting the
// patient discover that by tapping.
export const OPEN_STATUSES = ['PENDING', 'ACCEPTED'];

/** Human label for one drug row — "Name · 1 · 2×/day · 84 days". */
export function drugLabel(d) {
  if (!d) return '';
  const name = d.name || d.drugName || '';
  const bits = [];
  if (d.dosage) bits.push(`${d.dosage}`);
  if (d.frequency) bits.push(`${d.frequency}×/day`);
  if (d.duration) bits.push(`${d.duration} days`);
  return bits.length ? `${name} · ${bits.join(' · ')}` : name;
}

/**
 * Prescription.drugs is normally an array by the time it reaches the UI, but
 * older payloads (and the raw DB column) hand over a JSON string. Tolerate
 * both so a caller can pass whatever its endpoint gave it.
 */
export function asDrugArray(drugs) {
  if (Array.isArray(drugs)) return drugs;
  if (typeof drugs === 'string') {
    try {
      const parsed = JSON.parse(drugs || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Loads the signed-in patient's own renewal requests and indexes the OPEN ones
 * by prescription id, so any surface listing prescriptions can tell which
 * already have a request in flight.
 *
 * Reads `/api/wellness/portal/prescription-requests` — the same endpoint the
 * Android app uses. It runs behind `verifyPatientToken`, which accepts a
 * regular CUSTOMER session token and resolves it to the caller's linked
 * Patient row, so the web and the app see the same rows.
 */
export function useRenewalRequests() {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi('/api/wellness/portal/prescription-requests', {
        silent: true,
      });
      setRequests(Array.isArray(res) ? res : []);
      setError(null);
    } catch (err) {
      // Non-fatal for the host page: a prescription list is still useful
      // without the renewal overlay, so surface the error to the caller and
      // let it decide rather than blanking the page.
      setRequests([]);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const openByPrescription = useMemo(() => {
    const map = new Map();
    for (const r of requests) {
      if (OPEN_STATUSES.includes(r.status)) map.set(r.prescriptionId, r);
    }
    return map;
  }, [requests]);

  return { requests, openByPrescription, reload, loading, error };
}

export default useRenewalRequests;
