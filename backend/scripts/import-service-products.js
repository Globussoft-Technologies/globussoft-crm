#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const serviceProductsData = [
  {
    serviceName: "Hair PRP advance",
    duration: "00:45",
    price: 7999,
    products: [
      { name: "PRP(Hair)", unit: "Piece", price: 15000, quantity: 1 }
    ]
  },
  {
    serviceName: "Hair GFC adv",
    duration: "00:45",
    price: 9999,
    products: [
      { name: "I' aberre (Hair GFC)", unit: "Piece", price: 6999, quantity: 1 },
      { name: "G7 Pro GFC (Hair)", unit: "Piece", price: 7000, quantity: 1 }
    ]
  },
  {
    serviceName: "Exosomes",
    duration: "00:45",
    price: 7999,
    products: [
      { name: "Exosome (Hair)", unit: "ml", price: 15000, quantity: 1 }
    ]
  },
  {
    serviceName: "QR678",
    duration: "00:42",
    price: 6999,
    products: [
      { name: "QR 678 (HAIR)", unit: "ml", price: 41300, quantity: 1 }
    ]
  },
  {
    serviceName: "hair wash female",
    duration: "00:15",
    price: 499,
    products: [
      { name: "Gluta IV-", unit: "mg", price: 5000, quantity: 20 }
    ]
  },
  {
    serviceName: "Hair Transplant",
    duration: "09:14",
    price: 49999,
    products: [
      { name: "Methylene Blue Ink", unit: "ml", price: 249, quantity: 5 }
    ]
  },
  {
    serviceName: "Kenpeki",
    duration: "00:00",
    price: 3000,
    products: [
      { name: "Kempeki", unit: "Piece", price: 1, quantity: 1 }
    ]
  }
];

async function main() {
  try {
    console.log('Starting service-product import...');

    // Get the wellness tenant
    let tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    if (!tenant) {
      console.log('No wellness tenant found. Creating...');
      tenant = await prisma.tenant.create({
        data: {
          name: 'Wellness Clinic',
          vertical: 'wellness',
          country: 'IN',
          defaultCurrency: 'INR'
        }
      });
      console.log('Created tenant:', tenant.id);
    }

    const tenantId = tenant.id;
    console.log(`Using tenant ID: ${tenantId}\n`);

    // Process each service
    for (const serviceData of serviceProductsData) {
      console.log(`Processing service: ${serviceData.serviceName}`);

      // Check if service exists
      let service = await prisma.service.findFirst({
        where: {
          name: serviceData.serviceName,
          tenantId
        }
      });

      // Create or update the service
      if (service) {
        service = await prisma.service.update({
          where: { id: service.id },
          data: {
            basePrice: serviceData.price,
            durationMin: parseInt(serviceData.duration.split(':')[0]) * 60 + parseInt(serviceData.duration.split(':')[1]),
            isActive: true
          }
        });
        console.log(`  Updated service ID: ${service.id}`);
      } else {
        service = await prisma.service.create({
          data: {
            name: serviceData.serviceName,
            basePrice: serviceData.price,
            durationMin: parseInt(serviceData.duration.split(':')[0]) * 60 + parseInt(serviceData.duration.split(':')[1]),
            ticketTier: 'medium',
            tenantId,
            isActive: true
          }
        });
        console.log(`  Created service ID: ${service.id}`);
      }

      // Create/update products for this service
      for (const productData of serviceData.products) {
        console.log(`    Adding product: ${productData.name}`);

        const sku = productData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');

        // Check if product exists
        let product = await prisma.product.findFirst({
          where: {
            sku,
            tenantId
          }
        });

        if (product) {
          product = await prisma.product.update({
            where: { id: product.id },
            data: {
              price: productData.price,
              unit: productData.unit,
              isActive: true
            }
          });
        } else {
          product = await prisma.product.create({
            data: {
              name: productData.name,
              sku,
              price: productData.price,
              unit: productData.unit,
              tenantId,
              isActive: true
            }
          });
        }

        console.log(`      Product ID: ${product.id}, Unit: ${productData.unit}, Qty per service: ${productData.quantity}`);
      }
      console.log('');
    }

    console.log('✅ Import completed successfully!');

  } catch (error) {
    console.error('❌ Error during import:', error.message);
    if (error.meta) console.error('Details:', error.meta);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
