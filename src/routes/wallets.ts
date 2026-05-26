import { Router, Request, Response, NextFunction } from 'express';
import { gtp } from '../lib/gtpClient';

const router = Router();

// GET /api/wallets
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/wallets');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/balances
router.get('/balances', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get('/wallets/balances');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/:currency/transactions
router.get('/:currency/transactions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/wallets/${req.params.currency.toUpperCase()}/transactions`, { params: req.query });
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// GET /api/wallets/:currency
router.get('/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = await gtp.get(`/wallets/${req.params.currency.toUpperCase()}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
