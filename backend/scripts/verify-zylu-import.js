#!/usr/bin/env node
/**
 * Verification script for Zylu POS data import
 * Checks that data was imported correctly and displays summary
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    const TENANT_ID = parseInt(process.argv[2]) || 1;

    console.log(`\n📊 Zylu Import Verification Report (Tenant ID: ${TENANT_ID})\n`);

    // Count imported data
    const categories = await prisma.serviceCategory.findMany({
      where: { tenantId: TENANT_ID }
    });

    const services = await prisma.service.findMany({
      where: { tenantId: TENANT_ID },
      include: { serviceCategory: true }
    });

    const patients = await prisma.patient.findMany({
      where: { tenantId: TENANT_ID }
    });

    const visits = await prisma.visit.findMany({
      where: { tenantId: TENANT_ID },
      include: { patient: true, service: true }
    });

    console.log(`✅ Categories: ${categories.length}`);
    console.log(`✅ Services: ${services.length}`);
    console.log(`✅ Patients: ${patients.length}`);
    console.log(`✅ Visits/Bookings: ${visits.length}`);

    // Show category hierarchy
    console.log(`\n📁 Category Hierarchy:`);
    const rootCategories = categories.filter(c => !c.parentId);
    for (const root of rootCategories) {
      console.log(`  └─ ${root.name} (id: ${root.id})`);
      const children = categories.filter(c => c.parentId === root.id);
      for (const child of children) {
        console.log(`     └─ ${child.name} (id: ${child.id})`);
      }
    }

    // Show service pricing summary
    console.log(`\n💰 Service Pricing Summary:`);
    const byCategory = {};
    for (const service of services) {
      const catName = service.serviceCategory?.name || 'Uncategorized';
      if (!byCategory[catName]) byCategory[catName] = [];
      byCategory[catName].push(service);
    }

    for (const [catName, catServices] of Object.entries(byCategory)) {
      console.log(`  ${catName}:`);
      for (const svc of catServices) {
        const discountStr = svc.discountedPrice ? ` → ${svc.discountedPrice}` : '';
        console.log(`    • ${svc.name}: ₹${svc.basePrice}${discountStr} (${svc.durationMin} min)`);
      }
    }

    // Show patient booking summary
    console.log(`\n👥 Patient Booking Summary:`);
    const visitsByPatient = {};
    for (const visit of visits) {
      if (!visitsByPatient[visit.patientId]) {
        visitsByPatient[visit.patientId] = { patient: visit.patient, visits: [] };
      }
      visitsByPatient[visit.patientId].visits.push(visit);
    }

    for (const [patientId, data] of Object.entries(visitsByPatient)) {
      const { patient, visits: patientVisits } = data;
      console.log(`  ${patient.name} (${patient.phone}):`);
      for (const visit of patientVisits) {
        const status = visit.status.toUpperCase();
        const serviceName = visit.service?.name || 'Unknown';
        const amount = visit.amountCharged ? ` - ₹${visit.amountCharged}` : '';
        console.log(`    • ${serviceName} (${status})${amount}`);
      }
    }

    // Show new fields that were imported
    console.log(`\n🆕 New Zylu Fields in Services:`);
    const sampleService = services[0];
    if (sampleService) {
      console.log(`  Sample Service: "${sampleService.name}"`);
      console.log(`  • gender: ${sampleService.gender || 'N/A'}`);
      console.log(`  • code: ${sampleService.code || 'N/A'}`);
      console.log(`  • isStartingPrice: ${sampleService.isStartingPrice}`);
      console.log(`  • isHomeService: ${sampleService.isHomeService}`);
      console.log(`  • hidePriceFromCustomer: ${sampleService.hidePriceFromCustomer}`);
      console.log(`  • tax: ${sampleService.tax || 'N/A'}%`);
      console.log(`  • isTaxIncluded: ${sampleService.isTaxIncluded}`);
      console.log(`  • displayOrder: ${sampleService.displayOrder}`);
      console.log(`  • imageUrls: ${sampleService.imageUrls || 'N/A'}`);
    }

    console.log(`\n✨ Verification Complete!\n`);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
