# PRD: Superleap-Equivalent AI CRM

**Status:** Draft v0.1  
**Date:** 2026-08-10  
**Owner:** Product and Engineering  
**Audience:** Product, Design, Engineering, QA, Security, Data, Implementation, and Customer Success  
**Scope:** A detailed product specification for an enterprise AI CRM with the publicly documented capability surface of Superleap  
**Research basis:** Public Superleap product, integration, Voice AI, SuperAgents, MCP, deployment, and security pages reviewed on 2026-08-10

---

## 0. Document purpose and evidence policy

This PRD describes a buildable CRM product with feature parity to the capabilities Superleap publicly presents. It is a requirements document, not a claim that every internal behavior, screen, data field, entitlement, or implementation detail below exactly matches Superleap's private product.

Requirements use three evidence labels:

- **Verified:** Superleap explicitly describes the capability on an official public page.
- **Required interpretation:** Product behavior needed to make a verified capability complete and usable, but not publicly specified at field or workflow level.
- **Recommended extension:** An enterprise-grade addition that supports the target outcome but should not be represented as a verified Superleap feature.

The target product must not reuse Superleap trademarks, proprietary copy, visual design, or private implementation details. Working names such as `Revenue Agent`, `AI Dashboard`, and `Conversation Intelligence` are intentionally generic.

### Publicly verified product pillars

Superleap publicly presents the following product families:

1. Lead and pipeline management
2. Marketing automation
3. Omnichannel communications
4. Voice and conversation intelligence
5. Visual and AI-assisted workflow automation
6. Teams, hierarchy, territories, permissions, and handovers
7. Reports, dashboards, and natural-language analytics
8. iOS and Android mobile access, including field-sales tools
9. AI revenue agents for enrichment, nurturing, qualification, deal advancement, monitoring, coaching, and audit
10. Natural-language access to CRM data through an MCP-compatible interface
11. Custom data objects, a customer context graph, knowledge base, entity resolution, semantic search, and intent/signal processing
12. Integrations across communication, calendars, customer support, marketing, payments, productivity, accounting, and internal systems
13. Enterprise implementation, migration, configuration, training, and post-launch support
14. Enterprise security, availability, backup, disaster recovery, and compliance controls

---

## 1. Executive summary

The product is an AI-native revenue operating system for medium and large organizations. It combines the system-of-record responsibilities of a CRM with the execution capabilities normally spread across lead-routing tools, campaign tools, inboxes, dialers, call-intelligence products, workflow engines, analytics platforms, field-sales apps, enrichment vendors, and AI assistants.

The product's core promise is:

> Give every revenue team one governed source of customer truth, automate routine work across channels, and let users ask questions or request actions in natural language without losing human control.

The platform has three logical layers:

- **Data and context layer:** configurable CRM objects, customer timeline, identity resolution, relationship graph, files, knowledge, activity and communication history.
- **Execution layer:** pipelines, campaigns, communications, tasks, workflows, integrations, mobile operations, and approvals.
- **Intelligence layer:** conversation analysis, analytics, forecasting, AI assistants, specialized revenue agents, semantic retrieval, and MCP access.

The initial release should prioritize a reliable system of record and daily seller workflows. AI must improve those workflows, not become a dependency for basic CRM operation. Every consequential AI action must be permission-scoped, auditable, explainable, and reversible where feasible.

---

## 2. Product vision

### 2.1 Vision statement

Build an enterprise CRM that actively moves revenue work forward. The system should capture every lead, preserve every customer interaction, recommend the next best action, execute approved work across channels, and provide decision-ready answers without requiring users to assemble reports manually.

### 2.2 Product principles

1. **One customer context:** A user should not switch tools to understand the customer.
2. **Action over storage:** Every insight should lead to a clear next step.
3. **AI with evidence:** AI output should link to the records, conversations, or rules that support it.
4. **Human authority:** People control messages, approvals, record changes, and external actions according to policy.
5. **Flexible without chaos:** Custom objects and workflows must remain governable, versioned, and testable.
6. **Role-aware by default:** Data access, analytics, AI retrieval, and automation all enforce the same permissions.
7. **Mobile is operational:** Field users must be able to complete work, not merely view it.
8. **Observable automation:** Every workflow and agent run exposes status, inputs, outputs, failures, and cost.
9. **Enterprise migration is a product feature:** Imports, mapping, reconciliation, training, and adoption are in scope.

### 2.3 Goals

- Capture and route leads from all connected sources with no silent loss.
- Give representatives a complete, chronological customer and account view.
- Reduce manual data entry, follow-up administration, and report preparation.
- Support multi-team, multi-location, territory, franchise, and enterprise hierarchies.
- Enable governed outreach over email, SMS, WhatsApp, telephony, chat, and connected channels.
- Record, transcribe, summarize, and analyze customer conversations.
- Let business users create workflows and dashboards visually or by prompt.
- Provide useful AI agents for qualification, enrichment, nurturing, monitoring, coaching, audit, and deal progression.
- Make CRM intelligence available in approved AI clients through MCP-compatible tools.
- Meet enterprise expectations for isolation, security, auditability, resilience, and data governance.

### 2.4 Non-goals for the first release

- Replacing a general-purpose ERP, general ledger, payroll, or full customer-support suite.
- Fully autonomous negotiation, pricing, contracting, refunds, or regulated advice.
- Training foundation models on tenant data.
- Building every industry-specific object in the core product; industries should use configurable packs.
- Guaranteeing parity with undocumented Superleap behavior hidden behind authentication or commercial contracts.

---

## 3. Target users and jobs

### 3.1 Sales representative or counsellor

Needs to see assigned work, contact leads quickly, understand context, update outcomes, schedule follow-ups, create opportunities, and receive prioritized next actions.

### 3.2 Field sales representative

Needs mobile lead access, route planning, click-to-call, visit check-in, location-aware tasks, notes, attachments, and offline-tolerant updates.

### 3.3 Sales manager

Needs pipeline health, team activity, conversion, SLA compliance, forecast risk, lead-aging visibility, coaching insights, and intervention controls.

### 3.4 Marketing manager

Needs source attribution, audience segmentation, multichannel campaigns, personalized nurturing, ad-audience sync, spend-to-pipeline analysis, and consent controls.

### 3.5 Revenue operations administrator

Needs custom objects, fields, layouts, lifecycle definitions, routing, workflows, permissions, integrations, data quality, imports, analytics, and change governance.

### 3.6 Customer success or service user

Needs account health, interaction history, open commitments, renewal dates, support context, sentiment, churn signals, and expansion opportunities.

### 3.7 Quality, compliance, or enablement manager

Needs conversation scoring, process-adherence checks, policy monitoring, coaching queues, sampling, reviewer calibration, evidence, and audit exports.

### 3.8 Executive leader

Needs trusted revenue, funnel, forecast, campaign, team, account-health, and risk answers without depending on an analyst for every question.

### 3.9 CRM and security administrator

Needs identity, role, territory, field access, retention, integration, audit, AI, privacy, and security policy management.

---

## 4. Information architecture

### 4.1 Primary navigation

The desktop product should expose the following primary areas, subject to permissions:

- Home / My Work
- Leads
- Contacts
- Accounts
- Pipelines / Opportunities
- Tasks and Calendar
- Engage / Campaigns
- Inbox / Communications
- Calls / Conversation Intelligence
- Revenue Agents
- Workflows
- Dashboards
- Reports
- Data / Custom Objects
- Integrations
- Team and Territories
- Administration

Global surfaces:

- Universal search
- AI command / question entry
- Quick create
- Notifications
- Organization and workspace switcher
- Help and support
- User profile

### 4.2 My Work

The default operational page must show:

- prioritized leads and opportunities;
- overdue and upcoming tasks;
- SLA breaches and records approaching breach;
- recommended calls, messages, and meetings;
- meetings today with AI briefs;
- records awaiting user approval;
- workflow or integration failures the user owns;
- manager announcements and mentions.

Priority must be explainable using due date, lifecycle state, engagement, value, intent, inactivity, SLA, and manager rules. Users must be able to dismiss or snooze a recommendation with a reason.

---

## 5. Core CRM data platform

**Evidence:** Verified at capability-family level; detailed behavior is required interpretation.

### 5.1 Standard objects

The platform must provide these standard tenant-scoped objects:

