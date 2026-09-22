#!/usr/bin/env node
/**
 * Recover an audit row changed by the 2026 S3 -> OCI bulk URL migration.
 *
 * Dry-run is the default. --apply updates `details` only after proving that
 * reversing the URL substitution recreates the row's existing stored hash.
 * It never changes `hash` or `prevHash` and therefore cannot bless arbitrary
 * tampering as valid.
 *
 * Usage:
 *   node scripts/repair-audit-storage-url.js --tenant 73 --row 679826
 *   node scripts/repair-audit-storage-url.js --tenant 73 --row 679826 --apply
 */

require('dotenv').config();

const prisma = require('../lib/prisma');
const { assessStorageUrlRepair } = require('../lib/auditStorageUrlRepair');

const OLD_BASE = 'https://globuscrm-live-bucket.s3.ap-south-1.amazonaws.com';
const NEW_BASE = 'https://objectstorage.ap-mumbai-1.oraclecloud.com/n/ax080cwfvymc/b/globuscrm-live-media/o';

function parseArgs(argv) {
  const args = { tenantId: null, rowId: null, apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--tenant') args.tenantId = Number(argv[++i]);
    else if (argv[i] === '--row') args.rowId = Number(argv[++i]);
    else if (argv[i] === '--apply') args.apply = true;
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/repair-audit-storage-url.js --tenant <id> --row <id> [--apply]

Without --apply, the command only verifies whether the historical content can
be recovered. With --apply, it changes details only; hash and prevHash remain
untouched. Run the normal audit-chain backfill afterward.`);
}

async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!Number.isInteger(args.tenantId) || args.tenantId <= 0 ||
      !Number.isInteger(args.rowId) || args.rowId <= 0) {
    throw new Error('--tenant and --row must be positive integer IDs');
  }

  const row = await prisma.auditLog.findFirst({
    where: { id: args.rowId, tenantId: args.tenantId },
    select: {
      id: true,
      tenantId: true,
      entity: true,
      action: true,
      entityId: true,
      userId: true,
      details: true,
      createdAt: true,
      prevHash: true,
      hash: true,
    },
  });
  if (!row) throw new Error('No audit row matched both IDs');

  const assessment = assessStorageUrlRepair(row, {
    oldBase: OLD_BASE,
    newBase: NEW_BASE,
  });

  if (assessment.status === 'already-valid') {
    console.log(`Audit row #${row.id} is already valid; no repair needed.`);
    return 0;
  }
  if (assessment.status !== 'repairable') {
    throw new Error(
      `Audit row #${row.id} is not safely recoverable by the known S3/OCI rewrite (${assessment.status}); no write performed.`,
    );
  }
  if (!args.apply) {
    console.log(
      `DRY RUN: audit row #${row.id} is safely repairable. ` +
      'The reconstructed S3-era details exactly match its stored hash. Re-run with --apply.',
    );
    return 0;
  }

  // Compare-and-swap protects against a concurrent/manual edit between the
  // read and update. A count other than one is a hard failure.
  const result = await prisma.auditLog.updateMany({
    where: {
      id: row.id,
      tenantId: row.tenantId,
      hash: assessment.storedHash,
      details: assessment.currentDetails,
    },
    data: { details: assessment.restoredDetails },
  });
  if (result.count !== 1) {
    throw new Error(`Compare-and-swap updated ${result.count} rows; expected exactly 1`);
  }

  console.log(
    `Repaired audit row #${row.id}. hash and prevHash were not changed. ` +
    'Run the normal audit-chain repair/backfill now.',
  );
  return 0;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[repair-audit-storage-url] ${error.message}`);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { main, parseArgs };
