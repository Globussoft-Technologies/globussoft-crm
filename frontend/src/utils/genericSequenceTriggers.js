export const GENERIC_SEQUENCE_TRIGGERS = Object.freeze([
  { value: 'contact.created', label: 'New lead received' },
  { value: 'pickup_plot.selection_requested', label: 'Request pickup location & interested plot for new lead' },
  { value: 'pickup_point.assigned', label: 'Pickup location assigned or changed' },
  { value: 'contact.updated', label: 'Lead data updated' },
  { value: 'pickup_plot.selected', label: 'Pickup location & interested plot selected' },
  { value: 'payment.collected', label: 'Payment completed' },
  { value: 'plot.confirmed', label: 'Plot confirmed' },
]);

export const GENERIC_WHATSAPP_SEQUENCE_TRIGGERS = Object.freeze([
  { value: 'contact.created', label: 'Lead Created' },
  { value: 'contact.status_changed', label: 'Lead Status Changed' },
  { value: 'payment.due', label: 'Payment Due' },
  { value: 'pickup_plot.selection_requested', label: 'Pickup/plot selection requested' },
  { value: 'pickup_point.assigned', label: 'Pickup location assigned or changed' },
  { value: 'pickup_plot.selected', label: 'Pickup/plot selected — check response' },
  { value: 'payment.collected', label: 'Payment completed' },
  { value: 'plot.confirmed', label: 'Plot confirmed' },
]);
