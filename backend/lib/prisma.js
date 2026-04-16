const { PrismaClient } = require('@prisma/client');

// Singleton pattern — single PrismaClient across the app
// Fixes "Too many connections" errors from each route creating its own client
const globalForPrisma = global;

const prisma = globalForPrisma.prisma || new PrismaClient({
  log: process.env.NODE_ENV === 'production' ? ['error'] : ['warn', 'error'],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

module.exports = prisma;
