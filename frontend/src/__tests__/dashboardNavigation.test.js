import { describe, expect, it } from 'vitest';
import {
  dashboardNavigationState,
  dashboardPathForState,
} from '../utils/dashboardNavigation';

describe('dashboard navigation state', () => {
  it('uses the correct dashboard for each CRM vertical', () => {
    expect(dashboardPathForState(dashboardNavigationState('travel'))).toBe('/travel');
    expect(dashboardPathForState(dashboardNavigationState('wellness'))).toBe('/wellness');
    expect(dashboardNavigationState('generic')).toBeNull();
  });

  it('does not treat ordinary navigation state as dashboard navigation', () => {
    expect(dashboardPathForState({ fromSidebar: true })).toBeNull();
    expect(dashboardPathForState(undefined)).toBeNull();
  });
});
