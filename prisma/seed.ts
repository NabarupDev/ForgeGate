import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial data for ForgeGate...');

  // Seed default roles
  const roles = [
    { name: 'admin', description: 'System Administrator with full access' },
    { name: 'moderator', description: 'Moderator with manage permissions' },
    { name: 'user', description: 'Standard registered user' },
  ];

  for (const r of roles) {
    await prisma.role.upsert({
      where: { name: r.name },
      update: {},
      create: r,
    });
  }

  const adminRole = await prisma.role.findUnique({ where: { name: 'admin' } });

  // Seed default admin user
  const adminEmail = 'admin@forgegate.local';
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!existingAdmin && adminRole) {
    const passwordHash = await argon2.hash('AdminSecret123!');
    await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'System Admin',
        passwordHash,
        roleId: adminRole.id,
      },
    });
    console.log(`Created default admin user: ${adminEmail} / AdminSecret123!`);
  }

  // Seed plans
  const plans = [
    { name: 'Free', price: 0, features: { maxRequests: 1000, support: 'community' } },
    { name: 'Pro', price: 29.99, features: { maxRequests: 100000, support: 'priority' } },
    { name: 'Enterprise', price: 299.99, features: { maxRequests: 1000000, support: '24/7 dedicated' } },
  ];

  for (const p of plans) {
    await prisma.plan.upsert({
      where: { name: p.name },
      update: {},
      create: p,
    });
  }

  console.log('Database seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
