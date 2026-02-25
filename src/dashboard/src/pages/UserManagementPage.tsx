import { useState, useCallback } from 'react';
import { Card, Button, Modal, FormField, Select, TextInput } from '@/components/common';
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
    <div className="mx-auto max-w-4xl space-y-6">
      <Card
        title="User Management"
        subtitle="Manage user accounts and roles"
        action={
          <Button variant="primary" size="sm" onClick={openCreate}>
            + Add User
          </Button>
        }
      >
        {loading && !users ? (
          <p className="py-8 text-center text-sm text-gray-500">Loading users...</p>
        ) : error ? (
          <p className="py-8 text-center text-sm text-accent-red">{error}</p>
        ) : !users || users.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-500">No users found.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-navy-700/50 text-xs text-gray-500">
                  <th className="pb-2 text-left font-medium">User</th>
                  <th className="pb-2 text-left font-medium">Email</th>
                  <th className="pb-2 text-left font-medium">Role</th>
                  <th className="pb-2 text-left font-medium">Status</th>
                  <th className="pb-2 text-left font-medium">Last Login</th>
                  <th className="pb-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr
                    key={u.id}
                    className="border-b border-navy-700/30 last:border-0 hover:bg-navy-800/30"
                  >
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-navy-700 text-xs font-bold text-gray-300">
                          {u.display_name.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-gray-200">{u.display_name}</span>
                        {u.id === currentUser?.id && (
                          <span className="rounded bg-navy-700 px-1.5 py-0.5 text-[9px] font-medium text-gray-500 uppercase">
                            you
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-gray-400">{u.email}</td>
                    <td className="py-2.5">
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          ROLE_COLORS[u.role] ?? 'bg-gray-500/20 text-gray-400'
                        }`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="py-2.5">
                      {u.is_active ? (
                        <span className="text-xs text-accent-green">Active</span>
                      ) : (
                        <span className="text-xs text-gray-600">Inactive</span>
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-gray-500">
                      {u.last_login_at ? formatTimeAgo(u.last_login_at) : 'Never'}
                    </td>
                    <td className="py-2.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                          Edit
                        </Button>
                        {u.id !== currentUser?.id && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => {
                              setDeleteUser(u);
                              setDeleteError(null);
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
              placeholder="jane@clutch.gg"
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
  );
}
