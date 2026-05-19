#!/usr/bin/env node
/**
 * Zylu POS Data Import Script
 * Imports service categories, services, and booking records from TSV files
 * Usage: node scripts/zylu-import.js <tenantId>
 */

const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const TENANT_ID = parseInt(process.argv[2]) || 1;
const DATA_DIR = path.join(__dirname, 'zylu-data');

// Parse TSV file
function parseTSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  if (lines.length === 0) return [];

  const headers = lines[0].split('\t').map(h => h.trim());
  const data = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split('\t').map(v => v.trim());
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] || null;
    });
    data.push(row);
  }

  return data;
}

// Import Service Categories
async function importServiceCategories() {
  console.log('\n📦 Importing Service Categories...');

  const filePath = path.join(DATA_DIR, 'service_categories.txt');
  const categories = parseTSV(filePath);

  if (categories.length === 0) {
    console.log('❌ No service categories found');
    return {};
  }

  // Map to store name -> id for later reference
  const categoryMap = {};
  const categoryByParent = {};

  // First pass: create all root categories (those without parent)
  for (const cat of categories) {
    if (!cat.parent_name || cat.parent_name === '') {
      try {
        const existing = await prisma.serviceCategory.findFirst({
          where: {
            tenantId: TENANT_ID,
            name: cat.name
          }
        });

        if (existing) {
          categoryMap[cat.name] = existing.id;
          console.log(`⏭️  Category "${cat.name}" already exists (id: ${existing.id})`);
          continue;
        }

        const created = await prisma.serviceCategory.create({
          data: {
            name: cat.name,
            description: cat.description || null,
            color: cat.color || '#265855',
            displayOrder: parseInt(cat.display_order) || 0,
            imageUrl: cat.image_url || null,
            tenantId: TENANT_ID
          }
        });

        categoryMap[cat.name] = created.id;
        console.log(`✅ Created category "${cat.name}" (id: ${created.id})`);
      } catch (error) {
        console.error(`❌ Error creating category "${cat.name}":`, error.message);
      }
    }
  }

  // Second pass: create child categories (those with parent)
  for (const cat of categories) {
    if (cat.parent_name && cat.parent_name !== '') {
      try {
        const existing = await prisma.serviceCategory.findFirst({
          where: {
            tenantId: TENANT_ID,
            name: cat.name
          }
        });

        if (existing) {
          categoryMap[cat.name] = existing.id;
          console.log(`⏭️  Category "${cat.name}" already exists (id: ${existing.id})`);
          continue;
        }

        const parentId = categoryMap[cat.parent_name];
        if (!parentId) {
          console.warn(`⚠️  Parent category "${cat.parent_name}" not found for "${cat.name}". Creating as root.`);
        }

        const created = await prisma.serviceCategory.create({
          data: {
            name: cat.name,
            description: cat.description || null,
            color: cat.color || '#CD9481',
            displayOrder: parseInt(cat.display_order) || 0,
            imageUrl: cat.image_url || null,
            parentId: parentId || null,
            tenantId: TENANT_ID
          }
        });

        categoryMap[cat.name] = created.id;
        console.log(`✅ Created subcategory "${cat.name}" (parent: "${cat.parent_name}", id: ${created.id})`);
      } catch (error) {
        console.error(`❌ Error creating category "${cat.name}":`, error.message);
      }
    }
  }

  console.log(`\n📊 Imported ${Object.keys(categoryMap).length} categories`);
  return categoryMap;
}

