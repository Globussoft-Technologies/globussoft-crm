# Wellness Admin Support Chatbot — Staff Knowledge Base

This document is the canonical how-to source for the wellness clinic staff support chatbot. It is written for non-technical staff (front-desk, telecallers, doctors, professionals, helpers, managers and the owner). Every route listed here is a real page in this CRM; nothing links to unfinished pages.

Key facts to remember:

- This CRM is one login for the whole clinic. The left sidebar shows only what your role is allowed to see, so two staff members may see different menus.
- An appointment and a visit are the same booking at different stages. A new booking is a visit with status "booked".
- The visit lifecycle is: Booked, Confirmed, Arrived, In-treatment, Completed. A visit can also end as No-show or Cancelled. "Pending" on the Appointments page means booked but no doctor assigned yet.
- RBAC role is what you can do (ADMIN = owner, MANAGER = clinic manager, USER = staff, CUSTOMER = patient). Wellness role is what you are (doctor, professional, telecaller, helper).
- AdsGPT and Callified are separate Globussoft products that open in their own sites. AdsGPT is only for creating ads. Callified owns all voice calling and WhatsApp automation. Neither shares data with this CRM automatically.
- The floating robot button opens the support assistant (this chatbot). Drag it anywhere on screen; its position is remembered on that computer. It answers questions about using the CRM, not medical questions.

---

## Sidebar map

The sidebar groups pages like this (some groups only appear for admin/manager):

- Top block (no heading): Owner Dashboard, Recommendations, plus external AdsGPT and Callified launch buttons for admins and managers.
- Clinical: Calendar, Appointments, My appointments, Patients, Waitlist, Prescriptions, My Prescriptions, Visits, E-Signatures.
- Catalog: Service Catalog, Service Categories, Drug Catalogue, Memberships.
- Scheduling: Resources, Holidays, Working Hours.
- Staff: Attendance, Attendance Dashboard, Leave.
- Leads & Revenue: Unified Inbox, WhatsApp Threads, Telecaller Queue, All Leads, Converted Leads, Callified Data, Tasks, Routing Rules.
- Finance: Point of Sale, Estimates, Expenses, Payments, Patient Wallets, Gift Cards, Coupons, Cashback Rules.
- Marketing: SMS / Email Blasts.
- Reports: P&L + Attribution, Per-Location, Loyalty + Referrals, Surveys, Knowledge Base.
- Appointments: Book Appointment, My bookings.
- Products: Product Categories, Products, Auto-consumption.
- Inventory Admin: Vendors, Receipts, Adjustments.
- Admin: Locations, Staff, Roles, Commission Profiles, Revenue Goals, Channels, Approvals, Audit Log, Privacy, Settings.

If a page is missing from your sidebar, it is a permissions issue — ask the owner or manager to check your role under Admin → Roles.

---

## Owner Dashboard

Route: /wellness

Who sees it: owner and manager (ADMIN/MANAGER or wellnessRole owner/manager/admin). Other roles land on their own pages (telecallers land on Telecaller Queue, doctors on Calendar).

What it shows:

- Greeting and location filter (when more than one location is active).
- KPI tiles: today's appointments, revenue this month, today's expected revenue, occupancy percentage, new leads today, pending approvals, active treatment plans, no-show risk. Most tiles open the matching page when clicked.
- Yesterday's actuals: visits completed and revenue.
- Top recommendation card from the AI orchestrator.
- AdsGPT and Callified one-click launch cards (opens those products logged in as you).
- 30-day revenue chart.

---

## Recommendations (AI orchestrator)

Route: /wellness/recommendations

What it is: every day at 7 AM IST the system proposes action cards, for example "boost hair-transplant campaign budget" or "fill 3 open slots today".

How to act on a recommendation:

1. Go to Recommendations from the top of the sidebar.
2. Read the pending cards. Use the status chips (pending / approved / rejected / all) to filter.
3. Click Approve to run the action, or Reject to dismiss it. You are asked to confirm.
4. Managers and admins can also click Run orchestrator now to generate fresh recommendations without waiting for the daily run.

---

## Patients

Route: /wellness/patients

### How to add a new patient

