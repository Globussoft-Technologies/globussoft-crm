# Registration Flow Verification Test

**Purpose:** Verify that after successful registration, candidates are stored in all 3 places

---

## Expected Flow

### For Trip-Linked Pages (Non-Draft Mode)

When a user submits registration on a trip-linked page in normal (non-registration-draft) mode:

1. **✅ Contact Created** (in CRM Leads)
   - Table: `Contact`
   - Fields: name, email, phone, company, source="tmc_registration"
   - Status: "Lead"
   - Location: `/crm/contacts` → All contacts list
   - Also: Travel Leads list (because source="tmc_registration")

2. **✅ Deal Created** (in CRM Leads)
   - Table: `Deal`
   - Title: `LP Inbound: [Page Title]`
   - Stage: "lead"
   - Amount: 0
   - Location: `/crm/deals` → Associated with Contact

3. **✅ Participant Created** (in Trip)
   - Table: `TripParticipant`
   - Fields: fullName, parentName, parentEmail, parentPhone
   - Additional: grade, school, city from form
   - Location: Trip detail page → Participants tab
   - Status: "pending" (waiting for approval/payment)

---

## Testing Checklist

### Step 1: Identify Test Pages
```sql
-- Find trip-linked pages
SELECT id, slug, title, tripId, templateType 
FROM landing_pages 
WHERE tripId IS NOT NULL 
AND status = 'PUBLISHED'
LIMIT 5;
```

Expected: Pages like `singapore-school-5d`, `japan-family-trip`, etc.

---

### Step 2: Test Registration Form Submission

#### Via React Renderer (Recommended)
```bash
# Navigate to:
https://crm.globusdemos.com/p/{slug}

# Fill form with test data:
- Name: "Test Student"
- Email: "test-student-123@example.com"
- Phone: "+919999999999"
- Parent Name: "Test Parent"
- Parent Email: "test-parent-123@example.com"
- Parent Phone: "+919988888888"

# Click "Register" button
# Expected: Thank you message OR redirect to microsite
```

#### Via Direct API (If Manual Testing Difficult)
```bash
# Get a valid page
TRIP_ID=123  # From query above
PAGE_ID=456

# Check if page is registration-draft mode
curl -X GET "https://crm.globusdemos.com/api/landing-pages/${PAGE_ID}" \
  -H "Authorization: Bearer <TOKEN>"

# Submit registration
curl -X POST "https://crm.globusdemos.com/api/landing-pages/${PAGE_ID}/submit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TOKEN>" \
  -d '{
    "name": "Test Student",
    "email": "test-student-123@example.com",
    "phone": "+919999999999",
    "parentName": "Test Parent",
    "parentEmail": "test-parent-123@example.com",
    "parentPhone": "+919988888888",
    "school": "Test School",
    "grade": "10"
  }'

# Expected response:
{
  "success": true,
  "message": "Thank you for your submission!",
  "successRedirectUrl": "/p/singapore-school-5d" 
}
```

---

### Step 3: Verify Lead Created

#### Check Generic Leads List
```
CRM → Contacts → All Contacts

Expected to see:
- Contact Name: "Test Parent"
- Email: "test-parent-123@example.com"
- Phone: "+919988888888"
- Source: "tmc_registration"
- Status: "Lead"
- Company: "Test School"
```

#### Check Travel Leads List  
```
CRM → Travel → Leads (or Travel Leads)

Expected to see:
- Same contact as above
- Filtered by source="tmc_registration"
- Shows all registration-driven leads
```

#### Via Query
```sql
SELECT id, name, email, phone, source, status, company
FROM contact
WHERE email = 'test-parent-123@example.com'
LIMIT 1;

-- Expected result:
-- id: [some_id]
-- name: "Test Parent"
-- email: "test-parent-123@example.com"
-- phone: "+919988888888"
-- source: "tmc_registration"
-- status: "Lead"
-- company: "Test School"
```

---

### Step 4: Verify Deal Created

#### Check in CRM Deals
```
CRM → Deals

Expected to see:
- Title: "LP Inbound: [Page Title]"
- Stage: "Lead"
- Amount: $0 / ₹0
- Contact: "Test Parent"
- Associated with Contact we found above
```

#### Via Query
```sql
SELECT d.id, d.title, d.stage, d.amount, c.name
FROM deal d
JOIN contact c ON d.contactId = c.id
WHERE c.email = 'test-parent-123@example.com'
ORDER BY d.createdAt DESC
LIMIT 1;

-- Expected result:
-- id: [some_id]
-- title: "LP Inbound: [Page Title]"
-- stage: "Lead"
-- amount: 0
-- name: "Test Parent"
```

