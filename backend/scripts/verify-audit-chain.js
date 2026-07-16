#!/usr/bin/env node
/**
 * verify-audit-chain — stand-alone CLI for the #558 hash-chain
 * tamper-evidence trail.
 *
 * Why this exists (separately from GET /api/audit/verify):
 *   The HTTP endpoint walks ONE tenant's chain (the requesting admin's).
 *   For a SOC 2 / DPDP forensic review, the auditor wants to verify every
 *   tenant on the box without holding an admin token for each tenant. This
 *   CLI runs directly against the Prisma client, walks every tenant's
 *   chain, and exits non-zero if any chain is broken — suitable for cron-
 *   wiring or invocation from an incident-response runbook.
 *
 * Usage:
 *   node scripts/verify-audit-chain.js                    # all tenants
 *   node scripts/verify-audit-chain.js --tenant 1         # single tenant
 *   node scripts/verify-audit-chain.js --tenant all       # explicit all (e2e sugar)
 *   node scripts/verify-audit-chain.js --json             # machine-readable
 *   node scripts/verify-audit-chain.js --quiet            # only print broken
 *
 * Exit codes:
 *   0 — every walked chain verified clean
 *   1 — at least one chain is broken (brokenAt populated)
 *   2 — unexpected error (DB unreachable, schema mismatch, etc.)
 *
 * The walker mirrors GET /api/audit/verify + cron/auditIntegrityEngine
 * exactly — strict semantics (#558 Option A): a null hash on ANY row is
 * a chain break, NOT a silently-skipped legacy row. Run the backfill
 * (scripts/backfill-audit-chain.js or POST /api/audit/backfill) first.
 * computeHash + canonicalize come from backend/lib/audit.js so a future
 * change to the chain formula updates the CLI automatically.
 */

const prisma = require('../lib/prisma');
const { computeHash, genesisFor } = require('../lib/audit');

function parseArgs(argv) {
  const args = { tenant: null, json: false, quiet: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') {
      const v = argv[++i];
      // `--tenant all` is a no-op sugar for "walk every tenant" — matches
      // the e2e acceptance criterion wording. A real numeric id wins.
      if (v === 'all' || v === '*') {
        args.tenant = null;
      } else {
        args.tenant = Number(v);
      }
    } else if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`verify-audit-chain — #558 audit-log integrity verifier

Usage:
  node scripts/verify-audit-chain.js [--tenant <id|all>] [--json] [--quiet]

Options:
  --tenant <id>   Verify only the given tenantId (default: all tenants)
  --tenant all    Explicit "all tenants" — equivalent to omitting --tenant
  --json          Emit machine-readable JSON (one object) instead of text
  --quiet         Suppress per-tenant lines for clean chains (text mode)
  -h, --help      Show this message

Exit codes:
  0 — every walked chain verified clean
  1 — at least one chain is broken
  2 — unexpected error`);
}

async function listTenants(only) {
  if (only != null) return [{ tenantId: only }];
  return prisma.auditLog.findMany({
    distinct: ['tenantId'],
    select: { tenantId: true },
    orderBy: { tenantId: 'asc' },
  });
}

async function walkTenant(tenantId) {
  const rows = await prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      action: true,
      entity: true,
      entityId: true,
      userId: true,
      details: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    },
  });

  let chainLength = 0;
  let brokenAt = null;
  let brokenReason = null;
  let lastHash = null;

  for (const row of rows) {
    chainLength += 1;
    if (row.hash == null) {
      brokenAt = row.id;
      brokenReason = 'null hash — row was never chained (run backfill)';
      break;
    }

    const expectedPrev = lastHash == null ? genesisFor(tenantId) : lastHash;
    if (row.prevHash !== expectedPrev) {
      brokenAt = row.id;
      brokenReason = 'prevHash mismatch';
      break;
    }

    const recomputed = computeHash(row.prevHash, {
      tenantId,
      entity: row.entity,
      action: row.action,
      entityId: row.entityId,
      userId: row.userId,
      details: row.details,
      createdAt: row.createdAt.toISOString(),
    });

    if (recomputed !== row.hash) {
      brokenAt = row.id;
      brokenReason = 'hash mismatch (row content tampered)';
      break;
    }

    lastHash = row.hash;
  }

  return {
    tenantId,
    chainLength,
    totalRows: rows.length,
    brokenAt,
    brokenReason,
    integrityVerified: brokenAt === null,
    head: lastHash,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return 0;
  }

  let tenants;
  try {
    tenants = await listTenants(args.tenant);
  } catch (err) {
    console.error(`[verify-audit-chain] Failed to list tenants: ${err.message}`);
    return 2;
  }

  const results = [];
  for (const { tenantId } of tenants) {
    try {
      const r = await walkTenant(tenantId);
      results.push(r);
    } catch (err) {
      console.error(`[verify-audit-chain] Tenant ${tenantId} walk failed: ${err.message}`);
      results.push({
        tenantId,
        chainLength: 0,
        totalRows: 0,
        brokenAt: null,
        brokenReason: `walk error: ${err.message}`,
        integrityVerified: false,
        head: null,
        error: true,
      });
    }
  }

  const anyBroken = results.some((r) => !r.integrityVerified);
  const verifiedAt = new Date().toISOString();

  if (args.json) {
    console.log(JSON.stringify({
      verifiedAt,
      tenants: results,
      anyBroken,
      tenantsWalked: results.length,
    }, null, 2));
  } else {
    console.log(`verify-audit-chain — ${verifiedAt}`);
    console.log(`Tenants walked: ${results.length}`);
    for (const r of results) {
      if (r.integrityVerified) {
        if (!args.quiet) {
          console.log(`  OK tenant ${r.tenantId} — ${r.chainLength} rows verified clean`);
        }
      } else {
        const reason = r.brokenReason || 'unknown';
        const at = r.brokenAt != null ? `row #${r.brokenAt}` : 'walk-error';
        console.log(`  FAIL tenant ${r.tenantId} — BROKEN at ${at} (${reason}), chainLength=${r.chainLength}/${r.totalRows}`);
      }
    }
    if (anyBroken) {
      console.log('');
      console.log('AUDIT INTEGRITY FAILURE — escalate per incident-response runbook.');
    } else {
      console.log('');
      console.log('All chains verified.');
    }
  }

  return anyBroken ? 1 : 0;
}

if (require.main && require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[verify-audit-chain] Unexpected error: ${err.stack || err.message}`);
      process.exit(2);
    });
}

module.exports = { walkTenant, listTenants };