1. Open Clinical → Patients.
2. Click the + Add button at the top right and choose New patient.
3. Fill in name, phone, email, gender, date of birth, blood group, allergies and primary location.
4. Add a source if you know it (Meta ad, walk-in, referral, Google, and so on).
5. Save. The patient is immediately searchable.

### How to search for a patient

1. Open Clinical → Patients.
2. Type name, phone or email in the search box. Results update as you type.
3. Use Filters to narrow by source, gender, tags or date added.

### How to import or export patients (CSV)

Use the CSV import/export toolbar at the top of the Patients page (separate from the + Add button). Download the template, fill it, and import. Export downloads the current filtered list.

### How to open a patient's full record

Click the patient's row on the Patients page. The detail page (/wellness/patients/:id) has ten tabs:

1. Case history — timeline of visits, prescriptions, consents and plans.
2. New prescription — write a prescription for a visit.
3. Consent form — capture a signature on a consent template.
4. Treatment plans — multi-session packages with progress.
5. Log visit — record a new clinical visit with vitals, notes and photos.
6. Photos — before/after treatment photos.
7. Inventory used — products consumed during that patient's visits.
8. Telehealth — start or join a video consultation (Jitsi).
9. Wallet — credits, cashback, gift-card balance and transactions.
10. Memberships — active plans and entitlements.

The header of the detail page also has a Download PDF button (full patient summary) and the loyalty points card (view history, redeem points).

### How to edit or tag a patient

On the patient detail page, use the edit option in the header. On the Patients list, each row has a tag picker, and you can select multiple rows for bulk tagging.

Deleting a patient is restricted to ADMIN and only from the backend; the normal flow is to tag or archive instead of delete.

---

## Appointments

Route: /wellness/appointments

What it is: the full appointment book for the clinic.

How to use it:

1. Open Clinical → Appointments.
2. The list defaults to this week. Change the date range, filter by doctor, or filter by status: booked, pending, confirmed, arrived, in-treatment, completed, cancelled, no-show. Use the text search for a patient name or phone.
3. Click a row to open the appointment and reschedule, confirm, mark arrived, start treatment, complete, or cancel.

### What "pending" means and how to assign a doctor

Pending means the booking exists but no doctor is assigned. Click Assign doctor on a pending row. Only admins, managers or users with the assign-appointments permission can do this. Doctors see only their own appointments.

---

## Book Appointment

Route: /wellness/book-appointment

### How to book an appointment

1. Open Appointments → Book Appointment.
2. Pick the patient (search by name or phone). Staff users booking for themselves see their own record pre-filled.
3. Choose the service, then the doctor/practitioner, then the date. Available time slots (9:00 to 19:00, half-hour steps) appear automatically; past slots are hidden.
4. If the patient has a membership, you can redeem a session instead of charging.
5. Add a reason or notes if needed, then Save. The booking appears on the Calendar and in the Appointments list.

Booking is automatically blocked on holidays, outside working hours, and when the chosen room/equipment is already in use.

### How to check in a walk-in

Book the appointment as above and set the status to Arrived (or In-treatment if they are already in a chair), or open it from the Calendar and move the status forward.

---

## Calendar

Route: /wellness/calendar

What it is: one-day grid with a column per practitioner.

How to use it:

1. Open Clinical → Calendar. Use the role filter to show only doctors, only professionals, and so on. Holidays show a banner.
2. Click an empty slot to create a new visit in the popup. The popup also offers quick-pick from the Waitlist if someone is waiting for that time.
3. Click a booked appointment to view, reschedule or move it through the status lifecycle.
4. Deep links: /wellness/calendar?date=YYYY-MM-DD and ?focus=<visitId> open a specific day/appointment.

---

## Waitlist

Route: /wellness/waitlist

What it is: patients waiting for a preferred time slot.

### How to add to the waitlist

1. Open Clinical → Waitlist.
2. Click Add, pick the patient and service, and set the preferred date range and estimated wait.
3. Save. The entry shows status waiting.

### How to promote a waitlist entry

When a slot opens, click the entry and choose promote to booked. Filter by status (waiting, offered, booked, expired, cancelled) or date range to manage the list.

