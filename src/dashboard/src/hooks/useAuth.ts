import { useState, useEffect, useCallback, createContext, useContext } from 'react';
import * as api from '@/services/api';
import type { AuthUser, UserRole } from '@/types/api';

// ── Types ──────────────────────────────────────────────────────────────────

export interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  refetchUser: () => Promise<void>;
  hasRole: (role: UserRole) => boolean;
  isAdmin: boolean;
  isEditor: boolean;
}

// ── Role hierarchy ─────────────────────────────────────────────────────────

const ROLE_LEVEL: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };

// ── Provider hook ──────────────────────────────────────────────────────────

export function useAuthProvider(): AuthState {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check existing session on mount
  const checkSession = useCallback(async () => {
    try {
      const { user: u } = await api.getMe();
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  const login = useCallback(async (email: string, password: string): Promise<boolean> => {
    setError(null);
    try {
      const { user: u } = await api.login({ email, password });
      setUser(u);
      return true;
    } catch (err) {
      setError(err instanceof api.ApiError ? err.message : 'Login failed');
      return false;
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    setUser(null);
  }, []);

  const hasRole = useCallback(
    (role: UserRole) => {
      if (!user) return false;
      return ROLE_LEVEL[user.role] >= ROLE_LEVEL[role];
    },
    [user],
  );

  return {
    user,
    loading,
    error,
    login,
    logout,
    refetchUser: checkSession,
    hasRole,
    isAdmin: user?.role === 'admin',
    isEditor: !!user && ROLE_LEVEL[user.role] >= ROLE_LEVEL.editor,
  };
}

// ── React Context ──────────────────────────────────────────────────────────

export const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthContext.Provider');
  return ctx;
}
