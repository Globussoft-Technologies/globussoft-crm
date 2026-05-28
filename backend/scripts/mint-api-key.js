#!/usr/bin/env node
/**
 * Mint an external-partner API key for a specific tenant.
 *
 * Usage:
 *   node backend/scripts/mint-api-key.js --tenant=<slug> --name="<label>" [--user=<email>]
 *
 * Example:
 *   node backend/scripts/mint-api-key.js --tenant=enhanced-wellness --name="Acme Connector"
 *
 * The raw glbs_... secret is printed ONCE on stdout. Hand it to the consumer
 * (the "other API") to put in their env as X-API-Key. We don't store it
 * anywhere else — losing it means revoking and minting a fresh one.
 *
 * The key is scoped to the named tenant. Every request authenticated with
 * this key is automatically filtered to tenantId = <that tenant's id>.
 */
const crypto = require("crypto");
const prisma = require("../lib/prisma");

function parseArgs(argv) {
  const out = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.tenant || !args.name) {
    console.error("Usage: node backend/scripts/mint-api-key.js --tenant=<slug> --name=\"<label>\" [--user=<email>]");
    process.exit(1);
  }

  const tenant = await prisma.tenant.findUnique({ where: { slug: args.tenant } });
  if (!tenant) {
    console.error(`Tenant with slug "${args.tenant}" not found.`);
    process.exit(2);
  }

  const userWhere = args.user
    ? { email: args.user, tenantId: tenant.id }
    : { tenantId: tenant.id, role: "ADMIN" };
  const user = await prisma.user.findFirst({ where: userWhere });
  if (!user) {
    console.error(
      args.user
        ? `User ${args.user} not found in tenant ${args.tenant}.`
        : `No ADMIN user found in tenant ${args.tenant}. Pass --user=<email> explicitly.`,
    );
    process.exit(3);
  }

  const rawKey = `glbs_${crypto.randomBytes(24).toString("hex")}`;
  const created = await prisma.apiKey.create({
    data: { name: args.name, keySecret: rawKey, userId: user.id, tenantId: tenant.id },
  });

  console.log("");
  console.log("API key minted. Save this secret — it will NOT be shown again:");
  console.log("");
  console.log(`  Tenant : ${tenant.name} (slug=${tenant.slug}, id=${tenant.id})`);
  console.log(`  Owner  : ${user.email}`);
  console.log(`  Label  : ${created.name}`);
  console.log(`  Key ID : ${created.id}`);
  console.log(`  Secret : ${rawKey}`);
  console.log("");
  console.log("Consumer usage: send header  X-API-Key: <secret>  to /api/v1/external/*");
  console.log("Revoke with:    DELETE FROM ApiKey WHERE id = " + created.id + ";");
}

main()
  .catch((e) => { console.error(e); process.exit(99); })
  .finally(() => prisma.$disconnect());