---

## Prescriptions

Routes: /wellness/prescriptions (clinic-wide list), /wellness/my-prescriptions (your own, for staff who are also patients).

### How to write a prescription

1. Open the patient detail page and go to the New prescription tab.
2. Select the visit you are prescribing for.
3. Start typing a drug name and pick it from the catalogue. Fill dosage, frequency and duration. Add general instructions.
4. Save. The prescription appears in Case history and in the Prescriptions list.

### How to edit, download or send a prescription

1. Open Clinical → Prescriptions and filter by patient, or open Case history on the patient record.
2. Click the prescription to edit it, or use the Download PDF action.
3. Send on WhatsApp delivers the PDF to the patient's registered number.

---

## Visits

Route: /wellness/visits

What it is: a read-only report of completed clinical visits, defaulting to the last 30 days.

How to use it:

1. Open Clinical → Visits.
2. Set the date range. The page shows a per-patient summary.
3. Click a patient to drill into their visit-by-visit detail.

To log or edit a clinical visit, do it from the patient detail page (Log visit tab or Case history), not from this report.

---

## E-Signatures (consent forms)

Route: /signatures

What it is: tenant-wide list of signed consent forms. Capture happens per patient.

### How to capture a patient signature

1. Open the patient detail page → Consent form tab.
2. Pick the consent template (for example hair transplant, Botox/fillers, laser).
3. Hand the device to the patient. They read and sign on the signature canvas.
4. Save & Generate PDF. The signed PDF is stored on the patient record and listed under E-Signatures.

---

## Service Catalog, Categories and Packages

Routes: /wellness/services, /wellness/service-categories

### How to add a service

1. Open Catalog → Service Catalog (/wellness/services).
2. Click New service.
3. Fill name, one or more categories, ticket tier (low/medium/high), base price, duration in minutes, target marketing radius in km, and a description. You can add an image.
4. Save. The service is immediately bookable.

### How to manage packages and active treatments

- Packages live in the Packages tab on the Service Catalog page (staff/admin only). Build a bundle of sessions with a price.
- Active Treatments (also a tab on the same page) shows treatment plans currently in progress across patients.

### How to manage service categories

1. Open Catalog → Service Categories (/wellness/service-categories).
2. Add or edit a category with a name, optional parent category, display order, active on/off and an image. There is no slug field — the URL slug is generated automatically.

### How to manage the drug catalogue

1. Open Catalog → Drug Catalogue (/wellness/drugs).
2. Add drugs with name, generic name, dosage form (tablet, capsule, syrup, injection, topical, drops, inhaler, other), strength, default dosage/frequency/duration and notes.
3. Switch a drug to inactive to hide it from the prescription typeahead without deleting history.

---

## Memberships

Route: /wellness/memberships

What it is: the catalogue of sellable membership plans.

### How to create a membership plan

1. Open Catalog → Memberships.
2. Click New plan, set the name, included services/entitlements, price and validity.
3. Save. The plan can now be sold.

### How to sell a membership to a patient

Staff do not sell from the Memberships page itself. Sell from either:

- Point of Sale (/wellness/pos) — add a MEMBERSHIP or PACKAGE line and take payment, or
- the patient's detail page → Memberships tab.

Patients can also buy a plan themselves through the Razorpay purchase flow on the Memberships page when logged in as a customer.

---

## Point of Sale (POS) and cash registers

Route: /wellness/pos

### How to open and close a shift

1. Open Finance → Point of Sale.
2. Click Open Shift, pick the register and enter the opening cash float.
3. At the end of the day, click Close Shift, count the cash and enter the closing amount. The system shows expected vs actual and the difference.

### How to make a sale

1. Open Finance → Point of Sale.
2. Add lines: service, product, membership, package or gift card. Catalog prices fill automatically; adjust quantity, price and line discount as needed.
3. Optionally apply a basket discount (flat or percentage) or a coupon code (use Preview to check the math first).
4. Choose payment mode: cash, card, UPI, wallet, gift card, or combined.
5. Complete the sale. A receipt with an invoice number is generated.

Notes:

