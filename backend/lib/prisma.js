const { PrismaClient } = require('@prisma/client');
const { encrypt, decrypt, isEncrypted } = require('./fieldEncryption');

// Singleton pattern — single PrismaClient across the app
// Fixes "Too many connections" errors from each route creating its own client
const globalForPrisma = global;

// Map of model name -> array of fields to transparently encrypt on write and
// decrypt on read. When WELLNESS_FIELD_KEY is missing, encrypt()/decrypt() are
// pass-throughs, so this extension is effectively a no-op.
//
// Safe to extend: route handlers in wellness.js use only flat (non-nested)
// writes for these models, so the root $extends hooks catch every call site.
// If you ever introduce a nested write like
//   prisma.patient.create({ data: { ..., visits: { create: { notes: ... } } } })
// the inner notes will NOT be auto-encrypted — Prisma routes nested ops through
// the parent model's hook only. Use sequential creates instead, or expand the
// encryptInput logic to walk relations.
const ENCRYPTED_FIELDS = {
  Patient: ['allergies', 'notes'],
  Visit: ['notes', 'vitals'],
  Prescription: ['drugs', 'instructions'],
  ConsentForm: ['signatureSvg'],
};

function encryptInput(modelName, data) {
  if (!data || typeof data !== 'object') return data;
  const fields = ENCRYPTED_FIELDS[modelName];
  if (!fields) return data;
  for (const f of fields) {
    if (!(f in data)) continue;
    const v = data[f];
    // Plain string assignment: { allergies: "penicillin" }
    if (typeof v === 'string') {
      data[f] = encrypt(v);
    } else if (v && typeof v === 'object' && typeof v.set === 'string') {
      // Prisma update operator: { allergies: { set: "penicillin" } }
      data[f] = { set: encrypt(v.set) };
    }
    // null / undefined / non-string atoms: leave alone (encrypt is a no-op anyway)
  }
  return data;
}

function encryptArgs(modelName, args) {
  if (!args) return args;
  if (args.data) {
    if (Array.isArray(args.data)) {
      args.data = args.data.map((d) => encryptInput(modelName, { ...d }));
    } else {
      args.data = encryptInput(modelName, { ...args.data });
    }
  }
  if (args.create) args.create = encryptInput(modelName, { ...args.create });
  if (args.update) args.update = encryptInput(modelName, { ...args.update });
  return args;
}

// All field names that ANY encrypted model uses, flattened. We use this set
// to decrypt nested-include results where Prisma doesn't run a per-model
// hook (e.g. patient.findUnique({ include: { visits: { include: { prescriptions: true } } } }) —
// the inner Visit.notes / Prescription.drugs were returning as raw
// "ENC:v1:..." ciphertext to the UI before #224.
const ALL_ENCRYPTED_FIELD_NAMES = new Set(
  Object.values(ENCRYPTED_FIELDS).flat()
);

function decryptRecord(record) {
  if (!record || typeof record !== 'object') return record;
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v == null) continue;
    if (typeof v === 'string') {
      // Decrypt any field whose NAME matches an encrypted-field name AND
      // whose value is actually ciphertext. The isEncrypted() gate prevents
      // decryption attempts on plaintext that happens to share a field name
      // (e.g. Service.notes if it ever exists) — those leave the value alone.
      if (ALL_ENCRYPTED_FIELD_NAMES.has(key) && isEncrypted(v)) {
        record[key] = decrypt(v);
      }
    } else if (Array.isArray(v)) {
      for (const item of v) decryptRecord(item);
    } else if (typeof v === 'object') {
      decryptRecord(v);
    }
  }
  return record;
}

function decryptResult(modelName, result) {
  // modelName retained for signature compatibility but the walker is now
  // model-agnostic — it descends into every nested relation.
  if (result == null) return result;
  if (Array.isArray(result)) {
    for (const r of result) decryptRecord(r);
    return result;
  }
  return decryptRecord(result);
}

function buildClient() {
  const base = new PrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
  });

  // $extends (Prisma 5+/6) intercepts queries for transparent PII handling.
  // Reads → decrypt on the way out. Writes → encrypt on the way in.
  // Both sides are no-ops when WELLNESS_FIELD_KEY is unset, so this extension
  // is safe to deploy before flipping the encryption switch.
  return base.$extends({
    name: 'wellness-pii',
    query: {
      $allModels: {
        // Reads — decrypt outputs
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
        // Writes — encrypt inputs, decrypt the returned record so callers
        // immediately see plaintext (matches read-side behaviour)
        async create({ model, args, query }) {
          const r = await query(encryptArgs(model, args));
          return decryptResult(model, r);
        },
        async createMany({ model, args, query }) {
          // createMany returns { count }, no record to decrypt
          return query(encryptArgs(model, args));
        },
        async update({ model, args, query }) {
          const r = await query(encryptArgs(model, args));
          return decryptResult(model, r);
        },
        async updateMany({ model, args, query }) {
          // updateMany returns { count }
          return query(encryptArgs(model, args));
        },
        async upsert({ model, args, query }) {
          const r = await query(encryptArgs(model, args));
          return decryptResult(model, r);
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