- Lead
- Contact / Person
- Account / Organization
- Opportunity / Deal
- Pipeline and Stage
- Product / Service
- Price Book
- Quote
- Activity
- Task
- Meeting
- Call
- Message / Conversation
- Campaign
- List / Audience
- File / Document
- Note
- Team, User, Role, Territory, Location
- Consent and Communication Preference

### 5.2 Configurable object platform

`DATA-001` Administrators can create custom objects with singular/plural labels, icons, ownership mode, lifecycle, record naming, and enabled activities.

`DATA-002` Supported field types include text, long text, number, currency, percentage, date, date-time, checkbox, single select, multi-select, email, phone, URL, address, user, formula, auto-number, file, and relationship.

`DATA-003` Objects support one-to-one, one-to-many, and many-to-many relationships with configurable delete behavior.

`DATA-004` Administrators can create layouts by role, team, lifecycle, or record type.

`DATA-005` Field and object schema changes are versioned and auditable. Destructive changes require impact analysis and confirmation.

`DATA-006` List, board, calendar, map, and detail views can be configured and saved.

`DATA-007` Users can filter, sort, group, pin, export, and share views subject to policy.

`DATA-008` Bulk update, assignment, tagging, campaign enrollment, merge, and export require explicit permission and show affected-record counts before execution.

### 5.3 Customer 360 and context graph

`CTX-001` Every lead, contact, and account has a unified timeline containing field changes, messages, calls, meetings, notes, files, tasks, campaign events, workflow actions, consent changes, and AI actions.

`CTX-002` Activities link to all relevant entities, not only one parent record.

`CTX-003` The platform maintains relationships among people, accounts, opportunities, products, communications, and custom objects.

`CTX-004` Identity resolution proposes duplicates using normalized email, phone, domain, external IDs, and configurable fuzzy matching.

`CTX-005` Automatic merges are disabled by default. Suggested merges show field-by-field provenance and allow a survivor value to be chosen.

`CTX-006` Context enrichment can derive role, seniority, industry, location, company size, interests, intent, or other configured attributes while preserving source and confidence.

`CTX-007` Semantic search can retrieve records, notes, transcripts, messages, and approved knowledge documents using natural-language meaning.

`CTX-008` Every AI retrieval result must be filtered by the requesting user's row, field, and knowledge access before content reaches the model.

### 5.4 Knowledge base

`KB-001` Administrators can ingest documents, URLs, FAQs, product sheets, policy documents, and approved structured records.

`KB-002` Content has owner, audience, status, effective dates, sensitivity, language, source, and version.

`KB-003` Indexing exposes progress and parsing failures; removed or expired content must disappear from retrieval within the configured deletion SLA.

`KB-004` AI answers cite the source title and relevant passage location.

`KB-005` Administrators can test retrieval using a selected user persona to verify permission behavior.

### 5.5 Search

`SEARCH-001` Global search covers accessible standard objects, custom objects, communications, transcripts, and knowledge.

`SEARCH-002` Search supports exact, prefix, fuzzy, phone/email normalized, and semantic modes.

`SEARCH-003` Results are grouped by object and include matched-field snippets and recent context.

`SEARCH-004` Search indexes honor permission changes and data deletion.

---

## 6. Lead management and routing

**Evidence:** Verified.

### 6.1 Capture

`LEAD-001` Leads can enter through web forms, landing pages, APIs, CSV import, email, calls, chat, WhatsApp, SMS, ad platforms, partner sources, portals, manual creation, and connected applications.

`LEAD-002` Each ingress event records source, source detail, campaign, medium, external ID, received time, raw-payload reference, consent evidence, and ingestion status.

`LEAD-003` Ingestion is idempotent by tenant, connector, and external ID.

`LEAD-004` Invalid events enter a quarantine queue with reason, payload preview, correction, and replay controls. The system must never silently discard a lead.

`LEAD-005` Duplicate detection runs before assignment and supports link, merge, create anyway, or update-existing policies.

### 6.2 Qualification and scoring

`LEAD-006` Qualification combines explicit fit, engagement, source, campaign, intent, recency, completeness, and configurable business rules.

`LEAD-007` Users see the score, band, contributing factors, model/rule version, and last-calculated time.

`LEAD-008` A score can trigger prioritization or workflow actions but cannot hide or delete a lead.

`LEAD-009` Outcome data feeds score-performance reports so administrators can compare score bands with conversion.

### 6.3 Assignment and distribution

`LEAD-010` Routing supports round robin, weighted distribution, capacity, availability, skill, product, source, region, language, branch, territory, record attribute, and custom expression.

`LEAD-011` Rules have priorities, effective dates, business hours, fallbacks, and simulation mode.

`LEAD-012` Assignment records the matched rule and decision trace.

`LEAD-013` Reassignment supports absence, inactivity, SLA breach, capacity, manager action, team handover, and territory change.

`LEAD-014` Users can accept, decline with reason, transfer, or request manager help when policy permits.

### 6.4 Lifecycle and conversion

`LEAD-015` Tenant-configurable statuses support new, attempted, connected, qualified, nurtured, disqualified, converted, and archived equivalents.

`LEAD-016` Status transitions can require fields, outcomes, tasks, manager approval, or reason codes.

`LEAD-017` Conversion can create or link contact, account, and opportunity records without losing original attribution or timeline.

`LEAD-018` Reopened or recycled leads retain complete lifecycle history.

### 6.5 SLA management

`LEAD-019` SLA policies support first response, first meaningful contact, follow-up, and qualification deadlines by source, priority, schedule, and team.

`LEAD-020` Breach warnings and breaches can notify the owner, manager, or workflow.

`LEAD-021` Pauses, exceptions, and manual overrides require a reason and are audited.

---

## 7. Accounts, contacts, opportunities, and pipeline

**Evidence:** Pipeline and activity management are verified; detailed opportunity mechanics are required interpretation.

### 7.1 Accounts and contacts

`CRM-001` Account records show people, opportunities, activities, conversations, files, tickets or service context, products, payments, health, renewals, and related custom records.

`CRM-002` Contact records support multiple roles, account relationships, communication preferences, language, time zone, influence, and buying role.

`CRM-003` Relationship maps show decision makers, champions, blockers, influencers, reporting lines, and opportunity participation.

`CRM-004` Contact and account ownership can be direct, team-based, territory-derived, or shared.

### 7.2 Opportunity management

`PIPE-001` Multiple pipelines can be configured by business unit, product, segment, geography, or process.

`PIPE-002` Stages have probability, order, entry criteria, exit criteria, required fields, expected duration, allowed transitions, and forecast category.

`PIPE-003` Opportunities track amount, currency, products, quantity, discount, close date, source, competitors, stakeholders, next step, risk, owner, and team.

`PIPE-004` List and Kanban views support filtering, grouping, bulk actions, and drag-to-stage with validation.

`PIPE-005` Stage history records entered time, exited time, duration, actor, reason, and changed values.

`PIPE-006` The platform detects inactivity, stage aging, missing stakeholders, overdue next steps, sentiment changes, and engagement decline.

`PIPE-007` Win and loss capture requires configurable structured reasons and optional narrative.

`PIPE-008` Forecast views support pipeline, best case, commit, closed, weighted value, owner rollups, and manager overrides with audit history.

### 7.3 Deal collaboration and advancement

`PIPE-009` Opportunity members can be assigned roles and responsibilities.

`PIPE-010` Internal notes support mentions, threaded comments, attachments, and visibility rules.

`PIPE-011` Approval flows support discounts, non-standard terms, legal review, credit, pricing, and custom gates.

`PIPE-012` Approved templates can generate quotes, proposals, and deal documents from CRM data.

`PIPE-013` Commercial-risk detection may flag missing approvals, expired pricing, unapproved terms, excessive discount, or contradictory record data.

`PIPE-014` AI can recommend an action or draft a document, but sending, final pricing, and binding approval follow configured human-review policy.

---

## 8. Tasks, meetings, and productivity

**Evidence:** Tasks and mobile task management are verified; detailed behavior is required interpretation.

`TASK-001` Users can create calls, emails, meetings, follow-ups, visits, and custom task types linked to one or more records.

`TASK-002` Tasks support owner, collaborators, due date, recurrence, priority, reminder, SLA, checklist, outcome, and attachments.