- Guest Checkout lets you sell to an anonymous walk-in without creating a patient.
- Admins and managers can override the grand total with a reason; it is recorded in the audit log.
- Refunding or voiding a POS sale is ADMIN-only.
- Managers can open the register management panel on the same page to add registers and record petty cash deposits/withdrawals.

---

## Invoices, Estimates, Expenses and Payments

Routes: /invoices, /estimates, /expenses, /payments

How they fit together:

- A POS sale automatically creates an invoice/receipt. Invoices can also be opened from /invoices (or the /wellness/invoices alias).
- Payments (/payments) lists all money received: mode, amount, date and the linked invoice. Filter by date range, mode or status.
- Estimates (/estimates) are quotations you can send before billing. Expenses (/expenses) tracks clinic spending.

### How to record a payment against an invoice

1. Open the invoice.
2. Click Record Payment.
3. Choose the mode (cash, card, UPI, Razorpay link, wallet credit) and enter the amount.
4. Save.

### How to issue a refund

- For invoices: open the invoice and choose Refund, enter amount and reason.
- For POS sales: only ADMIN can refund or void a sale.
- Refunds on captured Razorpay payments are processed from the Payments page where eligible.

### How to configure payment gateways

Gateway keys (Razorpay/Stripe) are set server-side as environment variables by your system administrator, not in the UI. The Payments page explains the exact variable names and webhook URLs. Once set, per-invoice Pay-Now and customer checkout become available.

---

## Wallet, Gift Cards, Coupons and Cashback

Routes: /wellness/wallet, /wellness/giftcards, /wellness/coupons, /wellness/cashback-rules

### How to check or adjust a patient's wallet

1. Open Finance → Patient Wallets (/wellness/wallet).
2. Search the patient to see balance and the transaction list (gift-card credits, cashback, refunds, debits).
3. Admins can post a manual credit or debit from this page.

### How to issue a gift card

1. Open Finance → Gift Cards (/wellness/giftcards).
2. Click Issue, set the amount and recipient. A 16-character code is generated and shown once — copy it immediately.
3. Cards can be cancelled or reactivated; a redeemed card is final.

Patients buy gift cards themselves from the Buy Gift Cards storefront, and the value lands on the chosen patient's wallet after successful Razorpay payment.

### How to create a coupon

1. Open Finance → Coupons (/wellness/coupons).
2. Create a percentage or flat-amount code.
3. Use Preview a code to verify the discount before sharing it. Deleting coupons is ADMIN-only.

### How cashback rules work

Finance → Cashback Rules (/wellness/cashback-rules) defines automatic wallet credit as a percentage of a paid visit, optionally with a minimum spend or a list of services. When a visit completes, the first matching rule applies and the credit appears in the patient's wallet.

---

## Inventory (products, vendors, receipts, adjustments, auto-consumption)

Routes: /wellness/products, /wellness/product-categories, /wellness/vendors, /wellness/inventory-receipts, /wellness/inventory-adjustments, /wellness/auto-consumption-rules

Important: the Clinical → Inventory page (/wellness/inventory) is only an explainer. Wellness inventory is tracked as per-patient consumption plus central stock. Manage stock from the Products and Inventory Admin sections.

### How to add a product

1. Open Products → Products (/wellness/products).
2. Click Add product and fill name, SKU, category, selling price, dealer/purchase price, HSN code, barcode, opening stock and low-stock threshold.
3. Save. When stock falls below the threshold, a low-stock recommendation card appears on the Owner Dashboard.

### How to record stock received from a vendor

1. Open Inventory Admin → Receipts (/wellness/inventory-receipts).
2. Click New Receipt. Pick the product and vendor, enter quantity, unit cost, and optionally batch, expiry and supplier invoice number.
3. Save. Stock updates immediately. Edits are allowed only within five minutes of saving; to fix older receipts use a reverse entry (ADMIN with inventory.delete).

### How to adjust stock

1. Open Inventory Admin → Adjustments (/wellness/inventory-adjustments).
2. Pick the product, enter a signed quantity (+ or -) and choose a reason: shrinkage, damage, expiry, recount, transfer in/out, or manual.
3. Save. Adjustments are permanent history and cannot be edited afterwards.

### How automatic consumption works

