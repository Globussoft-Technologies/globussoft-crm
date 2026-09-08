import { PhoneCall } from 'lucide-react';
import CallifiedCallDialog from '../CallifiedCallDialog';

/**
 * Callified calling UI for the lead lists — All Leads and Converted Leads.
 *
 * Both pages are views over Contact filtered by status, so both render these
 * same controls and both call through /api/wellness/callified/leads/:leadId/*.
 * Shared here rather than written twice, so the two lists cannot drift apart.
 * The wellness + configured gate lives in hooks/useLeadCalling.js.
 */

/**
 * Per-row call action.
 *
 * A lead with no dialable number still gets the control, disabled with a
 * reason — silently hiding it reads as a missing feature, and the operator
 * needs to know WHY they cannot call so they can go fix the number. Same rule
 * the Appointments and Patients rows use, so every surface behaves alike.
 */
export function LeadCallButton({ lead, onCall }) {
  const phone = lead?.phone || '';
  const dialable = phone.replace(/\D/g, '').length >= 10;
  const name = lead?.name || 'this lead';

  return (
    <button
      type="button"
      onClick={onCall}
      disabled={!dialable}
      title={dialable ? `Call ${name}` : 'No valid phone number on file'}
      aria-label={`Call ${name}`}
      data-testid={`lead-call-${lead?.id}`}
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--accent-color)',
        cursor: dialable ? 'pointer' : 'not-allowed',
        opacity: dialable ? 1 : 0.4,
        padding: '0.25rem',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      <PhoneCall size={16} />
    </button>
  );
}

/**
 * The chooser itself — unchanged from every other surface, pointed at the
 * lead endpoints. A lead IS a CRM contact, so the backend dials it without
 * creating anything new.
 */
export function LeadCallDialog({ lead, onClose }) {
  if (!lead) return null;
  return (
    <CallifiedCallDialog
      customer={{
        name: lead.name,
        phone: lead.phone,
        subtitle: lead.email || lead.status || null,
      }}
      endpoints={{
        context: `/api/wellness/callified/leads/${lead.id}/context`,
        campaigns: '/api/wellness/callified/campaigns',
        aiCall: `/api/wellness/callified/leads/${lead.id}/ai-call`,
        manualCall: `/api/wellness/callified/leads/${lead.id}/manual-call`,
      }}
      onClose={onClose}
    />
  );
}
