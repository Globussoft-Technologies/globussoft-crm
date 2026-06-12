# Privacy Policy — Globus CRM

**Effective date:** 11 June 2026
**Last updated:** 11 June 2026
**Canonical URL:** https://globuscrm.globussoft.com/privacy-policy

Globus CRM ("the Service") is an enterprise customer-relationship-management platform operated by **Globussoft Technologies** ("Globussoft", "we", "us", "our"). This Privacy Policy explains what personal data we collect, how we use it, who we share it with, and the rights available to you.

This policy applies to:

- the Globus CRM web application (including the demo at `globuscrm.globussoft.com`),
- the **Globus CRM mobile applications** for Android and iOS,
- public pages served by the Service (booking pages, landing pages, surveys, quote-acceptance pages, patient and customer portals, knowledge-base articles, trip microsites),
- our marketing website,
- and the Globus CRM Partner API.

> **Note for tenant customers:** Globus CRM is a multi-tenant platform. For the business data your organisation stores in the CRM (your contacts, leads, deals, patients, etc.), **your organisation is the data controller** and Globussoft acts as a **data processor** on your behalf. Where this policy says "you", it covers both users of the Service and individuals whose data is processed through it.

---

## 1. Who we are

**Globussoft Technologies**
India
Privacy contact: **privacy@globussoft.com**
Grievance / Data Protection Officer: **dpo@globussoft.com**

If you interact with a business that uses Globus CRM (for example, you submitted a form on their landing page or booked an appointment at their clinic), direct privacy requests first to that business — they control your data. We will assist them in fulfilling your request.

## 2. Information we collect

### 2.1 Account and profile data

When your organisation creates an account or an administrator provisions you as a user, we collect:

- Name, email address, and hashed password (passwords are stored using bcrypt and are never readable by us)
- Role and permissions (admin / manager / user, and vertical-specific roles such as doctor, professional, or telecaller)
- Two-factor authentication secrets, if you enable 2FA
- SSO and SCIM identity attributes, if your organisation uses single sign-on or automated user provisioning
- Profile settings, email signatures, and notification preferences

### 2.2 CRM business data (processed on behalf of tenants)

Tenants store records about their own customers and prospects in the Service, which may include:

- **Contacts and leads** — names, email addresses, phone numbers, company details, addresses, deal and pipeline history, notes, tasks, attachments
- **Communications** — emails sent and received through connected mailboxes, SMS and WhatsApp messages, live-chat transcripts, call logs and call recordings/transcriptions where the tenant enables telephony features
- **Financial records** — quotes, estimates, invoices, payments, expenses, and contracts
- **Documents and signatures** — uploaded files, generated PDFs, and electronic signature records
- **Survey responses and support tickets**

### 2.3 Health-related data (wellness vertical)

Tenants operating clinics or wellness businesses may store **patient records**: visit history, prescriptions, treatment plans, consent forms (including drawn signatures), and clinical photographs. This is sensitive data. Protections specific to this data:

- Patient personally-identifiable fields support **field-level AES-256-GCM encryption at rest**
- Access is restricted by role (e.g. prescriptions are editable only by the prescribing clinician)
- Patient portal access requires phone + one-time-passcode verification

The tenant (the clinic) is the controller of patient data; we process it solely to provide the Service.

### 2.4 Payment data

Payments are processed by **Stripe** and **Razorpay**. We do not store full card numbers or bank credentials on our servers — payment instrument details are handled by the payment provider. We retain transaction metadata (amount, currency, status, invoice reference) needed for billing records.

### 2.5 Data collected automatically

- **Usage and log data** — IP address, browser type, pages viewed, API requests, timestamps. Used for security (rate limiting, abuse prevention), debugging, and audit trails.
- **Audit logs** — administrative and data-changing actions are recorded in a tamper-evident audit log (hash-chained) for security and compliance.
- **Error diagnostics** — we use Sentry for error monitoring; error reports may include request context.
- **Website visitor tracking** — if a tenant enables the web-visitor feature on their own website, that feature records page visits and form submissions for the tenant's site. The tenant is responsible for disclosing this to their visitors.

### 2.6 Data from third-party integrations

If you or your organisation connect integrations, we receive data from them as directed by you: Google and Outlook calendar events, inbound email via IMAP, leads from marketplaces (IndiaMART, JustDial, TradeIndia), social-media mentions, and data exchanged with partner products through the authenticated Partner API.

### 2.7 Cookies and similar technologies

We use cookies, browser storage, and equivalent on-device storage in the mobile apps for:

- **Authentication** — keeping you signed in (JWT session token)
- **Security** — CSRF protection tokens
- **Preferences** — theme, language, and layout choices
- **Push notifications** — push subscription identifiers and device push tokens (APNs / FCM), only if you opt in

We do not use third-party advertising cookies or advertising SDKs, and we do not sell data to advertisers.

