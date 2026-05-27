import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';

const router = Router();

const webhookSchema = z.object({
  url:         z.string().url(),
  description: z.string().max(255).optional(),
  events:      z.array(z.string()).optional(), // e.g. ["transfer.completed", "wallet.funded"]
});

// GET /api/webhooks — list registered webhooks
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/webhooks');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/webhooks — register a webhook endpoint
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = webhookSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, message: 'Validation error', errors: parsed.error.flatten() });
      return;
    }
    const { data } = await gtp.post('/webhooks', parsed.data);
    res.status(201).json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/webhooks/:webhook_id — get a single webhook
router.get('/:webhook_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/webhooks/${req.params.webhook_id}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/webhooks/:webhook_id — update a webhook
router.patch('/:webhook_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.patch(`/webhooks/${req.params.webhook_id}`, req.body);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/webhooks/:webhook_id — remove a webhook
router.delete('/:webhook_id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.delete(`/webhooks/${req.params.webhook_id}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/webhooks/:webhook_id/deliveries — delivery history / retry logs
router.get('/:webhook_id/deliveries', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/webhooks/${req.params.webhook_id}/deliveries`, { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
