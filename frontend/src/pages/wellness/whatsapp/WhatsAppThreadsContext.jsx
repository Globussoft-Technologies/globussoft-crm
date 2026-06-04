import React, { useContext } from 'react';

export const WhatsAppThreadsContext = React.createContext(null);

export function useWhatsAppThreads() {
  const ctx = useContext(WhatsAppThreadsContext);
  if (!ctx) throw new Error('useWhatsAppThreads must be used within WhatsAppThreads');
  return ctx;
}