### 2.8 Mobile applications and device permissions

The Globus CRM mobile apps request certain device permissions, each only when you use the related feature. You can grant or revoke these at any time in your device settings:

- **Camera and photo library** — to capture or attach photos to records (e.g. document attachments, clinical photographs in the wellness vertical). Photos are uploaded only when you explicitly attach them.
- **Notifications** — to deliver push notifications (reminders, mentions, assigned tasks) via Apple Push Notification service or Firebase Cloud Messaging. We store the device push token to route notifications; it is deleted when you sign out or disable notifications.
- **Microphone** — only if you use in-app calling features.
- **Files / storage** — to attach documents and download exports you request.

The mobile apps also collect basic device information (device model, OS version, app version, crash diagnostics) to operate the app and diagnose errors. The apps do not access your contacts book, track your precise location, or collect data when the app is not in use.

## 3. How we use your information

We use personal data to:

1. Provide, operate, and maintain the Service
2. Authenticate users and secure accounts (including 2FA and SSO)
3. Send communications **on the tenant's instruction** — emails, SMS, WhatsApp messages, sequences, and campaign sends initiated by tenant users
4. Process payments and generate invoices
5. Provide AI-assisted features (see Section 4)
6. Monitor for, prevent, and investigate security incidents, fraud, and abuse
7. Comply with legal obligations and enforce our terms
8. Improve the Service through aggregate, de-identified usage analysis

We do **not** sell personal data. We do **not** use tenant business data to train AI models.

## 4. AI features

Certain features (lead scoring, deal insights, sentiment analysis, junk-lead detection, content suggestions, readiness reports) use large-language-model services, currently **Google Gemini**. When a tenant uses these features:

- Relevant record content is sent to the AI provider to generate the output
- Outputs are stored as part of the tenant's CRM data
- AI-generated content is marked as such where surfaced to end customers, and passes through guardrail checks before publication
- Tenants can choose not to use AI features; rules-based fallbacks exist for several of them

## 5. Legal bases for processing (GDPR/UK GDPR)

Where European data-protection law applies, we rely on:

