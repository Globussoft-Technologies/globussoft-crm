export const PICKUP_STATUS_LABELS = {
  PICKUP_LOCATION_CAPTURED: 'Awaiting transport assignment',
  ASSIGNED: 'Transport assigned',
  ACCEPTED: 'Trip accepted',
  HEADING_TO_PICKUP: 'Heading to pickup',
  ARRIVED_AT_PICKUP: 'Arrived at pickup',
  PICKED_UP: 'Customer picked up',
  EN_ROUTE: 'En route to plot',
  ARRIVED_AT_DROP: 'Arrived at plot',
  COMPLETED: 'Trip completed',
  PENDING: 'Not started',
  AWAITING_BROKER_ASSIGNMENT: 'Awaiting Sales Executive assignment',
  READY_TO_SCHEDULE: 'Ready to schedule site visit',
  VISIT_SCHEDULED: 'Site visit scheduled',
  VISIT_CONFIRMED: 'Site visit confirmed',
  REMINDER_SENT: 'Site visit reminder sent',
  ATTENDED: 'Customer attended',
  NO_SHOW: 'No-show',
  VISIT_RESCHEDULED: 'Site visit rescheduled',
  PLOT_SHOWN: 'Plot shown',
  PLOT_SELECTED: 'Plot selected',
  CLOSED_NO_INTEREST: 'Closed (not interested)',
  PLOT_RESERVED: 'Plot reserved',
  BILLING: 'Billing',
  INVOICE_CREATED: 'Invoice created',
  INVOICE_SENT: 'Invoice sent',
  PAYMENT_PENDING: 'Payment pending',
  PAYMENT_RECEIVED: 'Payment received',
  PAYMENT_VERIFIED: 'Payment verified',
  BOOKING_CONFIRMED: 'Booking confirmed',
  PLOT_SOLD: 'Plot sold',
  TRANSACTION_COMPLETED: 'Transaction completed',
};

export const PICKUP_STAGE_LABELS = {
  pickup: 'Pickup',
  transport: 'Transport',
  broker: 'Sales Executive',
  billing: 'Billing',
  payment: 'Payment',
  plot: 'Plot',
};

export const formatPickupStatus = (status) => PICKUP_STATUS_LABELS[status]
  || String(status || 'PENDING').replaceAll('_', ' ').toLowerCase();

export const formatPickupStatusDate = (value) => value
  ? new Date(value).toLocaleString()
  : 'No update yet';

export const pickupTripStatusStyle = (status) => status === 'COMPLETED'
  ? { color: '#047857', background: 'rgba(16,185,129,.14)' }
  : status === 'PICKUP_LOCATION_CAPTURED'
    ? { color: '#a16207', background: 'rgba(245,158,11,.14)' }
    : { color: 'var(--primary-color, var(--accent-color))', background: 'rgba(79,70,229,.12)' };
