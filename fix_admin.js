const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function fix() {
  const hashedPassword = await bcrypt.hash('password123', 10);
  
  const user = await prisma.user.upsert({
    where: { email: 'admin@globussoft.com' },
    update: { password: hashedPassword, role: 'ADMIN' },
    create: { email: 'admin@globussoft.com', password: hashedPassword, name: 'System Administrator', role: 'ADMIN' }
  });
  
  console.log("Admin user successfully secured with robust bcrypt hash:", user.email);
}

fix().catch(console.error).finally(() => prisma.$disconnect());
