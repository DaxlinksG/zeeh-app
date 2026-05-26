import { Router, Request, Response, NextFunction } from 'express';
import { gtp } from '../lib/gtpClient';

const router = Router();

// GET /api/account
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/account');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/account
router.patch('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.patch('/account/update', req.body);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/account/banks?currency=NGN
router.get('/banks', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/banks', { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// POST /api/account/banks/validate
router.post('/banks/validate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.post('/banks/validate', req.body);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/account/transactions
router.get('/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/transactions', { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
