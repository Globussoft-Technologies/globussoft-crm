/**
 * Database schema (Drizzle / Postgres). Multi-tenant by design: every row that
 * belongs to a customer carries `tenantId`. Enforce isolation with row-level
 * security in production (policy: tenant_id = current_setting('app.tenant')).
 *
 * The usage_events table is the billing + analytics backbone — one row per
 * model call, recording raw cost and the marked-up billed amount.
 */
import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Default sector pack this tenant operates in. */
  defaultSector: text('default_sector').notNull().default('report-writing'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Per-tenant provider keys for BYOK. Pooled platform keys live in env, not here.
 * `encryptedKey` must be encrypted at rest (KMS/Vault) — never store plaintext.
 */
export const providerKeys = pgTable('provider_keys', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  provider: text('provider').notNull(),
  encryptedKey: text('encrypted_key').notNull(),
  baseUrl: text('base_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Tenant-level agent customizations. The base roster comes from sector packs;
 * rows here override prompt/tier/tools/enabled for a given (sector, agent).
 * This is the data behind the "agent management" UI.
 */
export const agentOverrides = pgTable('agent_overrides', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  sectorKey: text('sector_key').notNull(),
  agentKey: text('agent_key').notNull(),
  systemPrompt: text('system_prompt'),
  tier: text('tier'),
  tools: jsonb('tools').$type<string[]>(),
  enabled: integer('enabled').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable('runs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').references(() => tenants.id),
  sectorKey: text('sector_key').notNull(),
  goal: text('goal').notNull(),
  status: text('status').notNull().default('queued'),
  result: text('result'),
  billedUsdTotal: doublePrecision('billed_usd_total').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

/** The append-only event log — the source of the live trace and analytics. */
export const runEvents = pgTable('run_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  type: text('type').notNull(),
  agentKey: text('agent_key').notNull(),
  parentAgentKey: text('parent_agent_key'),
  data: jsonb('data').$type<Record<string, unknown>>().notNull(),
});

/** One row per model call. Drives cost dashboards and tenant invoices. */
export const usageEvents = pgTable('usage_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  tenantId: text('tenant_id').references(() => tenants.id),
  agentKey: text('agent_key').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: doublePrecision('cost_usd').notNull(),
  billedUsd: doublePrecision('billed_usd').notNull(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
});
