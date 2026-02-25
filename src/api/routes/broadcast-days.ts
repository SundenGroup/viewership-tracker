import { Router, Request, Response, NextFunction } from 'express';
import * as BroadcastDayModel from '../../models/broadcast-day';
import * as StageModel from '../../models/stage';
import { requireRole } from '../middleware/auth';

const router = Router();

// GET /api/stages/:stageId/days — List broadcast days for a stage
router.get('/:stageId/days', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const stage = await StageModel.findById(req.params.stageId as string);
    if (!stage) {
      res.status(404).json({ error: 'Stage not found' });
      return;
    }
    const days = await BroadcastDayModel.findAll({ stage_id: req.params.stageId as string });
    res.json(days);
  } catch (err) {
    next(err);
  }
});

// POST /api/stages/:stageId/days — Create a broadcast day (editor+)
router.post('/:stageId/days', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { label, date } = req.body;
    if (!label || typeof label !== 'string') {
      res.status(400).json({ error: 'label is required and must be a string' });
      return;
    }
    if (!date || typeof date !== 'string') {
      res.status(400).json({ error: 'date is required and must be a string (YYYY-MM-DD)' });
      return;
    }
    const stage = await StageModel.findById(req.params.stageId as string);
    if (!stage) {
      res.status(404).json({ error: 'Stage not found' });
      return;
    }
    const day = await BroadcastDayModel.create({
      ...req.body,
      stage_id: req.params.stageId as string,
      series_id: stage.series_id,
    });
    res.status(201).json(day);
  } catch (err) {
    next(err);
  }
});

// PUT /api/days/:id — Update a broadcast day (editor+)
router.put('/days/:id', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await BroadcastDayModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Broadcast day not found' });
      return;
    }
    const updated = await BroadcastDayModel.update(req.params.id as string, req.body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/days/:id — Delete a broadcast day (editor+)
router.delete('/days/:id', requireRole('admin', 'editor'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await BroadcastDayModel.remove(req.params.id as string);
    if (!deleted) {
      res.status(404).json({ error: 'Broadcast day not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// PUT /api/days/:id/status — Update broadcast day status (admin only)
router.put('/days/:id/status', requireRole('admin'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { status } = req.body;
    if (!status || !['scheduled', 'live', 'completed'].includes(status)) {
      res.status(400).json({ error: 'status must be one of: scheduled, live, completed' });
      return;
    }
    const existing = await BroadcastDayModel.findById(req.params.id as string);
    if (!existing) {
      res.status(404).json({ error: 'Broadcast day not found' });
      return;
    }
    const updated = await BroadcastDayModel.update(req.params.id as string, { status });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

export default router;
