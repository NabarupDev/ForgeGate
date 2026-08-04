import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding initial multi-tenant data for ForgeGate...');

  // Seed default tenants
  const defaultTenant = await prisma.tenant.upsert({
    where: { slug: 'acme-corp' },
    update: {},
    create: {
      name: 'Acme Corp',
      slug: 'acme-corp',
    },
  });

  const secondaryTenant = await prisma.tenant.upsert({
    where: { slug: 'initech' },
    update: {},
    create: {
      name: 'Initech',
      slug: 'initech',
    },
  });

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
  const userRole = await prisma.role.findUnique({ where: { name: 'user' } });

  // Seed default admin user for Acme Corp
  const adminEmail = 'admin@acme.com';
  let adminUser = await prisma.user.findUnique({ where: { email: adminEmail } });

  if (!adminUser && adminRole) {
    const passwordHash = await argon2.hash('AdminSecret123!');
    adminUser = await prisma.user.create({
      data: {
        email: adminEmail,
        name: 'Acme Admin',
        passwordHash,
        roleId: adminRole.id,
        tenantId: defaultTenant.id,
      },
    });
    console.log(`Created default admin user: ${adminEmail} / AdminSecret123!`);
  }

  // Seed secondary tenant user
  const userEmail = 'peter@initech.com';
  let userInitech = await prisma.user.findUnique({ where: { email: userEmail } });
  if (!userInitech && userRole) {
    const passwordHash = await argon2.hash('UserSecret123!');
    userInitech = await prisma.user.create({
      data: {
        email: userEmail,
        name: 'Peter Gibbons',
        passwordHash,
        roleId: userRole.id,
        tenantId: secondaryTenant.id,
      },
    });
    console.log(`Created Initech user: ${userEmail} / UserSecret123!`);
  }

  // Seed Sample Workflows
  if (adminUser) {
    const existingWf = await prisma.workflow.findFirst({
      where: { tenantId: defaultTenant.id, name: 'Customer Onboarding Workflow' },
    });

    if (!existingWf) {
      await prisma.workflow.create({
        data: {
          tenantId: defaultTenant.id,
          name: 'Customer Onboarding Workflow',
          description: 'Automated onboarding pipeline for new enterprise users',
          triggerType: 'webhook',
          createdById: adminUser.id,
          steps: {
            create: [
              {
                stepOrder: 1,
                actionType: 'http_request',
                config: { url: 'https://httpbin.org/post', method: 'POST', body: { event: 'user_created' } },
                retryLimit: 3,
              },
              {
                stepOrder: 2,
                actionType: 'data_transform',
                config: { mapping: { userId: 'data.id', status: 'ACTIVE' } },
                retryLimit: 2,
              },
              {
                stepOrder: 3,
                actionType: 'email_notification',
                config: { recipient: 'welcome@acme.com', subject: 'Welcome to ForgeGate' },
                retryLimit: 3,
              },
            ],
          },
        },
      });
      console.log('Created sample Customer Onboarding Workflow for Acme Corp');
    }
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