`TASK-003` Calendar views aggregate CRM meetings and connected calendars while respecting private-event visibility.

`TASK-004` Two-way calendar sync handles create, update, cancellation, attendee response, conflict, and disconnect states.

`TASK-005` Meeting pages provide customer context, recent changes, open commitments, risks, stakeholders, and suggested agenda.

`TASK-006` After a meeting or call, users receive a draft summary, outcomes, next steps, owners, and due dates for review.

`TASK-007` Bulk rescheduling and reassignment preserve history and notify affected owners according to policy.

---

## 9. Marketing automation and engagement

**Evidence:** Verified for WhatsApp, SMS, email, AI personalization, retargeting, and ad-data synchronization.

### 9.1 Segmentation

`MKT-001` Users can build static and dynamic audiences from CRM fields, relationships, behavior, campaign history, scores, consent, and calculated metrics.

`MKT-002` Audience preview shows estimated size, exclusions, duplicates, channel eligibility, and suppressed records before activation.

`MKT-003` Dynamic audiences refresh on a defined schedule or relevant event.

### 9.2 Campaigns and journeys

`MKT-004` Campaigns support email, SMS, WhatsApp, calls, advertising audiences, and internal tasks.

`MKT-005` Journey steps support send, wait, condition, split, goal, task, webhook, owner notification, score update, record update, audience transfer, and exit.

`MKT-006` Users can define business-hour and recipient-time-zone delivery windows.

`MKT-007` Templates support variables, conditionals, language variants, previews, test sends, approval status, and provider-specific compliance requirements.

`MKT-008` AI personalization can propose copy or select approved content using lead activity and context; users can inspect the input context and preview generated variants.

`MKT-009` Frequency caps, quiet hours, unsubscribes, opt-outs, hard bounces, invalid numbers, and suppression lists are enforced before provider submission.

`MKT-010` Campaigns support draft, approval, scheduled, running, paused, completed, cancelled, and failed states.

### 9.3 Retargeting and attribution

`MKT-011` Eligible audiences can synchronize to connected advertising platforms with sync status and removal behavior.

`MKT-012` Campaign and source attribution is preserved through lead conversion and opportunity closure.

`MKT-013` Reports connect spend and engagement to qualified leads, pipeline, won revenue, cost per converted lead, and return on spend.

`MKT-014` Attribution models include first touch, last touch, linear, position-based, and configurable models.

`MKT-015` UTM and external campaign mappings are normalized without erasing raw source values.

---

## 10. Omnichannel communications hub

**Evidence:** Verified.

### 10.1 Unified inbox

`COMMS-001` The inbox unifies connected email, SMS, WhatsApp, chat, social or partner messaging, and call events in customer conversations.

`COMMS-002` Threads show customer identity, account, owner, open opportunity, lifecycle, prior messages, consent, sentiment, and open tasks.

`COMMS-003` Users can assign, transfer, follow, tag, mention, prioritize, snooze, close, reopen, and merge conversations.

`COMMS-004` Collision detection shows when another user is viewing or composing in the same conversation.

`COMMS-005` Channel-specific delivery, read, bounce, failure, and provider states are normalized while retaining raw provider diagnostics.

### 10.2 Composition and sales assistance

`COMMS-006` Users can use approved templates, snippets, signatures, attachments, scheduling, and recipient-time-zone hints.

`COMMS-007` AI can summarize the thread, propose a reply, rewrite tone, translate, identify objections, and suggest talking points.

`COMMS-008` Suggested content uses only accessible CRM and knowledge context and shows evidence links.

`COMMS-009` Tenant policy controls whether AI text is draft-only, eligible for bulk approval, or allowed for narrow automated use cases.

`COMMS-010` Sending always enforces consent, suppression, provider template, attachment, and recipient validation.

### 10.3 Shared communication operations

`COMMS-011` Teams can define inboxes, channel identities, signatures, working hours, assignment rules, SLAs, and escalation paths.

`COMMS-012` Supervisors can inspect queue age, first-response time, handling time, unresolved count, and ownership.

`COMMS-013` Record access does not automatically grant permission to every sensitive conversation; channel and inbox policy can be stricter.

---

## 11. Telephony and conversation intelligence

**Evidence:** Verified for recording, transcription, analysis, summaries, next steps, sentiment, outcome prediction, and AI voice operations.

### 11.1 Human calling

`VOICE-001` The platform supports click-to-call, inbound screen-pop, call controls, disposition, notes, transfer, and provider status.

`VOICE-002` Calls link automatically to the best matching contact, account, lead, and opportunity; ambiguous matches require confirmation.

`VOICE-003` Recording and transcription honor jurisdiction, tenant policy, consent announcement, and role access.

`VOICE-004` Transcripts support speaker labels, timestamps, search, playback synchronization, language identification, and correction.

### 11.2 Conversation intelligence

`VOICE-005` Post-call analysis generates a summary, disposition, next steps, commitments, objections, products, competitors, risks, sentiment, and outcome signals.

`VOICE-006` Every extracted fact includes confidence and transcript evidence.

`VOICE-007` Proposed record updates are reviewed or automatically applied according to field-level AI policy.

`VOICE-008` Managers can define scorecards with weighted questions, automatic evidence-backed scoring, manual review, and calibration.

`VOICE-009` Coaching identifies patterns by rep and team and creates private, permissioned recommendations.

`VOICE-010` Conversation analytics cover topic frequency, talk ratio, monologue length, interruptions, questions, objections, sentiment, commitments, adherence, and outcome correlation where supported.

### 11.3 AI voice agents

`VAI-001` Authorized users can create inbound or outbound voice agents from a prompt and refine the generated flow visually.

`VAI-002` Agent configuration includes use case, objectives, language, voice, tone, pace, interruption behavior, opening, closing, retry, voicemail, transfer, compliance, and fallback.

`VAI-003` Agents can use approved knowledge and CRM context, invoke allowlisted APIs, update approved CRM fields, create tasks, schedule meetings, send payment links, and transfer to humans.

`VAI-004` Bulk campaigns support audience selection, concurrency, provider capacity, calling hours, retries, DNC checks, budget, pause, and emergency stop.

`VAI-005` Human-in-the-loop transfer supports intent, low confidence, negative sentiment, explicit request, policy trigger, and custom conditions.

`VAI-006` Multilingual operation supports configured languages and accents, with per-language prompt and QA testing.

`VAI-007` Model providers for speech recognition, language reasoning, and text-to-speech are abstracted behind a governed provider registry.

`VAI-008` Live actions validate arguments, time out safely, avoid duplicate execution, and return a customer-safe failure path.

`VAI-009` Every AI call stores campaign, agent version, prompt version, transcript, tool calls, outcomes, cost, latency, transfer, and policy events.

`VAI-010` Pre-production simulation and a limited canary campaign are required before full launch.

### 11.4 Representative use cases

- Lead pre-qualification and routing
- Appointment, demo, test-drive, or site-visit booking
- Admission, application, document, fee, and payment follow-up
- KYC or onboarding guidance without making regulated decisions
- Renewal, refill, maintenance, insurance, and warranty reminders
- Feedback, satisfaction, and post-visit surveys
- Re-engagement of inactive customers, users, sellers, or partners
- Order confirmation, alerts, and status notifications

---

## 12. Workflow automation

**Evidence:** Verified for visual triggers, conditions, actions, cross-functional automation, and AI-assisted workflow creation.

### 12.1 Workflow designer

`FLOW-001` Users can create workflows in a visual node-and-connector canvas.

`FLOW-002` Triggers include record created/updated/deleted, field transition, schedule, date reached, inactivity, form submission, campaign event, message event, call outcome, webhook, manual action, and integration event.

`FLOW-003` Logic supports conditions, branches, wait-until, wait-duration, business hours, loops over bounded collections, goals, joins, and stop conditions.

`FLOW-004` Actions include create/update record, assign, create task, send communication, enroll in journey, call webhook, invoke integration, request approval, run AI step, generate document, notify, and launch child workflow.

`FLOW-005` Workflows support draft, validated, active, paused, archived, and superseded versions.

### 12.2 AI-assisted workflow creation

`FLOW-006` A user can describe a workflow in natural language and receive an editable draft graph.

`FLOW-007` The generated draft identifies ambiguous requirements, unavailable fields, permissions, missing integrations, potential loops, and projected execution volume.

