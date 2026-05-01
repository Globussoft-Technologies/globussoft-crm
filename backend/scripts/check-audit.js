#!/usr/bin/env node
// CI-4 in TODOS.md — wraps `npm audit --json` and exits non-zero if any
// advisory above the configured threshold is NOT on the allowlist.
//
// Why a wrapper instead of `npm audit --audit-level=critical`?
// In the npm version this project uses, `npm audit` returns 0 even when
// it reports vulns at or above --audit-level. This script implements
// the gate logic explicitly + supports a documented allowlist of
// known-accepted advisories so existing long-standing issues don't
// block every PR until a proper remediation lands.
//
// Allowlist lives at backend/.audit-allowlist.json. Each entry must
// have a GHSA id + a short reason + a date when it was added. NEVER
// add a new entry without a clear remediation plan or sunset date.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const FAIL_LEVELS = process.env.AUDIT_FAIL_LEVELS
  ? process.env.AUDIT_FAIL_LEVELS.split(',').map((s) => s.trim().toLowerCase())
  : ['high', 'critical'];

const ALLOWLIST_PATH = path.join(__dirname, '..', '.audit-allowlist.json');

function loadAllowlist() {
  if (!fs.existsSync(ALLOWLIST_PATH)) return { ghsas: new Set(), pkgs: new Set() };
  try {
    const raw = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
    const advisories = Array.isArray(raw.advisories) ? raw.advisories : [];
    return {
      ghsas: new Set(advisories.map((a) => a.ghsa).filter(Boolean)),
      // Package names are matched ONLY when the audit entry is a
      // transitive root that doesn't expose a GHSA directly. The
      // package-level allowlist exists because npm audit reports
      // transitive vulns as "via: [parentPackage]" without surfacing
      // the underlying GHSA at the parent level — see imap → utf7 →
      // semver. Allowlisting `imap` + `utf7` is equivalent to
      // accepting the GHSA on `semver` since the only path is via
      // imap's dep chain.
      pkgs: new Set(advisories.map((a) => a.package).filter(Boolean)),
    };
  } catch (e) {
    console.error('[audit] failed to read allowlist:', e.message);
    process.exit(2);
  }
}

function runAudit() {
  // execFileSync without shell:true doesn't pick up `npm` from PATH on
  // Windows (npm is `npm.cmd`). Use shell:true so the system shell
  // resolves the executable consistently across platforms.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const out = execFileSync(npmCmd, ['audit', '--omit=dev', '--json'], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
    return JSON.parse(out);
  } catch (e) {
    // npm audit may exit non-zero but still emit valid JSON; parse stdout.
    if (e.stdout) {
      try {
        return JSON.parse(e.stdout);
      } catch (_) {
        /* fall through */
      }
    }
    console.error('[audit] npm audit failed:', e.message);
    process.exit(2);
  }
}

function main() {
  const allowlist = loadAllowlist();
  const audit = runAudit();
  const advisories = audit.vulnerabilities || {};

  const gating = []; // [{ name, severity, ghsa, viaList }]
  const allowed = []; // already-known, allowlisted

  for (const [name, info] of Object.entries(advisories)) {
    const severity = (info.severity || '').toLowerCase();
    if (!FAIL_LEVELS.includes(severity)) continue;

    // `via` is an array of either advisory objects (string ids → GHSA)
    // or transitive package names. Pull every GHSA we can see.
    const viaList = Array.isArray(info.via) ? info.via : [];
    const ghsaIds = viaList
      .filter((v) => v && typeof v === 'object' && v.url && v.url.includes('GHSA-'))
      .map((v) => v.url.split('/').pop()); // GHSA-xxxx-xxxx-xxxx

    // Two allowlist paths:
    //   1. The entry's GHSA(s) are all allowlisted, OR
    //   2. No GHSA on this entry (transitive) AND the package name is
    //      allowlisted (the underlying GHSA is on a downstream package
    //      which IS allowlisted by GHSA — we accept the parent by name)
    const allowedByGhsa = ghsaIds.length > 0 && ghsaIds.every((g) => allowlist.ghsas.has(g));
    const allowedByPackage = ghsaIds.length === 0 && allowlist.pkgs.has(name);
    const isAllowed = allowedByGhsa || allowedByPackage;

    if (isAllowed) {
      allowed.push({ name, severity, ghsaIds, allowedByPackage });
    } else {
      gating.push({ name, severity, ghsaIds, viaList });
    }
  }

  console.log('=== npm audit gate ===');
  console.log(`Fail levels: ${FAIL_LEVELS.join(', ')}`);
  console.log(`Allowlist size: ${allowlist.ghsas.size} GHSA(s) + ${allowlist.pkgs.size} package name(s)`);
  console.log(`Allowed (already known): ${allowed.length}`);
  console.log(`Gating (NEW or unallowlisted): ${gating.length}`);

  if (allowed.length) {
    console.log('\n--- allowlisted ---');
    for (const a of allowed) {
      console.log(`  ${a.severity.toUpperCase().padEnd(8)} ${a.name}  [${a.ghsaIds.join(', ')}]`);
    }
  }

  if (gating.length) {
    console.log('\n--- gating ---');
    for (const g of gating) {
      console.log(`  ${g.severity.toUpperCase().padEnd(8)} ${g.name}  GHSA=${g.ghsaIds.join(', ') || '(transitive — check via)'}`);
    }
    console.log('\nFAIL: new high/critical vulnerabilities detected.');
    console.log('To allowlist after manual review, add to backend/.audit-allowlist.json with a reason + date.');
    console.log('To remediate, run `npm audit fix` or upgrade the offending package.');
    process.exit(1);
  }

  console.log('\nOK: no gating advisories.');
  process.exit(0);
}

main();
