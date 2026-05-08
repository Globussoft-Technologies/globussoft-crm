/**
 * getGreeting — time-of-day greeting based on the user's local clock.
 *
 * #636: the wellness Owner Dashboard greeting was a hard-coded "Good
 * afternoon" / inline IST-only computation; the generic Dashboard had none.
 * This helper centralises the branch logic so every page renders the same
 * boundaries and the test suite can pin them in one place.
 *
 * Branch boundaries (local hour, 24h):
 *   - 05:00–11:59 → Good morning
 *   - 12:00–16:59 → Good afternoon
 *   - 17:00–21:59 → Good evening
 *   - 22:00–04:59 → Good night
 *
 * @param {Date} [now=new Date()] — injectable for tests; defaults to wall clock.
 * @returns {string}
 */
export function getGreeting(now = new Date()) {
  const hour = now.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good night';
}