Open Products → Auto-consumption (/wellness/auto-consumption-rules). For each service, define which product and quantity one visit consumes. When a visit is marked completed, stock is deducted automatically and shown on the patient's Inventory used tab.

### Vendors and categories

- Inventory Admin → Vendors (/wellness/vendors): add suppliers with contact, GSTIN and address; archive instead of delete.
- Products → Product Categories (/wellness/product-categories): organise products; supports images.

---

## Scheduling: Working Hours, Holidays, Resources

Routes: /wellness/working-hours, /wellness/holidays, /wellness/resources

### How to set working hours

1. Open Scheduling → Working Hours (/wellness/working-hours).
2. Search a staff member (or use the role chips). The editor is per staff member; there is no clinic-wide bulk edit.
3. Toggle each working day on/off and set start and end times. Default is 09:00–19:00 with Sunday off.
4. Save. Bookings outside these hours are blocked. Admins and managers can edit anyone; staff see their own row read-only.

### How to add a holiday

1. Open Scheduling → Holidays (/wellness/holidays).
2. Click Add Holiday. Set the date and name, optionally scope it to one location or one doctor, and choose whether it repeats every year.
3. Save. Booking on that date is blocked and the Calendar shows a banner.

### How to manage rooms and equipment (resources)

1. Open Scheduling → Resources (/wellness/resources).
2. Add each treatment room, machine or equipment with a name, type and location.
3. Resources are chosen at booking time in the Calendar New Visit popup. Double-booking a resource is blocked automatically.

---

## Staff: Attendance and Leave

Routes: /wellness/attendance, /wellness/attendance-dashboard, /wellness/attendance/calendar, /wellness/leave

### How to punch in and out

1. Open Staff → Attendance (/wellness/attendance).
2. Click Punch In when you start and Punch Out when you finish.
3. The My Last 30 Days grid shows your history: present, half day, late, absent, holiday.

### How to review everyone's attendance

1. Open Staff → Attendance Dashboard (/wellness/attendance-dashboard).
2. Pick a period (today, yesterday, 7 days, 30 days, month). KPI tiles show totals, late arrivals and early departures.
3. The all-staff table shows each person for the period. Only ADMIN can edit or delete an entry. Use the calendar link for a month view per person.

### How to apply for leave

1. Open Staff → Leave (/wellness/leave).
2. Check your balance cards, then click Apply.
3. Pick the policy, start and end dates, and a reason. Save.

### How to approve leave

Managers and admins see pending requests on the same Leave page with Approve and Reject buttons. Approved leave shows on the attendance calendar. Leave policies are configured by ADMIN.

---

## Leads, Telecaller Queue, Inbox and WhatsApp

Routes: /wellness/telecaller, /leads, /converted-leads, /inbox, /wellness/whatsapp, /wellness/whatsapp/templates, /lead-routing, /tasks

### Where leads come from

Leads arrive from Meta lead forms, Google Ads lead forms, WhatsApp (via Callified), the public booking page, walk-ins, IndiaMART/JustDial and manual entry. Routing rules (/lead-routing) decide who each new lead goes to.

### How to work the Telecaller Queue

1. Open Leads & Revenue → Telecaller Queue (/wellness/telecaller).
2. The queue sorts by SLA age and shows an AI score colour. Work from the top.
3. Click a lead, then use the call or WhatsApp action. After the conversation, set one disposition:
   - Interested — add notes for follow-up.
   - Callback — pick a date and time; a task is created automatically.
   - Booked — optionally attach appointment details.
   - Not interested.
   - Wrong number — destructive; use only when sure.
   - Junk — destructive; junk leads are removed from follow-up queues.

### Unified Inbox and WhatsApp Threads

- Unified Inbox (/inbox) is the combined message inbox.
- WhatsApp Threads (/wellness/whatsapp) is the two-way WhatsApp workspace: connect WhatsApp with the QR scanner, reply to conversations, assign a thread to a teammate, close, snooze or mark read. The + New composer (ADMIN) starts an outbound conversation. If a patient opts out, replies are blocked; an admin can unblock with a written DPDP reason.
- WhatsApp Templates (/wellness/whatsapp/templates) manages message templates with Meta: create, sync status from Meta, delete. Templates move through pending, approved, rejected states.

