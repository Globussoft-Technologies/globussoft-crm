#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    const tenantId = tenant.id;
    console.log('Creating missing parent categories...\n');

    const missingCategories = [
      { name: 'Haircut', color: '#2B2B2B', displayOrder: 1 },
      { name: 'Hair Color', color: '#615959', displayOrder: 2 },
      { name: 'Hair Removal', color: '#D0EBC5', displayOrder: 99 },
      { name: 'HAIR TREATMENT', color: '#BDA395', displayOrder: 4 },
      { name: 'Facial', color: '#ee5253', displayOrder: 17 },
      { name: 'Laser Skin Treatments', color: '#0abde3', displayOrder: 11 },
      { name: 'Body Care', color: '#2B2B2B', displayOrder: 6 },
      { name: 'Bleach', color: '#ee5253', displayOrder: 35 }
    ];

    for (const cat of missingCategories) {
      const existing = await prisma.serviceCategory.findFirst({
        where: { tenantId, name: cat.name }
      });

      if (!existing) {
        const created = await prisma.serviceCategory.create({
          data: {
            name: cat.name,
            color: cat.color,
            displayOrder: cat.displayOrder,
            tenantId
          }
        });
        console.log(`✅ Created: ${created.name}`);
      } else {
        console.log(`⊘ Already exists: ${cat.name}`);
      }
    }

    console.log('\n✅ Missing parent categories created successfully!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
