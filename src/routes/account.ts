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

// GET /api/account/states — US states list for USD wire transfer state_id field
const US_STATES = [
  { id: 1,  code: 'AL', name: 'Alabama' },
  { id: 2,  code: 'AK', name: 'Alaska' },
  { id: 3,  code: 'AZ', name: 'Arizona' },
  { id: 4,  code: 'AR', name: 'Arkansas' },
  { id: 5,  code: 'CA', name: 'California' },
  { id: 6,  code: 'CO', name: 'Colorado' },
  { id: 7,  code: 'CT', name: 'Connecticut' },
  { id: 8,  code: 'DE', name: 'Delaware' },
  { id: 9,  code: 'FL', name: 'Florida' },
  { id: 10, code: 'GA', name: 'Georgia' },
  { id: 11, code: 'HI', name: 'Hawaii' },
  { id: 12, code: 'ID', name: 'Idaho' },
  { id: 13, code: 'IL', name: 'Illinois' },
  { id: 14, code: 'IN', name: 'Indiana' },
  { id: 15, code: 'IA', name: 'Iowa' },
  { id: 16, code: 'KS', name: 'Kansas' },
  { id: 17, code: 'KY', name: 'Kentucky' },
  { id: 18, code: 'LA', name: 'Louisiana' },
  { id: 19, code: 'ME', name: 'Maine' },
  { id: 20, code: 'MD', name: 'Maryland' },
  { id: 21, code: 'MA', name: 'Massachusetts' },
  { id: 22, code: 'MI', name: 'Michigan' },
  { id: 23, code: 'MN', name: 'Minnesota' },
  { id: 24, code: 'MS', name: 'Mississippi' },
  { id: 25, code: 'MO', name: 'Missouri' },
  { id: 26, code: 'MT', name: 'Montana' },
  { id: 27, code: 'NE', name: 'Nebraska' },
  { id: 28, code: 'NV', name: 'Nevada' },
  { id: 29, code: 'NH', name: 'New Hampshire' },
  { id: 30, code: 'NJ', name: 'New Jersey' },
  { id: 31, code: 'NM', name: 'New Mexico' },
  { id: 32, code: 'NY', name: 'New York' },
  { id: 33, code: 'NC', name: 'North Carolina' },
  { id: 34, code: 'ND', name: 'North Dakota' },
  { id: 35, code: 'OH', name: 'Ohio' },
  { id: 36, code: 'OK', name: 'Oklahoma' },
  { id: 37, code: 'OR', name: 'Oregon' },
  { id: 38, code: 'PA', name: 'Pennsylvania' },
  { id: 39, code: 'RI', name: 'Rhode Island' },
  { id: 40, code: 'SC', name: 'South Carolina' },
  { id: 41, code: 'SD', name: 'South Dakota' },
  { id: 42, code: 'TN', name: 'Tennessee' },
  { id: 43, code: 'TX', name: 'Texas' },
  { id: 44, code: 'UT', name: 'Utah' },
  { id: 45, code: 'VT', name: 'Vermont' },
  { id: 46, code: 'VA', name: 'Virginia' },
  { id: 47, code: 'WA', name: 'Washington' },
  { id: 48, code: 'WV', name: 'West Virginia' },
  { id: 49, code: 'WI', name: 'Wisconsin' },
  { id: 50, code: 'WY', name: 'Wyoming' },
  { id: 51, code: 'DC', name: 'District of Columbia' },
];

router.get('/states', (_req: Request, res: Response) => {
  res.json({ success: true, data: { states: US_STATES, count: US_STATES.length } });
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