`FLOW-008` AI-generated workflows cannot activate without validation and an authorized user's confirmation.

### 12.3 Testing and operations

`FLOW-009` Validation detects unreachable nodes, missing paths, recursive loops, incompatible field types, unconfigured channels, and excessive fan-out.

`FLOW-010` Test mode runs against sample or selected records without external side effects unless explicitly enabled.

`FLOW-011` Execution logs expose trigger, version, path, inputs, actions, outputs, retries, errors, duration, and actor.

`FLOW-012` Failed steps support retry, skip, replay from step, or terminate, according to idempotency policy.

`FLOW-013` Administrators can define tenant and workflow concurrency, volume, spend, and AI-token limits.

`FLOW-014` A kill switch can pause one workflow, a category, or all tenant automations.

---

## 13. Teams, hierarchy, territories, and permissions

**Evidence:** Verified.

### 13.1 Organization model

`TEAM-001` The platform supports multiple business units, branches, locations, franchises, teams, subteams, and reporting relationships.

`TEAM-002` A visual hierarchy editor shows users, vacancies, managers, roles, territories, and inherited access.

`TEAM-003` Users may belong to multiple teams with one primary manager and policy-controlled dotted-line relationships.

`TEAM-004` Territories can be based on geography, product, industry, segment, account list, source, or custom rules.

### 13.2 Authorization

`AUTHZ-001` Access control combines role, hierarchy, team, territory, ownership, record sharing, field policy, and object permission.

`AUTHZ-002` Permissions distinguish view, create, edit, delete, export, assign, merge, approve, communicate, automate, administer, and AI-use actions.

`AUTHZ-003` Field security supports hidden, masked, read-only, and editable states.

`AUTHZ-004` Saved views, reports, dashboards, inboxes, knowledge sources, integrations, workflows, and AI agents have independent sharing controls.

`AUTHZ-005` Permission simulation lets an administrator inspect the effective experience of a selected user without impersonating their credentials.

### 13.3 Handover

`TEAM-005` User deactivation launches a handover workflow for records, tasks, conversations, approvals, campaigns, dashboards, workflows, and integration ownership.

`TEAM-006` Temporary delegation supports leave dates and automatic return of responsibilities.

`TEAM-007` Bulk ownership changes provide impact preview, preserve history, and are auditable.

---

## 14. Reports, dashboards, and forecasting

**Evidence:** Verified for real-time visual reporting and prompt-generated dashboards; natural-language use cases are verified through Superleap MCP.

### 14.1 Report builder

`BI-001` Reports can query accessible standard and custom objects, relationships, activities, communications, campaign events, and calculated metrics.

`BI-002` Users can select dimensions, measures, filters, date comparisons, grouping, sorting, limits, and chart type.

`BI-003` Supported outputs include table, KPI, line, area, bar, stacked bar, funnel, cohort, pie/donut where appropriate, scatter, map, and pivot.

`BI-004` Reports support save, clone, folder, sharing, scheduling, export, subscription, and dashboard placement.

`BI-005` Metric definitions display owner, formula, filters, grain, refresh state, and certification status.

### 14.2 Dashboards

`BI-006` Dashboards are responsive, filterable, role-aware, and refresh from governed datasets.

`BI-007` A natural-language prompt can generate a draft dashboard, including proposed metrics, filters, and visualizations.

`BI-008` Prompt-generated metrics must map to governed fields or disclose any derived formula before publication.

`BI-009` Users can drill from a metric to supporting records subject to permissions.

### 14.3 Standard analytics packs

The product must ship with:

- Lead source, speed-to-lead, contact, qualification, and conversion
- Funnel volume, conversion, velocity, aging, leakage, and stage duration
- Pipeline coverage, forecast, slippage, win/loss, and deal risk
- Activity volume, outcome, productivity, SLA, and rep performance
- Campaign delivery, engagement, qualification, pipeline, revenue, and ROI
- Conversation topic, sentiment, scorecard, quality, coaching, and outcome
- Workflow execution, failure, latency, volume, and business outcome
- Data completeness, duplicates, stale records, and source quality
- Account health, churn risk, renewal, and expansion
- AI usage, acceptance, correction, automation, quality, cost, and latency

### 14.4 Natural-language analytics

`BI-010` Users can ask questions such as pipeline by stage, win/loss by segment, team activity, stalled deals, funnel drop-off, campaign-to-pipeline, cost per conversion, account health, renewals, or expansion potential.

`BI-011` Answers include interpreted filters, time range, metric definition, result, visualization when useful, supporting records, and data freshness.

`BI-012` Ambiguous questions trigger clarification instead of silently selecting a definition.

`BI-013` Generated queries are tenant-scoped, permission-filtered, read-only, resource-limited, and logged.

`BI-014` Users can save a successful answer as a report, dashboard tile, alert, or scheduled digest.

---

## 15. AI assistant and revenue agents

**Evidence:** Verified for the agent families and broad outcomes. Detailed controls are required interpretation.

### 15.1 General AI assistant

`AI-001` A global assistant can answer CRM questions, summarize accessible context, prepare meetings, identify priorities, draft artifacts, and propose CRM actions.

`AI-002` Users can mention records, reports, files, or knowledge sources to constrain context.

`AI-003` The assistant distinguishes read-only answers, draft creation, reversible writes, external communication, and high-impact actions.

`AI-004` External communications, bulk changes, deletion, approvals, pricing, contractual action, and regulated decisions require explicit authorization and policy checks.

`AI-005` Every answer shows source links where it makes factual claims from CRM or knowledge data.

### 15.2 Agent runtime

Every agent definition includes:

- purpose and success metric;
- allowed tenants, roles, teams, objects, fields, and knowledge;
- allowed tools and action classes;
- triggers and operating schedule;
- model/provider configuration;
- instructions and version;
- human approval policy;
- per-run and periodic budgets;
- retry, timeout, fallback, and stop behavior;
- test cases and evaluation threshold;
- owner and escalation contact.

Every agent run stores inputs, retrieved evidence, decisions, tool calls, outputs, approvals, errors, latency, token/provider usage, cost estimate, and outcome feedback.

### 15.3 Enrichment agent

`AGENT-ENRICH-001` Detect missing, stale, or inconsistent records and propose field updates.

`AGENT-ENRICH-002` Preserve value-level provenance, retrieval date, source, confidence, and prior value.

`AGENT-ENRICH-003` Allow policy-controlled auto-acceptance for low-risk fields and review queues for sensitive or identity-changing fields.

`AGENT-ENRICH-004` Never overwrite a verified human value solely because an inferred value differs.

### 15.4 Nurture agent

`AGENT-NURTURE-001` Combine attribution, engagement, intent, lifecycle, and consent to recommend or execute approved nurture steps.

`AGENT-NURTURE-002` Personalize from approved context and templates, enforce frequency caps, and stop on conversion, reply, opt-out, or goal completion.

`AGENT-NURTURE-003` Report incremental pipeline and conversion outcomes by strategy and audience.

### 15.5 Qualification agent

`AGENT-QUALIFY-001` Qualify low-intent or high-volume leads through approved voice, chat, and WhatsApp interactions.

`AGENT-QUALIFY-002` Gather configured criteria, capture evidence, assign a qualification status, and route qualified opportunities.

`AGENT-QUALIFY-003` Escalate ambiguity, customer distress, unsupported questions, sensitive requests, and opt-out intent to a human or safe ending.

### 15.6 Deal advancement agent

`AGENT-ADVANCE-001` Identify approval blockers, missing documents, unresolved commercial risk, stale next steps, and process gaps.

`AGENT-ADVANCE-002` Draft deal documents from approved templates and route them through required review.

`AGENT-ADVANCE-003` Recommend a next action with evidence; it must not invent an approval, legal conclusion, or customer commitment.

### 15.7 Account monitoring agent

`AGENT-MONITOR-001` Monitor account activity, engagement, sentiment, tickets, usage signals, renewal dates, opportunity changes, and configured external signals.

`AGENT-MONITOR-002` Produce meeting briefs, churn warnings, expansion signals, and forecast-risk updates.

`AGENT-MONITOR-003` Alerts must explain the changed signals and suppress duplicate noise.

### 15.8 Coaching agent

`AGENT-COACH-001` Analyze conversations against role- and process-specific scorecards.