---

### Step 5: Verify Participant Created in Trip

#### Check Trip Participants
```
CRM → Travel → Trips → [Trip Name] → Participants

Expected to see:
- Full Name: "Test Student"
- Parent Name: "Test Parent"
- Parent Email: "test-parent-123@example.com"
- Parent Phone: "+919988888888"
- Additional: Grade, School, City
- Status: "pending"
```

#### Via Query
```sql
SELECT id, tripId, fullName, parentName, parentEmail, parentPhone, applicationStatus
FROM trip_participant
WHERE tripId = 123  -- The trip ID from earlier
AND parentEmail = 'test-parent-123@example.com'
ORDER BY createdAt DESC
LIMIT 1;

-- Expected result:
-- id: [some_id]
-- tripId: 123
-- fullName: "Test Student"
-- parentName: "Test Parent"
-- parentEmail: "test-parent-123@example.com"
-- parentPhone: "+919988888888"
-- applicationStatus: "pending"
```

---

### Step 6: Verify Analytics Recorded

#### Check Submission Analytics
```sql
SELECT id, landingPageId, eventType, metadata, createdAt
FROM landing_page_analytics
WHERE landingPageId = 456  -- The page ID from earlier
AND eventType = 'FORM_SUBMIT'
ORDER BY createdAt DESC
LIMIT 1;

-- Expected result:
-- id: [some_id]
-- landingPageId: 456
-- eventType: "FORM_SUBMIT"
-- metadata: {"kind": "lead-capture"} or {"kind": "registration-draft"}
-- createdAt: [recent timestamp]
```

---

## Expected Results Summary

After successful registration, you should find:

| Location | Type | Count | Status |
|----------|------|-------|--------|
| **Contacts (Leads)** | Contact record | 1 | ✅ Should exist |
| **Travel Leads** | Contact with source="tmc_registration" | 1 | ✅ Should exist |
| **Deals** | Deal linked to Contact | 1 | ✅ Should exist |
| **Trip Participants** | TripParticipant record | 1 | ✅ Should exist |
| **Analytics** | FORM_SUBMIT event | 1 | ✅ Should exist |

**Total: 3 places where candidate data appears**
1. Leads (Contact + Deal)
2. Travel Leads (Contact with tmc_registration source)
3. Trip Participants (TripParticipant record)

---

## Troubleshooting

### If Contact NOT Created

**Check:**
```
✓ Email is valid
✓ Phone is valid
✓ Name is not empty
✓ Page is published
✓ Backend logs for errors
```

**Endpoint hit check:**
```bash
tail -f /var/log/backend.log | grep "Submit error"
```

---

### If Deal NOT Created

**Check:**
```
✓ Contact was created successfully
✓ No errors in applyLeadRouting
✓ tenantId matches
```

---

### If Participant NOT Created

**Check:**
```
✓ Page.tripId is set
✓ formComp.type is NOT "registrationForm" (if it is, registration-draft mode applies)
✓ isBrochureRequest = false
✓ fullName is extracted correctly from form
```

**Note:** If page is in registration-draft mode, PendingTripRegistration is created instead of TripParticipant.

---

### If Redirect NOT Working

**Check:**
```
✓ successRedirectUrl is in form props
✓ FormBlock received pageId parameter
✓ Backend returns redirect in response
✓ Frontend has new redirect handling code
```

---

## Code Paths to Verify

### For Regular Trip Registration (Non-Draft)
- Backend: `backend/routes/landing_pages.js` line 2850-2900 (create Contact + Deal + Participant)
- Frontend: `frontend/src/components/landing-blocks/BasicBlocks.jsx` (form submission)

### For Registration-Draft Mode
- Backend: `backend/routes/landing_pages.js` line 2925 (handleRegistrationDraft function)
- Creates: PendingTripRegistration + Contact + Deal (no direct TripParticipant yet)

---

## Sign-Off Checklist

After testing, verify:

- [ ] Contact created in CRM Leads
- [ ] Contact appears in Travel Leads (source = "tmc_registration")
- [ ] Deal created and linked to Contact
- [ ] TripParticipant created in Trip
- [ ] Redirect works (thank-you message or microsite)
- [ ] Analytics event recorded
- [ ] No errors in backend logs
- [ ] Form data preserved in all 3 locations

---

**Status:** Ready for QA Testing

