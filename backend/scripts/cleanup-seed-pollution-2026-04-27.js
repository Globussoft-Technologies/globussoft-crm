// One-shot cleanup of seed/e2e pollution surfacing in the wellness tenant
// (#330, #328, #327, #322, #319, #318, #311, #310, #306, #320, #321).
//
// Each section is wrapped in try/catch so a single failure doesn't bail the
// rest of the pass. Default mode is dry-run; pass --commit to actually mutate.
// Modeled on backend/scripts/cleanup-p3-data-quality.js (same header/record/
// summary scaffolding) and backend/scripts/merge-duplicate-patients.js (same
// "patient is hard-delete-only, gated on clinical refs" pattern).
//
// SQL-LIKE wildcard footgun avoided everywhere: where a filter contains "_"
// or "%" as a literal, we fetch a permissive superset and JS-filter rather
// than rely on Prisma `contains:` (which lowers to SQL LIKE and matches the
// wildcard). See cleanup-p3-data-quality.js #267 for the lesson.
//
// Issues addressed (all tenantId=2 = Enhanced Wellness):
//   #330 [P2]  Tenant 2 base currency was USD/$ -> set to INR / IN / en-IN
//   #328 [P2]  KB has 9 published "Test Article 001 1777..." rows -> hard delete
//   #327 [P2]  Notifications dropdown has "Targeted / just user 8", "Test ..."
//              -> hard delete (Notification has no deletedAt)
//   #322 [P2]  Estimates with contact.name containing alert(/XSS/Year99
//              -> soft delete (Estimate has deletedAt)
//   #319 [P2]  AgentRecommendation rows "Lifecycle 087802..." -> hard delete
//              (no deletedAt)
//   #318 [P2]  Patient rows "Phone Validation Test%" / "Validation Test%"
//              -> hard delete IF zero clinical refs (visits, Rx, consents,
//              treatmentPlans, waitlists, loyaltyTransactions, referrals)
//   #311 [P3]  Contact (status=Lead) named alert(/XSS/xss-retest -> soft
//              delete via deletedAt
//   #310 [P2]  Invoice rows whose contact.name = alert(...)/Valid Name
//              -> hard delete (Invoice has no deletedAt; would cascade
//              anyway when Contact is deleted, but we don't hard-delete
//              Contacts in #311 — only soft-delete — so we delete invoices
//              explicitly here)
//   #306 [P2]  Patient name LIKE 'spam-%' or = 'Kumaraswamy' -> hard delete
//              IF zero clinical refs (same gate as #318)
//   #320 [P3]  LeadRoutingRule.name with trailing 13-digit timestamp
//              -> UPDATE name to strip the suffix (preserve rule)
//   #321 [P2]  ServiceConsumption with (qty * unitCost) > 1Cr -> NULL/0
//              the unitCost (P&L blowup; field is `qty` not `quantity`)
//
// Usage:
//   node scripts/cleanup-seed-pollution-2026-04-27.js              (dry run)
//   node scripts/cleanup-seed-pollution-2026-04-27.js --commit     (apply)

const prisma = require("../lib/prisma");

const TENANT_ID = 2; // wellness tenant
const COMMIT = process.argv.includes("--commit");
const MODE = COMMIT ? "COMMIT" : "DRY-RUN";

// ServiceConsumption blow-up threshold = INR 1 crore (10,000,000)
const COST_BLOWUP_THRESHOLD = 10_000_000;

const summary = []; // { issue, label, found, applied, errored, note }

function record(issue, label, found, applied, errored = false, note = "") {
  summary.push({ issue, label, found, applied, errored, note });
}

function header(issue, desc) {
  console.log("");
  console.log(`=== Issue #${issue}: ${desc} ===`);
}

