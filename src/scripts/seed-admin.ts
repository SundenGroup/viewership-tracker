/**
 * Seed script: creates the initial admin user.
 *
 * Usage:
 *   npx tsx src/scripts/seed-admin.ts <email> <password> [displayName]
 *
 * Example:
 *   npx tsx src/scripts/seed-admin.ts admin@clutch.game mypassword "Admin User"
 */

import db from '../utils/db';
import * as UserModel from '../models/user';

async function seedAdmin() {
  const email = process.argv[2];
  const password = process.argv[3];
  const displayName = process.argv[4] || 'Admin';

  if (!email || !password) {
    console.error('Usage: npx tsx src/scripts/seed-admin.ts <email> <password> [displayName]');
    process.exit(1);
  }

  // Run pending migrations
  console.log('Running migrations...');
  await db.migrate.latest();
  console.log('Migrations complete.');

  // Check if user already exists
  const existing = await UserModel.findByEmail(email);
  if (existing) {
    console.log(`User with email "${email}" already exists (role: ${existing.role}).`);
    await db.destroy();
    process.exit(0);
  }

  const user = await UserModel.create({
    email,
    password,
    display_name: displayName,
    role: 'admin',
  });

  console.log('');
  console.log('Admin user created:');
  console.log(`  ID:    ${user.id}`);
  console.log(`  Email: ${user.email}`);
  console.log(`  Name:  ${user.display_name}`);
  console.log(`  Role:  admin`);
  console.log('');
  console.log('Change the password after first login.');

  await db.destroy();
}

seedAdmin().catch((err) => {
  console.error('Failed to seed admin:', err);
  process.exit(1);
});
