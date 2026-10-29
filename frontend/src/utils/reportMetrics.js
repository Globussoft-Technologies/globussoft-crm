import { currencySymbol } from './money';

const METRIC_OPTIONS = [
  { value: 'revenue', label: 'Revenue', group: 'Deals' },
  { value: 'count', label: 'Deal Count', group: 'Deals' },
  { value: 'win_rate', label: 'Win/Loss Rate', group: 'Deals' },
  { value: 'invoices', label: 'Invoice Status', group: 'Financial' },
];

export function getReportMetricOptions(displayCurrency) {
  return METRIC_OPTIONS.map(option => option.value === 'revenue'
    ? { ...option, label: `Revenue (${currencySymbol(displayCurrency)})` }
    : option);
}
