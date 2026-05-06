// Shared timing constants. Keeps related delays consistent across modules
// — pen-test #548 found Patients at 250ms vs Omnibar at 300ms; consolidating
// here means future modules (Contacts/Deals/etc.) can import one value
// instead of inventing new ones.

/**
 * Debounce window for server-backed search inputs (Patients, Omnibar, etc.).
 * Long enough that a typist's burst of keystrokes settles into one fetch;
 * short enough that the result feels live.
 *
 * Client-side filters that operate on already-loaded data (e.g. Leads) do
 * NOT need a debounce — they re-run instantly on each keystroke without
 * a network round-trip.
 */
export const SEARCH_DEBOUNCE_MS = 300;
