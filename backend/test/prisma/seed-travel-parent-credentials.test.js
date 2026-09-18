// @ts-check
/**
 * Regression coverage for the TMC demo contact seed.
 *
 * Seed defaults are allowed on create (or on a legacy contact with no
 * password), but a password chosen through portal registration must never be
 * overwritten by a later idempotent seed run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const seedPath = path.resolve(__dirname, '../../prisma/seed-travel.js');
const seedSource = fs.readFileSync(seedPath, 'utf8');

function extractFunctionBody(source, name) {
  const match = new RegExp(`async\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  if (!match) return null;

  let depth = 1;
  let index = match.index + match[0].length;
  while (index < source.length && depth > 0) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    index += 1;
  }
  return source.slice(match.index + match[0].length, index - 1);
}

function extractContactSeedBlock(functionBody, declaration) {
  const start = functionBody.indexOf(declaration);
  if (start < 0) return null;
  const end = functionBody.indexOf('\n  });', start);
  return end < 0 ? null : functionBody.slice(start, end);
}

const functionBody = extractFunctionBody(seedSource, 'seedTmcParentReviewDemo');

describe('seed-travel.js — TMC portal credential preservation', () => {
  test('keeps the parent password out of the existing-contact update payload', () => {
    const parentUpsert = extractContactSeedBlock(
      functionBody,
      'const parent = await upsertContactByEmail({',
    );

    expect(parentUpsert).not.toBeNull();
    const updatePayload = parentUpsert.match(/update:\s*\{([\s\S]*?)\n\s*\},\s*create:/)?.[1] || '';
    expect(updatePayload).not.toMatch(/portalPasswordHash/);
  });

  test('provisions a default only on create or a legacy row with no hash', () => {
    const parentUpsert = extractContactSeedBlock(
      functionBody,
      'const parent = await upsertContactByEmail({',
    );

    expect(parentUpsert).toMatch(/create:[\s\S]*portalPasswordHash:\s*passwordHash/);
    expect(functionBody).toMatch(/if\s*\(!parent\.portalPasswordHash\)/);
    expect(functionBody).toMatch(/where:\s*\{\s*id:\s*parent\.id\s*\}[\s\S]*?data:\s*\{\s*portalPasswordHash:\s*passwordHash\s*\}/);
  });

  test('also preserves teacher-selected portal passwords', () => {
    const teacherUpsert = extractContactSeedBlock(
      functionBody,
      'const teacher = await upsertContactByEmail({',
    );

    expect(teacherUpsert).not.toBeNull();
    const updatePayload = teacherUpsert.match(/update:\s*\{([\s\S]*?)\n\s*\},\s*create:/)?.[1] || '';
    expect(updatePayload).not.toMatch(/portalPasswordHash/);
    expect(functionBody).toMatch(/if\s*\(!teacher\.portalPasswordHash\)/);
  });
});
