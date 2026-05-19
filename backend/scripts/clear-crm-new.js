const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: 'localhost',
    port: 3307,
    user: 'root',
    password: 'Mohit@39874',
    database: 'crm_new',
  });

  console.log('Clearing tables in crm_new...\n');

  // Disable foreign key checks
  await conn.query('SET FOREIGN_KEY_CHECKS=0');

  const tables = ['productcategory', 'product', 'service', 'contact'];

  for (const table of tables) {
    try {
      await conn.query(`TRUNCATE TABLE \`${table}\``);
      console.log(`✓ Truncated ${table}`);
    } catch (e) {
      console.log(`⚠ ${table}: ${e.message}`);
    }
  }

  // Re-enable foreign key checks
  await conn.query('SET FOREIGN_KEY_CHECKS=1');

  console.log('\n✓ crm_new cleared and ready for fresh import');

  await conn.end();
})();
