# Shared UI primitives

This directory holds the canonical small components that resolve the
v3.5.x form / list / modal consistency cluster:

- **#685** Tables — column-header alignment convention.
- **#686** Forms — required-field indicator (`<FormField required />`).
- **#687** Buttons — primary / secondary / destructive variants.
- **#688** Empty states — `<EmptyState />`.
- **#689** Loading states — `<Spinner />` + `<Skeleton />`.
- **#691** Modal dialogs — `<Modal />` (page-level) + `notify.confirm` (yes/no).
- **#694** Pagination — `<Pagination />` (page-numbers + jump, URL-syncable).
- **#695** Search inputs — `<SearchInput />` (debounced 250 ms, clear-X).

## Why a single conventions doc

The pre-refactor codebase had each module renderer making its own choices.
Different tables left-aligned numeric columns, different forms used
different asterisk colours, different empty states wrote different copy.
A user opening Patients then Leads saw two different list shells, two
different search-bar placements, two different empty-state copy
conventions. None of those small choices is individually wrong; the
cumulative inconsistency is the bug.

Rather than spend ~50 file-touches rewriting every callsite, we ship
the primitives + this README pinning the conventions. New code lands
correctly; existing surfaces migrate when their owning issue is
re-touched (incremental, low-risk).

---

## #685 — Tables: column header alignment

Use the existing `stable-table` class on the `<table>`. Alignment
convention:

| Column kind | `text-align` |
|---|---|
| Text (Name, Email, Description) | `left` |
| Numeric / currency (Amount, Count, MRR) | `right` |
| Status / badge / action buttons | `center` |

```jsx
<table className="stable-table">
  <thead>
    <tr>
      <th style={{ textAlign: 'left' }}>Patient</th>
      <th style={{ textAlign: 'right' }}>Amount (₹)</th>
      <th style={{ textAlign: 'center' }}>Status</th>
      <th style={{ textAlign: 'center' }}>Actions</th>
    </tr>
  </thead>
  ...
</table>
```

The matching `<td>` cell needs the same `text-align` so the column stays
visually aligned (header + body share the alignment via inline style; CSS
`th, td` selectors would scope-creep into other pages).

`stable-table` (defined in `index.css:397`) provides `table-layout: fixed`
+ hover stability — keep it on every list table.

---

## #686 — Forms: required-field indicator

Use `<FormField required>` for every required field. The `*` renders
in `--danger-color` after the label text. The wrapper also surfaces an
inline error below the field via the `error` prop.

```jsx
import { FormField } from '../components/ui';

<FormField label="Patient name" required htmlFor="patient-name" error={errors.name}>
  <input
    id="patient-name"
    className="input-field"
    value={name}
    onChange={(e) => setName(e.target.value)}
    aria-required="true"
  />
</FormField>
```

Optional fields just omit `required`; no marker renders. Don't roll a
custom asterisk — the wrapper is the single source of truth.

---

## #687 — Buttons: primary / secondary / destructive hierarchy

Use the existing classes:

| Class | When | Visual |
|---|---|---|
| `btn-primary` | One per view — the dominant action (Save, Create, Send). | Theme accent gradient, white text. |
| `btn-secondary` | Cancel, Back, secondary toolbar actions. | Surface + border. |
| `btn-danger` | Destructive: Delete, Archive, Revoke. | Solid `--danger-color`, white text. |
| (none / ghost) | Inline / icon-only / tertiary | No class — caller styles inline. |

Rules:

1. **One `btn-primary` per view.** If you find yourself wanting two
   primaries, one of them is actually secondary.
2. **Destructive flows use `btn-danger`** so the destructive choice is
   visually distinct from the safe one. Never colour-flip `btn-primary`
   to red — the muscle memory of "primary = safe" breaks.
3. **Don't introduce per-module accent colours.** The theme tokens
   `--accent-color` (generic blue) and `--primary-color` (wellness teal)
   already pivot on the active vertical; bare `var(--accent-color)` for
   primary CTAs reads salmon under wellness. The `.btn-primary` class
   already handles this — don't reimplement.

```jsx
<button className="btn-primary" onClick={save}>Save patient</button>
<button className="btn-secondary" onClick={cancel}>Cancel</button>
<button className="btn-danger" onClick={remove}>Delete</button>
```

---

## #688 — Empty states

When a list / table / report has zero rows, render `<EmptyState />`.
Pattern: icon + heading ("No <noun> yet") + 1-line body + optional
CTA.

```jsx
import { EmptyState } from '../components/ui';
import { Users } from 'lucide-react';

{patients.length === 0 ? (
  <EmptyState
    icon={<Users size={48} />}
    heading="No patients yet"
    body="Add your first patient to start scheduling visits."
    cta={{ label: 'Add patient', onClick: () => setShowAddModal(true) }}
  />
) : (
  <PatientTable rows={patients} />
)}
```

Copy conventions:

