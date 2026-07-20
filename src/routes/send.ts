import { Router, Request, Response } from 'express';
import {
  rcCreateCustomer,
  rcGetQuote,
  rcCheckDepositEmail,
  rcConfirmDepositEmail,
  rcListDepositEmails,
  rcCreatePayout,
  rcGetPayout,
} from '../lib/remitclickClient';
import { createSendOrder, getSendOrder, getUserSendOrders } from '../lib/sendOrderStore';
import { getUserById, updateUser } from '../lib/userStore';
import { getSpreadPct } from '../config/spread';

const router = Router();

// All routes here are mounted under /me/send — requireUser already applied upstream

// ── GET /me/send/quote ─────────────────────────────────────────────────────
// Returns a live CAD→NGN rate with Zeeh's spread applied.
// Query: ?amount=100  (CAD amount, major units)
router.get('/quote', async (req: Request, res: Response) => {
  const cadAmount = parseFloat(req.query.amount as string);
  if (!cadAmount || cadAmount <= 0) {
    return res.status(400).json({ success: false, message: 'amount is required (CAD, major units)' });
  }

  const rawQuote = await rcGetQuote('CAD', 'NGN', cadAmount);
  const spreadPct = getSpreadPct('CAD', 'NGN');

  // Apply spread: customer gets a worse rate (we earn the difference)
  const customerRate = rawQuote.rate * (1 - spreadPct / 100);
  const ngnAmount = Math.floor(cadAmount * customerRate);

  return res.json({
    success: true,
    from: 'CAD',
    to: 'NGN',
    cad_amount: cadAmount,
    ngn_amount: ngnAmount,
    raw_rate: rawQuote.rate,
    customer_rate: customerRate,
    spread_pct: spreadPct,
    rate_locked_minutes: 30,
    expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
});

// ── POST /me/send/verify-email ─────────────────────────────────────────────
// Step 1 of Interac sender verification. Sends OTP if email not yet verified.
// Body: { email: string }
router.post('/verify-email', async (req: Request, res: Response) => {
  const { email } = req.body as { email?: string };
  if (!email) return res.status(400).json({ success: false, message: 'email is required' });

  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // Ensure this user has a RemitClick customer record
  let rcCustomerId = user.rc_customer_id;
  if (!rcCustomerId) {
    const rcCustomer = await rcCreateCustomer(user.email, user.first_name, user.last_name);
    rcCustomerId = rcCustomer.id;
    await updateUser(userId, { rc_customer_id: rcCustomerId });
  }

  const result = await rcCheckDepositEmail(rcCustomerId, email);

  return res.json({
    success: true,
    email,
    status: result.status, // 'ready' | 'verify_required'
    message: result.status === 'ready'
      ? 'Email already verified — you can send from this email.'
      : 'OTP sent to this email. Enter it to complete verification.',
  });
});

// ── POST /me/send/confirm-email ────────────────────────────────────────────
// Step 2: confirm OTP to register the sender email with RemitClick.
// Body: { email: string, otp: string }
router.post('/confirm-email', async (req: Request, res: Response) => {
  const { email, otp } = req.body as { email?: string; otp?: string };
  if (!email || !otp) return res.status(400).json({ success: false, message: 'email and otp are required' });

  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const user = await getUserById(userId);
  if (!user?.rc_customer_id) {
    return res.status(400).json({ success: false, message: 'Run /me/send/verify-email first' });
  }

  const result = await rcConfirmDepositEmail(user.rc_customer_id, email, otp);
  return res.json({ success: result.success, message: result.success ? 'Email verified. You can now send from this email via Interac.' : 'Invalid or expired OTP.' });
});

// ── GET /me/send/emails ────────────────────────────────────────────────────
// List all verified Interac sender emails for this user.
router.get('/emails', async (req: Request, res: Response) => {
  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const user = await getUserById(userId);
  if (!user?.rc_customer_id) return res.json({ success: true, emails: [] });

  const emails = await rcListDepositEmails(user.rc_customer_id);
  return res.json({ success: true, emails });
});

// ── POST /me/send/initiate ─────────────────────────────────────────────────
// Creates a send order — locks the rate and returns Interac payment instructions.
// Body:
//   { ngn_amount, sender_email, recipient_account, recipient_bank_code, recipient_bank_name, recipient_name }
router.post('/initiate', async (req: Request, res: Response) => {
  const {
    ngn_amount,
    sender_email,
    recipient_account,
    recipient_bank_code,
    recipient_bank_name,
    recipient_name,
  } = req.body as {
    ngn_amount?: number;
    sender_email?: string;
    recipient_account?: string;
    recipient_bank_code?: string;
    recipient_bank_name?: string;
    recipient_name?: string;
  };

  if (!ngn_amount || !sender_email || !recipient_account || !recipient_bank_code || !recipient_name) {
    return res.status(400).json({ success: false, message: 'ngn_amount, sender_email, recipient_account, recipient_bank_code, recipient_name are required' });
  }

  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });

  // Ensure RemitClick customer exists
  let rcCustomerId = user.rc_customer_id;
  if (!rcCustomerId) {
    const rcCustomer = await rcCreateCustomer(user.email, user.first_name, user.last_name);
    rcCustomerId = rcCustomer.id;
    await updateUser(userId, { rc_customer_id: rcCustomerId });
  }

  // Get live rate and compute CAD cost
  const spreadPct = getSpreadPct('CAD', 'NGN');
  const rawQuote = await rcGetQuote('CAD', 'NGN', 1); // rate per 1 CAD
  const customerRate = rawQuote.rate * (1 - spreadPct / 100);
  const cadAmount = parseFloat((ngn_amount / customerRate).toFixed(2));

  // Create the send order (30-min rate lock)
  const order = await createSendOrder({
    user_id: userId,
    rc_customer_id: rcCustomerId,
    sender_email,
    cad_amount: cadAmount,
    ngn_amount,
    raw_rate: rawQuote.rate,
    customer_rate: customerRate,
    spread_pct: spreadPct,
    recipient_account,
    recipient_bank_code,
    recipient_bank_name: recipient_bank_name ?? '',
    recipient_name,
    status: 'awaiting_payment',
  });

  return res.json({
    success: true,
    order_id: order.order_id,
    cad_amount: cadAmount,
    ngn_amount,
    customer_rate: customerRate,
    expires_at: order.expires_at,
    instructions: {
      method: 'Interac e-Transfer',
      send_from_email: sender_email,
      send_to_email: process.env.INTERAC_RECEIVE_EMAIL ?? 'payments@zeehfi.ca',
      amount_cad: cadAmount,
      reference: order.order_id,
      note: `Send exactly CAD ${cadAmount.toFixed(2)} via Interac from ${sender_email}. Your rate is locked for 30 minutes. Reference: ${order.order_id}`,
    },
  });
});

// ── GET /me/send/:orderId ──────────────────────────────────────────────────
// Poll the status of a send order.
router.get('/:orderId', async (req: Request, res: Response) => {
  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const order = await getSendOrder(req.params.orderId);

  if (!order || order.user_id !== userId) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  // If payout was initiated, sync latest status from RemitClick
  let rcPayout = null;
  if (order.rc_payout_id) {
    try { rcPayout = await rcGetPayout(order.rc_payout_id); } catch {}
  }

  return res.json({
    success: true,
    order_id: order.order_id,
    status: order.status,
    cad_amount: order.cad_amount,
    ngn_amount: order.ngn_amount,
    customer_rate: order.customer_rate,
    recipient_name: order.recipient_name,
    created_at: order.created_at,
    expires_at: order.expires_at,
    completed_at: order.completed_at,
    failure_reason: order.failure_reason,
    payout_status: rcPayout?.status ?? null,
  });
});

// ── GET /me/send ───────────────────────────────────────────────────────────
// Send order history for this user.
router.get('/', async (req: Request, res: Response) => {
  const userId = (req as Request & { user: { user_id: string } }).user.user_id;
  const orders = await getUserSendOrders(userId);
  return res.json({ success: true, orders });
});

export default router;
