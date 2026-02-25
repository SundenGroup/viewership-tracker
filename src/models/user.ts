import db from '../utils/db';
import bcrypt from 'bcrypt';
import { config } from '../utils/config';

// ── Types ──────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Safe user — never exposes password_hash */
export type SafeUser = Omit<User, 'password_hash'>;

export interface CreateUser {
  email: string;
  password: string;
  display_name: string;
  role?: UserRole;
}

export interface UpdateUser {
  email?: string;
  display_name?: string;
  role?: UserRole;
  is_active?: boolean;
  password?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const TABLE = 'users';

function toSafe(user: User): SafeUser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { password_hash, ...safe } = user;
  return safe;
}

// ── CRUD ───────────────────────────────────────────────────────────────────

export async function create(data: CreateUser): Promise<SafeUser> {
  const password_hash = await bcrypt.hash(data.password, config.auth.bcryptRounds);
  const [row] = await db(TABLE)
    .insert({
      email: data.email.toLowerCase().trim(),
      password_hash,
      display_name: data.display_name,
      role: data.role ?? 'viewer',
    })
    .returning('*');
  return toSafe(row);
}

export async function findById(id: string): Promise<SafeUser | null> {
  const row = await db(TABLE).where({ id }).first();
  return row ? toSafe(row) : null;
}

/** Returns FULL user (with password_hash) — use only for login verification. */
export async function findByEmail(email: string): Promise<User | null> {
  const row = await db(TABLE).where({ email: email.toLowerCase().trim() }).first();
  return row ?? null;
}

export async function findAll(): Promise<SafeUser[]> {
  const rows = await db(TABLE).orderBy('created_at', 'desc');
  return rows.map(toSafe);
}

export async function update(id: string, data: UpdateUser): Promise<SafeUser> {
  const updateData: Record<string, unknown> = { updated_at: db.fn.now() };
  if (data.email !== undefined) updateData.email = data.email.toLowerCase().trim();
  if (data.display_name !== undefined) updateData.display_name = data.display_name;
  if (data.role !== undefined) updateData.role = data.role;
  if (data.is_active !== undefined) updateData.is_active = data.is_active;
  if (data.password) {
    updateData.password_hash = await bcrypt.hash(data.password, config.auth.bcryptRounds);
  }
  const [row] = await db(TABLE).where({ id }).update(updateData).returning('*');
  return toSafe(row);
}

export async function remove(id: string): Promise<boolean> {
  const count = await db(TABLE).where({ id }).delete();
  return count > 0;
}

// ── Auth helpers ───────────────────────────────────────────────────────────

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.password_hash);
}

export async function updateLastLogin(id: string): Promise<void> {
  await db(TABLE).where({ id }).update({ last_login_at: db.fn.now() });
}

export async function countAdmins(): Promise<number> {
  const [{ count }] = await db(TABLE)
    .where({ role: 'admin', is_active: true })
    .count('* as count');
  return parseInt(count as string, 10);
}
