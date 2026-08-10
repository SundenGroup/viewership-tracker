/**
 * In-app documentation.
 *
 * The Admin and User guides live in the repo (docs/*.md) so they version
 * with the code they describe — but nobody reads a markdown file on a
 * server, so the dashboard renders them at /guide. This route just hands
 * the raw markdown to the frontend.
 *
 * The user guide is for every authenticated role; the editor guide
 * covers roster and review work and is editor+; the admin guide
 * describes operations (server access, deploys, keys) and is
 * admin-only. Slugs are a fixed whitelist — nothing here ever touches a
 * path derived from user input.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { requireRole } from '../middleware/auth';

const router = Router();

const DOCS_DIR = path.join(process.cwd(), 'docs');
const FILES = {
  user: 'user-guide.md',
  editor: 'editor-guide.md',
  admin: 'admin-guide.md',
} as const;

async function sendDoc(slug: keyof typeof FILES, res: Response, next: NextFunction) {
  try {
    const file = path.join(DOCS_DIR, FILES[slug]);
    const [content, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    res.json({ slug, content, updatedAt: stat.mtime.toISOString() });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      res.status(404).json({ error: 'Guide not found on this deployment' });
      return;
    }
    next(err);
  }
}

router.get('/user', (_req: Request, res: Response, next: NextFunction) => {
  void sendDoc('user', res, next);
});

router.get('/editor', requireRole('admin', 'editor'), (_req: Request, res: Response, next: NextFunction) => {
  void sendDoc('editor', res, next);
});

router.get('/admin', requireRole('admin'), (_req: Request, res: Response, next: NextFunction) => {
  void sendDoc('admin', res, next);
});

export default router;