### Tasks

Tasks (/tasks) holds all follow-ups — callbacks, reminders and manual tasks. Completing a callback task from the queue also updates the lead.

---

## Reports

Routes: /wellness/reports, /wellness/per-location, /wellness/loyalty

### The four report tabs

Reports (/wellness/reports) has exactly four tabs:

1. P&L by Service — revenue, ad spend, product cost and margin per service.
2. Per Professional — appointments, revenue and utilisation per practitioner.
3. Per Location — clinic-level revenue and occupancy.
4. Marketing Attribution — which source each conversion came from.

Every tab has a date-range filter and Export as CSV, XLSX or PDF.

### Per-Location dashboard

Reports → Per-Location (/wellness/per-location) shows one column per active clinic location with KPIs, top services, staff on duty and weekly revenue. It only appears when you have at least two locations.

### Loyalty and referrals

Reports → Loyalty + Referrals (/wellness/loyalty) has four areas: monthly leaderboard, auto-credit rules (managers and above), a patient lookup with manual credit/redeem, and the referrals pipeline with reward actions.

---

## Marketing

Route: /marketing

What it is: SMS and email blasts to patient or lead lists. Pick the audience, write the message, preview and send. Landing pages and drip sequences are part of the generic CRM product and are not shown in the wellness sidebar.

---

## Patient-facing extras (customer side)

These exist for patients, not for staff operations:

- Patient portal: /wellness/portal — patients log in with phone + OTP to see their visits, prescriptions and products, and to book, cancel or reschedule their own appointments.
- Public booking page: /book/:slug — the shareable link new patients use to book without an account.
- Buy Gift Cards (/wellness/buy-giftcards) and My Transactions (/wellness/my-transactions): customer self-service pages for gift-card purchases and their own payment history.
- My bookings (/wellness/my-bookings): the customer's own appointment list.

Staff generally never need to operate these; they are mentioned here so you can guide a patient who calls.

---

## Admin: Locations, Staff, Roles, Audit and Settings

Routes: /wellness/locations, /staff, /settings/roles, /audit-log, /settings, plus /commission-profiles, /revenue-goals, /channels, /approvals, /privacy

### How to manage clinic locations

1. Open Admin → Locations (/wellness/locations).
2. Add a location with name, address, city, state, pincode, phone and email.
3. Activate or deactivate locations as needed. Deactivating hides it from booking and filters.

### How to add a staff member

1. Open Admin → Staff (/staff). This page is ADMIN-only.
2. Click Add Staff and enter name, phone, email, RBAC role (ADMIN, MANAGER or USER) and wellness role (doctor, professional, telecaller or helper).
3. Save. If email is configured, the person receives an invite to set their password.

### How to manage roles and permissions

1. Open Admin → Roles (/settings/roles).
2. Create or edit a role and grant module-level permissions (read, write, delete, export) per module: patients, appointments, prescriptions, inventory, marketing, settings, and so on.
3. Assign the role to users. Sidebar entries appear or hide automatically based on these permissions.

### How to set commission profiles and revenue goals

- Commission Profiles (/commission-profiles) defines per-staff commission rules.
- Revenue Goals (/revenue-goals) sets targets used by dashboards and reports.

### Audit log and privacy

- Audit Log (/audit-log) records sensitive actions (overrides, refunds, deletes, exports) with who/when/what.
- Privacy (/privacy) holds data-retention and consent settings.

### How to configure the AI support chatbot provider

1. Open Admin → Settings (/settings) and find the AI Provider (Support Chatbot) card.
2. Choose the provider: Gemini (Google generateContent) or an OpenAI-compatible endpoint.
3. Paste the API key. For Gemini you can also set a custom base URL (for the internal proxy) and the model name (default gemini-2.5-flash-lite).
4. Click Test Connection. When it says OK, click Update Provider to save.
5. The key is stored encrypted and is never shown again — only a masked hint. Use Remove to delete the configuration.

Keys are per clinic (BYOK). Without a key, the chatbot tells staff to ask an administrator instead of answering.

