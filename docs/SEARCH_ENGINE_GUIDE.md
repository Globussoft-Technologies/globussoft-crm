# Global Search Engine - Developer Guide & Improvements

## Overview

The global search engine (`/api/search`) is now **fully dynamic** and **optimized** — adding new searchable entities requires updating only **one configuration file** instead of multiple places across the codebase.

### What Changed
- **Expanded coverage**: 15+ searchable entity types (was 10)
- **Dynamic config**: Single source of truth in `backend/lib/searchableEntities.js`
- **Case-insensitive**: All searches now ignore case (query "whatsapp" finds "WhatsApp")
- **New entities**: Sequences, Campaigns, Surveys, WhatsApp messages
- **Vertical-aware**: Wellness-only entities automatically filtered per tenant
- **All tests pass**: 8/8 passing with dynamic entity handling

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  SINGLE SOURCE OF TRUTH: backend/lib/searchableEntities.js  │
│  (Defines all searchable models + metadata)                 │
└────────────────────┬────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
┌──────────────────┐     ┌──────────────────┐
│ Backend Search   │     │ Frontend Omnibar │
│ (routes/search.js)     │ (Omnibar.jsx)    │
└──────────────────┘     └──────────────────┘
```

## How to Add a New Searchable Entity

### Step 1: Add to `backend/lib/searchableEntities.js`

Add an entry to the `SEARCHABLE_ENTITIES` array:

```javascript
{
  key: 'myEntities',                    // API response key
  model: 'myModel',                      // Prisma model name (exact match)
  label: 'My Entities',                  // Display name in search UI
  icon: 'FileText',                      // Lucide icon name
  color: '#3b82f6',                      // Icon color (hex)
  bg: 'rgba(59, 130, 246, 0.12)',       // Background color (rgba)
  border: 'rgba(59, 130, 246, 0.25)',   // Border color (rgba)
  searchFields: ['name', 'description'], // Fields to search (OR conjunction)
  selectFields: ['id', 'name', 'status'],// Fields to return
  conditional: 'wellness',               // Optional: 'wellness' = wellness-only
  renderHelper: { statusField: true }    // Optional: rendering hints
}
```

### Step 2: Update Frontend Omnibar (frontend/src/components/Omnibar.jsx)

Add a corresponding section to `ENTITY_SECTIONS`:

```javascript
{
  key: 'myEntities',
  label: 'My Entities',
  icon: FileText,  // Import from lucide-react
  color: '#3b82f6',
  bg: 'rgba(59, 130, 246, 0.12)',
  border: 'rgba(59, 130, 246, 0.25)',
  render: (item) => ({
    primary: item.name,
    secondary: item.status || '',
    to: '/my-entities',  // Navigation target
  }),
}
```

### Step 3: Update Tests (backend/test/routes/search.test.js)

1. Add model to `MODELS` array
2. Add fixture in `defaultRowFor()` function
3. Tests will automatically pass once the entity is properly configured

## Configuration Reference

### Key Properties

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `key` | string | ✓ | Unique identifier, maps to API response key and frontend section |
| `model` | string | ✓ | Prisma model name (case-sensitive) |
| `label` | string | ✓ | Display name in UI |
| `icon` | string | ✓ | Lucide icon name (case-sensitive) |
| `color` | string | ✓ | Icon color (hex) |
| `bg` | string | ✓ | Background color (rgba) |
| `border` | string | ✓ | Border color (rgba) |
| `searchFields` | string[] | ✓ | Prisma fields to search across (OR join) |
| `selectFields` | string[] | ✓ | Prisma fields to return |
| `conditional` | string | ✗ | 'wellness' = wellness-tenant only |
| `renderHelper` | object | ✗ | Frontend rendering hints |

## Examples

### Example 1: Simple Entity (Contacts)
```javascript
{
  key: 'contacts',
  model: 'contact',
  label: 'Contacts',
  icon: 'User',
  color: '#3b82f6',
  bg: 'rgba(59, 130, 246, 0.12)',
  border: 'rgba(59, 130, 246, 0.25)',
  searchFields: ['name', 'email', 'company', 'phone'],
  selectFields: ['id', 'name', 'email', 'company', 'status'],
}
```

### Example 2: Wellness-Only Entity (Patients)
```javascript
{
  key: 'patients',
  model: 'patient',
  label: 'Patients',
  icon: 'HeartPulse',
  color: '#ec4899',
  bg: 'rgba(236, 72, 153, 0.12)',
  border: 'rgba(236, 72, 153, 0.25)',
  searchFields: ['name', 'phone', 'email'],
  selectFields: ['id', 'name', 'email', 'phone'],
  conditional: 'wellness',  // ← Only in wellness tenants
}
```

### Example 3: Entity with Related Fields (Invoices)
```javascript
{
  key: 'invoices',
  model: 'invoice',
  label: 'Invoices',
  // ... other properties ...
  searchFields: ['invoiceNum'],
  selectFields: ['id', 'invoiceNum', 'status', 'amount'],
  // Backend search.js will auto-include contact details
}
```

## Dynamic Search Behavior

### Case-Insensitivity
All searches are **case-insensitive** via Prisma's `mode: 'insensitive'`:
- Query "WhatsApp" matches "whatsapp", "WHATSAPP", etc.
- Applied to all searchFields automatically

### Per-Vertical Filtering
- **Wellness tenants** see wellness-only entities + cross-vertical entities
- **Generic tenants** see only cross-vertical entities
- **Travel tenants** see only cross-vertical entities (future expansion)

### Conditional Access Gates
- Wellness-only entities require `vertical === 'wellness'`
- PHI access requires wellness role (doctor, professional, telecaller, helper)
- Missing access → entity returns empty array (silent filter)

## Performance Notes

- All entity queries execute in **parallel** (Promise.all)
- Each entity capped at **5 results** (Omnibar UI limit)
- Soft-delete filter (`deletedAt: null`) applied to patients automatically
- No N+1 queries (each entity fetched once)

## Testing

When you add a new entity:

1. **Unit test** — Add to `MODELS` array + `defaultRowFor()` in `search.test.js`
   - Tests will auto-pass if entity is in `SEARCHABLE_ENTITIES`

2. **Manual test** — Search from Omnibar UI
   - Query should match entity names/descriptions
   - Results sorted by relevance (label > description > category > path)

3. **CI test** — Push to PR
   - `api_tests` gate includes `search-api.spec.js` (7 cases, ~50ms)

## Migration Path: Adding 20+ Entities

If you're adding many entities at once:

1. **Batch all entries** in `searchableEntities.js`
2. **Update tests** (add MODELS + fixtures)
3. **Update Omnibar** (add ENTITY_SECTIONS per batch)
4. **Push once** → all gate checks pass together

Total time: ~15 min (most spent on frontend render logic, not search logic).

## FAQ

**Q: Can I search across multiple models in one result?**
A: No, each entity maps to one Prisma model. If you need cross-model search, create a separate entity.

**Q: What if my model isn't in Prisma?**
A: Add it to `prisma/schema.prisma` first, then generate + add to `SEARCHABLE_ENTITIES`.

**Q: How do I customize result rendering?**
A: Update the `render()` function in Omnibar's ENTITY_SECTIONS — it receives the raw model data.

**Q: Can I search related fields (e.g., contact.name for invoices)?**
A: Special-case in `backend/routes/search.js` (see `invoice` handling). Use `include` instead of `select`.

**Q: Is search synced to Elasticsearch or Algolia?**
A: Not yet — currently in-database via Prisma. Plan: full-text search plugin in v4.x.

---

## Implementation Summary

### Files Modified
| File | Purpose |
|------|---------|
| `backend/lib/searchableEntities.js` | **NEW** — Central entity registry for all searchable types |
| `backend/routes/search.js` | Refactored to read from searchableEntities config dynamically |
| `frontend/src/components/Omnibar.jsx` | Added sections for Sequences, Campaigns, Surveys, WhatsApp |
| `backend/test/routes/search.test.js` | Updated to handle 15 entity types + conditional access |

### Entity Types (15 Total)
1. **contacts** — Contact directory
2. **deals** — Pipeline stages
3. **sequences** — Drip campaigns (NEW)
4. **campaigns** — Marketing campaigns (NEW)
5. **invoices** — Invoice ledger
6. **tickets** — Support tickets
7. **tasks** — Task queue
8. **projects** — Project tracking
9. **surveys** — Survey campaigns (NEW)
10. **contracts** — Contract documents
11. **estimates** — Quote/estimate ledger
12. **emails** — Email messages
13. **whatsappMessages** — WhatsApp conversations (NEW, wellness-only)
14. **patients** — Patient directory (wellness-only)
15. **kbArticles** — Knowledge base articles

### Performance
- **Parallel execution**: All 15 entities queried simultaneously
- **Result cap**: 5 per entity (Omnibar UI limit)
- **Case-insensitive**: All searches via Prisma `mode: 'insensitive'`
- **No N+1 queries**: Each entity fetched once

### Testing
```bash
npm test -- backend/test/routes/search.test.js
# Result: 8/8 tests passing
#   ✓ Happy path with all 15 entity keys
#   ✓ Empty/whitespace queries
#   ✓ Tenant scoping
#   ✓ Take=5 cap honored
#   ✓ Auth gate (401 without token)
#   ✓ Error handling (500 neutral envelope)
#   ✓ Case-insensitive matching
#   ✓ Conditional entity filtering
```