// ─── #330: tenant 2 base currency USD -> INR ──────────────────────────────
async function fixTenantCurrency() {
  header(330, "Tenant 2 base currency USD -> INR / IN / en-IN");
  try {
    const t = await prisma.tenant.findUnique({
      where: { id: TENANT_ID },
      select: {
        id: true, name: true, defaultCurrency: true, country: true, locale: true,
      },
    });
    if (!t) {
      console.log(`Tenant id=${TENANT_ID} not found — skipping.`);
      record(330, "Tenant currency", 0, 0, false, "tenant missing");
      return;
    }
    console.log(
      `Current: id=${t.id} name="${t.name}" defaultCurrency="${t.defaultCurrency}" country="${t.country}" locale="${t.locale}"`
    );
    const needsUpdate =
      t.defaultCurrency !== "INR" || t.country !== "IN" || t.locale !== "en-IN";
    if (!needsUpdate) {
      console.log("Already INR/IN/en-IN — no change needed.");
      record(330, "Tenant currency", 0, 0, false, "already correct");
      return;
    }
    let applied = 0;
    if (COMMIT) {
      await prisma.tenant.update({
        where: { id: TENANT_ID },
        data: { defaultCurrency: "INR", country: "IN", locale: "en-IN" },
      });
      applied = 1;
      console.log("Updated tenant 2 -> INR / IN / en-IN.");
    } else {
      console.log("Would update tenant 2 -> INR / IN / en-IN.");
    }
    record(330, "Tenant currency", 1, COMMIT ? applied : 1);
  } catch (e) {
    console.error(`#330 failed:`, e.message);
    record(330, "Tenant currency", 0, 0, true, e.message);
  }
}

// ─── #328: KB "Test Article%" rows -> hard delete ─────────────────────────
async function cleanupKbArticles() {
  header(328, "Hard-delete KbArticle rows with title LIKE 'Test Article%'");
  try {
    const articles = await prisma.kbArticle.findMany({
      where: { tenantId: TENANT_ID, title: { startsWith: "Test Article" } },
      select: { id: true, title: true, slug: true, isPublished: true },
    });
    console.log(`Found ${articles.length} 'Test Article%' KbArticle rows`);
    for (const a of articles) {
      console.log(
        `  id=${a.id} title="${a.title}" slug="${a.slug}" published=${a.isPublished}`
      );
    }
    let applied = 0;
    if (COMMIT && articles.length > 0) {
      // KbArticle has no deletedAt; hard delete is the only option.
      const result = await prisma.kbArticle.deleteMany({
        where: { id: { in: articles.map((a) => a.id) } },
      });
      applied = result.count;
      console.log(`Hard-deleted ${applied} KbArticle rows.`);
    } else {
      console.log(`Would hard-delete ${articles.length} KbArticle rows.`);
    }
    record(328, "KbArticle test pollution", articles.length, COMMIT ? applied : articles.length);
  } catch (e) {
    console.error(`#328 failed:`, e.message);
    record(328, "KbArticle test pollution", 0, 0, true, e.message);
  }
}

// ─── #327: notification test rows -> hard delete ─────────────────────────
async function cleanupTestNotifications() {
  header(327, "Hard-delete Notification rows from e2e tests");
  try {
    // Notification has no deletedAt; hard delete required.
    // Fetch superset and JS-filter to be safe with substrings.
    const all = await prisma.notification.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, title: true, message: true, createdAt: true, userId: true },
    });
    const isTestPollution = (n) => {
      const hay = `${n.title || ""} ${n.message || ""}`;
      // Patterns from #327: "Targeted / just user 8", "Test ...", anything
      // mentioning "just user N"
      return (
        /just user \d+/i.test(hay) ||
        /^Targeted \//i.test(n.title || "") ||
        /^Test\b/i.test(n.title || "") ||
        /^Test\b/i.test(n.message || "")
      );
    };
    const offenders = all.filter(isTestPollution);
    console.log(
      `Scanned ${all.length} tenant-${TENANT_ID} notifications; ${offenders.length} match test pattern`
    );
    for (const n of offenders) {
      console.log(`  id=${n.id} userId=${n.userId} title="${n.title}" message="${n.message}"`);
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.notification.deleteMany({
        where: { id: { in: offenders.map((n) => n.id) } },
      });
      applied = result.count;
      console.log(`Hard-deleted ${applied} Notification rows.`);
    } else {
      console.log(`Would hard-delete ${offenders.length} Notification rows.`);
    }
    record(327, "Notifications test pollution", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#327 failed:`, e.message);
    record(327, "Notifications test pollution", 0, 0, true, e.message);
  }
}