- Heading: `No <plural noun> yet` (capital N, "yet" signals "more to
  come"). Don't write `Nothing found.` or `Empty.` — those are blank
  and discouraging.
- Body: optional but recommended. One short sentence explaining how to
  populate the state. Don't write "Click the button below to add one."
  — that's redundant with the CTA label. Instead: "Visits show up here
  once a patient is checked in."
- CTA: optional. Render only if the create-affordance doesn't already
  live elsewhere on the page (avoid double primaries — see #687).

Distinguish "empty" from "loading" (use `<Skeleton />`) and "error"
(use `notify.error` or an inline banner). The three states are not
interchangeable.

---

## #689 — Loading states

Two primitives, one rule of thumb:

| Use this | When |
|---|---|
| `<SkeletonTable rows cols />` or `<SkeletonRow columns />` | Table / card-list loading. The skeleton's shape cues "what's coming." |
| `<Spinner size="small" />` | Inline within a button or row action awaiting a network response. |
| `<Spinner size="large" />` | Full-page first-load (rare — prefer skeleton). |

```jsx
import { Spinner, SkeletonTable, EmptyState } from '../components/ui';

if (loading) return <SkeletonTable rows={8} columns={5} />;
if (error) return <ErrorBanner error={error} retry={refetch} />;
if (rows.length === 0) return <EmptyState heading="No patients yet" ... />;
return <PatientTable rows={rows} />;
```

**Hard timeout convention**: a list/page that's been "loading" >15 s
should flip to an error state with a retry button. Don't leave a
blank screen or an infinite spinner. The page's data-fetching hook is
responsible for the timeout (not the spinner itself).

---

## #691 — Modal dialogs

Two surfaces:

| For | Use |
|---|---|
| Yes/no confirmation, prompt for one input | `notify.confirm()` / `notify.prompt()` (`utils/notify.jsx`) |
| Page-level form, picker, multi-step flow | `<Modal />` (this module) |

Both implement the canonical close affordances:

- **ESC closes** (unless `destructive: true`).
- **Click-outside closes** (unless `destructive: true`).
- **Top-right X** (unless `hideClose: true`).
- **role="dialog" + aria-modal + aria-labelledby** are wired automatically.
- Focus is captured on open + restored to the previously-focused element
  on close.

```jsx
import { Modal, FormField } from '../components/ui';

<Modal
  open={open}
  title="New patient"
  onClose={() => setOpen(false)}
  footer={<>
    <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
    <button className="btn-primary" onClick={save}>Save</button>
  </>}
>
  <FormField label="Full name" required htmlFor="p-name">
    <input id="p-name" className="input-field" value={name} onChange={...} />
  </FormField>
</Modal>
```

For destructive confirmations (Delete patient, Revoke API key) prefer
`notify.confirm({ destructive: true, ... })` — the red button signals
the destructive choice and ESC/click-outside don't close (forcing an
explicit Cancel/Confirm choice).

---

## #694 — Pagination

`<Pagination />` is page-numbers with prev/next, total-count, and
range label ("Showing 1–50 of 253"). One pattern, always.

```jsx
import { Pagination } from '../components/ui';

<Pagination
  page={page}
  pageSize={50}
  total={total}
  onChange={(p) => {
    setPage(p);
    navigate(`?page=${p}`, { replace: true });
  }}
/>
```

**Deprecated patterns**:

- Infinite scroll — breaks the back button and orientation on long lists.
  If you absolutely need it for a feed surface (e.g. notifications), use
  it AND keep a "view all" surface that switches to pagination.
- "Load more" button — provides no orientation. Use page-numbers instead.

**URL-sync via `?page=N`** is recommended — gives the back button a
useful history and makes pages bookmarkable. The component itself is
URL-agnostic; the caller wires the navigate(...) call.

---

## #695 — Search / filter

`<SearchInput />` with 250 ms debounce, magnifier icon left, clear-X
on the right when there's a value. Toolbar layout: **search left,
filter chips middle, action buttons right**.

```jsx
import { SearchInput } from '../components/ui';

<div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
  <SearchInput
    value={query}
    onSearch={(q) => setQuery(q)}
    placeholder="Search patients…"
  />
  <FilterChips ... />
  <div style={{ marginLeft: 'auto' }}>
    <button className="btn-primary">Add patient</button>
  </div>
</div>
```

- One debounce timing (250 ms) across all list views — no per-page tuning.
- The clear-X (`<X />` icon) appears when the value is non-empty.
- Place ONLY on the left of the toolbar; do not embed search inside a
  column header (deprecated; was used on Audit Log only).

---

## Migration guidance

This refactor ships the primitives + documents the conventions. Existing
surfaces continue to work as-is. **When you next touch an existing list /
form / modal page for an unrelated change, opportunistically migrate that
page's local handcrafted version to the shared primitive.** Don't do a
big-bang sweep; the diff would be unreviewable.

The 5–10 most-visible surfaces (Dashboard, Patients, Leads, Invoices,
Inbox, Reports, Calendar, Channels, AuditLog, KnowledgeBase) are good
first migration targets — those carry the most user-facing inconsistency
weight.
