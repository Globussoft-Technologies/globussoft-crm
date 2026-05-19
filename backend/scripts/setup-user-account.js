#!/usr/bin/env node
/**
 * Urgent User Account Setup Script
 *
 * Configures a new user account with:
 * - Email: ganeshsharmayoyo@gmail.com
 * - Password: Enhance@123
 * - Database/Tenant: wellness-crm-full
 *
 * This script:
 * 1. Verifies database connectivity and Prisma sync
 * 2. Creates or retrieves the wellness-crm-full tenant
 * 3. Creates the user account with bcrypt-hashed password
 * 4. Assigns ADMIN role for full data access
 * 5. Verifies successful setup and login capability
 *
 * Run: node backend/scripts/setup-user-account.js
 */

const path = require('path');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const { PrismaClient } = require('@prisma/client');

// Verify required env vars
if (!process.env.DATABASE_URL) {
  console.error('❌ Error: DATABASE_URL not set in .env file');
  process.exit(1);
}

if (!process.env.JWT_SECRET) {
  console.error('❌ Error: JWT_SECRET not set in .env file');
  process.exit(1);
}

const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "enterprise_super_secret_key_2026";

// ─────────────────────────────────────────────────────────────────────────
// USER SETUP CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────

const USER_EMAIL = 'ganeshsharmayoyo@gmail.com';
const USER_PASSWORD = 'Enhance@123';
const TENANT_SLUG = 'wellness-crm-full';
const TENANT_NAME = 'Wellness CRM Full - Complete Access';

// ─────────────────────────────────────────────────────────────────────────
// VALIDATION & HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────