// ─── #322: XSS/Year99 estimates -> soft delete ────────────────────────────
async function cleanupXssEstimates() {
  header(322, "Soft-delete Estimate rows with XSS/alert/Year99 pollution");
  try {
    // Estimate.contact is the relation, contact.name is on Contact. We need
    // to look at both Estimate.title (for "Year99") and the joined contact
    // name (for "alert(" / "XSS"). Fetch a permissive superset and JS-filter.
    const estimates = await prisma.estimate.findMany({
      where: { tenantId: TENANT_ID, deletedAt: null },
      select: {
        id: true, title: true, status: true, deletedAt: true,
        contact: { select: { id: true, name: true } },
      },
    });
    const offenders = estimates.filter((e) => {
      const cname = e.contact?.name || "";
      const title = e.title || "";
      return (
        cname.includes("alert(") ||
        /XSS/i.test(cname) ||
        title.includes("Year99") ||
        /XSS/i.test(title) ||
        title.includes("alert(")
      );
    });
    console.log(
      `Scanned ${estimates.length} tenant-${TENANT_ID} live estimates; ${offenders.length} match`
    );
    for (const e of offenders) {
      console.log(
        `  id=${e.id} title="${e.title}" status="${e.status}" contact="${e.contact?.name}"`
      );
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.estimate.updateMany({
        where: { id: { in: offenders.map((e) => e.id) } },
        data: { deletedAt: new Date() },
      });
      applied = result.count;
      console.log(`Soft-deleted ${applied} Estimate rows.`);
    } else {
      console.log(`Would soft-delete ${offenders.length} Estimate rows.`);
    }
    record(322, "Estimates XSS pollution", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#322 failed:`, e.message);
    record(322, "Estimates XSS pollution", 0, 0, true, e.message);
  }
}

// ─── #319: AgentRecommendation timestamp pollution -> hard delete ─────────
async function cleanupAgentRecommendations() {
  header(319, "Hard-delete AgentRecommendation rows w/ 'Lifecycle 087xxx' titles");
  try {
    // AgentRecommendation has no deletedAt -> hard delete only.
    const recs = await prisma.agentRecommendation.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, title: true, type: true, status: true },
    });
    const offenders = recs.filter((r) => {
      const t = r.title || "";
      // "Lifecycle 087802", "Lifecycle 087803", … and the broader
      // "anything ending with ' 087xxx...'" timestamp-suffix pattern
      return /^Lifecycle\s+\d/i.test(t) || /\s087\d{3,}/.test(t);
    });
    console.log(
      `Scanned ${recs.length} tenant-${TENANT_ID} recommendations; ${offenders.length} match`
    );
    for (const r of offenders) {
      console.log(`  id=${r.id} type=${r.type} status=${r.status} title="${r.title}"`);
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.agentRecommendation.deleteMany({
        where: { id: { in: offenders.map((r) => r.id) } },
      });
      applied = result.count;
      console.log(`Hard-deleted ${applied} AgentRecommendation rows.`);
    } else {
      console.log(`Would hard-delete ${offenders.length} AgentRecommendation rows.`);
    }
    record(319, "AgentRecommendation pollution", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#319 failed:`, e.message);
    record(319, "AgentRecommendation pollution", 0, 0, true, e.message);
  }
}

// ─── shared: patient clinical-ref count (mirror merge-duplicate-patients) ─
async function patientClinicalRefCount(patientId) {
  const [v, rx, cf, tp, wl, lt, rfOut, rfIn] = await Promise.all([
    prisma.visit.count({ where: { patientId } }),
    prisma.prescription.count({ where: { patientId } }),
    prisma.consentForm.count({ where: { patientId } }),
    prisma.treatmentPlan.count({ where: { patientId } }),
    prisma.waitlist.count({ where: { patientId } }),
    prisma.loyaltyTransaction.count({ where: { patientId } }),
    prisma.referral.count({ where: { referrerPatientId: patientId } }),
    prisma.referral.count({ where: { referredPatientId: patientId } }),
  ]);
  return {
    v, rx, cf, tp, wl, lt, rf: rfOut + rfIn,
    total: v + rx + cf + tp + wl + lt + rfOut + rfIn,
  };
}