- **Performance of a contract** — providing the Service to you and your organisation
- **Legitimate interests** — securing the platform, preventing abuse, improving the Service
- **Consent** — optional features such as browser push notifications, marketing communications, and (where required by the tenant's workflow) consent records collected from end customers
- **Legal obligation** — retaining records where law requires (e.g. tax and accounting)

For data processed on behalf of tenants, the tenant determines the legal basis as controller.

## 6. How we share information

We share personal data only with:

| Category                 | Recipients                                                   | Purpose                                                                      |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Payment processors       | Stripe, Razorpay                                             | Payment processing                                                           |
| Communication providers  | Twilio, MSG91, Mailgun, WhatsApp (Meta) Cloud API            | Delivering SMS, voice, email, and WhatsApp messages sent through the Service |
| Telephony providers      | MyOperator, Knowlarity                                       | Click-to-call and call handling, where enabled                               |
| AI providers             | Google (Gemini)                                              | AI-assisted features (Section 4)                                             |
| Error monitoring         | Sentry                                                       | Service reliability and debugging                                            |
| Calendar/email providers | Google, Microsoft                                            | Two-way sync the user connects                                               |
| Lead marketplaces        | IndiaMART, JustDial, TradeIndia                              | Importing leads at the tenant's direction                                    |
| Partner products         | Authenticated Partner API consumers authorised by the tenant | Data exchange the tenant configures                                          |
| Legal/authorities        | Courts, regulators, law enforcement                          | Where required by applicable law                                             |

Each provider processes data under its own terms and, where applicable, a data-processing agreement. We may also share data in connection with a merger, acquisition, or sale of assets, with notice to affected users.

### 6.1 Data received from Meta Platforms (WhatsApp Business Platform)

Where a tenant connects the WhatsApp Business Platform (Cloud API), we receive Platform Data from Meta on the tenant's behalf: message content sent to and from the tenant's WhatsApp business number, the sender's phone number and profile name, message delivery status, and template/quality metadata.

We use this data **solely** to provide the messaging features of the Service to that tenant — displaying conversations, delivering replies, and recording message history in the tenant's CRM. We do not use Platform Data for advertising, profiling unrelated to the tenant's CRM, or training AI models, and we do not sell or transfer it to third parties except as required to operate the Service or by law. We comply with the Meta Platform Terms and applicable WhatsApp Business terms.

**Deletion:** WhatsApp message data is deleted when the tenant deletes the related conversation or contact, when the tenant's retention policy expires it, or when the tenant disconnects the WhatsApp integration and requests deletion. You may also request deletion of your WhatsApp message data by contacting the business you messaged, or by emailing **privacy@globussoft.com** with the phone number you used; verified requests are completed within 30 days.

## 7. International data transfers

The Service may be hosted in, and the providers above may operate from, jurisdictions other than yours (including India, the United States, and the European Union). Where data is transferred across borders from a jurisdiction that restricts such transfers, we rely on appropriate safeguards such as standard contractual clauses or the provider's equivalent mechanism.

## 8. Data retention

- **Account data** is retained while your organisation's account is active and for a reasonable period afterwards to permit reactivation, then deleted.
- **Tenant business data** is retained according to the tenant's configuration. The Service provides **configurable retention policies**, enforced automatically by a daily retention job, allowing tenants to set maximum retention periods per data type.
- **Junk/spam leads** in the wellness vertical are automatically purged after 90 days.
- **Audit logs** are retained for security and compliance purposes.
- **Backups** are taken daily and rotated; deleted data may persist in backups for a limited period before rotation removes it.
- **Financial records** are retained as required by tax and accounting law.

## 9. Security

We apply technical and organisational measures appropriate to the risk, including:

- Encryption in transit (TLS/HTTPS) for all traffic
- bcrypt password hashing; no plaintext password storage
- Optional **AES-256-GCM field-level encryption** for sensitive patient fields
- Role-based access control (RBAC) with field-level permission filtering
- Two-factor authentication and SSO support
- CSRF protection, security headers, input sanitisation, and rate limiting
- Tamper-evident (hash-chained) audit logging with automated integrity checks
- Tenant isolation enforced at the application and query layer
- Automated dependency vulnerability scanning and secret scanning in our development pipeline

No system is perfectly secure. If we become aware of a personal-data breach, we will notify affected tenants and regulators as required by applicable law (including within 72 hours where GDPR applies).

## 10. Your rights

Depending on your jurisdiction (GDPR, UK GDPR, India's DPDP Act 2023, CCPA/CPRA, and similar laws), you may have the right to:

- **Access** the personal data we hold about you
- **Rectify** inaccurate data
- **Erase** your data ("right to be forgotten")
- **Export** your data in a portable, machine-readable format
- **Restrict or object** to certain processing
- **Withdraw consent** where processing is based on consent
- **Complain** to your supervisory authority

The Service includes built-in tools supporting these rights: data-export requests, deletion workflows, and consent records. If you are an end customer of a tenant, contact that business first; we will support them in responding within the legally required timeframe. Otherwise, contact **privacy@globussoft.com**. We respond to verified requests within 30 days.

We do not discriminate against anyone for exercising privacy rights.

### 10.1 Account deletion

You can delete your Globus CRM account and associated personal data at any time:

- **In the app / web app:** go to **Settings → Privacy → Delete account** and follow the confirmation steps; or
- **Online:** submit a deletion request at **https://globuscrm.globussoft.com/account-deletion**; or
- **By email:** write to **privacy@globussoft.com** from the email address on the account.

On a verified deletion request we deactivate the account immediately and permanently delete the account's personal data within 30 days, except for records we are legally required to keep (e.g. invoices and tax records, which are retained for the statutory period and then deleted) and residual copies in backups, which are removed on the normal backup-rotation cycle. If your account belongs to an organisation's workspace, the workspace administrator may need to approve or initiate the deletion, since the organisation is the controller of workspace data.

## 11. Communications preferences

- **Transactional messages** (password resets, security alerts, invoices) are sent as part of operating the Service and cannot be opted out of while you hold an account.
- **Marketing messages** sent by tenants through the Service include opt-out mechanisms (unsubscribe links for email; STOP keywords for SMS where supported). Tenants are responsible for honouring opt-outs and for having a lawful basis to message their recipients.
- **Push notifications** (browser and mobile) are opt-in and can be disabled at any time in your browser or device settings.

## 12. Children's privacy

The Service is a business tool and is not directed at children under 18. We do not knowingly collect personal data directly from children. Tenants in the travel vertical may store student records (e.g. school-trip rosters) supplied by schools or parents/guardians; the tenant is responsible for obtaining the necessary parental consents. If you believe a child's data has been provided to us improperly, contact us and we will delete it.

## 13. Third-party links and embedded content

Tenant-created landing pages, booking pages, and microsites may link to or embed third-party content. This policy does not cover third-party sites; review their privacy policies separately.

## 14. Changes to this policy

We may update this policy from time to time. Material changes will be announced through the Service or by email to account administrators at least 14 days before they take effect. The "Last updated" date at the top reflects the latest revision. Continued use of the Service after changes take effect constitutes acceptance.

## 15. Contact us

For privacy questions, requests, or complaints:

- **Email:** privacy@globussoft.com
- **Data Protection Officer / Grievance Officer (India DPDP):** dpo@globussoft.com
- **Postal:** Globussoft Technologies, India

If you are in the EU/UK and are unsatisfied with our response, you may lodge a complaint with your local data-protection authority.
