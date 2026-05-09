import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const passwordHash = await bcrypt.hash('admin123', 10);
  
  const user = await prisma.user.upsert({
    where: { username: 'admin' },
    update: {
      passwordHash // Update password in case it already exists
    },
    create: {
      username: 'admin',
      passwordHash,
      role: 'SUPER_ADMIN',
      firstName: 'Super',
      lastName: 'Admin',
    },
  });
  console.log('Super Admin user seeded successfully:');
  console.log(`Username: ${user.username}`);
  console.log(`Role: ${user.role}`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