// ─── shared: hard-delete patients with zero clinical refs ─────────────────
async function deleteSafePatients(issue, label, candidates) {
  // candidates: [{ id, name }]
  const safe = [];
  const unsafe = [];
  for (const p of candidates) {
    const refs = await patientClinicalRefCount(p.id);
    if (refs.total === 0) safe.push({ ...p, refs });
    else unsafe.push({ ...p, refs });
  }
  console.log(`  safe (zero clinical refs):    ${safe.length}`);
  console.log(`  unsafe (has clinical refs):   ${unsafe.length}`);
  for (const p of safe) {
    console.log(`    SAFE   id=${p.id} name="${p.name}"`);
  }
  for (const p of unsafe) {
    console.log(
      `    SKIP   id=${p.id} name="${p.name}" refs=${p.refs.total} (v=${p.refs.v} rx=${p.refs.rx} cf=${p.refs.cf} tp=${p.refs.tp} wl=${p.refs.wl} lt=${p.refs.lt} rf=${p.refs.rf})`
    );
  }
  let applied = 0;
  if (COMMIT && safe.length > 0) {
    // Patient.delete (per-row) — same approach as merge-duplicate-patients;
    // deleteMany would also work since refs=0 means no FK constraints, but
    // per-row matches the existing pattern and lets us catch one failure.
    for (const p of safe) {
      try {
        await prisma.patient.delete({ where: { id: p.id } });
        applied++;
      } catch (err) {
        console.log(`    [ERROR] id=${p.id}: ${err.message}`);
      }
    }
    console.log(`  Hard-deleted ${applied} Patient rows.`);
  } else {
    console.log(`  Would hard-delete ${safe.length} Patient rows.`);
  }
  record(issue, label, candidates.length, COMMIT ? applied : safe.length, false,
    unsafe.length > 0 ? `${unsafe.length} kept (has clinical refs)` : "");
}

// ─── #318: "Phone Validation Test"/etc patient rows ───────────────────────
async function cleanupPhoneValidationPatients() {
  header(318, "Hard-delete e2e 'Phone Validation Test%' patients (zero refs)");
  try {
    const patients = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, name: true },
    });
    const offenders = patients.filter((p) => {
      const n = (p.name || "").trim();
      return (
        /^Phone Validation Test/i.test(n) ||
        /^Validation Test/i.test(n)
      );
    });
    console.log(`Found ${offenders.length} test-name patient rows`);
    await deleteSafePatients(318, "Patient phone-validation pollution", offenders);
  } catch (e) {
    console.error(`#318 failed:`, e.message);
    record(318, "Patient phone-validation pollution", 0, 0, true, e.message);
  }
}

