/**
 * Copy migrated data from crm to crm_new database
 * This script copies all the imported Zylu data to the new database
 */

const mysql = require('mysql2/promise');

const DB_HOST = 'localhost';
const DB_PORT = 3307;
const DB_USER = 'root';
const DB_PASSWORD = 'Mohit@39874';
const SOURCE_DB = 'crm';
const TARGET_DB = 'crm_new';
const TENANT_ID = 1;

async function main() {
  console.log('=== Copying Data from crm → crm_new ===\n');

  const sourceConn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: SOURCE_DB,
  });

  const targetConn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    database: TARGET_DB,
  });

  try {
    // Get the max IDs in target to avoid conflicts
    const [maxProductId] = await targetConn.query('SELECT MAX(id) as maxId FROM product');
    const [maxServiceId] = await targetConn.query('SELECT MAX(id) as maxId FROM service');
    const [maxContactId] = await targetConn.query('SELECT MAX(id) as maxId FROM contact');

    const productIdOffset = (maxProductId[0].maxId || 0) + 1000;
    const serviceIdOffset = (maxServiceId[0].maxId || 0) + 1000;
    const contactIdOffset = (maxContactId[0].maxId || 0) + 1000;

    // Copy ProductCategory
    console.log('Copying ProductCategory...');
    const [categories] = await sourceConn.query(
      `SELECT * FROM productcategory WHERE tenantId = ? LIMIT 100000`,
      [TENANT_ID]
    );
    for (const cat of categories) {
      await targetConn.query(
        'INSERT INTO productcategory (tenantId, name, color, imageUrl, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [TENANT_ID, cat.name, cat.color, cat.imageUrl, cat.createdAt, new Date()]
      );
    }
    console.log(`✓ Copied ${categories.length} product categories\n`);

    // Copy Products
    console.log('Copying Products...');
    const [products] = await sourceConn.query(
      `SELECT * FROM product WHERE tenantId = ? LIMIT 100000`,
      [TENANT_ID]
    );
    for (const prod of products) {
      await targetConn.query(
        `INSERT INTO product (tenantId, name, description, price, purchasePrice, currentStock, sku, barcode, threshold, isRecurring, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          TENANT_ID,
          prod.name,
          prod.description,
          prod.price,
          prod.purchasePrice,
          prod.currentStock,
          prod.sku,
          prod.barcode,
          prod.threshold,
          prod.isRecurring,
          prod.createdAt,
          new Date(),
        ]
      );
    }
    console.log(`✓ Copied ${products.length} products\n`);

    // Copy Services
    console.log('Copying Services...');
    const [services] = await sourceConn.query(
      `SELECT * FROM service WHERE tenantId = ? LIMIT 100000`,
      [TENANT_ID]
    );
    for (const svc of services) {
      await targetConn.query(
        `INSERT INTO service (tenantId, name, category, ticketTier, basePrice, discountedPrice, durationMin, description, isActive, tax, isTaxIncluded, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          TENANT_ID,
          svc.name,
          svc.category,
          svc.ticketTier,
          svc.basePrice,
          svc.discountedPrice,
          svc.durationMin,
          svc.description,
          svc.isActive,
          svc.tax,
          svc.isTaxIncluded,
          svc.createdAt,
        ]
      );
    }
    console.log(`✓ Copied ${services.length} services\n`);

    // Copy Contacts
    console.log('Copying Contacts...');
    const [contacts] = await sourceConn.query(
      `SELECT * FROM contact WHERE tenantId = ? LIMIT 100000`,
      [TENANT_ID]
    );
    for (const contact of contacts) {
      await targetConn.query(
        `INSERT INTO contact (tenantId, name, email, phone, company, status, source, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          TENANT_ID,
          contact.name,
          contact.email,
          contact.phone,
          contact.company,
          contact.status,
          contact.source,
          contact.createdAt,
        ]
      );
    }
    console.log(`✓ Copied ${contacts.length} contacts\n`);

    // Summary
    console.log('=== Data Copy Complete ===\n');
    console.log(`✓ Product Categories: ${categories.length}`);
    console.log(`✓ Products: ${products.length}`);
    console.log(`✓ Services: ${services.length}`);
    console.log(`✓ Contacts: ${contacts.length}`);
    console.log(`\n✨ All data successfully copied to crm_new database!`);
    console.log(`\nYour database is now ready with all wellness/salon data!`);

  } catch (error) {
    console.error('Error copying data:', error.message);
    process.exit(1);
  } finally {
    await sourceConn.end();
    await targetConn.end();
  }
}

main();