`AGENT-COACH-002` Generate private coaching recommendations with timestamps and examples.

`AGENT-COACH-003` Managers can review, edit, assign, and track coaching actions; sensitive coaching access is narrower than ordinary call access.

`AGENT-COACH-004` The system reports model-to-reviewer agreement and allows score appeals.

### 15.9 Audit and quality agent

`AGENT-AUDIT-001` Score calls, chats, emails, and WhatsApp interactions for process adherence, quality, approved claims, required disclosures, and configured compliance risks.

`AGENT-AUDIT-002` Monitor both human and AI-generated interactions.

`AGENT-AUDIT-003` Findings include severity, rule, evidence, confidence, affected interaction, and recommended disposition.

`AGENT-AUDIT-004` A human reviewer decides consequential compliance outcomes unless policy explicitly defines deterministic automatic action.

### 15.10 AI evaluation and governance

`AI-GOV-001` Each production use case has a versioned evaluation dataset with expected behavior and prohibited behavior.

`AI-GOV-002` Promotion requires thresholds for groundedness, task success, unsafe action rate, sensitive-data leakage, and latency.

`AI-GOV-003` Models, prompts, tools, retrieval settings, and policies are versioned independently.

`AI-GOV-004` Administrators can disable a provider, model, agent, tool, or action category immediately.

`AI-GOV-005` User corrections and accepted/rejected suggestions feed quality reporting; they do not automatically become training data.

---

## 16. MCP-compatible CRM access

**Evidence:** Verified for access from Claude, ChatGPT, Gemini, and other compatible AI tools.

`MCP-001` The platform exposes a standards-compatible MCP server for approved CRM search, retrieval, analytics, and actions.

`MCP-002` Authentication uses short-lived, revocable user or service authorization with tenant binding.

`MCP-003` Tool permissions are never broader than the user's effective CRM permissions.

`MCP-004` Initial read tools include search records, get record context, query governed metrics, get pipeline, get tasks, get meeting brief, and search knowledge.

`MCP-005` Optional write tools include create task, add note, update approved fields, and draft communication. High-impact and external actions require interactive confirmation or an approved service policy.

`MCP-006` Tool responses minimize data, mark sensitive fields, include source identifiers, and avoid returning inaccessible related records.

`MCP-007` Administrators can allow or deny individual clients, tools, objects, fields, teams, and action classes.

`MCP-008` All sessions and tool calls are audited with client, user, scopes, arguments summary, result status, latency, and records accessed.

`MCP-009` Rate limits, query budgets, result caps, and anomaly detection protect against extraction and runaway agent loops.

`MCP-010` Revoking a user, token, client, or tenant feature takes effect without waiting for a long-lived session to expire.

---

## 17. Mobile and field sales

**Evidence:** Verified for iOS/Android access, territory and route planning, GPS, geofenced tasks, leads, calls, task updates, visit notes, and real-time follow-ups.

### 17.1 Mobile core

`MOB-001` Native or high-quality cross-platform iOS and Android applications expose My Work, leads, contacts, accounts, opportunities, tasks, calendar, inbox, calls, notifications, and search.

`MOB-002` Users can create and update records, log outcomes, add notes, scan or attach documents, and complete follow-ups.

`MOB-003` Click-to-call logs the call and prompts for disposition without blocking urgent subsequent work.

`MOB-004` Push notifications deep-link to the relevant record or task and obey quiet-hour policy.

### 17.2 Field operations

`MOB-005` Route planning uses assigned visits, time windows, priority, estimated travel time, and user-controlled start/end points.

`MOB-006` Users can accept or reorder a proposed route and launch navigation in an approved maps application.

`MOB-007` Visit check-in and check-out can capture time and location with clear consent and configured precision.

`MOB-008` Geofenced tasks can suggest arrival or completion but must not silently mark work complete.

`MOB-009` Managers see field location only under explicit company policy, user notice, business-purpose limits, and configured working hours.

`MOB-010` Offline mode caches a minimal encrypted work set and queues updates with conflict handling. Logout, revocation, or device policy can wipe cached tenant data.

### 17.3 Mobile non-functional requirements

- Cold launch p95 under 3 seconds on supported mid-range devices under normal conditions.
- Cached list interaction under 200 ms.
- Resumable upload for photos and documents.
- Accessible text scaling and touch targets.
- Battery-efficient location collection; continuous background tracking is off by default.

---

## 18. Integrations and platform APIs

**Evidence:** Verified for 100+ integrations and the published integration categories; Zoom, Slack, Gmail, and Zapier are explicitly named.

### 18.1 Integration categories

- Calendar and meetings
- Communication services
- Customer support
- Marketing and analytics
- Advertising platforms
- Payments and accounting
- Productivity and collaboration
- Data enrichment
- Telephony
- Internal systems and data warehouses
- Automation platforms

### 18.2 Named baseline integrations

`INT-001` Zoom: schedule, join, and track meetings.

`INT-002` Slack: route real-time notifications to approved channels and support record deep links.

`INT-003` Gmail or Google Workspace: send, receive, synchronize, and track email with appropriate mailbox authorization.

`INT-004` Zapier: expose triggers and actions for broader application connectivity.

`INT-005` Calendar connectors should support Google and Microsoft ecosystems in the baseline enterprise package.

### 18.3 Connector framework

`INT-006` Connectors have tenant configuration, credential owner, status, scopes, health, sync direction, field mapping, conflict policy, and log retention.

`INT-007` Credentials are encrypted, redacted from UI and logs, rotatable, and never included in model context.

`INT-008` OAuth uses least privilege, state validation, short-lived access where available, and revocation handling.

`INT-009` Sync supports initial backfill, incremental cursors, idempotency, retries, dead-letter handling, replay, and rate-limit backoff.

`INT-010` Administrators can inspect record-level failures without seeing secret values.

`INT-011` Webhooks are signed, timestamp-checked, replay-protected, and observable.

`INT-012` A public API supports tenant-scoped CRUD, search, bulk import/export, events, and metadata according to customer entitlement.

`INT-013` API keys and service principals have granular scopes, expiry, IP policy, usage analytics, and immediate revocation.

---

## 19. Industry solution packs

**Evidence:** Superleap publicly positions tailored solutions for education, healthcare, BFSI, real estate, automotive, manufacturing, and marketplace businesses. Solution packs below translate those outcomes into configurable product packages.

### 19.1 Education

- Student enquiry and guardian records
- Program, course, campus, intake, counsellor, and partner entities
- Student journey and admission pipeline
- Omnichannel nurturing and multilingual engagement
- Region, program, source, and counsellor assignment
- Application, document, deadline, fee, and follow-up workflows
- Student or applicant portal

### 19.2 Healthcare

- Patient or client relationship context separated from the clinical system of record
- Appointment and reminder workflows
- Consent-aware communications
- Lab-ready notifications, feedback, refill, and recurring engagement use cases
- Healthcare-specific access and audit controls
- EHR, scheduling, billing, or service integrations where contracted

The CRM must not present itself as an EHR or make clinical decisions unless a separate regulated product scope is approved.

### 19.3 BFSI

- Central client 360
- Product-interest and application lifecycle
- KYC workflow guidance and status integration
- Renewal, payment, and relationship workflows
- Agent hierarchy and branch visibility
- Communication review, disclosure checks, risk flags, and strict audit

The CRM must not make autonomous credit, underwriting, investment, or fraud determinations in the baseline scope.

### 19.4 Real estate

- Property, project, unit, inventory, broker, and buyer-preference objects
- Portal and advertising lead capture
- Budget, location, property-type, and intent qualification
- Site-visit scheduling and field execution
- Buyer engagement and end-to-end sales pipeline
- Payment and document reminders

### 19.5 Automotive

- Dealer, branch, vehicle, variant, inventory, customer, and service context
- Lead and dealership distribution
- Test-drive booking and follow-up
- Vehicle sales journey from enquiry to delivery
- Insurance, service, warranty, and satisfaction workflows
- Field and dealership mobile operations

### 19.6 Manufacturing

- Distributor, dealer, product, order, installation, warranty, and maintenance objects
- Channel pipeline and territory management
- Order confirmations, maintenance alerts, safety broadcasts, and payment follow-ups
- ERP, inventory, accounting, and service integrations

### 19.7 Marketplace platforms

