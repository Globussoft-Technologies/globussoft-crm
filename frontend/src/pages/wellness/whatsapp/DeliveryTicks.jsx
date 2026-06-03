
import {
  Check,
  CheckCheck,
  Clock,
  AlertTriangle,
} from 'lucide-react';

// Wave 7D — PRD Gap §7 item 3 — delivery-tick icon per WhatsAppMessage.status.
// Icons are familiar to anyone who's used WhatsApp on a phone:
//   QUEUED → small clock (still being dispatched)
//   SENT   → single grey check
//   DELIVERED → double grey check
//   READ   → double blue check
//   FAILED → red triangle/exclamation
// QUEUED is treated as "no checkmark yet" — the row's status text alongside
// already says it. Returns null for inbound messages (we never emit these
// statuses for INBOUND rows; they're stored as 'RECEIVED').
export default function DeliveryTicks({ status, direction }) {
  if (direction !== 'OUTBOUND') return null;
  if (status === 'READ') {
    return <CheckCheck size={14} color="#3b82f6" aria-label="Read" data-testid="delivery-tick-read" />;
  }
  if (status === 'DELIVERED') {
    return <CheckCheck size={14} color="rgba(255,255,255,0.7)" aria-label="Delivered" data-testid="delivery-tick-delivered" />;
  }
  if (status === 'SENT') {
    return <Check size={14} color="rgba(255,255,255,0.7)" aria-label="Sent" data-testid="delivery-tick-sent" />;
  }
  if (status === 'FAILED') {
    return <AlertTriangle size={14} color="#ef4444" aria-label="Failed" data-testid="delivery-tick-failed" />;
  }
  if (status === 'QUEUED') {
    return <Clock size={12} color="rgba(255,255,255,0.5)" aria-label="Queued" data-testid="delivery-tick-queued" />;
  }
  return null;
}
