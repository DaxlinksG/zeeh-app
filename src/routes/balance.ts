import { Router, Request, Response, NextFunction } from 'express';
import { getAllBalances, getBalance, getTransactions } from '../lib/ledger';

const router = Router();

// GET /api/balance — all currencies
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const balances = await getAllBalances(clientId);

    res.json({
      success: true,
      data: {
        client:   req.apiClient!.client_name,
        balances: balances.map(b => ({
          currency:   b.currency,
          balance:    b.balance,
          available:  b.available,
          reserved:   b.reserved,
          updated_at: b.updated_at,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/balance/:currency — single currency
router.get('/:currency', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const currency = req.params.currency.toUpperCase();
    const balance  = await getBalance(clientId, currency);

    res.json({
      success: true,
      data: {
        currency:   balance.currency,
        balance:    balance.balance,
        available:  balance.available,
        reserved:   balance.reserved,
        updated_at: balance.updated_at,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/balance/transactions — full ledger history
router.get('/transactions/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.apiClient!.key_id;
    const limit    = Math.min(parseInt(req.query.limit as string ?? '50', 10), 200);
    const txns     = await getTransactions(clientId, limit);

    res.json({
      success: true,
      data: {
        transactions: txns.map(t => ({
          txn_id:        t.txn_id,
          type:          t.type,
          direction:     t.direction,
          currency:      t.currency,
          amount:        t.amount,
          balance_after: t.balance_after,
          reference:     t.reference,
          description:   t.description,
          created_at:    t.created_at,
        })),
        count: txns.length,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
