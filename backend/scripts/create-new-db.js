/**
 * Script to create a new database and add a user
 * Run: node scripts/create-new-db.js
 */

const path = require('path');
const dotenv = require('dotenv');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');

// Load .env file
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const DB_NAME = 'crm_new';
const DB_HOST = 'localhost';
const DB_PORT = 3307;
const DB_USER = 'root';
const DB_PASSWORD = 'Mohit@39874';

async function main() {
  console.log('=== Creating New Database and Adding User ===\n');

  try {
    // Step 1: Create the database
    console.log('Step 1: Creating new database...');
    const connection = await mysql.createConnection({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASSWORD,
    });

    await connection.query(`CREATE DATABASE IF NOT EXISTS ${DB_NAME}`);
    console.log(`✓ Database '${DB_NAME}' created successfully\n`);
    await connection.end();

    // Step 2: Update DATABASE_URL to point to new database
    console.log('Step 2: Updating database configuration...');
    const newDatabaseUrl = `mysql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
    process.env.DATABASE_URL = newDatabaseUrl;
    console.log(`✓ DATABASE_URL updated to: ${newDatabaseUrl}\n`);

    // Step 3: Initialize Prisma with the new database
    console.log('Step 3: Pushing Prisma schema to new database...');
    const prisma = new PrismaClient();

    // Run prisma db push
    const { execSync } = require('child_process');
    execSync('npx prisma db push --skip-generate', {
      cwd: __dirname + '/..',
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: newDatabaseUrl }
    });
    console.log('✓ Prisma schema synced to new database\n');

    // Step 4: Create tenant
    console.log('Step 4: Creating default tenant...');
    await prisma.tenant.create({
      data: {
        id: 1,
        name: 'Test Organization',
        slug: 'test-org',
        plan: 'enterprise',
        ownerEmail: 'ganeshsharmayoyo@gmail.com',
        isActive: true,
      },
    });
    console.log('✓ Default tenant created\n');

    // Step 5: Create the new user
    console.log('Step 5: Creating user...');
    const email = 'ganeshsharmayoyo@gmail.com';
    const password = 'Enhance@123';
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email: email,
        password: hashedPassword,
        name: 'Ganesh Sharma',
        role: 'ADMIN',
        userType: 'STAFF',
      },
    });

    console.log(`✓ User created successfully`);
    console.log(`  Email: ${email}`);
    console.log(`  Password: ${password}`);
    console.log(`  Role: ADMIN\n`);

    await prisma.$disconnect();

    console.log('=== Setup Complete ===');
    console.log(`New database: ${DB_NAME}`);
    console.log(`Connection string: ${newDatabaseUrl}`);
    console.log('\nTo use this database, update your .env file:');
    console.log(`DATABASE_URL=mysql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}`);

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
