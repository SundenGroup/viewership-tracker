import { Router, Request, Response, NextFunction } from 'express';
import * as StageModel from '../../models/stage';
import * as TournamentSeriesModel from '../../models/tournament-series';

const router = Router();

// GET /api/series/:seriesId/stages — List stages for a series
router.get('/:seriesId/stages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const stages = await StageModel.findAll({ series_id: req.params.seriesId as string });
    res.json(stages);
  } catch (err) {
    next(err);
  }
});

// POST /api/series/:seriesId/stages — Create a stage
router.post('/:seriesId/stages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, order } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required and must be a string' });
      return;
    }
    if (order === undefined || typeof order !== 'number') {
      res.status(400).json({ error: 'order is required and must be a number' });
      return;
    }
    const series = await TournamentSeriesModel.findById(req.params.seriesId as string);
    if (!series) {
      res.status(404).json({ error: 'Series not found' });
      return;
    }
    const stage = await StageModel.create({
      ...req.body,
      series_id: req.params.seriesId as string,
    });
    res.status(201).json(stage);
  } catch (err) {
    next(err);
  }
});

// PUT /api/stages/:id — Update a stage
router.put('/stages/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await StageModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Stage not found' });
      return;
    }
    const updated = await StageModel.update(req.params.id as string, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/stages/:id — Delete a stage (cascades)
router.delete('/stages/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await StageModel.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Stage not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