// ─── #311: XSS lead Contacts -> soft delete ───────────────────────────────
async function cleanupXssLeadContacts() {
  header(311, "Soft-delete Contact (status=Lead) with XSS/alert/xss-retest");
  try {
    // Contact has deletedAt -> soft delete is preferred.
    const contacts = await prisma.contact.findMany({
      where: { tenantId: TENANT_ID, deletedAt: null, status: "Lead" },
      select: { id: true, name: true, email: true, status: true },
    });
    const offenders = contacts.filter((c) => {
      const n = c.name || "";
      const e = c.email || "";
      return (
        n.includes("alert(") ||
        /XSS/i.test(n) ||
        e.includes("xss-retest") ||
        /XSS/i.test(e)
      );
    });
    console.log(
      `Scanned ${contacts.length} tenant-${TENANT_ID} live leads; ${offenders.length} match`
    );
    for (const c of offenders) {
      console.log(`  id=${c.id} name="${c.name}" email="${c.email}"`);
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.contact.updateMany({
        where: { id: { in: offenders.map((c) => c.id) } },
        data: { deletedAt: new Date() },
      });
      applied = result.count;
      console.log(`Soft-deleted ${applied} Contact (Lead) rows.`);
    } else {
      console.log(`Would soft-delete ${offenders.length} Contact (Lead) rows.`);
    }
    record(311, "Contacts XSS leads", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#311 failed:`, e.message);
    record(311, "Contacts XSS leads", 0, 0, true, e.message);
  }
}

// ─── #310: invoices against XSS/Valid Name contacts -> hard delete ────────
async function cleanupXssInvoices() {
  header(310, "Hard-delete Invoice rows w/ contact.name XSS or 'Valid Name'");
  try {
    // Invoice has no deletedAt -> hard delete (would also cascade if its
    // Contact were hard-deleted, but #311 only soft-deletes the Contact, so
    // we explicitly delete the invoice rows here).
    const invoices = await prisma.invoice.findMany({
      where: { tenantId: TENANT_ID },
      select: {
        id: true, invoiceNum: true, amount: true, status: true,
        contact: { select: { id: true, name: true } },
      },
    });
    const offenders = invoices.filter((inv) => {
      const cname = inv.contact?.name || "";
      return (
        cname.includes("alert(") ||
        /XSS/i.test(cname) ||
        cname === "Valid Name"
      );
    });
    console.log(
      `Scanned ${invoices.length} tenant-${TENANT_ID} invoices; ${offenders.length} match`
    );
    for (const inv of offenders) {
      console.log(
        `  id=${inv.id} num=${inv.invoiceNum} amount=${inv.amount} status=${inv.status} contact="${inv.contact?.name}"`
      );
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.invoice.deleteMany({
        where: { id: { in: offenders.map((i) => i.id) } },
      });
      applied = result.count;
      console.log(`Hard-deleted ${applied} Invoice rows.`);
    } else {
      console.log(`Would hard-delete ${offenders.length} Invoice rows.`);
    }
    record(310, "Invoices XSS pollution", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#310 failed:`, e.message);
    record(310, "Invoices XSS pollution", 0, 0, true, e.message);
  }
}

// ─── #306: spam-N / Kumaraswamy patient rows ──────────────────────────────
async function cleanupSpamPatients() {
  header(306, "Hard-delete 'spam-%'/'Kumaraswamy' patients (zero refs)");
  try {
    const patients = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, name: true },
    });
    const offenders = patients.filter((p) => {
      const n = (p.name || "").trim();
      return /^spam-\d/i.test(n) || n.toLowerCase() === "kumaraswamy";
    });
    console.log(`Found ${offenders.length} spam-* / Kumaraswamy patient rows`);
    await deleteSafePatients(306, "Patient spam/Kumaraswamy pollution", offenders);
  } catch (e) {
    console.error(`#306 failed:`, e.message);
    record(306, "Patient spam/Kumaraswamy pollution", 0, 0, true, e.message);
  }
}

