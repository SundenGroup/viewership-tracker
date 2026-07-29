import { useState, useCallback } from 'react';
import { Button, Modal, FormField, Select, TextInput } from '@/components/common';
import { SettingsShell } from '@/components/design';
import { useApi } from '@/hooks/useApi';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import type { AuthUser, UserRole } from '@/types/api';
import { formatTimeAgo } from '@/utils/formatters';

// ── Constants ────────────────────────────────────────────────────────────

const ROLE_OPTIONS = [
  { value: 'viewer', label: 'Viewer' },
  { value: 'editor', label: 'Editor' },
  { value: 'admin', label: 'Admin' },
];

const ROLE_COLORS: Record<string, string> = {
  admin: 'bg-clutch-red/20 text-clutch-red',
  editor: 'bg-amber-500/20 text-amber-400',
  viewer: 'bg-sky-500/20 text-sky-400',
};

// ── Component ────────────────────────────────────────────────────────────

export function UserManagementPage() {
  const { user: currentUser } = useAuth();
  const { data: users, loading, error, refetch } = useApi<AuthUser[]>(
    () => api.listUsers(),
    [],
  );

  // ── Create modal state ────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({
    email: '',
    display_name: '',
    password: '',
    role: 'viewer' as UserRole,
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ── Edit modal state ──────────────────────────────────────────────────
  const [editUser, setEditUser] = useState<AuthUser | null>(null);
  const [editForm, setEditForm] = useState({
    email: '',
    display_name: '',
    role: 'viewer' as UserRole,
    password: '',
    is_active: true,
  });
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // ── Delete state ──────────────────────────────────────────────────────
  const [deleteUser, setDeleteUser] = useState<AuthUser | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Handlers: Create ──────────────────────────────────────────────────

  const openCreate = useCallback(() => {
    setCreateForm({ email: '', display_name: '', password: '', role: 'viewer' });
    setCreateError(null);
    setCreateOpen(true);
  }, []);

  const handleCreate = useCallback(async () => {
    if (!createForm.email || !createForm.display_name || !createForm.password) {
      setCreateError('All fields are required.');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      await api.createUser({
        email: createForm.email.trim(),
        display_name: createForm.display_name.trim(),
        password: createForm.password,
        role: createForm.role,
      });
      setCreateOpen(false);
      refetch();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  }, [createForm, refetch]);

  // ── Handlers: Edit ────────────────────────────────────────────────────

  const openEdit = useCallback((user: AuthUser) => {
    setEditUser(user);
    setEditForm({
      email: user.email,
      display_name: user.display_name,
      role: user.role,
      password: '',
      is_active: user.is_active,
    });
    setEditError(null);
  }, []);

  const handleEdit = useCallback(async () => {
    if (!editUser) return;
    setEditing(true);
    setEditError(null);
    try {
      const update: Record<string, unknown> = {
        email: editForm.email.trim(),
        display_name: editForm.display_name.trim(),
        role: editForm.role,
        is_active: editForm.is_active,
      };
      if (editForm.password.trim()) {
        update.password = editForm.password.trim();
      }
      await api.updateUser(editUser.id, update as Parameters<typeof api.updateUser>[1]);
      setEditUser(null);
      refetch();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update user');
    } finally {
      setEditing(false);
    }
  }, [editUser, editForm, refetch]);

  // ── Handlers: Delete ──────────────────────────────────────────────────

  const handleDelete = useCallback(async () => {
    if (!deleteUser) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteUser(deleteUser.id);
      setDeleteUser(null);
      refetch();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setDeleting(false);
    }
  }, [deleteUser, refetch]);

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <SettingsShell
      breadcrumb="Settings · Users"
      title="User management"
      description="Manage operator accounts. Editors can run polling and approve discoveries; admins can additionally manage users, YouTube API keys, and series setup."
    >
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 18,
        gap: 16,
      }}>
        <div />
        <button
          type="button"
          className="btn btn-primary"
          onClick={openCreate}
        >
          + Add user
        </button>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading && !users ? (
          <p style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--fg-muted)' }}>
            Loading users…
          </p>
        ) : error ? (
          <p style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--red)' }}>
            {error}
          </p>
        ) : !users || users.length === 0 ? (
          <p style={{ padding: 32, textAlign: 'center', fontSize: 13, color: 'var(--fg-muted)' }}>
            No users found.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--bg-sunken)' }}>
                  <Th>User</Th>
                  <Th>Email</Th>
                  <Th>Role</Th>
                  <Th>Status</Th>
                  <Th>Last login</Th>
                  <Th align="right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    style={{ borderBottom: '1px solid var(--border-faint)' }}
                  >
                    <td style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 28,
                            height: 28,
                            borderRadius: '50%',
                            background: 'var(--bg-hover)',
                            fontSize: 11,
                            fontWeight: 700,
                            color: 'var(--fg-muted)',
                          }}
                        >
                          {u.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ color: 'var(--fg)' }}>{u.display_name}</span>
                        {u.id === currentUser?.id && (
                          <span
                            style={{
                              padding: '2px 6px',
                              borderRadius: 3,
                              background: 'var(--bg-hover)',
                              fontSize: 9,
                              fontWeight: 500,
                              color: 'var(--fg-dim)',
                              textTransform: 'uppercase',
                              letterSpacing: 0.4,
                            }}
                          >
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--fg-muted)' }}>{u.email}</td>
                    <td style={{ padding: '10px 14px' }}>
                      <RoleBadge role={u.role} />
                    </td>
                    <td style={{ padding: '10px 14px' }}>
                      {u.is_active ? (
                        <span style={{ fontSize: 12, color: 'var(--live)' }}>Active</span>
                      ) : (
                        <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>Inactive</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px', fontSize: 12, color: 'var(--fg-dim)' }}>
                      {u.last_login_at ? formatTimeAgo(u.last_login_at) : 'Never'}
                    </td>
                    <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs"
                          onClick={() => openEdit(u)}
                        >
                          Edit
                        </button>
                        {u.id !== currentUser?.id && (
                          <button
                            type="button"
                            className="btn btn-xs"
                            style={{
                              color: 'var(--red)',
                              borderColor: 'color-mix(in oklab, var(--red) 35%, transparent)',
                              background: 'color-mix(in oklab, var(--red) 8%, transparent)',
                            }}
                            onClick={() => {
                              setDeleteUser(u);
                              setDeleteError(null);
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Create User Modal ─────────────────────────────────────────── */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Add User"
        maxWidth="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleCreate} loading={creating}>
              Create User
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Display Name" required>
            <TextInput
              value={createForm.display_name}
              onChange={(e) =>
                setCreateForm((prev) => ({ ...prev, display_name: e.target.value }))
              }
              placeholder="Jane Doe"
              autoFocus
            />
          </FormField>
          <FormField label="Email" required>
            <TextInput
              type="email"
              value={createForm.email}
              onChange={(e) =>
                setCreateForm((prev) => ({ ...prev, email: e.target.value }))
              }
              placeholder="jane@clutch.game"
            />
          </FormField>
          <FormField label="Password" required>
            <TextInput
              type="password"
              value={createForm.password}
              onChange={(e) =>
                setCreateForm((prev) => ({ ...prev, password: e.target.value }))
              }
              placeholder="Set initial password"
            />
          </FormField>
          <FormField label="Role">
            <Select
              options={ROLE_OPTIONS}
              value={createForm.role}
              onChange={(e) =>
                setCreateForm((prev) => ({ ...prev, role: e.target.value as UserRole }))
              }
            />
          </FormField>
          {createError && (
            <p className="rounded bg-red-600/10 px-3 py-2 text-xs text-accent-red">
              {createError}
            </p>
          )}
        </div>
      </Modal>

      {/* ── Edit User Modal ───────────────────────────────────────────── */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`Edit: ${editUser?.display_name ?? ''}`}
        maxWidth="max-w-md"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditUser(null)} disabled={editing}>
              Cancel
            </Button>
            <Button variant="primary" size="sm" onClick={handleEdit} loading={editing}>
              Save Changes
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Display Name" required>
            <TextInput
              value={editForm.display_name}
              onChange={(e) =>
                setEditForm((prev) => ({ ...prev, display_name: e.target.value }))
              }
              autoFocus
            />
          </FormField>
          <FormField label="Email" required>
            <TextInput
              type="email"
              value={editForm.email}
              onChange={(e) =>
                setEditForm((prev) => ({ ...prev, email: e.target.value }))
              }
            />
          </FormField>
          <FormField label="New Password">
            <TextInput
              type="password"
              value={editForm.password}
              onChange={(e) =>
                setEditForm((prev) => ({ ...prev, password: e.target.value }))
              }
              placeholder="Leave blank to keep current"
            />
          </FormField>
          <FormField label="Role">
            <Select
              options={ROLE_OPTIONS}
              value={editForm.role}
              onChange={(e) =>
                setEditForm((prev) => ({ ...prev, role: e.target.value as UserRole }))
              }
            />
          </FormField>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="edit-active"
              checked={editForm.is_active}
              onChange={(e) =>
                setEditForm((prev) => ({ ...prev, is_active: e.target.checked }))
              }
              className="h-4 w-4 rounded border-navy-600 bg-navy-800 text-clutch-red focus:ring-clutch-red/50"
            />
            <label htmlFor="edit-active" className="text-sm text-gray-300">
              Account active
            </label>
          </div>
          {editError && (
            <p className="rounded bg-red-600/10 px-3 py-2 text-xs text-accent-red">
              {editError}
            </p>
          )}
        </div>
      </Modal>

      {/* ── Delete Confirmation Modal ─────────────────────────────────── */}
      <Modal
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title="Delete User"
        maxWidth="max-w-sm"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteUser(null)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={handleDelete} loading={deleting}>
              Delete User
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-gray-300">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-gray-100">
              {deleteUser?.display_name}
            </span>
            ? This action cannot be undone.
          </p>
          {deleteError && (
            <p className="rounded bg-red-600/10 px-3 py-2 text-xs text-accent-red">
              {deleteError}
            </p>
          )}
        </div>
      </Modal>
    </div>
    </SettingsShell>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      style={{
        padding: '10px 14px',
        textAlign: align,
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 0.6,
        color: 'var(--fg-dim)',
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {children}
    </th>
  );
}

function RoleBadge({ role }: { role: UserRole | string }) {
  const colors: Record<string, { bg: string; fg: string; bd: string }> = {
    admin: {
      bg: 'color-mix(in oklab, var(--red) 14%, transparent)',
      fg: 'var(--red)',
      bd: 'color-mix(in oklab, var(--red) 35%, transparent)',
    },
    editor: {
      bg: 'color-mix(in oklab, var(--warn) 14%, transparent)',
      fg: 'var(--warn)',
      bd: 'color-mix(in oklab, var(--warn) 35%, transparent)',
    },
    viewer: {
      bg: 'color-mix(in oklab, var(--info) 14%, transparent)',
      fg: 'var(--info)',
      bd: 'color-mix(in oklab, var(--info) 35%, transparent)',
    },
  };
  const c = colors[role] ?? { bg: 'var(--bg-hover)', fg: 'var(--fg-muted)', bd: 'var(--border)' };
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        fontFamily: 'var(--font-mono)',
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.bd}`,
      }}
    >
      {role}
    </span>
  );
}
