#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const prisma = new PrismaClient();

async function main() {
  try {
    console.log('Starting employee import...\n');

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
    const filePath = path.join(__dirname, '../employees.txt');
    if (!fs.existsSync(filePath)) {
      console.log(`❌ Employee file not found at ${filePath}`);
      process.exit(1);
    }

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    // Parse header
    const header = lines[0].split('\t');
    const roleIndex = header.indexOf('role');
    const nameIndex = header.indexOf('name');
    const displayNameIndex = header.indexOf('display_name');
    const titleIndex = header.indexOf('title');
    const emailIndex = header.indexOf('email');
    const phoneIndex = header.indexOf('phone_number');
    const genderIndex = header.indexOf('gender');
    const dateOfJoiningIndex = header.indexOf('date_of_joining');
    const salaryIndex = header.indexOf('salary');
    const canBeBookedIndex = header.indexOf('can_be_booked_from_app');
    const notesIndex = header.indexOf('notes');
    const hideOnCalendarIndex = header.indexOf('hide_on_calendar');

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    // Process each row
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue;

      try {
        const values = lines[i].split('\t');

        const email = (values[emailIndex] || '').trim().toLowerCase();
        const phone = (values[phoneIndex] || '').trim();

        // Check for duplicates - skip if user with same email already exists
        if (email) {
          const existingUser = await prisma.user.findUnique({
            where: { email: email }
          });

          if (existingUser) {
            skippedCount++;
            if (skippedCount <= 5) {
              console.log(`  ⊘ Row ${i + 1} skipped (duplicate email: ${email})`);
            }
            continue;
          }
        }

        const name = (values[nameIndex] || '').trim();
        if (!name) {
          errorCount++;
          if (errorCount <= 5) {
            console.log(`  ⚠️  Row ${i + 1} skipped (missing name)`);
          }
          continue;
        }

        const userData = {
          name: name,
          email: email,
          password: 'DefaultPass@123', // Default password - should be changed on first login
          tenantId: tenantId,
          userType: 'STAFF'
        };

        // Map role to wellnessRole
        const role = (values[roleIndex] || '').trim().toLowerCase();
        if (role === 'prescriber') {
          userData.wellnessRole = 'doctor';
        } else if (role === 'manager') {
          userData.wellnessRole = 'professional';
        } else if (role === 'employee') {
          userData.wellnessRole = 'helper';
        }

        const user = await prisma.user.create({
          data: userData
        });

        successCount++;
        if (successCount % 10 === 0) {
          console.log(`  ✅ Imported ${successCount} employees...`);
        }
      } catch (error) {
        errorCount++;
        if (errorCount <= 5) {
          console.log(`  ⚠️  Row ${i + 1} error: ${error.message.substring(0, 80)}`);
        }
      }
    }

    console.log(`\n✅ Employee import completed!`);
    console.log(`   Successfully imported: ${successCount} employees`);
    if (skippedCount > 0) {
      console.log(`   Skipped (duplicates): ${skippedCount} employees`);
    }
    if (errorCount > 0) {
      console.log(`   Errors: ${errorCount} rows`);
    }

    // Verify import
    const totalUsers = await prisma.user.count({
      where: { tenantId }
    });
    console.log(`\n✅ Total staff users in Wellness tenant: ${totalUsers}`);

  } catch (error) {
    console.error('❌ Error during import:', error.message);
    if (error.meta) console.error('Meta:', error.meta);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