- Buyer, seller, merchant, partner, and marketplace-account objects
- Onboarding and verification journeys
- Activation, reactivation, feedback, quality, payout, and settlement communications
- Partner health, expansion, and churn monitoring

---

## 20. Security, privacy, compliance, and resilience

**Evidence:** Superleap publicly states ISO 27001 certification, HIPAA-supporting design, TLS 1.2+, restricted just-in-time infrastructure access, annual third-party penetration testing, redundant services, encrypted backups, multi-location backups, restoration testing, and disaster-recovery procedures. The requirements below are the target product's own implementation obligations.

### 20.1 Identity and access

`SEC-001` Support SSO through SAML or OIDC, MFA, session policy, password policy for local accounts, and SCIM or equivalent lifecycle automation.

`SEC-002` Enforce least privilege, tenant isolation, object/row/field access, service-account scopes, and separation of administrative duties.

`SEC-003` Privileged production access is time-bound, approved, strongly authenticated, and audited.

### 20.2 Data protection

`SEC-004` Encrypt data in transit with TLS 1.2 or higher and at rest using managed key services.

`SEC-005` Secrets and credentials use a dedicated secret store and never appear in application logs, exports, analytics, or AI context.

`SEC-006` Sensitive fields can be masked, encrypted at field level, excluded from export, and excluded from AI processing by policy.

`SEC-007` Tenant-configurable retention supports records, communications, recordings, transcripts, AI traces, audit logs, and backups within supported limits.

`SEC-008` Data-subject access, correction, export, restriction, and deletion workflows preserve required legal and audit exceptions.

### 20.3 Audit and monitoring

`SEC-009` Audit events cover authentication, permission changes, data access where required, exports, bulk changes, integration configuration, workflow publication, agent publication, AI actions, and administrative operations.

`SEC-010` Audit records include tenant, actor, action, target, timestamp, request or run ID, source, result, and relevant before/after metadata.

`SEC-011` Security monitoring combines deterministic rules, anomaly detection, alert triage, and incident procedures.

`SEC-012` Customers can export or integrate approved audit and security events with a SIEM.

### 20.4 Availability and recovery

`SEC-013` Production services use redundancy across failure domains and remove unhealthy instances automatically.

`SEC-014` Backups are encrypted, geographically separated as policy requires, integrity-checked, and restore-tested.

`SEC-015` Define contractual RPO and RTO by service tier. Proposed enterprise targets are RPO <= 15 minutes for primary transactional data and RTO <= 4 hours for a regional disaster, pending architecture approval.

`SEC-016` Disaster-recovery, incident-response, and business-continuity exercises occur at least annually, with corrective actions tracked.

### 20.5 Secure development

`SEC-017` CI performs dependency, secret, static-code, infrastructure, and container scanning where applicable.

`SEC-018` High-risk changes receive threat modeling and security review.

`SEC-019` Independent penetration testing occurs at least annually and after material architectural change.

`SEC-020` Maintain a public vulnerability-disclosure process and internal remediation SLAs by severity.

### 20.6 AI-specific security

`SEC-AI-001` Treat retrieved documents, messages, web content, and tool output as untrusted input.

`SEC-AI-002` Prompt injection cannot grant new tools, permissions, data access, or action authority.

`SEC-AI-003` Tool arguments are schema-validated and policy-checked independently of model output.

`SEC-AI-004` Sensitive data redaction, residency, model-provider retention, and training policies are configurable and contractually documented.

---

## 21. Administration, migration, and deployment services

**Evidence:** Verified for data migration, custom flows and connections, platform configuration, dedicated technical account/implementation support, training, agent deployment, zero-downtime migration, post-launch support, and optimization.

### 21.1 Administration

Administrators need centralized control for:

- organization, workspace, business unit, branch, and locale;
- users, teams, hierarchy, roles, territories, and locations;
- objects, fields, relationships, layouts, pipelines, and stages;
- channels, identities, consent, templates, and suppression;
- workflows, agents, models, budgets, approvals, and AI policy;
- integrations, APIs, webhooks, and service accounts;
- reports, metric definitions, folders, sharing, and certification;
- security, SSO, retention, audit, export, and mobile policy;
- usage, entitlements, limits, health, and support access.

### 21.2 Migration workbench

`MIG-001` Import supports CSV and API-based migration for standard and custom objects, activities, notes, files, ownership, and relationships.

`MIG-002` Mapping supports source field, target field, transformation, default, lookup, reference resolution, and validation.

`MIG-003` Dry run reports valid, invalid, duplicate, unresolved-reference, and permission-conflict counts.

`MIG-004` Import jobs are resumable and provide row-level outcomes and downloadable error files.

`MIG-005` Reconciliation compares source counts, target counts, key totals, relationships, sample hashes, and failed rows.

`MIG-006` Cutover plans support incremental delta loads and a defined source freeze to minimize interruption.

`MIG-007` Rollback strategy is documented and tested before production cutover.

### 21.3 Implementation lifecycle

1. Discovery and success-metric baseline
2. Process and data mapping
3. Security, identity, and integration design
4. Sandbox configuration
5. Migration rehearsal and reconciliation
6. Workflow and AI-agent evaluation
7. Role-based UAT
8. Training and enablement
9. Production cutover
10. Hypercare, adoption review, and optimization

Named implementation owners, decision logs, risks, dependencies, test evidence, training completion, and go-live criteria must be visible to customer and delivery teams.

---

## 22. Notifications and collaboration

`COLLAB-001` In-app, email, mobile push, Slack, and other enabled destinations use a shared notification preference model.

`COLLAB-002` Users can follow records and receive mentions, ownership changes, task reminders, SLA events, approval requests, replies, workflow failures, and AI findings.

`COLLAB-003` Notifications are grouped, deduplicated, actionable, and deep-linked.

`COLLAB-004` Managers can publish team announcements without exposing hidden record data.

`COLLAB-005` Digest frequency and quiet hours are user-configurable within mandatory-policy boundaries.

---

## 23. Data model summary

The implementation should use tenant-scoped models equivalent to the following domains:

| Domain | Core entities |
|---|---|
| Tenant and identity | Tenant, Workspace, BusinessUnit, Location, User, Team, TeamMembership, Role, PermissionSet, Territory, Delegation |
| CRM metadata | ObjectDefinition, FieldDefinition, RelationshipDefinition, Layout, RecordType, Lifecycle, StageDefinition, SavedView |
| CRM records | Lead, Contact, Account, Opportunity, OpportunityContactRole, Product, PriceBook, Quote, QuoteLine |
| Work | Activity, Task, Meeting, Visit, Note, File, Mention, Notification |
| Communications | Channel, ChannelIdentity, Inbox, Conversation, Participant, Message, DeliveryEvent, CallSession, Recording, Transcript |
| Marketing | Campaign, Journey, JourneyVersion, JourneyStep, Audience, AudienceMember, Template, Consent, Suppression |
| Automation | Workflow, WorkflowVersion, WorkflowNode, WorkflowRun, WorkflowStepRun, ApprovalRequest |
| Intelligence | ScoreDefinition, ScoreSnapshot, Signal, Insight, ForecastSnapshot, MetricDefinition, Report, Dashboard |
| AI | AgentDefinition, AgentVersion, AgentRun, ToolDefinition, ToolCall, AiSuggestion, AiApproval, ModelPolicy, EvaluationCase, EvaluationRun |
| Knowledge | KnowledgeSource, KnowledgeDocument, KnowledgeChunk, Citation, Entity, EntityRelationship, IdentityMatch |
| Integrations | ConnectorDefinition, ConnectorInstance, CredentialReference, SyncCursor, SyncJob, SyncError, WebhookEndpoint, ApiClient |
| Governance | AuditEvent, ExportJob, ImportJob, RetentionPolicy, LegalHold, SecurityEvent, DataSubjectRequest |

Every business entity must include tenant identity, stable ID, creation/update metadata, version or concurrency token, and soft-delete/retention behavior where appropriate.

---

## 24. Non-functional requirements

### 24.1 Performance

- Standard cached list API p95 under 500 ms and detail API p95 under 700 ms at the agreed reference load.
- Interactive UI response under 100 ms for local state and visible acknowledgement under 300 ms for network actions.
- Global indexed search p95 under 2 seconds.
- Dashboard initial useful render p95 under 3 seconds for standard dashboards.
- AI assistant should stream first useful output p95 under 3 seconds, excluding slow external tools; total status must remain visible.
- Bulk jobs and long-running AI tasks must be asynchronous, resumable, and progress-reporting.

