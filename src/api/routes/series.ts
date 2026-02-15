import { Router, Request, Response, NextFunction } from 'express';
import * as TournamentSeriesModel from '../../models/tournament-series';

const router = Router();

// GET /api/series — List all series (optional ?status=active)
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.query;
    const filters: Partial<Pick<TournamentSeriesModel.TournamentSeries, 'status'>> = {};
    if (status && ['draft', 'active', 'completed'].includes(status as string)) {
      filters.status = status as TournamentSeriesModel.TournamentStatus;
    }
    const series = await TournamentSeriesModel.findAll(filters);
    res.json(series);
  } catch (err) {
    next(err);
  }
});

// POST /api/series — Create a new series
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }
    const series = await TournamentSeriesModel.create(req.body);
    res.status(201).json(series);
  } catch (err) {
    next(err);
  }
});

// GET /api/series/:id — Get series with nested stages + broadcast days
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await TournamentSeriesModel.findWithStages(req.params.id as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    res.json(series);
  } catch (err) {
    next(err);
  }
});

// PUT /api/series/:id — Update a series
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await TournamentSeriesModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated = await TournamentSeriesModel.update(req.params.id as string, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/series/:id — Delete a series (cascades)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await TournamentSeriesModel.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PUT /api/series/:id/status — Update series status
router.put('/:id/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    if (!status || !['draft', 'active', 'completed'].includes(status)) {
      res.status(400).json({ error: 'status must be one of: draft, active, completed' });
      return;
    }
    const existing = await TournamentSeriesModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const updated = await TournamentSeriesModel.updateStatus(req.params.id as string, status);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
