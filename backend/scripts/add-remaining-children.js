#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    const tenantId = tenant.id;
    console.log('Adding remaining child categories...\n');

    const childCategories = [
      {
        name: 'Stretch Marks',
        parentName: 'Body Care',
        color: '#ff9f43',
        imageUrl: 'https://zylu-prod-s3-storage.s3.ap-southeast-1.amazonaws.com/76056156/Stretch-Marks.jpg'
      }
    ];

    for (const cat of childCategories) {
      const existing = await prisma.serviceCategory.findFirst({
        where: { tenantId, name: cat.name }
      });

      if (existing) {
        console.log(`⊘ Already exists: ${cat.name}`);
        continue;
      }

      const parent = await prisma.serviceCategory.findFirst({
        where: { tenantId, name: cat.parentName }
      });

      if (!parent) {
        console.log(`⚠️  Parent not found: ${cat.parentName}`);
        continue;
      }

      const created = await prisma.serviceCategory.create({
        data: {
          name: cat.name,
          color: cat.color,
          imageUrl: cat.imageUrl,
          tenantId,
          parentId: parent.id
        }
      });
      console.log(`✅ Created: ${created.name} → ${cat.parentName}`);
    }

    console.log('\n✅ Child categories completed!');

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
