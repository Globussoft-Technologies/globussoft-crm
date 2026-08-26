import { useContext, useEffect, useState } from 'react';
import { AuthContext } from '../App';
import { fetchApi } from '../utils/api';

/**
 * Callified calling for the lead lists — All Leads and Converted Leads.
 *
 * Both pages are views over Contact filtered by status, so both call through
 * the same `/api/wellness/callified/leads/:leadId/*` routes and both get the
 * same AI / Manual chooser the Appointments and Patients rows use. This hook
 * exists so the two pages share ONE gate rather than growing a copy each —
 * they are cross-vertical pages, and this is the part most likely to drift if
 * it were written twice.
 *
 * Two conditions, both required:
 *   - wellness only. `/leads` and `/converted-leads` are shared with the
 *     generic and travel verticals; generic has its own Callified flow on the
 *     same page, and travel has none.
 *   - Callified configured for this tenant. Without it the action would be a
 *     button that always fails.
 */
export function useLeadCalling() {
  const auth = useContext(AuthContext);
  const isWellness = auth?.tenant?.vertical === 'wellness';

  const [configured, setConfigured] = useState(false);
  const [target, setTarget] = useState(null);

  useEffect(() => {
    if (!isWellness) {
      setConfigured(false);
      return undefined;
    }
    let cancelled = false;
    fetchApi('/api/wellness/callified/status', { silent: true })
      .then((res) => {
        if (cancelled) return;
        setConfigured(Boolean(res?.configured && res?.enabled));
      })
      // A 403 here just means this role may not place calls; a 503 means the
      // tenant has no Callified credentials. Either way: no call action.
      .catch(() => {
        if (!cancelled) setConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isWellness]);

  return {
    enabled: isWellness && configured,
    target,
    open: (lead) => setTarget(lead),
    close: () => setTarget(null),
  };
}

export default useLeadCalling;
