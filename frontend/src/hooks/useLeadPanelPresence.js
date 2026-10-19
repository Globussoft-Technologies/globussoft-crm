import { useLayoutEffect, useState } from 'react';

// Retain the outgoing record just long enough for the non-modal panel to fade.
export default function useLeadPanelPresence(lead) {
  const [retained, setRetained] = useState(lead);
  useLayoutEffect(() => {
    if (lead) {
      setRetained(lead);
      return undefined;
    }
    const timer = setTimeout(() => setRetained(null), 200);
    return () => clearTimeout(timer);
  }, [lead]);
  return lead || retained;
}
