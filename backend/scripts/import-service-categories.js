#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Starting service category import...\n');

    // Get the wellness tenant
    const tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    if (!tenant) {
      console.log('❌ Wellness tenant not found!');
      process.exit(1);
    }

    const tenantId = tenant.id;
    console.log(`✅ Using Wellness Tenant: ${tenant.name} (ID: ${tenantId})\n`);

    // Read the TSV file
    const filePath = path.join(__dirname, '../service_categories.txt');
    if (!fs.existsSync(filePath)) {
      console.log(`❌ Service categories file not found at ${filePath}`);
      process.exit(1);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    // Parse header
    const header = lines[0].split('\t');
    const nameIndex = header.indexOf('name');
    const colorIndex = header.indexOf('color');
    const descriptionIndex = header.indexOf('description');
    const orderIndex = header.indexOf('order');
    const parentNameIndex = header.indexOf('parent_name');
    const imageUrlIndex = header.indexOf('image_url');

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    // Track categories by name for parent lookup
    const categoryMap = new Map();

    // First pass: Create all categories without parents
    console.log('Creating top-level categories...\n');
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      try {
        const values = lines[i].split('\t');
        const name = (values[nameIndex] || '').trim();
        const parentName = (values[parentNameIndex] || '').trim();

        // Skip if has parent or no name
        if (parentName || !name) continue;

        // Check for duplicates
        const existing = await prisma.serviceCategory.findFirst({
          where: { tenantId: tenantId, name: name }
        });

        if (existing) {
          skippedCount++;
          if (skippedCount <= 5) {
            console.log(`  ⊘ ${name} skipped (duplicate)`);
          }
          categoryMap.set(name, existing.id);
          continue;
        }

        const categoryData = {
          name: name,
          tenantId: tenantId
        };

        const color = (values[colorIndex] || '').trim();
        if (color && color !== 'null') categoryData.color = color;

        const description = (values[descriptionIndex] || '').trim();
        if (description && description !== 'null' && description !== '') {
          categoryData.description = description;
        }

        const order = (values[orderIndex] || '').trim();
        if (order && !isNaN(parseInt(order))) {
          categoryData.displayOrder = parseInt(order);
        }

        const imageUrl = (values[imageUrlIndex] || '').trim();
        if (imageUrl && imageUrl !== 'null' && imageUrl !== '') {
          categoryData.imageUrl = imageUrl;
        }

        const category = await prisma.serviceCategory.create({
          data: categoryData
        });

        categoryMap.set(name, category.id);
        successCount++;
      } catch (error) {
        errorCount++;
        if (errorCount <= 5) {
          console.log(`  ⚠️  Row ${i + 1} error: ${error.message.substring(0, 80)}`);
        }
      }
    }

    console.log(`✅ Created ${successCount} top-level categories\n`);

    // Second pass: Create child categories with parent references
    console.log('Creating child categories...\n');
    let childCount = 0;
    errorCount = 0;

    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      try {
        const values = lines[i].split('\t');
        const name = (values[nameIndex] || '').trim();
        const parentName = (values[parentNameIndex] || '').trim();

        // Skip if no parent or no name
        if (!parentName || !name) continue;

        // Check for duplicates
        const existing = await prisma.serviceCategory.findFirst({
          where: { tenantId: tenantId, name: name }
        });

        if (existing) {
          skippedCount++;
          if (skippedCount <= 5) {
            console.log(`  ⊘ ${name} skipped (duplicate)`);
          }
          continue;
        }

        // Get parent ID
        const parentId = categoryMap.get(parentName);
        if (!parentId) {
          console.log(`  ⚠️  ${name} skipped (parent not found: ${parentName})`);
          continue;
        }

        const categoryData = {
          name: name,
          tenantId: tenantId,
          parentId: parentId
        };

        const color = (values[colorIndex] || '').trim();
        if (color && color !== 'null') categoryData.color = color;

        const description = (values[descriptionIndex] || '').trim();
        if (description && description !== 'null' && description !== '') {
          categoryData.description = description;
        }

        const order = (values[orderIndex] || '').trim();
        if (order && !isNaN(parseInt(order))) {
          categoryData.displayOrder = parseInt(order);
        }

        const imageUrl = (values[imageUrlIndex] || '').trim();
        if (imageUrl && imageUrl !== 'null' && imageUrl !== '') {
          categoryData.imageUrl = imageUrl;
        }

        const category = await prisma.serviceCategory.create({
          data: categoryData
        });

        childCount++;
      } catch (error) {
        errorCount++;
        if (errorCount <= 5) {
          console.log(`  ⚠️  Row ${i + 1} error: ${error.message.substring(0, 80)}`);
        }
      }
    }

    console.log(`\n✅ Service category import completed!`);
    console.log(`   Top-level categories: ${successCount}`);
    console.log(`   Child categories: ${childCount}`);
    if (skippedCount > 0) {
      console.log(`   Skipped (duplicates): ${skippedCount}`);
    }
    if (errorCount > 0) {
      console.log(`   Errors: ${errorCount}`);
    }

    // Verify import
    const totalCategories = await prisma.serviceCategory.count({
      where: { tenantId }
    });
    console.log(`\n✅ Total service categories in Wellness tenant: ${totalCategories}`);

  } catch (error) {
    console.error('❌ Error during import:', error.message);
    if (error.meta) console.error('Meta:', error.meta);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
