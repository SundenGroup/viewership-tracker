import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../utils/config';
import * as UserModel from '../../models/user';
import db from '../../utils/db';

// ── Types ──────────────────────────────────────────────────────────────────

export type UserRole = 'admin' | 'editor' | 'viewer';

/** Extend Express Request to carry the authenticated user */
declare global {
  namespace Express {
    interface Request {
      user?: UserModel.SafeUser;
    }
  }
}

// ── Role hierarchy ─────────────────────────────────────────────────────────

const ROLE_LEVEL: Record<UserRole, number> = {
  admin: 3,
  editor: 2,
  viewer: 1,
};

export function hasMinRole(userRole: UserRole, requiredRole: UserRole): boolean {
  return ROLE_LEVEL[userRole] >= ROLE_LEVEL[requiredRole];
}

// ── authenticate ───────────────────────────────────────────────────────────
// Reads JWT from httpOnly cookie, verifies it, and attaches req.user.

export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = req.cookies?.[config.auth.cookieName];

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  try {
    const payload = jwt.verify(token, config.auth.jwtSecret) as { sub: string };
    const user = await UserModel.findById(payload.sub);

    if (!user || !user.is_active) {
      res.status(401).json({ error: 'User not found or inactive' });
      return;
    }

    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ── requireRole ────────────────────────────────────────────────────────────
// Factory that returns middleware checking req.user.role against allowed roles.
// Admin always passes regardless of the listed roles.

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Admin always has access
    if (req.user.role === 'admin') {
      next();
      return;
    }

    if (!roles.includes(req.user.role as UserRole)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }

    next();
  };
}

// ── requirePublicSeries ───────────────────────────────────────────────────
// Verifies the series exists, is public, and stashes it on req for handlers.

export function requirePublicSeries(paramName = 'shortName') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const shortName = req.params[paramName];
    if (!shortName) {
      res.status(400).json({ error: 'Series identifier required' });
      return;
    }

    const series = await db('tournament_series')
      .where({ short_name: shortName, is_public: true })
      .first();

    if (!series) {
      res.status(404).json({ error: 'Series not found or not public' });
      return;
    }

    // Stash resolved series on request for downstream handlers
    (req as Request & { publicSeries?: unknown }).publicSeries = series;
    next();
  };
}

// ── requireSeriesAccess ────────────────────────────────────────────────────
// Checks that the user's role meets the series' min_role requirement.
// Looks for seriesId in req.params[paramName] or req.query.seriesId.

export function requireSeriesAccess(paramName = 'seriesId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Admin bypasses all series restrictions
    if (req.user.role === 'admin') {
      next();
      return;
    }

    const seriesId = req.params[paramName] ?? (req.query.seriesId as string);
    if (!seriesId) {
      next();
      return;
    }

    const series = await db('tournament_series')
      .where({ id: seriesId })
      .select('min_role')
      .first();

    if (!series) {
      // Series not found — let route handler 404
      next();
      return;
    }

    if (!hasMinRole(req.user.role as UserRole, series.min_role)) {
      res.status(403).json({ error: 'You do not have access to this series' });
      return;
    }

    next();
  };
}