### 24.2 Scale

Capacity planning must define tested limits for:

- active tenants and users;
- records and activities per tenant;
- messages, calls, and transcript hours per day;
- workflow and agent runs per minute;
- concurrent imports, exports, campaigns, and voice calls;
- search and analytics freshness;
- integration webhook bursts.

No limit may exist only in documentation; it must be enforced with a clear error, queue, or entitlement state.

### 24.3 Reliability

- Mutation APIs use idempotency keys where retry is expected.
- Event consumers provide at-least-once processing with deduplication.
- External side effects use durable outbox or equivalent guarantees.
- Failed jobs retain enough state for safe replay.
- Provider outages degrade the affected channel without blocking unrelated CRM work.

### 24.4 Accessibility and responsiveness

- Web application targets WCAG 2.2 AA.
- All operational pages work from 320 CSS pixels through large desktop layouts.
- Keyboard navigation, focus order, screen-reader names, contrast, zoom to 200%, reduced motion, and error association are test gates.
- Dense operational screens reflow or scroll within bounded regions; controls and text must not overlap.

### 24.5 Localization

- Locale-aware date, time, time zone, number, currency, address, and name formatting.
- User and recipient time zones are distinct and explicit.
- UI and template localization support translation keys and fallback.
- Right-to-left support is an architectural requirement even if deferred from launch.

### 24.6 Observability

- Correlated request, workflow, connector, campaign, call, and agent run IDs.
- Metrics for availability, latency, error, queue lag, provider status, data freshness, cost, and business outcome.
- Tenant-safe diagnostics and support tooling.
- Alerting ties to owned runbooks and service-level objectives.

---

## 25. Critical end-to-end acceptance journeys

### Journey A: New paid-ad lead to qualified opportunity

1. A lead arrives from an ad connector with campaign attribution and consent evidence.
2. Ingestion deduplicates and normalizes the record.
3. Routing assigns the lead using branch, language, capacity, and business hours.
4. The owner receives a mobile and in-app alert with the response SLA.
5. The qualification agent may contact the lead under campaign and consent policy.
6. Answers and transcript evidence update qualification fields after review or policy-approved automation.
7. A qualified lead converts to contact, account, and opportunity with full attribution and timeline.
8. Dashboards update lead response, source conversion, pipeline, and agent outcomes.

**Pass condition:** No event is silently lost; every decision and external action is traceable.

### Journey B: Omnichannel nurture with customer reply

1. Marketing builds a consent-eligible dynamic audience.
2. A journey sends approved WhatsApp, email, and SMS steps using recipient-local delivery windows.
3. The customer replies on WhatsApp.
4. Remaining outbound steps stop according to the journey goal.
5. The unified inbox identifies the record, owner, and open opportunity.
6. AI proposes a grounded reply; the user edits and sends it.
7. Campaign-to-pipeline reporting includes the response and later opportunity outcome.

**Pass condition:** Reply, consent, suppression, and lifecycle events prevent inappropriate further sends.

### Journey C: Call intelligence and coaching

1. A representative places a CRM call.
2. Policy-compliant recording and transcription begin.
3. The call links to the correct entities.
4. Analysis creates an evidence-backed summary, commitments, objections, sentiment, and next steps.
5. The user confirms record updates and tasks.
6. The quality agent scores the call against the active scorecard.
7. A manager reviews a flagged item and assigns private coaching.

**Pass condition:** Every extracted claim links to transcript evidence and obeys recording and coaching access.

### Journey D: Natural-language executive analysis

1. A leader asks why conversion dropped last month.
2. The system clarifies the funnel, period, and comparison if ambiguous.
3. A permission-safe query analyzes volume, conversion, source, stage, team, and response-time shifts.
4. The answer shows definitions, freshness, evidence, chart, and supporting records.
5. The leader saves the result as a monitored dashboard tile.

**Pass condition:** Re-running the same defined query produces reconcilable numbers with the certified report layer.

### Journey E: Field visit

1. A mobile user receives a prioritized route for assigned visits.
2. The user adjusts the route and launches navigation.
3. Arrival triggers a geofence suggestion; the user confirms check-in.
4. The user logs notes, outcome, next task, and an attachment offline.
5. Sync resumes, handles any conflict, and updates manager visibility.

**Pass condition:** No data is lost, location collection is transparent, and geofence presence does not fabricate completion.

### Journey F: AI voice campaign with live action

1. An authorized user selects an eligible audience and a tested AI voice-agent version.
2. The system previews volume, budget, calling hours, language, DNC exclusions, and concurrency.
3. A canary campaign runs and passes quality review.
4. During a call, the agent checks availability through an allowlisted API and books a meeting.
5. A duplicate tool invocation does not create a duplicate meeting.
6. A low-confidence question transfers to a human with context.
7. Outcomes, costs, recordings, transcripts, actions, and failures appear in the campaign report.

**Pass condition:** Policy, budget, tool safety, handoff, and stop controls work under load.

---

## 26. Success metrics

### 26.1 Adoption

- Weekly active users / licensed users
- Time to first useful record, workflow, dashboard, and integration
- User completion of daily work in CRM
- Mobile weekly active field users
- Search, assistant, and agent adoption by role

### 26.2 Revenue operations

- Lead capture success rate
- Median and p90 speed to first response
- Contact and qualification rate
- Lead-to-opportunity and opportunity-to-win conversion
- Pipeline velocity and stage-aging reduction
- Forecast accuracy
- Follow-up completion and overdue reduction

### 26.3 Marketing and communications

- Deliverability and channel failure rate
- Reply and meaningful engagement rate
- Qualified pipeline and won revenue by campaign
- Cost per qualified and converted lead
- Opt-out, complaint, and frequency-cap violation rate

### 26.4 AI and automation

- Suggestion acceptance and edit rate
- Grounded-answer rate
- Agent task-success rate
- Incorrect autonomous-action rate
- Human escalation precision
- Workflow failure and replay rate
- Time saved per user
- AI cost per successful business outcome

### 26.5 Data and platform quality

- Duplicate rate
- Required-field completeness
- Stale-data rate
- Integration freshness and reconciliation error
- Search index freshness
- Availability, latency, and error SLO attainment
- Security incident and access-policy violation rate

---

## 27. Delivery roadmap

The complete scope is a multi-release platform program, not a single launch.

### Phase 0: Foundations and research, 4-6 weeks

- Confirm target industries, deployment model, residency, entitlements, and commercial constraints.
- Inventory existing CRM capabilities that can be retained.
- Define canonical entities, event model, permissions, audit, consent, and integration framework.
- Establish design system, responsive shell, SLOs, security baseline, and product analytics.
- Run customer workflow research and migration-data profiling.

**Exit:** Approved architecture, prioritized MVP, data contract, threat model, and measurable baselines.

### Phase 1: CRM system of record, 10-14 weeks

- Leads, contacts, accounts, opportunities, pipelines, tasks, notes, files, views, and search
- Capture APIs, imports, deduplication, routing, lifecycle, and SLA
- Teams, roles, hierarchy, territories, ownership, and handover
- Basic dashboards and mobile-responsive web
- Audit, SSO baseline, exports, and administration

**Exit:** A sales team can run lead-to-close without spreadsheets for core workflow.

### Phase 2: Communications and marketing, 10-14 weeks

- Unified inbox and email integration
- SMS and WhatsApp provider framework
- Templates, consent, suppression, campaigns, audiences, and journeys
- Calendar sync and meeting workflows
- Attribution and campaign-to-pipeline reporting

**Exit:** A team can capture, nurture, reply, and measure across approved channels.

### Phase 3: Workflow, analytics, and mobile field operations, 12-16 weeks

- Visual workflow engine, testing, replay, budgets, and observability
- Report builder, certified metrics, dashboards, prompt-to-dashboard draft
- iOS/Android or approved cross-platform mobile app
- Routes, visits, location policy, geofence suggestions, and offline work
- Core connector marketplace and public APIs

**Exit:** RevOps can configure common processes without code and field teams can operate mobile-first.

### Phase 4: Conversation intelligence and governed AI, 12-16 weeks