// Import Services
async function importServices(categoryMap) {
  console.log('\n🛎️  Importing Services...');

  const filePath = path.join(DATA_DIR, 'services_zylu.txt');
  const services = parseTSV(filePath);

  if (services.length === 0) {
    console.log('❌ No services found');
    return [];
  }

  const serviceMap = {}; // Map to store name -> id for later reference
  let created = 0;
  let skipped = 0;

  for (const svc of services) {
    try {
      // Check for duplicates (tenantId + name)
      const existing = await prisma.service.findFirst({
        where: {
          tenantId: TENANT_ID,
          name: svc.name
        }
      });

      if (existing) {
        serviceMap[svc.name] = existing.id;
        console.log(`⏭️  Service "${svc.name}" already exists (id: ${existing.id})`);
        skipped++;
        continue;
      }

      // Get category ID from name
      const categoryId = svc.service_category ? categoryMap[svc.service_category] : null;

      const imageUrls = svc.image_urls ? JSON.parse(svc.image_urls) : [];

      const createdService = await prisma.service.create({
        data: {
          name: svc.name,
          categoryId: categoryId || null,
          basePrice: parseFloat(svc.base_price) || 0,
          discountedPrice: svc.discounted_price ? parseFloat(svc.discounted_price) : null,
          durationMin: parseInt(svc.duration_minutes) || 30,
          description: svc.description || null,
          gender: svc.gender || null,
          code: svc.code || null,
          isStartingPrice: svc.is_starting_price === 'true' || svc.is_starting_price === '1' || false,
          isHomeService: svc.is_home_service === 'true' || svc.is_home_service === '1' || false,
          hidePriceFromCustomer: svc.hide_price_from_customer === 'true' || svc.hide_price_from_customer === '1' || false,
          tax: svc.tax ? parseFloat(svc.tax) : null,
          isTaxIncluded: svc.is_tax_included === 'true' || svc.is_tax_included === '1' || false,
          displayOrder: parseInt(svc.display_order) || 0,
          imageUrls: imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
          tenantId: TENANT_ID
        }
      });

      serviceMap[svc.name] = createdService.id;
      created++;
      console.log(`✅ Created service "${svc.name}" (id: ${createdService.id}, category: ${svc.service_category || 'none'})`);
    } catch (error) {
      console.error(`❌ Error creating service "${svc.name}":`, error.message);
    }
  }

  console.log(`\n📊 Imported ${created} services (${skipped} skipped as duplicates)`);
  return serviceMap;
}

// Import Bookings/Visits
async function importBookings(serviceMap) {
  console.log('\n📅 Importing Bookings (Visits)...');

  const filePath = path.join(DATA_DIR, 'bookings.txt');
  const bookings = parseTSV(filePath);

  if (bookings.length === 0) {
    console.log('❌ No bookings found');
    return [];
  }

  let created = 0;
  let skipped = 0;

  for (const booking of bookings) {
    try {
      // Find or create patient (using phone as unique identifier)
      let patient = await prisma.patient.findFirst({
        where: {
          tenantId: TENANT_ID,
          normalizedPhone: booking.phone ? booking.phone.replace(/\D/g, '') : ''
        }
      });

      if (!patient) {
        patient = await prisma.patient.create({
          data: {
            name: booking.customer_name || 'Unknown',
            phone: booking.phone || '',
            normalizedPhone: booking.phone ? booking.phone.replace(/\D/g, '') : '',
            email: booking.customer_email || null,
            tenantId: TENANT_ID
          }
        });
        console.log(`➕ Created patient "${patient.name}" (phone: ${booking.phone})`);
      }

      // Get service ID from name
      const serviceId = booking.service_name ? serviceMap[booking.service_name] : null;

      if (!serviceId) {
        console.warn(`⚠️  Service "${booking.service_name}" not found for booking ${booking.booking_id}`);
        skipped++;
        continue;
      }

      // Create visit record
      const visit = await prisma.visit.create({
        data: {
          patientId: patient.id,
          serviceId: serviceId,
          visitDate: booking.booking_date ? new Date(booking.booking_date) : new Date(),
          status: booking.status || 'completed',
          amountCharged: booking.amount_charged ? parseFloat(booking.amount_charged) : null,
          notes: booking.notes || null,
          tenantId: TENANT_ID
        }
      });

      created++;
      console.log(`✅ Created visit for "${patient.name}" - "${booking.service_name}" (id: ${visit.id})`);
    } catch (error) {
      console.error(`❌ Error creating booking for ${booking.booking_id}:`, error.message);
    }
  }

  console.log(`\n📊 Imported ${created} bookings (${skipped} skipped due to missing services)`);
}

// Main execution
async function main() {
  try {
    console.log(`🚀 Starting Zylu POS import for tenant ID: ${TENANT_ID}`);
    console.log(`📂 Reading data from: ${DATA_DIR}`);

    // Check if data directory exists
    if (!fs.existsSync(DATA_DIR)) {
      console.error(`❌ Data directory not found: ${DATA_DIR}`);
      console.error(`Please place the following files in ${DATA_DIR}:`);
      console.error('  - service_categories.txt');
      console.error('  - services_zylu.txt');
      console.error('  - bookings.txt');
      process.exit(1);
    }

    // Run imports in sequence
    const categoryMap = await importServiceCategories();
    const serviceMap = await importServices(categoryMap);
    await importBookings(serviceMap);

    console.log('\n✨ Import completed successfully!');
  } catch (error) {
    console.error('❌ Fatal error:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
