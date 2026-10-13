const { Prisma } = require('@prisma/client');
const prisma = require('./prisma');

function namePartExpression(part) {
  const name = Prisma.sql`TRIM(REGEXP_REPLACE(c.name, '[[:space:]]+', ' '))`;
  return part === 'first'
    ? Prisma.sql`SUBSTRING_INDEX(${name}, ' ', 1)`
    : Prisma.sql`CASE WHEN LOCATE(' ', ${name}) = 0 THEN '' ELSE SUBSTRING(${name}, LOCATE(' ', ${name}) + 1) END`;
}

function trackingExpression(field) {
  // field is validated by the route's fixed tracking-field registry, and
  // the JSON path remains a bound parameter, not interpolated SQL.
  const json = Prisma.sql`JSON_EXTRACT(IF(JSON_VALID(s.payloadJson), s.payloadJson, '{}'), ${`$._meta.tracking.${field}`})`;
  return Prisma.sql`CASE WHEN JSON_TYPE(${json}) = 'NULL' THEN NULL ELSE JSON_UNQUOTE(${json}) END`;
}

function literalLike(value) {
  return `%${String(value).replace(/[=%_]/g, (char) => `=${char}`)}%`;
}

function nonempty(expression) {
  return Prisma.sql`(${expression} IS NOT NULL AND TRIM(${expression}) <> '')`;
}

function containsAny(expression, values) {
  return Prisma.sql`(${Prisma.join(values.map((value) => Prisma.sql`${expression} LIKE ${literalLike(value)} ESCAPE '='`), ' OR ')})`;
}

async function matchingContactIds({ tenantId, status, assignedToId, namePart, trackingField, operator, values }) {
  if (!['contains', 'not_contains', 'is_empty', 'is_not_empty'].includes(operator)) return null;
  const list = (values || []).filter((value) => value != null && value !== '');
  if (['contains', 'not_contains'].includes(operator) && !list.length) return null;
  const expression = namePart ? namePartExpression(namePart) : trackingExpression(trackingField);
  let predicate = ['is_empty', 'is_not_empty'].includes(operator)
    ? nonempty(expression) : containsAny(expression, list);
  if (trackingField) {
    predicate = Prisma.sql`EXISTS (SELECT 1 FROM WebFormSubmission s WHERE s.contactId = c.id AND s.tenantId = c.tenantId AND ${predicate})`;
  }
  if (operator === 'is_empty' || operator === 'not_contains') {
    predicate = namePart && operator === 'not_contains'
      ? Prisma.sql`(${expression} IS NULL OR NOT ${predicate})`
      : Prisma.sql`NOT ${predicate}`;
  }
  const rows = await prisma.$queryRaw(Prisma.sql`SELECT c.id FROM Contact c WHERE c.tenantId = ${tenantId}
    AND c.deletedAt IS NULL ${status ? Prisma.sql`AND c.status = ${status}` : Prisma.empty}
    ${assignedToId != null ? Prisma.sql`AND c.assignedToId = ${assignedToId}` : Prisma.empty}
    AND ${predicate}`);
  return rows.map((row) => row.id);
}

async function distinctValues({ tenantId, status, assignedToId, namePart, trackingField, search }) {
  const expression = namePart ? namePartExpression(namePart)
    : trackingField === 'submittedAt' ? Prisma.sql`DATE_FORMAT(s.submittedAt, '%Y-%m-%d')`
      : trackingExpression(trackingField);
  const rows = await prisma.$queryRaw(Prisma.sql`SELECT DISTINCT ${expression} AS value
    FROM Contact c ${trackingField ? Prisma.sql`JOIN WebFormSubmission s ON s.contactId = c.id AND s.tenantId = c.tenantId` : Prisma.empty}
    WHERE c.tenantId = ${tenantId} AND c.deletedAt IS NULL
    ${status ? Prisma.sql`AND c.status = ${status}` : Prisma.empty}
    ${assignedToId != null ? Prisma.sql`AND c.assignedToId = ${assignedToId}` : Prisma.empty}
    AND ${nonempty(expression)} ${search ? Prisma.sql`AND ${containsAny(expression, [search])}` : Prisma.empty}
    ORDER BY value ASC LIMIT 200`);
  return rows.map((row) => ({ value: String(row.value), label: String(row.value) }));
}

module.exports = { matchingContactIds, distinctValues, literalLike };
