#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Starting patient import from customer data...\n');

    // Get the wellness tenant - specifically looking for vertical='wellness'
    let tenant = await prisma.tenant.findFirst({
      where: { vertical: 'wellness' }
    });

    if (!tenant) {
      console.log('No wellness tenant found! Checking all tenants...');
      const allTenants = await prisma.tenant.findMany({});
      console.log('Available tenants:', allTenants.map(t => ({ id: t.id, name: t.name, vertical: t.vertical })));
      process.exit(1);
    }

    const tenantId = tenant.id;
    console.log(`Using Wellness Tenant: ${tenant.name} (ID: ${tenantId})\n`);

    // Read the TSV file
    const filePath = path.join(__dirname, '../customer.txt');
    if (!fs.existsSync(filePath)) {
      console.log(`Customer file not found at ${filePath}`);
      process.exit(1);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    // Parse header
    const header = lines[0].split('\t');
    const idIndex = header.indexOf('id');
    const nameIndex = header.indexOf('name');
    const emailIndex = header.indexOf('email');
    const phoneIndex = header.indexOf('phone_number');
    const birthDateIndex = header.indexOf('birth_date');
    const genderIndex = header.indexOf('gender');
    const notesIndex = header.indexOf('notes');

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    // Process each row
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      try {
        const values = lines[i].split('\t');

        const email = (values[emailIndex] || '').trim();
        const phone = (values[phoneIndex] || '').trim();

        // Check for duplicates - skip if patient with same email or phone already exists
        if (email || phone) {
          const existingPatient = await prisma.patient.findFirst({
            where: {
              tenantId: tenantId,
              OR: [
                email ? { email: email } : undefined,
                phone ? { phone: phone } : undefined
              ].filter(Boolean)
            }
          });

          if (existingPatient) {
            skippedCount++;
            if (skippedCount <= 5) {
              console.log(`  ⊘ Row ${i + 1} skipped (duplicate: ${email || phone})`);
            }
            continue;
          }
        }

        const patientData = {
          name: (values[nameIndex] || `Customer ${values[idIndex] || i}`).trim(),
          tenantId: tenantId
        };

        // Add optional fields
        if (email) patientData.email = email;
        if (phone) patientData.phone = phone;

        const birthDate = (values[birthDateIndex] || '').trim();
        if (birthDate && birthDate !== '') {
          try {
            const date = new Date(birthDate);
            if (!isNaN(date.getTime())) {
              patientData.dob = date;
            }
          } catch (e) {
            // Ignore invalid dates
          }
        }

        const gender = (values[genderIndex] || '').trim();
        if (gender) patientData.gender = gender;

        const notes = (values[notesIndex] || '').trim();
        if (notes) patientData.notes = notes;

        const patient = await prisma.patient.create({
          data: patientData
        });

        successCount++;
        if (successCount % 50 === 0) {
          console.log(`  ✅ Imported ${successCount} patients...`);
        }
      } catch (error) {
        errorCount++;
        if (errorCount <= 5) {
          console.log(`  ⚠️  Row ${i + 1} error: ${error.message.substring(0, 80)}`);
        }
      }
    }

    console.log(`\n✅ Patient import completed!`);
    console.log(`   Successfully imported: ${successCount} patients`);
    if (skippedCount > 0) {
      console.log(`   Skipped (duplicates): ${skippedCount} patients`);
    }
    if (errorCount > 0) {
      console.log(`   Errors: ${errorCount} rows`);
    }

    // Verify import
    const totalPatients = await prisma.patient.count({
      where: { tenantId }
    });
    console.log(`\n✅ Total patients in Wellness tenant: ${totalPatients}`);

  } catch (error) {
    console.error('❌ Error during import:', error.message);
    if (error.meta) console.error('Meta:', error.meta);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
