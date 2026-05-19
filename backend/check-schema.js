const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();

(async () => {
  try {
    const result = await db.$queryRaw`SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'Patient' AND TABLE_SCHEMA = 'crm' ORDER BY ORDINAL_POSITION`;
    console.log('Patient table columns:');
    result.forEach(col => console.log(`  ${col.COLUMN_NAME}: ${col.DATA_TYPE}`));

    // Check if userId exists
    const hasUserId = result.some(col => col.COLUMN_NAME === 'userId');
    console.log(`\nuserId column exists: ${hasUserId}`);
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await db.$disconnect();
  }
})();
