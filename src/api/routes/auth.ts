import { Router, Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../utils/config';
import * as UserModel from '../../models/user';
import { authenticate, requireRole } from '../middleware/auth';

const router = Router();

// ── POST /login ─── public ────────────────────────────────────────────────

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const user = await UserModel.findByEmail(email);
    if (!user || !user.is_active) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await UserModel.verifyPassword(user, password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Issue JWT
    const token = jwt.sign(
      { sub: user.id },
      config.auth.jwtSecret,
      { expiresIn: config.auth.jwtExpiresIn } as jwt.SignOptions,
    );

    // Set httpOnly cookie
    res.cookie(config.auth.cookieName, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: config.auth.cookieMaxAgeMs,
      path: '/',
    });

    await UserModel.updateLastLogin(user.id);

    // Return safe user (no password_hash)
    const { password_hash: _, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (err) {
    next(err);
  }
});

// ── POST /logout ── public ────────────────────────────────────────────────

router.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(config.auth.cookieName, { path: '/' });
  res.json({ ok: true });
});

// ── GET /me ─── authenticated ─────────────────────────────────────────────

router.get('/me', authenticate, (req: Request, res: Response) => {
  res.json({ user: req.user });
});

// ── Admin: User CRUD ──────────────────────────────────────────────────────

// GET /users — list all users
router.get(
  '/users',
  authenticate,
  requireRole('admin'),
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const users = await UserModel.findAll();
      res.json(users);
    } catch (err) {
      next(err);
    }
  },
);

// POST /users — create a user
router.post(
  '/users',
  authenticate,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password, display_name, role } = req.body;
      if (!email || !password || !display_name) {
        res.status(400).json({ error: 'email, password, and display_name are required' });
        return;
      }
      if (role && !['admin', 'editor', 'viewer'].includes(role)) {
        res.status(400).json({ error: 'role must be one of: admin, editor, viewer' });
        return;
      }
      const user = await UserModel.create({ email, password, display_name, role });
      res.status(201).json(user);
    } catch (err) {
      if ((err as Error).message?.includes('unique') || (err as Error).message?.includes('duplicate')) {
        res.status(409).json({ error: 'A user with that email already exists' });
        return;
      }
      next(err);
    }
  },
);

// PUT /users/:id — update a user
router.put(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const existing = await UserModel.findById(id);
      if (!existing) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      const updated = await UserModel.update(id, req.body);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

// DELETE /users/:id — delete a user
router.delete(
  '/users/:id',
  authenticate,
  requireRole('admin'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const id = req.params.id as string;
      const user = await UserModel.findById(id);
      if (!user) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // Prevent deleting the last admin
      if (user.role === 'admin') {
        const adminCount = await UserModel.countAdmins();
        if (adminCount <= 1) {
          res.status(400).json({ error: 'Cannot delete the last admin user' });
          return;
        }
      }
      await UserModel.remove(id);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  },
);

export default router;
