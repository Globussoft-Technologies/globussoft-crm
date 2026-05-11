# PR: Fix Expense Notification System

## Summary
Fixed broken expense notification system where:
- Admins/managers were NOT being notified when expenses were created
- Admins were receiving approval notifications instead of the creator
- Notifications were not being displayed in the bell due to missing `isRead` field

## Changes Made

### 1. **backend/lib/notificationService.js**
- **Added**: `isRead: false` field when creating notifications (line 112)
  - Previously notifications were created without isRead, causing them not to display
- **Added**: Comprehensive logging for debugging notification creation and socket.io emission

### 2. **backend/lib/notificationRulesEngine.js**  
- **Removed**: Duplicate `expense.submitted` listener (merged with `expense.created`)
- **Fixed**: `expense.created` event listener to:
  - Query for all ADMIN/MANAGER users in the tenant (line 156-161)
  - Notify each approver with expense details (line 163-175)
  - Add detailed logging for debugging
- **Fixed**: `expense.approved` event listener to:
  - Notify ONLY the creator (submitterId) not admins (line 195-211)
  - Add validation to ensure submitterId exists
- **Fixed**: `expense.rejected` event listener to:
  - Notify ONLY the creator (submitterId) not admins (line 217-233)
  - Include rejection reason in notification message

### 3. **backend/lib/eventBus.js**
- **Added**: Global io reference system:
  - `setIO(io)` function to set global socket.io instance (line 9-11)
  - `getIO()` function to retrieve global io instance (line 13-15)
- **Updated**: `emitEvent()` to use global io if not provided (line 181-183)
- **Exported**: `setIO` and `getIO` functions (line 388-389)

### 4. **backend/server.js**
- **Added**: Call to `setIO(io)` after socket.io server initialization (line 255-256)
  - Makes io reference available globally for eventBus

### 5. **backend/routes/expenses.js**
- **Added**: Better logging when emitting expense.created event (line 70-71)
- **Maintained**: Correct submitterId in all event emissions:
  - `expense.created`: submitterId = expense.userId (creator)
  - `expense.approved`: submitterId = updated.userId (creator)
  - `expense.rejected`: submitterId = updated.userId (creator)

### 6. **backend/routes/notifications.js**
- **Added**: Debug logging to track notification fetching:
  - Logs userId, tenantId, and where clause (line 20)
  - Logs total found vs returned count (line 38-39)
  - Helps identify query issues

## Notification Flow

### When Expense is CREATED:
```
User creates expense → 
  Emit expense.created event with submitterId, submitterName, amount, title →
  NotificationRulesEngine listener finds all ADMIN/MANAGER users →
  Creates notifications for each approver →
  Socket.io broadcasts to each approver's bell
```

### When Expense is APPROVED:
```
Admin approves expense →
  Emit expense.approved event with submitterId (creator), amount, title →
  NotificationRulesEngine listener gets creator's ID →
  Creates notification for creator only →
  Socket.io broadcasts to creator's bell
```

### When Expense is REJECTED:
```
Admin rejects expense →
  Emit expense.rejected event with submitterId (creator), rejectionReason →
  NotificationRulesEngine listener gets creator's ID →
  Creates notification for creator only with rejection reason →
  Socket.io broadcasts to creator's bell
```

## Testing Steps

1. **Clear browser cache** (Ctrl+Shift+Delete)
2. **Log in as regular user** (user@crm.com / password123)
3. **Create an expense** with title "Test" and amount ₹500
4. **Switch to Admin tab** (admin@globussoft.com / password123)
5. **Verify notification bell**:
   - ✅ Should show badge with count "1"
   - ✅ Should display: "[UserName] submitted an expense 'Test' for ₹500"
   - ✅ Click notification → goes to /expenses page
6. **Click "Approve" on the expense**
7. **Switch to User tab**
8. **Verify notification bell**:
   - ✅ Should show new notification: "Your expense 'Test' for ₹500 has been approved"
   - ✅ Click notification → goes to /expenses page

## Files Changed
- backend/lib/notificationService.js (1 change)
- backend/lib/notificationRulesEngine.js (3 listeners fixed)
- backend/lib/eventBus.js (2 functions added, 1 updated)
- backend/server.js (1 call added)
- backend/routes/expenses.js (logging improved)
- backend/routes/notifications.js (logging added)

## Key Fixes
1. ✅ Admins/managers now receive "expense for approval" notifications
2. ✅ Creators now receive "expense approved/rejected" notifications (not admins)
3. ✅ Notifications display properly in the bell (isRead = false)
4. ✅ Socket.io real-time delivery working via global io reference
5. ✅ Comprehensive logging for debugging

## Notes
- All changes are backwards compatible
- No database migrations needed
- Socket.io namespace: `user:${userId}` for targeted notifications
- Event listeners have detailed console logging for troubleshooting
