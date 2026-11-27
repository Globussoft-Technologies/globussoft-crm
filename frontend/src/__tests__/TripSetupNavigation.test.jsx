import { render, screen, fireEvent } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SetupNavigator, setupSteps } from '../pages/travel/TripSetupNavigation';

it('keeps the navigator through completion, hides it on reopening, and dismisses it for the visit', () => {
  const nav = flags => <SetupNavigator trip={{id: 1, tripCode: 'School trip'}} flags={flags} viewed={0}/>;
  const all = [true, true, true, true, true, true, true];
  const pending = [true, true, true, true, true, true, false];
  const first = render(nav(pending));
  first.rerender(nav(all));
  expect(screen.getByText('100%')).toBeVisible();
  first.unmount();

  const next = render(nav([true, true, true, undefined, true, true, undefined]));
  next.rerender(nav(all));
  expect(screen.queryByLabelText('Trip navigator')).toBeNull();
  next.rerender(nav(pending));
  fireEvent.click(screen.getByRole('button', {name: 'Close trip navigator'}));
  next.rerender(nav(pending));
  expect(screen.queryByLabelText('Trip navigator')).toBeNull();
});

it('marks the seventh Rooming step complete only when the trip has a room', () => {
  const trip = { id: 1, teacherContactId: null, _count: { rooming: 0 } };
  expect(setupSteps(trip, false)[6]).toBe(false);
  expect(setupSteps({ ...trip, _count: { rooming: 1 } }, false)[6]).toBe(true);
});
