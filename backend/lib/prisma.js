const { PrismaClient } = require('@prisma/client');
const { decrypt, isEncrypted } = require('./fieldEncryption');

// Singleton pattern — single PrismaClient across the app
// Fixes "Too many connections" errors from each route creating its own client
const globalForPrisma = global;

// Map of model name -> array of fields to transparently decrypt on read.
// Wellness PII fields. When WELLNESS_FIELD_KEY is missing, decrypt() is a
// pass-through, so this extension is effectively a no-op.
const ENCRYPTED_FIELDS = {
  Patient: ['allergies', 'notes'],
  Visit: ['notes', 'vitals'],
  Prescription: ['drugs', 'instructions'],
  ConsentForm: ['signatureSvg'],
};

function decryptRecord(modelName, record) {
  if (!record || typeof record !== 'object') return record;
  const fields = ENCRYPTED_FIELDS[modelName];
  if (!fields) return record;
  for (const f of fields) {
    const v = record[f];
    if (typeof v === 'string' && isEncrypted(v)) {
      record[f] = decrypt(v);
    }
  }
  return record;
}

function decryptResult(modelName, result) {
  if (result == null) return result;
  if (Array.isArray(result)) {
    for (const r of result) decryptRecord(modelName, r);
    return result;
  }
  return decryptRecord(modelName, result);
}

function buildClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });

  // Use $extends (Prisma 5+/6) for transparent decryption on all reads.
  // Covers: findUnique, findUniqueOrThrow, findFirst, findFirstOrThrow,
  // findMany. Writes are NOT auto-encrypted — callers/backfill script handle
  // encryption explicitly via fieldEncryption.encrypt().
  return base.$extends({
    name: 'wellness-pii-decrypt',
    query: {
      $allModels: {
        async findUnique({ model, args, query }) {
          const r = await query(args); return decryptResult(model, r);
        },
        async findUniqueOrThrow({ model, args, query }) {
          const r = await query(args); return decryptResult(model, r);
        },
        async findFirst({ model, args, query }) {
          const r = await query(args); return decryptResult(model, r);
        },
        async findFirstOrThrow({ model, args, query }) {
          const r = await query(args); return decryptResult(model, r);
        },
        async findMany({ model, args, query }) {
          const r = await query(args); return decryptResult(model, r);
        },
      },
    },
  });
}

const prisma = globalForPrisma.prisma || buildClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
