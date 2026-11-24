import { describe, expect, it } from 'vitest';
import {
  GENERIC_LEAD_STATUS_EDIT_OPTIONS,
  genericLeadStatusLabel,
  genericLeadStatusValue,
} from '../utils/genericLeadStatus';

describe('genericLeadStatus', () => {
  it('shows the eight Generic CRM labels while preserving Lead as the New stored value', () => {
    expect(GENERIC_LEAD_STATUS_EDIT_OPTIONS).toEqual([
      { value: 'Lead', label: 'New' },
      { value: 'Contacted', label: 'Contacted' },
      { value: 'Interested', label: 'Interested' },
      { value: 'Unqualified', label: 'Unqualified' },
      { value: 'Qualified', label: 'Qualified' },
      { value: 'Lost', label: 'Lost' },
      { value: 'Won', label: 'Won' },
      { value: 'Churned', label: 'Churned' },
    ]);
    expect(genericLeadStatusLabel('Lead')).toBe('New');
    expect(genericLeadStatusValue('New')).toBe('Lead');
    expect(genericLeadStatusValue('Lead')).toBe('Lead');
  });

  it('normalizes legacy Generic CRM values for the editor without changing their labels elsewhere', () => {
    expect(genericLeadStatusValue('Prospect')).toBe('Contacted');
    expect(genericLeadStatusValue('Customer')).toBe('Won');
    expect(genericLeadStatusValue('Junk')).toBe('Unqualified');
  });
});