// ─── #320: LeadRoutingRule trailing 13-digit timestamps -> strip ──────────
async function cleanupLeadRoutingRuleNames() {
  header(320, "Strip trailing 13-digit timestamp from LeadRoutingRule.name");
  try {
    const rules = await prisma.leadRoutingRule.findMany({
      where: { tenantId: TENANT_ID },
      select: { id: true, name: true, isActive: true },
    });
    // /\s\d{13}$/ — exactly the spec ("trailing 13-digit timestamp")
    const TIMESTAMP_TAIL = /\s\d{13}$/;
    const offenders = rules
      .map((r) => ({
        ...r,
        cleaned: (r.name || "").replace(TIMESTAMP_TAIL, "").trimEnd(),
      }))
      .filter((r) => TIMESTAMP_TAIL.test(r.name || "") && r.cleaned !== r.name);
    console.log(
      `Scanned ${rules.length} tenant-${TENANT_ID} rules; ${offenders.length} have trailing 13-digit timestamp`
    );
    for (const r of offenders) {
      console.log(
        `  id=${r.id} active=${r.isActive} "${r.name}" -> "${r.cleaned}"`
      );
    }
    let applied = 0;
    if (COMMIT) {
      for (const r of offenders) {
        try {
          await prisma.leadRoutingRule.update({
            where: { id: r.id },
            data: { name: r.cleaned },
          });
          applied++;
        } catch (err) {
          console.log(`  [ERROR] id=${r.id}: ${err.message}`);
        }
      }
      console.log(`Renamed ${applied} LeadRoutingRule rows.`);
    } else {
      console.log(`Would rename ${offenders.length} LeadRoutingRule rows.`);
    }
    record(320, "LeadRoutingRule rename", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#320 failed:`, e.message);
    record(320, "LeadRoutingRule rename", 0, 0, true, e.message);
  }
}

// ─── #321: ServiceConsumption cost blow-up -> NULL/0 unitCost ─────────────
async function cleanupServiceConsumptionBlowups() {
  header(321, `Zero out ServiceConsumption.unitCost where qty*unitCost > ${COST_BLOWUP_THRESHOLD}`);
  try {
    // ServiceConsumption has its own tenantId column (no need to traverse
    // service.tenantId). Field is `qty`, not `quantity`. unitCost is non-
    // nullable (Float @default(0)), so we set it to 0 (not NULL).
    const rows = await prisma.serviceConsumption.findMany({
      where: { tenantId: TENANT_ID },
      select: {
        id: true, productName: true, qty: true, unitCost: true,
        visitId: true, productId: true,
      },
    });
    const offenders = rows.filter(
      (r) => (r.qty || 0) * (r.unitCost || 0) > COST_BLOWUP_THRESHOLD
    );
    console.log(
      `Scanned ${rows.length} tenant-${TENANT_ID} consumption rows; ${offenders.length} exceed threshold`
    );
    for (const r of offenders) {
      const total = (r.qty || 0) * (r.unitCost || 0);
      console.log(
        `  id=${r.id} visit=${r.visitId} product="${r.productName}" qty=${r.qty} unitCost=${r.unitCost} total=${total}`
      );
    }
    let applied = 0;
    if (COMMIT && offenders.length > 0) {
      const result = await prisma.serviceConsumption.updateMany({
        where: { id: { in: offenders.map((r) => r.id) } },
        data: { unitCost: 0 },
      });
      applied = result.count;
      console.log(`Zeroed unitCost on ${applied} ServiceConsumption rows.`);
    } else {
      console.log(`Would zero unitCost on ${offenders.length} ServiceConsumption rows.`);
    }
    record(321, "ServiceConsumption blowup", offenders.length, COMMIT ? applied : offenders.length);
  } catch (e) {
    console.error(`#321 failed:`, e.message);
    record(321, "ServiceConsumption blowup", 0, 0, true, e.message);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`cleanup-seed-pollution-2026-04-27.js  mode=${MODE}  tenantId=${TENANT_ID}`);
  console.log(`(pass --commit to apply changes)`);

  await fixTenantCurrency();             // #330
  await cleanupKbArticles();             // #328
  await cleanupTestNotifications();      // #327
  await cleanupXssEstimates();           // #322
  await cleanupAgentRecommendations();   // #319
  await cleanupPhoneValidationPatients();// #318
  await cleanupXssLeadContacts();        // #311
  await cleanupXssInvoices();            // #310 (after #311 so the soft-delete cascade reasoning is logged in order)
  await cleanupSpamPatients();           // #306
  await cleanupLeadRoutingRuleNames();   // #320
  await cleanupServiceConsumptionBlowups(); // #321

  console.log("");
  console.log("=== Summary ===");
  console.log(`Mode: ${MODE}`);
  const col = (s, w) => String(s).padEnd(w);
  console.log(
    col("Issue", 8) + col("Section", 36) + col("Found", 8) + col("Applied", 10) + "Errored / Note"
  );
  for (const r of summary) {
    console.log(
      col("#" + r.issue, 8) +
        col(r.label, 36) +
        col(r.found, 8) +
        col(r.applied, 10) +
        (r.errored ? "YES (" + r.note + ")" : (r.note ? "no — " + r.note : "no"))
    );
  }
  const totalFound = summary.reduce((a, r) => a + r.found, 0);
  const totalApplied = summary.reduce((a, r) => a + r.applied, 0);
  const totalErrored = summary.filter((r) => r.errored).length;
  console.log(
    `Totals: found=${totalFound} applied=${totalApplied} errored_sections=${totalErrored}`
  );
  if (!COMMIT) {
    console.log("");
    console.log("DRY RUN — no rows changed. Re-run with --commit to apply.");
  }
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("FATAL:", e);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
