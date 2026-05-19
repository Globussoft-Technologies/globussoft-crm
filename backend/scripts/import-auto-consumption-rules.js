#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const autoConsumptionData = [
  {
    serviceName: "Hair PRP advance",
    products: [
      { name: "PRP(Hair)", quantity: 1 }
    ]
  },
  {
    serviceName: "Hair GFC adv",
    products: [
      { name: "I' aberre (Hair GFC)", quantity: 1 },
      { name: "G7 Pro GFC (Hair)", quantity: 1 }
    ]
  },
  {
    serviceName: "Exosomes",
    products: [
      { name: "Exosome (Hair)", quantity: 1 }
    ]
  },
  {
    serviceName: "QR678",
    products: [
      { name: "QR 678 (HAIR)", quantity: 1 }
    ]
  },
  {
    serviceName: "hair wash female",
    products: [
      { name: "Gluta IV-", quantity: 20 }
    ]
  },
  {
    serviceName: "Hair Transplant",
    products: [
      { name: "Methylene Blue Ink", quantity: 5 }
    ]
  },
  {
    serviceName: "Kenpeki",
    products: [
      { name: "Kempeki", quantity: 1 }
    ]
  }
];

async function main() {
  try {
    console.log('Starting auto-consumption rules import...\n');

    // Get the wellness tenant
    let tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    if (!tenant) {
      console.log('No wellness tenant found!');
      process.exit(1);
    }

    const tenantId = tenant.id;
    console.log(`Using tenant ID: ${tenantId}\n`);

    // Process each service
    for (const ruleData of autoConsumptionData) {
      console.log(`Setting up auto-consumption for: ${ruleData.serviceName}`);

      // Find the service
      const service = await prisma.service.findFirst({
        where: {
          name: ruleData.serviceName,
          tenantId
        }
      });

      if (!service) {
        console.log(`  ❌ Service not found!`);
        continue;
      }

      console.log(`  Service ID: ${service.id}`);

      // Create auto-consumption rules for each product
      for (const productData of ruleData.products) {
        // Find the product
        const sku = productData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const product = await prisma.product.findFirst({
          where: {
            sku,
            tenantId
          }
        });

        if (!product) {
          console.log(`    ❌ Product "${productData.name}" not found!`);
          continue;
        }

        // Create or update auto-consumption rule
        const rule = await prisma.autoConsumptionRule.upsert({
          where: {
            tenantId_serviceId_productId: {
              tenantId,
              serviceId: service.id,
              productId: product.id
            }
          },
          update: {
            quantityPerVisit: productData.quantity
          },
          create: {
            tenantId,
            serviceId: service.id,
            productId: product.id,
            quantityPerVisit: productData.quantity,
            isActive: true
          }
        });

        console.log(`    ✅ ${productData.name} x${productData.quantity} → Auto-Consumption Rule ID: ${rule.id}`);
      }
      console.log('');
    }

    console.log('✅ Auto-consumption rules import completed successfully!');

  } catch (error) {
    console.error('❌ Error during import:', error.message);
    if (error.meta) console.error('Details:', error.meta);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