- Calling integration, recording, transcription, summaries, extraction, scorecards, and coaching
- Knowledge base, semantic search, general AI assistant, and natural-language analytics
- Agent runtime, evaluation harness, evidence, approvals, budgets, and kill switches
- Enrichment, nurture, monitoring, coaching, and audit agents

**Exit:** AI outputs are production-useful, measured, permission-safe, and evidence-backed.

### Phase 5: Agentic execution, Voice AI, and MCP, 14-20 weeks

- Qualification and deal-advancement agents
- Voice-agent builder, multilingual operation, campaigns, live actions, and human transfer
- MCP server and approved read/write tools
- Context graph, advanced identity resolution, account health, and expansion signals
- Industry solution packs and enterprise-scale hardening

**Exit:** Approved agents can safely execute bounded revenue workflows across CRM and connected systems.

---

## 28. Testing and release gates

Every module must include:

- unit tests for rules, transformations, permissions, and calculations;
- integration tests for persistence, queues, providers, retries, and idempotency;
- API contract tests for public and internal contracts;
- end-to-end tests for critical journeys and role boundaries;
- accessibility tests for all primary workflows;
- responsive tests at phone, tablet, laptop, and desktop sizes;
- load and soak tests for ingestion, search, dashboards, workflows, campaigns, and calls;
- tenant-isolation and field-security tests;
- migration rehearsal and reconciliation tests;
- disaster-recovery and backup-restore exercises;
- AI evaluation, prompt-injection, unauthorized-tool, data-leakage, and unsafe-action tests;
- provider outage, timeout, duplicate webhook, and partial-failure tests.

Release cannot proceed when:

- a mandatory journey fails;
- tenant or field isolation is not proven;
- a migration cannot reconcile;
- a workflow or external action is not idempotent where retries are possible;
- AI fails the approved safety or groundedness threshold;
- monitoring, rollback, or kill-switch controls are absent;
- unresolved critical or high security findings remain outside an approved exception.

---

## 29. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Attempting every feature at once | Long delay and weak core CRM | Phase by complete user journey and enforce exit criteria |
| AI acts on incomplete context | Incorrect communication or data | Evidence, confidence, approval tiers, retrieval controls, and reversible actions |
| Customization creates unmaintainable tenants | Slow releases and broken reports | Metadata platform, versioning, validation, limits, and no tenant-specific code forks |
| Omnichannel compliance failure | Legal, trust, and deliverability damage | Central consent, suppression, template, quiet-hour, and audit enforcement |
| Voice AI damages customer experience | Brand and regulatory risk | Simulation, canary, scorecards, escalation, monitoring, and emergency stop |
| Permissions differ across CRM, analytics, and AI | Data leakage | One authorization service enforced before retrieval and action |
| Integration failures silently lose data | Lead and activity loss | Durable ingestion, quarantine, dead-letter queues, replay, and reconciliation |
| Natural-language metrics disagree with dashboards | Loss of trust | Governed semantic metrics, definition display, and reconcilable query layer |
| Field tracking invades employee privacy | Adoption and legal risk | Notice, consent, business hours, precision limits, retention, and policy controls |
| Migration corrupts historical context | Operational disruption | Rehearsals, reconciliation, deltas, cutover plan, and tested rollback |
| Provider costs become unpredictable | Margin and customer budget impact | Usage budgets, quotas, model routing, cost attribution, and alerts |

---

## 30. Open product decisions

These decisions must be made before Phase 0 exit:

1. Is this a net-new product, a target-state roadmap for Globussoft CRM, or a competitive parity specification?
2. Which industries and two end-to-end journeys define the first commercial release?
3. What are the deployment, residency, and tenant-isolation tiers?
4. Which communications and telephony providers are launch dependencies?
5. Which AI actions may run automatically, and which always require confirmation?
6. Which model providers are permitted for each data classification?
7. Is MCP read-only at launch, or are low-risk writes included?
8. Is the mobile application native, cross-platform, or a progressive web application first?
9. What employee-location policy is legally and culturally acceptable?
10. What availability, RPO, RTO, retention, and support commitments are contractual?
11. Which connectors are native at launch, and which rely on Zapier or customer APIs?
12. Which analytics metrics are certified and centrally governed?
13. What pricing dimensions apply to users, contacts, channels, AI usage, calls, storage, and integrations?
14. What implementation timeline is promised, and which conditions must customers satisfy for that promise?

---

## 31. Requirements traceability to public Superleap material

| Capability family | Evidence | PRD sections |
|---|---|---|
| Pipeline, leads, tasks, engage, dashboards, workflows, reports, integrations | [Superleap homepage](https://www.superleap.com/) | 4-14, 18 |
| Custom objects, context graph, knowledge, relationship mapping, entity resolution, intent/signals, semantic retrieval | [Superleap platform architecture](https://www.superleap.com/) | 5, 15, 23 |
| Lead capture, qualification, real-time assignment, unified activity | [Superleap product overview](https://webflow-content.superleap.com/) | 5-7 |
| WhatsApp, SMS, email automation, AI personalization, retargeting, ad sync | [Superleap product overview](https://webflow-content.superleap.com/) | 9 |
| Multichannel inbox and contextual response assistance | [Superleap product overview](https://webflow-content.superleap.com/) | 10 |
| Call recording, transcription, summaries, next steps, sentiment, sale prediction | [Superleap product overview](https://webflow-content.superleap.com/) | 11 |
| Visual workflow logic and AI workflow creation | [Superleap product overview](https://webflow-content.superleap.com/) | 12 |
| Roles, territories, visual team hierarchy, permissions, views, handovers | [Superleap product overview](https://webflow-content.superleap.com/) | 13 |
| Real-time reports and prompt-generated dashboards | [Superleap product overview](https://webflow-content.superleap.com/) | 14 |
| Mobile territory, routes, GPS, geofences, leads, calls, and tasks | [Superleap product overview](https://webflow-content.superleap.com/) | 17 |
| Enrich, Nurture, Qualify, Advance, Monitor, Coach, Audit agents | [SuperAgents](https://www.superleap.com/superagents) | 15 |
| Voice agents, bulk calling, custom API triggers, transfer, multilingual use, live actions, provider choice, interruption handling | [Voice AI agents](https://www.superleap.com/voice-ai-agents) | 11.3-11.4 |
| CRM access in Claude, ChatGPT, Gemini, and compatible AI clients | [Superleap MCP](https://www.superleap.com/mcp) | 14.4, 16 |
| Zoom, Slack, Gmail, Zapier and integration categories | [Superleap integrations](https://www.superleap.com/integrations) | 18 |
| Implementation, migration, configuration, training, agent rollout, hypercare | [Superleap Deploy](https://www.superleap.com/deploy) | 21 |
| ISO 27001, HIPAA-supporting design, infrastructure controls, backups, DR, TLS | [Superleap security and compliance](https://www.superleap.com/security-and-compliance) | 20 |
| Education, healthcare, BFSI, real estate, automotive, manufacturing, marketplace use cases | [Superleap homepage](https://www.superleap.com/), [Voice AI agents](https://www.superleap.com/voice-ai-agents) | 19 |

### Research limitations

- The authenticated Superleap application, commercial packaging, customer-specific configurations, internal APIs, and private documentation were not accessed.
- Public pages describe capability outcomes more often than exact field behavior. Detailed acceptance behavior in this PRD is therefore marked as required interpretation by section.
- Public claims can change. Revalidate this appendix before treating parity as a contractual commitment.

---

## 32. Definition of done for the full program

The target is complete when:

1. All in-scope requirements have an owner, release, design, implementation, and automated acceptance evidence.
2. The six critical journeys pass under representative enterprise load and role configurations.
3. Core numbers reconcile across records, dashboards, natural-language analytics, exports, and APIs.
4. Every workflow, integration, campaign, and agent is observable and recoverable.
5. AI and MCP enforce the same tenant, row, field, knowledge, and action permissions as the CRM UI.
6. External actions are consent-aware, policy-checked, idempotent, and auditable.
7. Mobile workflows are usable under real field-network conditions.
8. Migration rehearsals reconcile and the production rollback plan is tested.
9. Security, accessibility, performance, resilience, and AI evaluation gates pass.
10. Adoption and business-success metrics are instrumented before rollout, not added afterward.

