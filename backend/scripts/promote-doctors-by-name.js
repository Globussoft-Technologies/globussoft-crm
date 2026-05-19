#!/usr/bin/env node
/**
 * Promote staff with "Dr" in name to doctor wellnessRole
 *
 * This fixes the issue where imported doctors have wellnessRole='staff'
 * instead of 'doctor', so they don't appear on the calendar.
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function promoteDoctor() {
  try {
    console.log('\n' + '='.repeat(70));
    console.log('  PROMOTE DOCTORS BY NAME');
    console.log('='.repeat(70) + '\n');

    const tenantId = 2;

    // Find staff with "Dr" in name
    console.log('🔍 Searching for staff with "Dr" in name...\n');

    const allStaff = await prisma.user.findMany({
      where: { tenantId },
      select: { id: true, name: true, wellnessRole: true }
    });

    const doctorCandidates = allStaff.filter(s =>
      (s.name || '').toLowerCase().includes('dr ')
    );

    console.log(`   Found ${doctorCandidates.length} staff with "Dr" in name:\n`);

    for (const s of doctorCandidates) {
      console.log(`   - ${s.name} (current role: ${s.wellnessRole})`);
    }
    console.log();

    if (doctorCandidates.length === 0) {
      console.log('   ℹ️  No doctors found with "Dr" prefix\n');
      await prisma.$disconnect();
      return;
    }

    // Promote them to doctors
    console.log('🔧 Promoting to doctor role...\n');

    const doctorIds = doctorCandidates.map(d => d.id);
    const result = await prisma.user.updateMany({
      where: { id: { in: doctorIds } },
      data: { wellnessRole: 'doctor' }
    });

    console.log(`   ✅ Promoted ${result.count} staff to 'doctor' role\n`);

    // Verify
    const updated = await prisma.user.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, name: true, wellnessRole: true }
    });

    console.log('✅ Verification:\n');
    for (const s of updated) {
      console.log(`   - ${s.name}: ${s.wellnessRole}`);
    }
    console.log();

    // Count total doctors now
    const totalDoctors = await prisma.user.count({
      where: { tenantId, wellnessRole: 'doctor' }
    });

    console.log('='.repeat(70));
    console.log('  ✅ DOCTORS PROMOTED');
    console.log('='.repeat(70));

    console.log(`\n✅ Total doctors now: ${totalDoctors}`);
    console.log(`\n🚀 Next Steps:`);
    console.log(`   1. Add working hours for each doctor`);
    console.log(`      → Go to: Working Hours (in sidebar)`);
    console.log(`      → Click: Add Working Hours`);
    console.log(`      → Select doctor name`);
    console.log(`      → Set schedule: Mon-Fri 09:00-18:00`);
    console.log(`   2. Refresh the Calendar page`);
    console.log(`   3. All ${totalDoctors} doctors will appear!\n`);

    console.log(`⚡ Shortcut: Auto-create default working hours`);
    console.log(`   Run: node scripts/create-default-working-hours.js\n`);

  } catch (error) {
    console.error('\n❌ Failed:', error.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

promoteDoctor();
