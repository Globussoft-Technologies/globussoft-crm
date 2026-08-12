# PRD: AI-Powered GTM Outreach Engine

**Status:** Draft v0.1  
**Date:** 2026-08-10  
**Owner:** Product, Revenue Operations, and Engineering  
**Audience:** Product, Design, Backend, Frontend, Data, AI, Security, QA, Deliverability, and Customer Success  
**Target product:** Globussoft Enterprise CRM, generic vertical first  
**Source inspiration:** [Uddipta Kumar Talukdar's LinkedIn workflow](https://www.linkedin.com/posts/uddipta-talukdar-mba_gtm-gtmengineer-n8n-share-7490667214077956096-69bI/)

---

## 0. Executive summary

This PRD defines a governed, end-to-end outbound engine that converts an ideal customer profile into approved, personalized outreach while keeping the CRM as the source of truth.

The reference workflow uses Clay, Google Sheets, n8n, HubSpot, OpenAI, Telegram, and Gmail. The target implementation preserves the useful operating model without requiring that exact tool stack:

```text
ICP and prospect source
        |
        v
Lead ingestion and validation
        |
        v
Enrichment and identity resolution
        |
        v
CRM company/contact upsert
        |
        v
AI research and outreach draft
        |
        v
Human approval or rejection
        |
        v
Policy-checked email delivery
        |
        v
CRM timeline, stage, metrics, and follow-up
```

The CRM owns lead identity, company/contact data, consent, approval state, message state, pipeline state, audit history, and reporting. Clay or other prospecting tools can feed it. n8n can orchestrate it when customers prefer external automation. Telegram can carry approval notifications. Gmail, Google Workspace, Microsoft 365, or SendGrid can deliver mail. None of those external tools may become an untracked second source of truth.

The first release focuses on one-to-one or low-volume prospecting with human approval before every first-touch email. Autonomous sending, multichannel sequencing, and advanced optimization are later phases.

---

## 1. Problem statement

Outbound workflows commonly fail at the boundaries between tools:

- Prospecting data is exported into a spreadsheet and becomes stale.
- Companies and contacts are created manually or duplicated in the CRM.
- AI drafts use weak context, invent details, or send without review.
- Approval decisions live in chat and are not connected to the CRM record.
- An email may send successfully while the CRM still says `Draft`.
- A retry may send the same email twice.
- Rejections are not categorized, so prompt quality does not improve.
- Replies, bounces, opt-outs, and meetings do not consistently stop outreach.
- Management sees activity counts but cannot connect work to pipeline.

The product must turn this fragmented chain into a durable state machine. Every prospect must have one canonical identity, every transition must be observable, and no email may be sent unless the current tenant policy permits it.

---

## 2. Product vision and principles

### 2.1 Vision

Enable a revenue operator to define an audience, enrich and qualify prospects, generate genuinely relevant outreach, approve it efficiently, send through a trusted mailbox, and measure outcomes without reconciling spreadsheets or guessing what an automation did.

### 2.2 Product principles

1. **CRM is authoritative.** External systems contribute data or execute actions; they do not own lifecycle state.
2. **Human judgment at the risky point.** First-touch AI email is draft-only until an authorized human approves it.
3. **No silent loss.** Invalid leads, provider errors, and failed transitions go to visible recovery queues.
4. **Evidence before personalization.** A personalized claim must link to its source and confidence.
5. **Consent and deliverability before volume.** Technical ability to send does not create permission to send.
6. **Idempotent by design.** Replayed webhooks and retries must not duplicate records or sends.
7. **One state machine.** UI, API, n8n, Telegram, and email-provider events update the same CRM run.
8. **AI quality is measurable.** Approval, edit, rejection, reply, and outcome data feed evaluations.
9. **Vendor optionality.** Prospecting, LLM, approval channel, and email providers use replaceable adapters.

---

## 3. Goals and non-goals

### 3.1 Goals

- Define reusable ICPs and prospecting campaigns.
- Accept prospects from Clay, CSV, Google Sheets, API, forms, and manual entry.
- Validate, normalize, deduplicate, enrich, and score every prospect.
- Upsert the correct CRM contact and company context without duplicate creation.
- Research an account from approved data sources.
- Identify an evidence-backed automation or business opportunity.
- Generate a personalized email draft from an approved template and prompt version.
- Route drafts into a CRM approval queue and optional Telegram/Slack notification.
- Send approved emails through a connected provider exactly once.
- Synchronize message, approval, contact, and outreach-stage state transactionally.
- Detect replies, bounces, opt-outs, and meetings and stop inappropriate follow-up.
- Report operational quality, deliverability, engagement, pipeline, AI performance, and cost.
- Support native CRM orchestration and an optional n8n integration path.

### 3.2 Non-goals for v1

- Fully autonomous first-touch email sending.
- Bulk purchased-list blasting.
- LinkedIn message automation or scraping that violates platform terms.
- Replacing Clay or every specialist enrichment vendor.
- Replacing the CRM with Google Sheets or HubSpot.
- AI-created claims without verifiable source evidence.
- Automatic pricing, contractual commitments, or regulated advice.
- Multichannel sequences beyond email in the initial release.
- Self-optimizing prompts that publish directly to production.

---

## 4. Personas and permissions

### 4.1 GTM operator

Builds ICPs, imports or connects prospect sources, maps fields, starts runs, reviews quality, and monitors outcomes.

Required permissions:

- view/create outreach projects;
- import and enrich prospects;
- generate drafts;
- view assigned prospects and non-sensitive enrichment;
- submit drafts for approval;
- retry recoverable failures.

### 4.2 Sales representative

Owns prospects, edits drafts, approves or rejects their own messages when tenant policy allows, sends approved outreach, and manages replies and follow-ups.

### 4.3 Reviewer or sales manager

Reviews draft quality, policy, evidence, positioning, and audience fit. Can approve, reject, request changes, reassign, or pause a project.

### 4.4 RevOps administrator

Configures providers, mappings, routing, templates, prompts, approval rules, suppression, limits, stages, and reporting definitions.

### 4.5 Deliverability or compliance administrator

Manages sender identities, domains, consent policy, suppression, bounce thresholds, sending limits, restricted terms, and emergency stop controls.

### 4.6 Executive or analyst

Views aggregate performance and pipeline attribution but does not automatically gain access to message content or private enrichment data.

### 4.7 Service principal

Represents Clay, n8n, Google Apps Script, or another integration. It receives least-privilege scopes and cannot approve its own generated drafts unless an explicit non-human policy exists in a later phase.

---

## 5. Scope and terminology

### 5.1 Core terms

- **ICP:** A versioned definition of companies and people the project targets.
- **Outreach project:** A configured GTM initiative with audience, providers, prompt, template, approval, sender, and limits.
- **Prospect:** The project-specific view of a person and company before or after linking to a CRM `Contact`.
- **Run:** One execution of an outreach project over a selected audience.
- **Prospect run:** The state of one prospect within one run.
- **Enrichment fact:** A value with provider, source, retrieval time, confidence, and evidence.
- **AI opportunity:** The evidence-backed business problem or use case selected for personalization.
- **Draft:** A versioned subject/body generated or edited for one prospect.
- **Approval:** A human decision over a specific immutable draft version.
- **Delivery:** The provider attempt and normalized outcome for an approved draft.
- **Suppression:** A rule that prevents outreach to an address, domain, contact, company, or tenant-defined segment.

### 5.2 Source-of-truth policy

| Data | Source of truth |
|---|---|
| Contact and customer lifecycle | CRM `Contact` |
| Company context in v1 | CRM contact company fields plus new company profile record; future first-class Account |
| Prospect-source payload | Immutable intake event |
| Current enrichment value | CRM-approved value with provenance |
| Outreach project and run state | CRM outreach models |
| Draft and approval status | CRM draft/approval models |
| Email delivery truth | CRM normalized from provider event |
| Pipeline and opportunity outcome | CRM deal/pipeline records |
| External spreadsheet status | Derived convenience mirror only |

Google Sheets, Clay, n8n, Telegram, and email providers may display or mirror status. A mirrored value cannot override a newer authoritative CRM state without a conflict policy.

---

## 6. Existing Globussoft CRM capabilities and gap assessment

The implementation should reuse existing foundations where their contracts fit.

### 6.1 Reusable foundations

- `Contact` already represents lead/prospect/customer lifecycle and stores company, title, industry, company size, LinkedIn, website, AI score, enrichment timestamp, source, attribution, owner, and territory context.
- `LeadRoutingRule` already supports tenant-scoped conditions, priority, round robin, specific user, territory, channel, and fallback behavior.
- `AutomationRule` and `backend/routes/workflows.js` already support conditions, approval creation, and `approval.created`, `approval.approved`, and `approval.rejected` events.
- `ApprovalRequest` and `backend/routes/approvals.js` already provide tenant-scoped pending/approved/rejected decisions and notifications.
- `EmailMessage` already stores inbound/outbound messages, threading, sentiment, contact linkage, user linkage, and tenant scope.
- `ScheduledEmail` already stores pending/sent/failed/canceled delivery state and provider error messages.
- `Campaign` supports email channel, scheduling, counters, audience filters, and sequence linkage.
- Existing AI provider settings and call logging can support model routing and spend visibility.

### 6.2 Gaps requiring first-class models or extension

- No first-class outreach project/run/prospect-run state machine.
- No immutable source-event ledger with idempotency and replay.
- No field-level enrichment provenance or evidence model.
- No first-class AI draft versions tied to source evidence and prompt/model versions.
- Generic `ApprovalRequest` identifies integer entities but cannot alone store draft hashes, expiry, decision reason taxonomy, or external approval tokens.
- `ScheduledEmail` is insufficient as the complete delivery ledger because it lacks draft version, approval, provider message ID, idempotency key, and detailed normalized events.
- No project-level sender, volume, deliverability, suppression, or emergency-stop policy.
- No explicit synchronization ledger for n8n, Sheets, Clay, Telegram, and provider callbacks.
- No experiment and evaluation layer connecting AI draft quality to approval and business outcome.

### 6.3 Architectural recommendation

Use a new `GtmOutreach*` model family and services around the existing `Contact`, routing, approvals, email, campaign, audit, and AI infrastructure. Do not overload `AutomationRule`, `ApprovalRequest`, or `ScheduledEmail` with the entire domain state.

The native workflow engine should own the default path. An n8n adapter should expose the same APIs and events for customers who want external orchestration.

---

## 7. End-to-end workflow

### 7.1 Happy path

1. An operator creates an outreach project.
2. The operator selects an ICP, source connector, enrichment providers, prompt/template, sender identity, approval policy, routing policy, and daily limit.
3. A prospect arrives from Clay, Google Sheets, API, CSV, or manual entry.
4. The CRM records an immutable intake event and acknowledges it with a stable ID.
5. Validation normalizes email, domain, phone, country, company name, and URLs.
6. Suppression and eligibility checks run before expensive enrichment.
7. Identity resolution links or creates the canonical CRM contact/company context.
8. Enrichment providers add evidence-backed facts.
9. Fit rules calculate ICP score and eligibility.
10. Lead routing assigns an owner or review team.
11. AI selects a relevant opportunity from the approved evidence.
12. AI generates a subject and email body under the selected template and policy.
13. Deterministic and AI quality checks evaluate the draft.
14. The draft enters the CRM approval queue.
15. An optional Telegram or Slack notification deep-links to the same approval.
16. A human approves, rejects, or requests changes.
17. Approval freezes a content hash and creates a delivery command.
18. Final send-time policy checks run.
19. The email provider accepts the message exactly once.
20. CRM stores the outbound message and advances the prospect-run stage.
21. Provider delivery events update delivery state.
22. Replies link to the contact/thread, stop configured follow-up, and create a task.
23. Meetings, qualification, opportunity, and won/lost outcomes feed project reporting.

### 7.2 Rejection path

1. Reviewer selects one or more rejection reasons.
2. Reviewer may add private feedback and an editable instruction.
3. No delivery command is created.
4. Prospect run moves to `REJECTED` or `CHANGES_REQUESTED`.
5. A revised draft becomes a new version and requires a fresh decision.
6. The prior rejected content remains immutable for audit and evaluation.

### 7.3 Failure path

1. A step fails with a normalized error code and retry classification.
2. Retryable failures use bounded exponential backoff.
3. Permanent failures enter a recovery queue with suggested action.
4. The operator can retry from the safe failed step, skip the prospect, correct data, or cancel.
5. Replaying a step cannot duplicate a contact, approval, or email.

---

## 8. State machines

### 8.1 Outreach project

```text
DRAFT -> VALIDATING -> READY -> ACTIVE -> PAUSED -> ACTIVE
                         |        |          |
                         |        v          v
                         |     COMPLETED  CANCELLED
                         v
                      INVALID
```

Rules:

- Only `READY` projects may activate.
- Activation requires a verified sender, active approval policy, valid template/prompt, source access, and limits.
- Pausing prevents new prospect processing and unsent delivery commands; in-flight provider sends cannot always be recalled.
- Cancel is terminal and requires confirmation.

### 8.2 Prospect run

```text
RECEIVED
  -> VALIDATING
  -> SUPPRESSED | INVALID | DUPLICATE_LINKED
  -> ENRICHING
  -> NOT_ICP | RESEARCHING
  -> GENERATING
  -> QUALITY_FAILED | PENDING_APPROVAL
  -> CHANGES_REQUESTED -> GENERATING
  -> REJECTED | APPROVED
  -> QUEUED_TO_SEND
  -> SENT
  -> DELIVERED | BOUNCED | FAILED
  -> REPLIED | MEETING_BOOKED | QUALIFIED | CLOSED
```

Global terminal/interrupt states:

- `CANCELLED`
- `OPTED_OUT`
- `BLOCKED`
- `EXPIRED`

### 8.3 Draft

```text
DRAFT -> CHECKING -> READY_FOR_REVIEW -> APPROVED
  |         |               |             |
  |         v               v             v
  |   QUALITY_FAILED     REJECTED       SUPERSEDED
  |                         |
  +<---- CHANGES_REQUESTED--+
```

Approval applies to one `draftVersion` and `contentHash`. Any subject, body, sender, recipient, or material personalization change invalidates approval.

### 8.4 Delivery

```text
CREATED -> QUEUED -> SUBMITTED -> SENT -> DELIVERED
   |          |          |         |
   v          v          v         v
CANCELLED   FAILED     FAILED    BOUNCED/COMPLAINED/REPLIED
```

Provider states remain in raw events, while the CRM maps them to normalized states.

---

## 9. Functional requirements

### 9.1 Outreach project configuration

`GTM-PROJ-001` Authorized users can create, clone, edit, archive, pause, resume, and cancel projects.

`GTM-PROJ-002` A project includes name, description, owner, team, purpose, target region, ICP version, source, enrichment plan, routing rule, prompt, template, approval policy, sender, schedule, limits, stop conditions, and attribution tags.

`GTM-PROJ-003` The configuration UI shows readiness checks and blocks activation until required dependencies pass.

`GTM-PROJ-004` Configuration changes create versions. Active runs remain attached to the version under which they started unless a controlled migration is executed.

`GTM-PROJ-005` Users can estimate prospect count, provider calls, AI cost, and email volume before activation.

`GTM-PROJ-006` A project-level emergency stop is always visible to authorized operators.

### 9.2 ICP definition

`GTM-ICP-001` Users can define company criteria including geography, employee range, industry, technology, funding, revenue, business model, growth signals, and exclusions.

`GTM-ICP-002` Users can define person criteria including title, function, seniority, decision role, location, and verified-work-email requirement.

`GTM-ICP-003` Criteria support required, preferred, excluded, and weighted attributes.

`GTM-ICP-004` Each ICP is versioned with owner, rationale, effective dates, and sample accounts.

`GTM-ICP-005` Preview explains why each sample prospect matches, partially matches, or fails.

`GTM-ICP-006` The reference ICP can be represented as US companies with 2-30 employees, founders or decision makers, verified work email, and plausible need for AI process automation.

`GTM-ICP-007` Project results report conversion by ICP criterion so teams can revise assumptions rather than treating the initial ICP as fact.

### 9.3 Prospect ingestion

`GTM-INGEST-001` Sources include native API/webhook, Clay, Google Sheets, CSV, manual entry, and an n8n connector.

`GTM-INGEST-002` Every event carries tenant, project, source, source record ID, schema version, received time, and idempotency key.

`GTM-INGEST-003` Raw payloads are encrypted or redacted according to classification and retained for a configurable troubleshooting period.

`GTM-INGEST-004` Field mapping supports direct map, constant, lookup, concatenation, normalization, and approved transformation expressions.

`GTM-INGEST-005` Required fields for initial acceptance are project ID plus a person or company identifier sufficient for configured enrichment.

`GTM-INGEST-006` Invalid events enter quarantine with field-level errors and replay controls.

`GTM-INGEST-007` Replaying an identical event returns the original prospect-run ID without creating duplicates.

`GTM-INGEST-008` CSV and Sheets sources show total, accepted, duplicate, invalid, suppressed, and queued counts.

### 9.4 Validation and normalization

`GTM-VALID-001` Normalize email casing, whitespace, international phone format, domains, company names, country/state values, and supported social URLs.

`GTM-VALID-002` Email validation distinguishes syntactic validity, domain/MX validity, provider verification, role address, disposable address, catch-all, and unknown.

`GTM-VALID-003` Verification status is evidence, not consent.

`GTM-VALID-004` Company domains are canonicalized without discarding the submitted value.

`GTM-VALID-005` Validation rules are versioned and their output is reproducible.

### 9.5 Suppression and eligibility

`GTM-ELIG-001` Eligibility runs before enrichment, generation, approval, and send.

`GTM-ELIG-002` Suppression can apply to email, domain, contact, company, project, tenant, country, source, or legal basis.

`GTM-ELIG-003` The engine blocks known opt-outs, hard bounces, spam complaints, prohibited domains, existing customers when configured, competitors, employees, and internal test records.

`GTM-ELIG-004` Contact-frequency rules prevent repeated first-touch outreach across projects within a configurable window.

`GTM-ELIG-005` Eligibility decisions record rule, version, evidence, and timestamp.

`GTM-ELIG-006` Authorized administrators may override eligible business rules with a reason, but cannot override legally mandatory suppression through ordinary UI.

### 9.6 Identity resolution and CRM upsert

`GTM-ID-001` Match contacts by normalized verified email first, then approved deterministic identifiers, then fuzzy proposals.

`GTM-ID-002` Match companies by canonical domain and external provider IDs; name-only matches require review when ambiguous.

`GTM-ID-003` The upsert transaction links the prospect run to an existing `Contact` or creates one with tenant scope.

`GTM-ID-004` New prospects default to `Contact.status = Lead` unless tenant mapping defines another allowed value.

`GTM-ID-005` Existing human-verified values are not overwritten by lower-confidence provider or AI values.

`GTM-ID-006` Every field change records source, prior value, new value, actor, confidence, and reason.

`GTM-ID-007` Conflicts enter a merge/review queue rather than producing silent last-write-wins behavior.

`GTM-ID-008` CRM creation or linkage completes before AI generation so the draft has a durable customer context.

### 9.7 Enrichment

`GTM-ENRICH-001` Administrators can configure ordered enrichment waterfalls by field, provider, region, cost, and confidence.

`GTM-ENRICH-002` Enrichment facts include field, value, source URL or provider reference, retrieved time, confidence, expiry, and raw-fact reference.

`GTM-ENRICH-003` Supported baseline facts include company industry, employee range, location, website, description, technology, recent public signals, person title, seniority, LinkedIn URL, and verified work email.

`GTM-ENRICH-004` Each provider has timeout, retry, quota, budget, and fallback policy.

`GTM-ENRICH-005` The engine avoids requesting a paid value that is already fresh and sufficiently trusted.

`GTM-ENRICH-006` Enrichment failures can continue with partial data only if the project's minimum-data policy passes.

`GTM-ENRICH-007` Users can approve, reject, correct, or mark a fact as verified.

`GTM-ENRICH-008` Provider licenses and terms determine whether raw data, derived data, or source evidence may be retained.

### 9.8 Fit scoring and routing

`GTM-FIT-001` Fit is calculated from the active ICP version using deterministic criteria first.

`GTM-FIT-002` The result includes score, band, matched criteria, missing criteria, disqualifiers, and rule version.

`GTM-FIT-003` An optional AI explanation can summarize fit but cannot override deterministic exclusions.

`GTM-FIT-004` Projects define the minimum score and mandatory criteria for draft generation.

`GTM-FIT-005` Eligible prospects route through existing `LeadRoutingRule` infrastructure using team, territory, source, capacity, and project attributes.

`GTM-FIT-006` Unassigned prospects remain visible with a routing failure reason and fallback queue.

### 9.9 AI research and opportunity selection

`GTM-RESEARCH-001` Research uses only approved CRM values, enrichment facts, and allowlisted public or licensed sources.

`GTM-RESEARCH-002` The engine produces a structured account brief: company summary, relevant signals, likely repetitive process, proposed automation opportunity, supporting evidence, and confidence.

`GTM-RESEARCH-003` Every factual claim has one or more citations or is explicitly labeled an inference.

`GTM-RESEARCH-004` The system must not infer sensitive personal traits, protected characteristics, health, financial distress, or other prohibited attributes.

`GTM-RESEARCH-005` Weak-evidence opportunities fail or fall back to a non-specific approved value proposition according to project policy.

`GTM-RESEARCH-006` Research output is stored independently from the email draft so reviewers can evaluate the reasoning.

`GTM-RESEARCH-007` Source content is treated as untrusted and cannot instruct the model to change system policy or call unauthorized tools.

### 9.10 AI email generation

`GTM-DRAFT-001` Generation inputs include project objective, approved template, sender persona, recipient/context, opportunity, evidence, style constraints, prohibited claims, CTA, locale, and maximum length.

`GTM-DRAFT-002` Output is structured as subject, plain-text body, optional HTML body, selected opportunity ID, citations, confidence, and quality metadata.

`GTM-DRAFT-003` The email must not expose internal scores, enrichment-provider names, private notes, or source URLs to the recipient unless explicitly intended.

`GTM-DRAFT-004` The generator must not claim the sender visited a page, used a product, knows the recipient, or observed a fact unless evidence supports that exact claim.

`GTM-DRAFT-005` Prompt, model, model parameters, template, evidence set, and provider request ID are versioned for every generation.

`GTM-DRAFT-006` Re-generation creates a new version and preserves prior versions.

`GTM-DRAFT-007` Users can manually edit subject and body before submission. Manual edits are attributed to the editor.

`GTM-DRAFT-008` Preview shows recipient, sender, merge values, body, source evidence, and warnings in one screen.

### 9.11 Quality checks

`GTM-QA-001` Deterministic checks cover unresolved variables, invalid links, empty content, length, duplicate content, prohibited terms, unsupported claims, required signature, opt-out/footer policy, and sender mismatch.

`GTM-QA-002` Semantic checks cover evidence alignment, personalization relevance, hallucination risk, tone, clarity, CTA, and policy.

`GTM-QA-003` Quality checks cannot approve a message; they only pass, warn, or block submission.

`GTM-QA-004` Blocked drafts display actionable findings and can be regenerated or edited.

`GTM-QA-005` Project dashboards report recurring findings by prompt, template, model, source, and segment.

### 9.12 Human approval

`GTM-APPROVAL-001` Every v1 first-touch email requires approval by an authorized human.

`GTM-APPROVAL-002` The approval view displays person/company context, ICP fit, research, evidence, warnings, subject/body, sender, recipient, and prior outreach.

`GTM-APPROVAL-003` Available decisions are approve, reject, request changes, edit and approve, reassign, and suppress prospect.

`GTM-APPROVAL-004` Rejection reasons include poor fit, incorrect data, weak personalization, factual error, tone, duplicate outreach, compliance concern, wrong recipient, wrong offer, and other with comment.

`GTM-APPROVAL-005` Approval stores reviewer, time, draft version, content hash, decision, comment, source channel, and policy version.

`GTM-APPROVAL-006` Approval expires when its configured time-to-live passes or relevant recipient, sender, content, eligibility, or evidence changes.

`GTM-APPROVAL-007` Bulk approval is disabled in v1. A later release may allow it only for sampled, template-constrained drafts under tenant policy.

`GTM-APPROVAL-008` Generic `ApprovalRequest` may drive notifications and queue membership, but a dedicated outreach-approval record owns the immutable draft decision.

### 9.13 Telegram, Slack, and external approval

`GTM-EXTAPP-001` External approval is optional and mirrors a CRM approval; it does not create an independent decision object.

`GTM-EXTAPP-002` Notifications contain minimal context and a signed, expiring action token or CRM deep link.

`GTM-EXTAPP-003` Approve/reject actions verify user identity, tenant, approval assignment, draft version, expiry, and single use.

`GTM-EXTAPP-004` Sensitive evidence and full contact context should remain behind authenticated CRM access by default.

`GTM-EXTAPP-005` Duplicate callbacks return the existing decision idempotently.

`GTM-EXTAPP-006` If a CRM decision occurs first, stale Telegram or Slack buttons become non-actionable and show final status.

### 9.14 Send-time policy and delivery

`GTM-SEND-001` Approval creates a delivery command but does not bypass final policy checks.

`GTM-SEND-002` Final checks include current approval hash, suppression, consent/legal basis, prior contact, reply state, customer state, sender verification, daily limits, mailbox health, quiet hours, and project status.

`GTM-SEND-003` Delivery uses a deterministic idempotency key derived from tenant, prospect run, draft version, and channel.

`GTM-SEND-004` Supported adapters are SendGrid, Gmail/Google Workspace, Microsoft 365, and a generic SMTP or API adapter subject to security review.

`GTM-SEND-005` Provider acceptance stores provider message ID, sender, recipient, timestamps, and normalized state before marking the prospect run sent.

`GTM-SEND-006` Timeouts with unknown provider outcome enter reconciliation, not blind retry.

`GTM-SEND-007` The outbound email is written to `EmailMessage` and linked to the CRM contact and sending user or service identity.

`GTM-SEND-008` Send failures retain provider diagnostics in a redacted operator-safe form.

`GTM-SEND-009` Daily tenant, project, domain, mailbox, and provider limits are enforced atomically.

`GTM-SEND-010` Emergency stop blocks unsent commands immediately.

### 9.15 Delivery events and synchronization

`GTM-SYNC-001` Normalize accepted, sent, delivered, delayed, soft bounce, hard bounce, dropped, complaint, open, click, unsubscribe, and reply events when providers support them.

`GTM-SYNC-002` Webhooks verify signature, timestamp, replay protection, tenant/provider mapping, and message identity.

`GTM-SYNC-003` Out-of-order events are retained and folded into a monotonic normalized state without losing raw chronology.

`GTM-SYNC-004` Hard bounce, complaint, and unsubscribe create immediate suppression according to policy.

`GTM-SYNC-005` Sheets, Clay, or n8n status mirrors include CRM run ID and last authoritative version.

`GTM-SYNC-006` Mirror-write failure does not roll back a successfully sent email; it creates a sync-repair task.

`GTM-SYNC-007` Reconciliation jobs compare pending/unknown CRM deliveries with provider status.

### 9.16 Replies and follow-up

`GTM-REPLY-001` Inbound replies link by provider thread/message references, then verified sender/recipient fallback.

`GTM-REPLY-002` Any genuine reply stops automated follow-up unless a tenant-approved classification explicitly allows otherwise.

`GTM-REPLY-003` AI may classify positive interest, question, objection, not now, referral, wrong person, unsubscribe, out-of-office, or other; confidence and evidence are stored.

`GTM-REPLY-004` Unsubscribe intent is enforced even when phrased conversationally.

`GTM-REPLY-005` Positive or ambiguous replies create an owner task and notification with response SLA.

`GTM-REPLY-006` Meeting-booked and qualified outcomes advance the project stage and may create or link a CRM deal.

`GTM-REPLY-007` Out-of-office messages may schedule a policy-controlled follow-up after the stated return date.

### 9.17 Pipeline and attribution

`GTM-PIPE-001` Project stages map to received, enriched, eligible, draft, approved, sent, delivered, replied, meeting, qualified, opportunity, won, lost, rejected, suppressed, and failed equivalents.

`GTM-PIPE-002` Contact source, first-touch source, last-touch source, project, run, and message attribution remain connected through conversion.

`GTM-PIPE-003` Creating or linking a deal requires a deterministic or human-confirmed match.

`GTM-PIPE-004` Project reporting distinguishes sourced, influenced, and merely contacted pipeline.

`GTM-PIPE-005` Manual stage changes require a reason when they conflict with observed system events.

---

## 10. User experience requirements

### 10.1 Outreach projects list

The list shows:

- name and owner;
- status and current version;
- source and sender;
- prospects received, eligible, pending approval, sent, replied, and qualified;
- errors and suppression count;
- daily limit and today's utilization;
- last activity and health.

Filters include owner, team, status, source, sender, date, and health. Primary actions are create, pause/resume, open approvals, and view run.

### 10.2 Project workspace

Tabs:

1. Overview
2. Prospects
3. Approvals
4. Messages
5. Performance
6. Errors
7. Configuration
8. Versions and audit

The overview prioritizes operational state. It must not use decorative marketing composition.

### 10.3 Prospect table

Columns include prospect, company, fit, owner, current stage, evidence health, draft status, approval, delivery, reply, error, and updated time.

Users can filter and bulk-select for safe commands such as assign, regenerate, retry enrichment, suppress, or cancel. Bulk send and bulk approval are absent in v1.

### 10.4 Approval workspace

Desktop layout:

- left queue with filters and keyboard navigation;
- center email preview and editable draft;
- right context/evidence panel;
- persistent approve, request changes, reject, and suppress commands.

Laptop and tablet layouts collapse the context panel into tabs or a drawer. Mobile uses sequential review: context, draft, evidence, decision. Text, controls, and panes must not overlap from 320 CSS pixels through wide desktop.

### 10.5 Error recovery

Errors are grouped by source ingestion, validation, enrichment, identity, AI generation, approval, delivery, webhook, and mirror synchronization.

Every row shows:

- normalized code and human-readable explanation;
- whether retry is safe;
- attempt count and next retry;
- affected prospect/project;
- provider correlation ID;
- available recovery commands.

### 10.6 Notifications

Notifications are sent for:

- approval assignment and reminders;
- requested changes;
- project paused by policy;
- sender or provider degradation;
- daily limit reached;
- unusual bounce/complaint rate;
- unrecoverable prospect failure;
- positive reply or meeting booked;
- sync reconciliation failure.

Notifications are deduplicated and deep-link to the exact CRM state.

---

## 11. Data model

### 11.1 New models

#### `GtmIcpDefinition`

- `id`, `tenantId`, `name`, `description`
- `criteriaJson`, `scoringJson`, `exclusionsJson`
- `version`, `status`, `effectiveFrom`, `effectiveTo`
- `ownerUserId`, `createdAt`, `updatedAt`

#### `GtmOutreachProject`

- `id`, `tenantId`, `name`, `description`
- `ownerUserId`, `teamId`, `status`
- `activeVersionId`, `createdAt`, `updatedAt`, `archivedAt`

#### `GtmOutreachProjectVersion`

- `id`, `tenantId`, `projectId`, `version`
- `icpDefinitionId`, `sourceConfigJson`, `enrichmentConfigJson`
- `routingConfigJson`, `researchConfigJson`
- `promptTemplateId`, `emailTemplateId`
- `approvalPolicyJson`, `senderIdentityId`
- `scheduleJson`, `limitsJson`, `stopConditionsJson`
- `createdByUserId`, `createdAt`

#### `GtmOutreachRun`

- `id`, `tenantId`, `projectId`, `projectVersionId`
- `status`, `startedByUserId`, `startedAt`, `completedAt`
- aggregate counters and `lastErrorAt`

#### `GtmProspectRun`

- `id`, `tenantId`, `runId`, `contactId`
- `sourceEventId`, `sourceRecordId`, `idempotencyKey`
- `state`, `stateVersion`, `ownerUserId`
- `fitScore`, `fitBand`, `fitExplanationJson`
- `currentDraftId`, `deliveryId`, `failureCode`, `failureDetail`
- `receivedAt`, `updatedAt`, `completedAt`

Unique constraint: `(tenantId, runId, idempotencyKey)`.

#### `GtmSourceEvent`

- `id`, `tenantId`, `projectId`, `connectorId`
- `externalId`, `idempotencyKey`, `schemaVersion`
- `payloadEncrypted`, `payloadHash`
- `status`, `receivedAt`, `processedAt`, `retentionExpiresAt`

Unique constraint: `(tenantId, connectorId, idempotencyKey)`.

#### `GtmEnrichmentFact`

- `id`, `tenantId`, `prospectRunId`, `contactId`
- `fieldName`, `valueJson`, `normalizedValueHash`
- `provider`, `sourceUrl`, `sourceReference`
- `confidence`, `retrievedAt`, `expiresAt`
- `verificationStatus`, `verifiedByUserId`, `verifiedAt`

#### `GtmResearchBrief`

- `id`, `tenantId`, `prospectRunId`
- `summary`, `opportunity`, `confidence`
- `evidenceJson`, `inferenceJson`
- `modelProvider`, `modelName`, `promptVersion`
- `createdAt`

#### `GtmEmailDraft`

- `id`, `tenantId`, `prospectRunId`, `version`
- `recipientEmail`, `senderIdentityId`
- `subject`, `bodyText`, `bodyHtml`
- `contentHash`, `evidenceJson`, `qualityJson`
- `promptTemplateId`, `promptVersion`, `modelProvider`, `modelName`
- `generatedBy`, `editedByUserId`, `status`, `createdAt`

Unique constraint: `(tenantId, prospectRunId, version)`.

#### `GtmOutreachApproval`

- `id`, `tenantId`, `prospectRunId`, `draftId`
- `draftContentHash`, `status`, `assignedToUserId`
- `decisionByUserId`, `decisionChannel`
- `reasonCodesJson`, `comment`
- `expiresAt`, `decidedAt`, `createdAt`
- `externalActionNonceHash`

#### `GtmEmailDelivery`

- `id`, `tenantId`, `prospectRunId`, `draftId`, `approvalId`
- `idempotencyKey`, `provider`, `providerMessageId`
- `fromAddress`, `toAddress`, `status`
- `submittedAt`, `sentAt`, `deliveredAt`, `failedAt`
- `errorCode`, `errorDetail`, `reconciliationStatus`

Unique constraints on `(tenantId, idempotencyKey)` and provider message identity where available.

#### `GtmDeliveryEvent`

- `id`, `tenantId`, `deliveryId`
- `providerEventId`, `eventType`, `rawEventType`
- `payloadRedactedJson`, `occurredAt`, `receivedAt`

Unique constraint: `(tenantId, provider, providerEventId)` where supported.

#### `GtmSyncRecord`

- `id`, `tenantId`, `prospectRunId`, `system`, `externalRecordId`
- `direction`, `entityType`, `crmVersion`, `externalVersion`
- `status`, `lastAttemptAt`, `lastSuccessAt`, `errorDetail`

### 11.2 Existing model links

- `Contact`: canonical lead/contact identity.
- `LeadRoutingRule`: owner selection.
- `ApprovalRequest`: shared approval notification and generic queue link.
- `EmailMessage`: customer-facing message timeline.
- `ScheduledEmail`: may remain for existing scheduler flows; GTM delivery should own its richer send ledger.
- `Campaign`: optional parent marketing attribution or aggregate reporting link.
- `AutomationRule`: project lifecycle and downstream actions.
- `AuditLog`/audit helper: security and business audit events.
- `LlmCallLog`: provider usage, latency, tokens, and cost.

### 11.3 State transition integrity

All prospect-run transitions use optimistic concurrency with `stateVersion`. A command provides expected state/version. Stale commands return the current state without applying duplicate side effects.

External side effects use a durable outbox:

1. Transaction validates current state.
2. Transaction writes next state and outbox command.
3. Worker submits external request with idempotency key.
4. Result updates delivery and emits domain event.

---

## 12. API surface

### 12.1 Projects and ICPs

- `POST /api/gtm/icps`
- `GET /api/gtm/icps`
- `GET /api/gtm/icps/:id`
- `POST /api/gtm/icps/:id/versions`
- `POST /api/gtm/projects`
- `GET /api/gtm/projects`
- `GET /api/gtm/projects/:id`
- `PUT /api/gtm/projects/:id`
- `POST /api/gtm/projects/:id/validate`
- `POST /api/gtm/projects/:id/activate`
- `POST /api/gtm/projects/:id/pause`
- `POST /api/gtm/projects/:id/resume`
- `POST /api/gtm/projects/:id/cancel`

### 12.2 Runs and prospects

- `POST /api/gtm/projects/:id/runs`
- `GET /api/gtm/runs/:id`
- `GET /api/gtm/runs/:id/prospects`
- `GET /api/gtm/prospects/:id`
- `POST /api/gtm/prospects/:id/retry`
- `POST /api/gtm/prospects/:id/cancel`
- `POST /api/gtm/prospects/:id/suppress`
- `POST /api/gtm/prospects/:id/regenerate`

### 12.3 Intake and connectors

- `POST /api/gtm/intake/:projectKey`
- `POST /api/gtm/connectors/clay/webhook`
- `POST /api/gtm/connectors/n8n/events`
- `POST /api/gtm/connectors/google-sheets/import`
- `POST /api/gtm/imports/csv`
- `GET /api/gtm/imports/:id`

Intake endpoints require scoped connector credentials, signature or OAuth where supported, idempotency key, and rate limits.

### 12.4 Drafts and approval

- `GET /api/gtm/approvals`
- `GET /api/gtm/approvals/:id`
- `POST /api/gtm/approvals/:id/approve`
- `POST /api/gtm/approvals/:id/reject`
- `POST /api/gtm/approvals/:id/request-changes`
- `POST /api/gtm/approvals/:id/edit-and-approve`
- `POST /api/gtm/approvals/:id/reassign`
- `POST /api/gtm/external-approvals/:token/decision`

### 12.5 Delivery and callbacks

- `POST /api/gtm/deliveries/:id/send`
- `POST /api/gtm/providers/:provider/events`
- `POST /api/gtm/mailboxes/:provider/inbound`
- `GET /api/gtm/deliveries/:id`
- `POST /api/gtm/deliveries/:id/reconcile`

### 12.6 Reporting

- `GET /api/gtm/projects/:id/stats`
- `GET /api/gtm/projects/:id/funnel`
- `GET /api/gtm/projects/:id/deliverability`
- `GET /api/gtm/projects/:id/ai-quality`
- `GET /api/gtm/projects/:id/pipeline-attribution`
- `GET /api/gtm/operations/health`

All routes require JWT/service authorization and tenant scoping. Failures use the canonical `{ error, code }` envelope.

---

## 13. Event contracts and n8n integration

### 13.1 Domain events

- `gtm.prospect.received`
- `gtm.prospect.validated`
- `gtm.prospect.suppressed`
- `gtm.prospect.enriched`
- `gtm.prospect.eligible`
- `gtm.draft.generated`
- `gtm.draft.quality_failed`
- `gtm.approval.requested`
- `gtm.approval.approved`
- `gtm.approval.rejected`
- `gtm.approval.changes_requested`
- `gtm.delivery.queued`
- `gtm.delivery.sent`
- `gtm.delivery.delivered`
- `gtm.delivery.bounced`
- `gtm.delivery.complained`
- `gtm.reply.received`
- `gtm.meeting.booked`
- `gtm.prospect.qualified`
- `gtm.prospect.failed`

Each event contains event ID, schema version, tenant ID, project/run/prospect IDs, occurred time, actor, correlation ID, and minimal event-specific data.

### 13.2 n8n operating modes

#### Mode A: Native orchestration, recommended

CRM workers execute every stage. n8n may consume events for optional side effects.

Benefits:

- strongest transactional consistency;
- one operational dashboard;
- simpler tenant permission enforcement;
- fewer split-brain failures.

#### Mode B: n8n orchestration

n8n calls CRM command APIs for each stage. CRM validates every command and owns state.

Rules:

- n8n never writes database state directly;
- every node passes correlation and idempotency IDs;
- CRM rejects invalid or stale transitions;
- credentials use a tenant-scoped service principal;
- workflow export is versioned and attached to project configuration;
- callbacks are signed;
- sensitive values are minimized in n8n execution history.

### 13.3 Reference n8n workflow

```text
Webhook / Sheets trigger
  -> CRM intake command
  -> poll/wait for enrichment completion event
  -> CRM generate-draft command
  -> wait for approval event
  -> CRM delivery command
  -> wait for delivery event
  -> update optional source mirror
```

n8n must not call Gmail directly after a Telegram approval if doing so bypasses CRM send-time policy. It calls the CRM delivery command instead.

---

## 14. Provider adapters

### 14.1 Prospecting and enrichment

Adapter interface:

- validate credentials;
- search or accept prospect payload;
- enrich company/person;
- verify email;
- expose provenance and permitted retention;
- normalize errors and cost;
- report quota/health.

Clay is a launch adapter, not a required core dependency.

### 14.2 LLM

Adapter interface:

- structured generation;
- model capability and region metadata;
- token and cost reporting;
- timeout/cancellation;
- provider request ID;
- zero-retention or approved retention policy;
- safety and content-filter outcome.

The existing provider router should support OpenAI-compatible, Gemini, and approved fallbacks. Projects pin a model policy, not an unversioned provider default.

### 14.3 Approval notification

Adapters:

- in-app notification;
- email;
- Telegram bot;
- Slack app;
- Microsoft Teams in a later release.

Only in-app CRM approval is mandatory for v1.

### 14.4 Email delivery

Adapters normalize:

- sender verification;
- send request and idempotency behavior;
- provider message ID;
- delivery events;
- inbound replies/threading;
- bounce and complaint data;
- rate/limit signals;
- provider error taxonomy.

---

## 15. AI prompt and quality specification

### 15.1 Research output schema

```json
{
  "companySummary": "string",
  "signals": [
    {
      "fact": "string",
      "sourceFactIds": [123],
      "confidence": 0.0
    }
  ],
  "opportunity": {
    "problem": "string",
    "proposedOutcome": "string",
    "reasonRelevant": "string",
    "sourceFactIds": [123, 456],
    "confidence": 0.0,
    "isInference": true
  }
}
```

### 15.2 Draft output schema

```json
{
  "subject": "string",
  "bodyText": "string",
  "bodyHtml": "string|null",
  "personalizedClaims": [
    {
      "text": "string",
      "sourceFactIds": [123],
      "confidence": 0.0
    }
  ],
  "callToAction": "string",
  "warnings": []
}
```

### 15.3 Prompt constraints

- Do not invent customers, metrics, integrations, relationships, or observed behavior.
- Do not mention scraped or private-looking data in the recipient-facing email.
- Do not use protected or sensitive attributes for personalization.
- Avoid false familiarity and manipulative urgency.
- Use the configured sender voice, offer, CTA, language, and length.
- Prefer one specific evidence-backed relevance point over many shallow points.
- Return a safe generic draft or fail when evidence is inadequate, according to project policy.

### 15.4 Evaluation dataset

Each production prompt has at least:

- strong-fit prospects with good evidence;
- weak-fit prospects;
- missing-data cases;
- conflicting-source cases;
- prohibited-sensitive-data cases;
- prompt-injection content in company pages;
- competitor and internal-domain cases;
- non-English data;
- long company descriptions;
- misleading evidence designed to test hallucination.

Promotion gates measure schema validity, evidence precision, unsupported-claim rate, personalization relevance, policy violations, reviewer acceptance, edit distance, and latency.

---

## 16. Deliverability, consent, and responsible outreach

### 16.1 Sender readiness

Before activation, the system verifies:

- sender mailbox or API identity;
- SPF, DKIM, and DMARC status where detectable;
- reply-to configuration;
- sending-domain policy;
- mailbox/provider daily limit;
- unsubscribe mechanism required by tenant policy;
- physical-address/footer requirements where applicable;
- inbound reply processing.

### 16.2 Sending controls

- Default v1 daily limit is conservative and tenant-configurable within provider limits.
- New sender identities ramp through an approved warm-up plan; the CRM does not fabricate warm-up engagement.
- Per-domain throttling prevents bursts to one company.
- A project stops automatically when hard-bounce, complaint, unsubscribe, or provider-error thresholds exceed policy.
- Open tracking is off where tenant or recipient privacy policy requires it.
- Link tracking uses trusted branded domains where enabled.

### 16.3 Legal and policy posture

The tenant is responsible for defining its lawful basis and target jurisdictions. The product must provide controls and evidence, not assume that a verified work email is permission to contact.

Requirements include:

- region-aware consent or legitimate-interest configuration;
- clear sender identification;
- opt-out capture and immediate enforcement;
- data provenance and retention controls;
- do-not-contact lists;
- policy version recorded at send time;
- legal review before production use in a new jurisdiction.

---

## 17. Security and privacy

`GTM-SEC-001` Every query and mutation is scoped by `tenantId` and effective user/service permissions.

`GTM-SEC-002` Connector credentials live in encrypted secret storage and never in project JSON, logs, prompts, Telegram messages, or exports.

`GTM-SEC-003` External approval tokens are random, hashed at rest, single-use, short-lived, and bound to tenant, user, approval, and draft hash.

`GTM-SEC-004` Webhooks use signatures, timestamp windows, replay protection, and provider event IDs.

`GTM-SEC-005` Prompt construction applies field- and source-level AI exclusion before data leaves the CRM.

`GTM-SEC-006` Raw source payload and provider events have configurable retention and redaction.

`GTM-SEC-007` Audit events cover project configuration, activation, ingestion, merge, enrichment acceptance, generation, edit, approval, rejection, suppression, send, retry, provider callback, and export.

`GTM-SEC-008` Spreadsheet formulas are escaped in CSV/Sheets exports to prevent formula injection.

`GTM-SEC-009` Model output and researched web content are untrusted; tool calls and state transitions are independently validated.

`GTM-SEC-010` Data-subject deletion propagates to outreach data according to legal hold and message-record policy.

`GTM-SEC-011` Support access is time-bound, approved, tenant-visible where contracted, and audited.

`GTM-SEC-012` Rate limits protect intake, generation, approval callbacks, send commands, and reporting exports.

---

## 18. Reporting and metrics

### 18.1 Funnel

- prospects received;
- valid and suppressed;
- enriched;
- ICP eligible;
- drafts generated;
- quality pass/fail;
- pending/approved/rejected/changes requested;
- queued/sent/delivered/bounced;
- replied;
- positive replies;
- meetings;
- qualified leads;
- opportunities;
- won/lost revenue.

### 18.2 Efficiency

- median time per workflow stage;
- approval queue age;
- operator minutes per approved message;
- automated versus manual field completion;
- provider calls and cost per eligible prospect;
- AI tokens and cost per draft, approved draft, reply, meeting, and opportunity;
- retry and manual-recovery rate.

### 18.3 AI quality

- first-pass approval rate;
- edit-and-approve rate;
- rejection rate by reason;
- average edit distance;
- unsupported-claim and weak-evidence rate;
- quality-check false positive/negative rate;
- acceptance by model, prompt, template, segment, operator, and reviewer;
- positive-reply and meeting rate by draft version cohort.

### 18.4 Deliverability

- provider acceptance;
- delivery;
- soft and hard bounce;
- complaint;
- unsubscribe;
- reply;
- domain/mailbox throttling;
- sender health and project stop events.

### 18.5 Data quality

- duplicate-link and merge-review rate;
- enrichment completeness and freshness;
- provider disagreement rate;
- invalid email/domain rate;
- mirror-sync lag and failures;
- CRM field overwrite conflicts.

### 18.6 Attribution

Reports distinguish:

- outreach-sourced opportunity;
- outreach-influenced opportunity;
- existing opportunity contacted;
- meeting created by outreach;
- revenue by project, ICP version, source, sender, owner, template, and model.

---

## 19. Non-functional requirements

### 19.1 Performance

- Intake acknowledgement p95 under 500 ms, excluding asynchronous processing.
- Project/prospect list p95 under 1 second for standard filtered pages.
- Approval next-item transition under 300 ms after decision acknowledgement.
- AI generation exposes progress and completes p95 under 30 seconds at launch-provider baseline.
- Provider callback acknowledgement under 500 ms after durable event capture.

### 19.2 Reliability

- Intake, contact upsert, approval decision, delivery command, and provider events are idempotent.
- External requests use bounded retries with jitter.
- Unknown delivery outcomes enter reconciliation.
- A process restart does not lose queued work.
- A provider outage degrades only the dependent stage.
- Outbox lag and dead-letter count are monitored.

### 19.3 Scale baseline

Initial tested target per tenant:

- 100,000 prospects per project;
- 10,000 intake events/hour burst;
- 1,000 concurrent enrichment/generation jobs under queue controls;
- configurable daily email caps, with a launch safety ceiling below provider maximum;
- 1 million delivery events retained according to policy.

These are engineering test targets, not contractual limits until capacity validation.

### 19.4 Accessibility and responsiveness

- WCAG 2.2 AA target.
- Complete project, prospect, and approval workflows at 320 px, tablet, laptop, and desktop widths.
- Keyboard review flow with clear focus and non-conflicting shortcuts.
- Screen-reader names for decision controls and evidence links.
- Zoom to 200% without overlapping content or hidden commands.
- Reduced-motion support.

### 19.5 Observability

Every run has tenant, project, run, prospect, request, event, provider, LLM, approval, and delivery correlation IDs where relevant.

Dashboards and alerts cover queue lag, stage latency, error rates, provider health, webhook failures, approval age, send volume, suppression, bounce/complaint thresholds, AI cost, and reconciliation backlog.

---

## 20. Critical acceptance journeys

### AC-1: Clay lead to approved send

1. Clay submits a valid prospect with an idempotency key.
2. CRM records intake, enriches, links/creates contact, scores fit, routes owner, researches, and drafts.
3. Reviewer sees evidence and approves version 1.
4. CRM sends once and records the outbound message.
5. Provider delivery updates the prospect run.

**Pass:** Replaying the Clay event or send command creates neither a duplicate contact nor a second email.

### AC-2: Existing contact

1. A source submits a prospect whose normalized email already exists in the tenant.
2. CRM links the prospect run to that contact.
3. Lower-confidence enrichment conflicts with a verified title.

**Pass:** No duplicate contact is created and the verified value is preserved with a visible conflict.

### AC-3: Suppressed recipient

1. An opted-out email passes syntactic validation.
2. Project attempts to enrich and draft it.

**Pass:** Eligibility suppresses it before paid enrichment and no approval/send is created.

### AC-4: Human rejection

1. AI produces a plausible but unsupported claim.
2. Quality check warns and reviewer rejects for factual error.

**Pass:** No send is possible; reason/evidence/prompt/model are available in AI-quality reporting.

### AC-5: Edit invalidates approval

1. Reviewer approves a draft.
2. Recipient, sender, subject, or body changes before submission.

**Pass:** Hash mismatch blocks sending and requires fresh approval.

### AC-6: Telegram race

1. Approval notification is sent to Telegram.
2. Reviewer rejects inside CRM.
3. The old Telegram Approve button is clicked.

**Pass:** Callback returns final `REJECTED`; no state change or delivery occurs.

### AC-7: Provider timeout with successful send

1. CRM submits an approved email.
2. Provider accepts it but the request times out before response.
3. Worker retries or reconciles.

**Pass:** Recipient receives one message; CRM resolves provider state without duplicate send.

### AC-8: Reply stops follow-up

1. Delivered prospect replies with a question.
2. Inbound processor links the thread.

**Pass:** Follow-up stops, owner receives a task, and project funnel advances to replied.

### AC-9: Unsubscribe language

1. Recipient replies, "Please don't email me again."

**Pass:** Contact/email suppression is immediate, future send commands fail closed, and action is audited.

### AC-10: Tenant isolation

1. A user/service from tenant A requests tenant B's project, approval, contact, or callback token.

**Pass:** Access is denied without revealing existence; automated isolation tests cover every route and worker lookup.

### AC-11: n8n stale transition

1. n8n retries `generate draft` after the prospect is already sent.

**Pass:** CRM rejects the stale transition idempotently and preserves the sent state.

### AC-12: Project emergency stop

1. Complaint threshold triggers while deliveries remain queued.

**Pass:** Project pauses, unsent deliveries are blocked, operators are alerted, and in-flight uncertainty is reconciled.

---

## 21. Testing strategy

### 21.1 Backend unit tests

- state transition matrix;
- idempotency-key behavior;
- email/domain normalization;
- eligibility and suppression;
- ICP scoring;
- field precedence and enrichment conflicts;
- draft hashing and approval invalidation;
- provider state normalization;
- out-of-order delivery events;
- retry classification;
- reply and unsubscribe classification;
- tenant-scoped queries;
- prompt construction and AI field exclusion.

### 21.2 Frontend tests

- project readiness and activation;
- prospect filters and recovery actions;
- approval context, edit, approve, reject, and request changes;
- stale decision handling;
- warnings and blocked draft states;
- responsive review layout;
- keyboard and accessibility behavior;
- error queue and retry feedback.

### 21.3 API and integration tests

- Clay/n8n intake and replay;
- CSV/Sheets import mapping;
- contact upsert and duplicate handling;
- generic approval event integration;
- Telegram signed callback;
- provider send timeout and reconciliation;
- webhook signature/replay/out-of-order delivery;
- inbound reply threading;
- campaign/deal attribution;
- cross-tenant and role access.

New route specs must be wired into both canonical CI API-spec lists according to repository convention.

### 21.4 AI evaluation

- fixed golden dataset by prompt version;
- unsupported-claim red-team set;
- prompt-injection pages;
- sensitive-attribute leakage;
- schema and citation validity;
- reviewer acceptance shadow run;
- model upgrade comparison before promotion.

### 21.5 Load and resilience

- intake burst;
- queue backlog recovery;
- provider 429/500/timeout;
- worker restart mid-step;
- duplicate and delayed webhooks;
- large approval queue;
- emergency-stop propagation;
- database contention on daily send caps.

---

## 22. Rollout plan

### Phase 0: Product and compliance decisions, 1-2 weeks

- Confirm launch audience, jurisdictions, lawful basis, sender providers, and approval roles.
- Confirm company-model strategy before first-class Account migration.
- Establish baseline prompt/evaluation dataset and deliverability policy.
- Validate provider contracts and retention terms.

### Phase 1: Native core and manual approval, 4-6 weeks

- New outreach models and state machine
- Project/run/prospect APIs
- CSV/API intake
- validation, suppression, identity linking, and contact creation
- existing enrichment and LLM provider integration
- draft generation and CRM approval workspace
- SendGrid or one launch email adapter
- delivery ledger, `EmailMessage` linkage, basic funnel

**Exit:** One operator can process a small, compliant list from intake to approved send and reply without external orchestration.

### Phase 2: Clay, n8n, Telegram, and Gmail adapters, 3-5 weeks

- Clay webhook and field mapping
- n8n command/event package and reference workflow
- Google Sheets import/status mirror
- Telegram approval notification/action
- Gmail or Google Workspace delivery and inbound threading
- reconciliation and sync-error UI

**Exit:** The LinkedIn reference workflow can run through CRM-owned state and policy.

### Phase 3: Operations and quality, 3-4 weeks

- enrichment waterfalls and provenance UI
- ICP builder and fit explanation
- AI research brief and evidence panel
- deterministic/semantic draft QA
- detailed rejection taxonomy and AI reports
- deliverability health, thresholds, emergency stop
- dashboards and pipeline attribution

### Phase 4: Scale and controlled sequences, 4-6 weeks

- low-volume follow-up sequences
- response-aware stopping
- experiment cohorts and prompt/model comparison
- manager sampling and bounded bulk review
- additional email providers and Slack
- advanced quotas, budgets, and cost allocation

Autonomous first-touch sending remains a separate product decision and requires evidence that narrow use cases meet agreed quality and complaint thresholds.

---

## 23. Success metrics and launch gates

### 23.1 Primary product metrics

- At least 95% of valid accepted prospects reach a terminal or actionable state without operator investigation.
- Zero duplicate sends in acceptance, replay, and timeout tests.
- 100% of sent v1 first-touch emails have a valid human approval for the exact content hash.
- At least 80% first-pass draft approval in the agreed pilot segment after tuning.
- Median approval handling under 60 seconds per draft.
- Less than 1% unresolved synchronization failures after the repair SLA.

### 23.2 Deliverability guardrails

Exact thresholds require deliverability approval. Proposed pilot gates:

- hard bounce below 2%;
- complaint below 0.1%;
- unsubscribe monitored by segment and sender;
- provider rejection and unknown-delivery outcomes below agreed limits;
- automatic project pause on threshold breach.

### 23.3 AI launch gates

- structured-output validity above 99%;
- no critical sensitive-data or policy leakage in evaluation;
- unsupported personalization claims below the approved threshold;
- all production claims traceable to evidence or labeled inference;
- model/prompt version and cost captured for every generation;
- kill switch tested.

### 23.4 Operational gates

- sender identity and inbound reply path verified;
- suppression and unsubscribe end-to-end test passed;
- retry/reconciliation drills passed;
- tenant isolation tests passed;
- dashboards reconcile with underlying records;
- on-call runbook and project emergency-stop owner assigned.

---

## 24. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| AI invents a personalization fact | Trust and brand damage | Evidence-linked claims, quality gates, human review, rejection analytics |
| A retry sends twice | Customer harm | Delivery idempotency key, outbox, provider reconciliation |
| Sheets and CRM disagree | Operational confusion | CRM authority, versioned mirror sync, repair queue |
| Duplicate contact creation | Dirty CRM and repeated outreach | Deterministic identity resolution, unique keys, merge review |
| Verified email mistaken for consent | Compliance exposure | Separate verification and eligibility concepts, legal-basis policy |
| Telegram button used by wrong/stale user | Unauthorized send | Bound short-lived token, identity check, draft hash, single-use decision |
| High bounce/complaint rate | Domain reputation damage | Conservative limits, eligibility, verification, live thresholds, emergency stop |
| n8n bypasses CRM policy | Untracked external action | Commands only through CRM API, least-privilege principal, stale-state rejection |
| Provider timeout has unknown result | Duplicate or missing status | Unknown state and reconciliation before retry |
| Enrichment license violation | Contract or privacy risk | Provider-specific retention and provenance policy |
| Approval queue becomes bottleneck | Slow outreach | Fast review UX, prioritization, SLA, quality improvement, later controlled sampling |
| Metrics optimize volume over relevance | Low-quality outreach | Primary metrics include approval quality, positive replies, meetings, complaints, pipeline |

---

## 25. Open decisions

The following decisions gate implementation:

1. Is the first release for internal Globussoft outbound, one design partner, or all tenants?
2. Which jurisdictions and lawful-basis policies are allowed at launch?
3. Which provider is the first sender: existing SendGrid, Google Workspace, or Microsoft 365?
4. Is Clay a launch dependency or only an API example?
5. Is n8n hosted by Globussoft, customer-hosted, or unsupported except through generic APIs?
6. Is Telegram approved for actionable decisions, or notification/deep-link only?
7. Who can approve: record owner, project reviewer, manager, or a configurable role?
8. How long does approval remain valid?
9. Which data fields may be included in LLM context?
10. Which public research sources and enrichment licenses are approved?
11. Should company identity remain on `Contact.company` in v1 or introduce a first-class `Account` now?
12. How should existing `Campaign`, `Sequence`, and generic `ApprovalRequest` surfaces appear alongside GTM projects?
13. What are the initial daily send, per-domain, bounce, and complaint thresholds?
14. Is follow-up sequencing part of the first customer commitment or Phase 4?
15. What business outcome defines pilot success: replies, meetings, qualified opportunities, or revenue?

---

## 26. Reference implementation mapping

| LinkedIn workflow component | Responsibility | Target CRM implementation |
|---|---|---|
| Clay | ICP prospecting and enrichment | Clay adapter or any approved source/enrichment adapter |
| Google Sheets | Lead list and trigger | Optional import/status mirror; never authoritative |
| n8n | Workflow orchestration | Native engine by default; optional command/event orchestrator |
| HubSpot | Company/contact and pipeline truth | Globussoft `Contact`, future Account, deals, activities, and GTM models |
| OpenAI | Research and personalized drafting | Existing governed LLM router with prompt/model/evidence versioning |
| Telegram | Human approval | CRM approval workspace plus optional signed notification/action adapter |
| Gmail | Approved outbound delivery | Gmail/Workspace adapter or existing SendGrid provider |

### Key product correction to the reference workflow

The reference implementation updates Google Sheets and HubSpot after Gmail sends. A production CRM should reverse the control relationship:

```text
Approval
  -> CRM creates durable delivery command
  -> provider sends with idempotency
  -> CRM records authoritative delivery state
  -> optional Sheets/n8n mirrors update afterward
```

This preserves human control while eliminating the most dangerous gap: an email sent outside the CRM with no reliable transaction, audit, suppression re-check, or duplicate-send protection.

---

## 27. Definition of done

The GTM Outreach Engine v1 is done when:

1. An authorized operator can configure and activate a project.
2. API or CSV prospects are durably accepted, validated, suppressed, and deduplicated.
3. Eligible prospects link to canonical CRM contacts and route to owners.
4. Research and drafts are evidence-backed, versioned, and quality-checked.
5. An authorized human approves or rejects the exact immutable draft version.
6. Approved email sends exactly once after final policy checks.
7. Delivery, bounce, complaint, opt-out, and reply events update authoritative CRM state.
8. Errors are visible, recoverable, and safe to replay.
9. Funnel, AI quality, cost, deliverability, and pipeline reports reconcile with record-level data.
10. Tenant isolation, permissions, consent, audit, security, responsive UI, accessibility, load, and resilience gates pass.