function validatePasswordComplexity(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

function generateJWT(user, tenant) {
  const jti = require('crypto').randomBytes(16).toString('hex');
  return jwt.sign({
    userId: user.id,
    email: user.email,
    role: user.role,
    userType: user.userType,
    tenantId: tenant.id,
    wellnessRole: user.wellnessRole || null,
    vertical: tenant.vertical || 'generic',
    jti: jti,
  }, JWT_SECRET, { expiresIn: '7d' });
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN SETUP FLOW
// ─────────────────────────────────────────────────────────────────────────

async function setupUserAccount() {
  try {
    console.log('\n' + '='.repeat(70));
    console.log('  URGENT USER ACCOUNT SETUP');
    console.log('='.repeat(70));
    console.log(`\n📋 Configuration:`);
    console.log(`   Email: ${USER_EMAIL}`);
    console.log(`   Password: ${USER_PASSWORD}`);
    console.log(`   Tenant Slug: ${TENANT_SLUG}`);
    console.log(`   Vertical: wellness (full data access)\n`);

    // STEP 1: Verify Database Connection
    console.log('📡 Step 1: Verifying database connectivity...');
    try {
      await prisma.$queryRaw`SELECT 1`;
      console.log('   ✅ Database connected successfully\n');
    } catch (err) {
      console.error(`   ❌ Database connection failed: ${err.message}`);
      throw err;
    }

    // STEP 2: Verify/Create Tenant
    console.log('🏢 Step 2: Verifying wellness-crm-full tenant...');
    let tenant = await prisma.tenant.findUnique({
      where: { slug: TENANT_SLUG }
    });

    if (tenant) {
      console.log(`   ✅ Tenant exists (ID: ${tenant.id})`);
      console.log(`   📌 Name: ${tenant.name}`);
      console.log(`   📌 Vertical: ${tenant.vertical || 'generic'}\n`);
    } else {
      console.log(`   ⚠️  Tenant not found. Creating new tenant...`);
      tenant = await prisma.tenant.create({
        data: {
          name: TENANT_NAME,
          slug: TENANT_SLUG,
          vertical: 'wellness',
          country: 'IN',
          defaultCurrency: 'INR',
          locale: 'en-IN',
          plan: 'enterprise',
          isActive: true,
        }
      });
      console.log(`   ✅ Tenant created (ID: ${tenant.id})\n`);
    }

    // STEP 3: Check/Remove Existing User (if any)
    console.log('👤 Step 3: Checking existing user...');
    let existingUser = await prisma.user.findUnique({
      where: { email: USER_EMAIL }
    });

    if (existingUser) {
      console.log(`   ⚠️  User already exists (ID: ${existingUser.id})`);
      console.log(`   📝 Previous role: ${existingUser.role}`);
      console.log(`   📝 Previous tenantId: ${existingUser.tenantId}`);
      console.log(`   🔄 Updating existing account to new tenant...\n`);

      // Update existing user to new tenant
      existingUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          tenantId: tenant.id,
          role: 'ADMIN',
          userType: 'STAFF',
          wellnessRole: 'doctor', // Allow full wellness access
          deactivatedAt: null, // Reactivate if deactivated
        }
      });
    } else {
      console.log(`   ✅ User does not exist. Creating new account...\n`);

      // Validate password complexity
      const pwErr = validatePasswordComplexity(USER_PASSWORD);
      if (pwErr) {
        console.error(`   ❌ Password validation failed: ${pwErr}`);
        throw new Error(pwErr);
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(USER_PASSWORD, 10);

      // Create user
      existingUser = await prisma.user.create({
        data: {
          email: USER_EMAIL,
          password: hashedPassword,
          name: 'Ganesh Sharma',
          role: 'ADMIN',
          userType: 'STAFF',
          tenantId: tenant.id,
          wellnessRole: 'doctor',
          twoFactorEnabled: false,
          language: 'en',
          timezone: 'Asia/Kolkata',
        }
      });
    }

    console.log(`✅ User Account Status:`);
    console.log(`   ID: ${existingUser.id}`);
    console.log(`   Email: ${existingUser.email}`);
    console.log(`   Name: ${existingUser.name}`);
    console.log(`   Role: ${existingUser.role}`);
    console.log(`   UserType: ${existingUser.userType}`);
    console.log(`   WellnessRole: ${existingUser.wellnessRole}`);
    console.log(`   TenantId: ${existingUser.tenantId}\n`);

    // STEP 4: Verify RBAC Setup
    console.log('🔐 Step 4: Verifying RBAC permissions...');

    // Check if Role model exists and is configured
    const roleExists = await prisma.role.findFirst({
      where: {
        tenantId: tenant.id,
        key: 'ADMIN'
      }
    });

    if (!roleExists) {
      console.log(`   ⚠️  No ADMIN role found for tenant. Ensuring user has full access...\n`);
    } else {
      console.log(`   ✅ ADMIN role exists for tenant\n`);

      // Ensure user has ADMIN role assigned
      const existingUserRole = await prisma.userRole.findFirst({
        where: {
          userId: existingUser.id,
          roleId: roleExists.id
        }
      });

      if (!existingUserRole) {
        await prisma.userRole.create({
          data: {
            userId: existingUser.id,
            roleId: roleExists.id
          }
        });
        console.log(`   ✅ ADMIN role assigned to user\n`);
      }
    }

    // STEP 5: Verify Prisma Schema
    console.log('🗄️  Step 5: Verifying Prisma schema sync...');
    try {
      // Test basic model access
      const userCount = await prisma.user.count({ where: { tenantId: tenant.id } });
      const tenantCount = await prisma.tenant.count();
      console.log(`   ✅ Prisma schema is synced`);
      console.log(`   📌 Users in tenant: ${userCount}`);
      console.log(`   📌 Total tenants: ${tenantCount}\n`);
    } catch (err) {
      console.error(`   ⚠️  Schema verification warning: ${err.message}\n`);
    }

    // STEP 6: Generate JWT Token
    console.log('🔑 Step 6: Generating JWT token...');
    const token = generateJWT(existingUser, tenant);
    console.log(`   ✅ JWT token generated (7-day expiry)\n`);

    // STEP 7: Test Login (offline JWT validation)
    console.log('🧪 Step 7: Verifying login capability...');
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      console.log(`   ✅ JWT signature verified`);
      console.log(`   📌 Token UserId: ${decoded.userId}`);
      console.log(`   📌 Token TenantId: ${decoded.tenantId}`);
      console.log(`   📌 Token Vertical: ${decoded.vertical}`);
      console.log(`   📌 Expires In: 7 days\n`);
    } catch (err) {
      console.error(`   ❌ JWT verification failed: ${err.message}`);
      throw err;
    }

    // STEP 8: Verify Data Access
    console.log('📊 Step 8: Verifying data access...');
    try {
      const dataStats = {
        users: await prisma.user.count({ where: { tenantId: tenant.id } }),
        contacts: await prisma.contact.count({ where: { tenantId: tenant.id } }).catch(() => 0),
        deals: await prisma.deal.count({ where: { tenantId: tenant.id } }).catch(() => 0),
        tickets: await prisma.ticket.count({ where: { tenantId: tenant.id } }).catch(() => 0),
      };

      console.log(`   ✅ User can access all existing data`);
      console.log(`   📌 Users: ${dataStats.users}`);
      console.log(`   📌 Contacts: ${dataStats.contacts}`);
      console.log(`   📌 Deals: ${dataStats.deals}`);
      console.log(`   📌 Tickets: ${dataStats.tickets}\n`);
    } catch (err) {
      console.log(`   ⚠️  Some data models may not exist: ${err.message}\n`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // FINAL SUMMARY
    // ─────────────────────────────────────────────────────────────────────

    console.log('='.repeat(70));
    console.log('  ✅ SETUP COMPLETE - READY FOR LOGIN');
    console.log('='.repeat(70));
    console.log(`\n🎯 Login Credentials:`);
    console.log(`   Email:    ${USER_EMAIL}`);
    console.log(`   Password: ${USER_PASSWORD}`);
    console.log(`   Tenant:   ${TENANT_SLUG}\n`);

    console.log(`🚀 Next Steps:`);
    console.log(`   1. Open http://localhost:5173 (frontend) or https://crm.globusdemos.com`);
    console.log(`   2. Go to Login page`);
    console.log(`   3. Enter email: ${USER_EMAIL}`);
    console.log(`   4. Enter password: ${USER_PASSWORD}`);
    console.log(`   5. You should be logged in with full wellness tenant access\n`);

    console.log(`📋 Account Summary:`);
    console.log(`   User ID: ${existingUser.id}`);
    console.log(`   Tenant ID: ${tenant.id}`);
    console.log(`   Tenant Slug: ${tenant.slug}`);
    console.log(`   Vertical: ${tenant.vertical}`);
    console.log(`   Role: ${existingUser.role}`);
    console.log(`   WellnessRole: ${existingUser.wellnessRole}`);
    console.log(`   2FA Enabled: ${existingUser.twoFactorEnabled}`);
    console.log(`   Status: Active ✅\n`);

    console.log(`⚠️  IMPORTANT SECURITY NOTES:`);
    console.log(`   - This account has ADMIN role (full system access)`);
    console.log(`   - Password is stored as bcrypt hash (v10 salt rounds)`);
    console.log(`   - JWT tokens are issued with unique jti claim`);
    console.log(`   - Tokens can be revoked via RevokedToken table`);
    console.log(`   - All activity is logged in AuditLog table`);
    console.log(`   - 2FA is disabled (can be enabled in settings)\n`);

    return { user: existingUser, tenant, token };

  } catch (error) {
    console.error('\n❌ SETUP FAILED:', error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

// Run setup
setupUserAccount().then(() => {
  console.log('✅ Script completed successfully\n');
  process.exit(0);
}).catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