---

## Common troubleshooting

### The chatbot says the AI provider is not configured

An administrator must open Admin → Settings (/settings) and complete the AI Provider (Support Chatbot) card. See the steps above. Staff cannot fix this themselves.

### A page is missing from my sidebar

Your role does not have permission for it. Ask the owner or manager to check Admin → Roles and your user record on Admin → Staff.

### I cannot find a patient

- Check the phone number without country-code mismatch.
- Clear the Filters panel; a location or source filter may be hiding them.
- Use the global search bar at the very top of the screen as a fallback.

### I cannot book a slot on the Calendar

- Check Scheduling → Holidays for that date.
- Check the practitioner's Scheduling → Working Hours.
- The room or equipment may already be booked for that slot — pick another resource or time.

### I do not see Invoices in the sidebar

Invoices (/invoices) is reachable by URL (or /wellness/invoices) but is intentionally not listed in the wellness sidebar. Day-to-day clinic billing happens in Point of Sale, and money tracking happens in Payments.

### Stock looks wrong

- Check Inventory Admin → Receipts for what was received.
- Check Inventory Admin → Adjustments for manual corrections.
- Check Products → Auto-consumption rules — a wrong rule over- or under-deducts on every completed visit.

### A WhatsApp reply will not send

The patient may have opted out — the thread shows an opt-out chip. Only an admin can unblock, and it requires a written DPDP reason.

---

## Quick route reference

- Owner Dashboard: /wellness
- Recommendations: /wellness/recommendations
- Calendar: /wellness/calendar
- Appointments: /wellness/appointments
- Book Appointment: /wellness/book-appointment
- My appointments (practitioner): /wellness/my-appointments
- Patients: /wellness/patients
- Patient detail: /wellness/patients/:id
- Waitlist: /wellness/waitlist
- Prescriptions: /wellness/prescriptions
- My Prescriptions (staff self): /wellness/my-prescriptions
- Visits report: /wellness/visits
- E-Signatures: /signatures
- Service Catalog (services, packages, active treatments): /wellness/services
- Service Categories: /wellness/service-categories
- Drug Catalogue: /wellness/drugs
- Memberships: /wellness/memberships
- Point of Sale: /wellness/pos
- Estimates: /estimates
- Expenses: /expenses
- Payments: /payments
- Invoices: /invoices
- Patient Wallets: /wellness/wallet
- Gift Cards: /wellness/giftcards
- Coupons: /wellness/coupons
- Cashback Rules: /wellness/cashback-rules
- Marketing blasts: /marketing
- Reports: /wellness/reports
- Per-Location report: /wellness/per-location
- Loyalty and referrals: /wellness/loyalty
- Surveys: /surveys
- Knowledge Base: /knowledge-base
- Telecaller Queue: /wellness/telecaller
- All Leads: /leads
- Converted Leads: /converted-leads
- Unified Inbox: /inbox
- WhatsApp Threads: /wellness/whatsapp
- WhatsApp Templates: /wellness/whatsapp/templates
- Callified Data: /callified-data
- Tasks: /tasks
- Routing Rules: /lead-routing
- Resources: /wellness/resources
- Holidays: /wellness/holidays
- Working Hours: /wellness/working-hours
- My Attendance (punch in/out): /wellness/attendance
- Attendance Dashboard (all staff): /wellness/attendance-dashboard
- Attendance Calendar: /wellness/attendance/calendar
- Leave: /wellness/leave
- Product Categories: /wellness/product-categories
- Products: /wellness/products
- Auto-consumption rules: /wellness/auto-consumption-rules
- Vendors: /wellness/vendors
- Inventory Receipts: /wellness/inventory-receipts
- Inventory Adjustments: /wellness/inventory-adjustments
- Locations: /wellness/locations
- Staff: /staff
- Roles: /settings/roles
- Commission Profiles: /commission-profiles
- Revenue Goals: /revenue-goals
- Channels: /channels
- Approvals: /approvals
- Audit Log: /audit-log
- Privacy: /privacy
- Settings (incl. AI Provider card): /settings
- Patient portal (patients only): /wellness/portal
- Public booking page (patients only): /book/:slug
