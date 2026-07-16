#!/usr/bin/env node
/**
 * backfill-audit-chain — one-shot operator script that fills `prevHash`
 * and `hash` on every audit row whose chain was never written. The HTTP
 * equivalent (`POST /api/audit/backfill`) is the per-tenant version
 * driven from the AuditLog UI; this script is the cross-tenant version
 * for SOC 2 / DPDP forensics + post-release rollouts where the operator
 * doesn't want to log in as every tenant's admin.
 *
 * Usage:
 *   node scripts/backfill-audit-chain.js                # all tenants
 *   node scripts/backfill-audit-chain.js --tenant 2     # single tenant
 *   node scripts/backfill-audit-chain.js --tenant all   # explicit all
 *   node scripts/backfill-audit-chain.js --dry-run      # walk + count, no writes
 *   node scripts/backfill-audit-chain.js --json         # machine-readable
 *
 * Exit codes:
 *   0 — every walked tenant backfilled clean (or already clean)
 *   1 — at least one tenant aborted with a hash-conflict (suspected tampering)
 *   2 — unexpected error (DB unreachable, schema mismatch, etc.)
 *
 * The walker shares its canonical-serialization + computeHash with the
 * /verify endpoint and verify-audit-chain CLI — see backend/lib/audit.js
 * for the contract. Re-running this script is a no-op: rows that already
 * have a valid hash are validated and left alone.
 */

const prisma = require('../lib/prisma');
const { backfillTenantChain } = require('../lib/audit');
const { computeHash, genesisFor } = require('../lib/audit');

function parseArgs(argv) {
  const args = { tenant: null, dryRun: false, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tenant') {
      const v = argv[++i];
      if (v === 'all' || v === '*') {
        args.tenant = null;
      } else {
        args.tenant = Number(v);
      }
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`backfill-audit-chain — #558 one-shot chain backfill

Usage:
  node scripts/backfill-audit-chain.js [--tenant <id|all>] [--dry-run] [--json]

Options:
  --tenant <id>   Backfill only the given tenantId (default: every tenant)
  --tenant all    Explicit "all tenants" — equivalent to omitting --tenant
  --dry-run       Walk every row and count unchained rows without writing
  --json          Emit machine-readable JSON (one object) instead of text
  -h, --help      Show this message

Exit codes:
  0 — every walked tenant backfilled clean (or already clean)
  1 — at least one tenant aborted with a hash conflict (suspected tampering)
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

// Dry-run walker — mirrors backfillTenantChain but writes nothing.
// Returns { walked, wouldUpdate, alreadyChained, head, conflictRowId? }.
async function dryRunTenant(tenantId) {
  const rows = await prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true, action: true, entity: true, entityId: true, userId: true,
      details: true, createdAt: true, prevHash: true, hash: true,
    },
  });

  let walked = 0;
  let wouldUpdate = 0;
  let alreadyChained = 0;
  let lastHash = null;

  for (const row of rows) {
    walked += 1;
    const expectedPrev = lastHash == null ? genesisFor(tenantId) : lastHash;
    const recomputed = computeHash(expectedPrev, {
      tenantId,
      entity: row.entity, action: row.action,
      entityId: row.entityId, userId: row.userId,
      details: row.details, createdAt: row.createdAt.toISOString(),
    });
    if (row.hash != null) {
      if (row.prevHash !== expectedPrev || row.hash !== recomputed) {
        return { walked, wouldUpdate, alreadyChained, head: lastHash, conflictRowId: row.id };
      }
      alreadyChained += 1;
      lastHash = row.hash;
    } else {
      wouldUpdate += 1;
      lastHash = recomputed;
    }
  }

  return { walked, wouldUpdate, alreadyChained, head: lastHash };
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
    console.error(`[backfill-audit-chain] Failed to list tenants: ${err.message}`);
    return 2;
  }

  const results = [];
  let anyConflict = false;

  for (const { tenantId } of tenants) {
    try {
      if (args.dryRun) {
        const r = await dryRunTenant(tenantId);
        if (r.conflictRowId != null) anyConflict = true;
        results.push({ tenantId, ...r, dryRun: true });
      } else {
        const r = await backfillTenantChain(tenantId);
        results.push({ tenantId, ...r });
      }
    } catch (err) {
      if (err && err.conflictRowId != null) {
        anyConflict = true;
        results.push({
          tenantId,
          conflictRowId: err.conflictRowId,
          conflictReason: err.message,
          error: 'hash-conflict',
        });
      } else {
        results.push({ tenantId, error: err.message || String(err) });
        anyConflict = true;
      }
    }
  }

  const runAt = new Date().toISOString();

  if (args.json) {
    console.log(JSON.stringify({ runAt, dryRun: args.dryRun, tenants: results, anyConflict }, null, 2));
  } else {
    console.log(`backfill-audit-chain — ${runAt}${args.dryRun ? ' (dry-run)' : ''}`);
    console.log(`Tenants walked: ${results.length}`);
    for (const r of results) {
      if (r.error === 'hash-conflict') {
        console.log(`  CONFLICT tenant ${r.tenantId} — aborted at row #${r.conflictRowId}: ${r.conflictReason}`);
      } else if (r.error) {
        console.log(`  ERROR tenant ${r.tenantId} — ${r.error}`);
      } else if (args.dryRun) {
        console.log(`  DRY tenant ${r.tenantId} — walked=${r.walked}, would-update=${r.wouldUpdate}, already-chained=${r.alreadyChained}`);
      } else {
        console.log(`  OK tenant ${r.tenantId} — walked=${r.walkedRows}, updated=${r.updatedRows}, already-chained=${r.skippedRows}`);
      }
    }
  }

  return anyConflict ? 1 : 0;
}

if (require.main && require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`[backfill-audit-chain] Unexpected error: ${err.stack || err.message}`);
      process.exit(2);
    });
}

module.exports = { dryRunTenant, listTenants };
