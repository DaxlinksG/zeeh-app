import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { gtp } from '../lib/gtpClient';

const router = Router();

const webhookSchema = z.object({
  url: z.string().url(),
  description: z.string().max(255).optional(),
});

// POST /api/webhooks — register/update webhook URL with GTP
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

export default router;
