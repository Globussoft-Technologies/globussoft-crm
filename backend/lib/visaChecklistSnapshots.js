// Visa Sure checklist snapshot helpers.
//
// The checklist admin keeps editable template rows, while applications lock
// against immutable snapshots so later template edits never rewrite history.
// This module centralizes the snapshot create/list/diff logic.

const crypto = require('crypto');
const { sanitizeText, sanitizeJsonForStringColumn } = require('./sanitizeJson');

function normalizeComboValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeChecklistItem(row = {}, fallbackSortOrder = 0) {
  const docType = sanitizeText(normalizeComboValue(row.docType));
  if (!docType) return null;
  const notes = row.notes == null ? null : sanitizeText(String(row.notes));
  return {
    docType,
    required: !!row.required,
    sortOrder: Number.isFinite(Number(row.sortOrder)) ? Number(row.sortOrder) : fallbackSortOrder,
    notes: notes || null,
  };
}

function sortChecklistItems(items) {
  return [...items].sort((a, b) => {
    const bySort = (a.sortOrder || 0) - (b.sortOrder || 0);
    if (bySort !== 0) return bySort;
    const aDoc = String(a.docType || '').toLowerCase();
    const bDoc = String(b.docType || '').toLowerCase();
    return aDoc.localeCompare(bDoc);
  });
}

function hashText(input) {
  return crypto.createHash('sha256').update(String(input || '')).digest('hex');
}

function itemKey(item) {
  return String(item?.docType || '').trim().toLowerCase();
}

function diffChecklistItems(beforeItems = [], afterItems = []) {
  const beforeMap = new Map(sortChecklistItems(beforeItems).filter(Boolean).map((item) => [itemKey(item), item]));
  const afterMap = new Map(sortChecklistItems(afterItems).filter(Boolean).map((item) => [itemKey(item), item]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, after] of afterMap.entries()) {
    const before = beforeMap.get(key);
    if (!before) {
      added.push(after);
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed.push({ before, after });
    }
  }
  for (const [key, before] of beforeMap.entries()) {
    if (!afterMap.has(key)) removed.push(before);
  }

  return { added, removed, changed };
}

async function loadChecklistComboState(prisma, { tenantId, applicationType, destinationCountry }) {
  const [templates, sources] = await Promise.all([
    prisma.visaChecklistTemplate.findMany({
      where: { tenantId, applicationType, destinationCountry, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: { docType: true, required: true, sortOrder: true, notes: true },
    }),
    prisma.visaChecklistSource.findMany({
      where: { tenantId, applicationType, destinationCountry, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        sourceName: true,
        sourceUrl: true,
        sourceKind: true,
        notes: true,
        isActive: true,
      },
    }),
  ]);

  const items = sortChecklistItems(
    (templates || [])
      .map((row, index) => normalizeChecklistItem(row, index))
      .filter(Boolean),
  );

  return {
    items,
    sourceList: Array.isArray(sources) ? sources : [],
  };
}

async function getLatestChecklistSnapshot(prisma, { tenantId, applicationType, destinationCountry }) {
  if (!prisma || !Number.isFinite(tenantId)) return null;
  const row = await prisma.visaChecklistSnapshot.findFirst({
    where: { tenantId, applicationType, destinationCountry },
    orderBy: { versionNumber: 'desc' },
  });
  if (!row) return null;
  return hydrateChecklistSnapshot(row);
}

function hydrateChecklistSnapshot(row) {
  if (!row) return null;
  let items = [];
  let sourceList = [];
  try {
    const parsed = typeof row.itemsJson === 'string' ? JSON.parse(row.itemsJson) : row.itemsJson;
    items = Array.isArray(parsed) ? sortChecklistItems(parsed.map((item, index) => normalizeChecklistItem(item, index)).filter(Boolean)) : [];
  } catch (_err) {
    items = [];
  }
  try {
    const parsedSources = typeof row.sourceListJson === 'string' ? JSON.parse(row.sourceListJson) : row.sourceListJson;
    sourceList = Array.isArray(parsedSources) ? parsedSources : [];
  } catch (_err) {
    sourceList = [];
  }
  return {
    ...row,
    items,
    sourceList,
  };
}

async function ensureChecklistSnapshot(prisma, { tenantId, applicationType, destinationCountry, actorUserId = null }) {
  if (!prisma || !Number.isFinite(tenantId)) return null;
  const comboState = await loadChecklistComboState(prisma, { tenantId, applicationType, destinationCountry });
  if (!comboState.items.length) {
    return null;
  }

  const itemsJson = sanitizeJsonForStringColumn(comboState.items);
  const sourceListJson = sanitizeJsonForStringColumn(comboState.sourceList || []);
  const snapshotHash = hashText(JSON.stringify({
    items: comboState.items,
    sourceList: comboState.sourceList || [],
  }));
  const latest = await prisma.visaChecklistSnapshot.findFirst({
    where: { tenantId, applicationType, destinationCountry },
    orderBy: { versionNumber: 'desc' },
  });

  if (
    latest &&
    latest.snapshotHash === snapshotHash &&
    String(latest.itemsJson || '') === String(itemsJson || '') &&
    String(latest.sourceListJson || '') === String(sourceListJson || '')
  ) {
    return hydrateChecklistSnapshot(latest);
  }

  const versionNumber = (latest?.versionNumber || 0) + 1;
  const created = await prisma.visaChecklistSnapshot.create({
    data: {
      tenantId,
      applicationType,
      destinationCountry,
      versionNumber,
      snapshotHash,
      itemsJson,
      sourceListJson,
      createdById: actorUserId ?? null,
      sourceId: null,
    },
  });
  return hydrateChecklistSnapshot(created);
}

function parseChecklistSnapshotItems(row) {
  return hydrateChecklistSnapshot(row)?.items || [];
}

function parseChecklistSnapshotSources(row) {
  return hydrateChecklistSnapshot(row)?.sourceList || [];
}

module.exports = {
  diffChecklistItems,
  ensureChecklistSnapshot,
  getLatestChecklistSnapshot,
  hydrateChecklistSnapshot,
  loadChecklistComboState,
  parseChecklistSnapshotItems,
  parseChecklistSnapshotSources,
  sortChecklistItems,
};
