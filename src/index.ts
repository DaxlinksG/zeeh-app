import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import axios from 'axios';
import swaggerUi from 'swagger-ui-express';
import { requireApiKey } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { requestId, httpLogger } from './middleware/logger';
import { apiLimiter, transferLimiter, quoteLimiter, authLimiter, userLimiter } from './middleware/rateLimiter';
import { openapiSpec } from './openapi';
import ratesRouter from './routes/rates';
import swapsRouter from './routes/swaps';
import transfersRouter from './routes/transfers';
import walletsRouter from './routes/wallets';
import accountRouter from './routes/account';
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/admin';
import balanceRouter from './routes/balance';
import authRouter from './routes/auth';
import meRouter from './routes/me';
import { requireUser } from './middleware/userAuth';
import { createPendingDeposit } from './lib/deposits';
import { runReconciliation, getSnapshots, getLatestSnapshot } from './lib/treasury';
import { getVirtualAccountByReference, recordVirtualAccountCredit } from './lib/virtualAccountStore';
import virtualAccountsRouter from './routes/virtualAccounts';
import { creditBalance } from './lib/ledger';
import { warmWalletCache } from './lib/walletCache';
import { updateKycStatus, getUserById } from './lib/userStore';
import type { KycStatus } from './lib/userStore';
import { sendKycSubmitted, sendAdminKycAlert } from './lib/mailer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand as DdbPutCommand } from '@aws-sdk/lib-dynamodb';

// ── Webhook idempotency store ──────────────────────────────────────────────
// Deduplicates GTP webhook deliveries — GTP retries on any non-200 response.
// Each event_key is stored for 7 days (TTL) then auto-purged.
const _wdb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION ?? 'ca-central-1' }));
const WEBHOOK_DEDUP_TABLE = process.env.WEBHOOK_DEDUP_TABLE ?? 'zeeh-processed-webhooks';

async function markWebhookProcessed(eventKey: string): Promise<boolean> {
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7 days
  try {
    await _wdb.send(new DdbPutCommand({
      TableName: WEBHOOK_DEDUP_TABLE,
      Item: { event_key: eventKey, processed_at: new Date().toISOString(), ttl },
      ConditionExpression: 'attribute_not_exists(event_key)', // fails if already exists
    }));
    return true;  // first time — process it
  } catch (err: unknown) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false; // duplicate
    throw err; // real error — let it bubble
  }
}

const app = express();

// CORS — lock to ALLOWED_ORIGINS in production; fall back to permissive in dev.
// Capacitor Android uses "https://localhost" as the WebView origin, so that is
// always allowed regardless of the ALLOWED_ORIGINS list.
const _allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const _capacitorOrigins = ['https://localhost', 'capacitor://localhost', 'ionic://localhost'];

app.use(cors({
  origin: _allowedOrigins.length
    ? (origin, cb) => {
        const ok = !origin
          || _allowedOrigins.includes(origin)
          || _capacitorOrigins.includes(origin);   // mobile WebView
        ok ? cb(null, true) : cb(new Error('CORS: origin not allowed'));
      }
    : true,
  credentials: true,
}));
// Capture raw body for webhook signature verification BEFORE json parsing
app.use((req, _res, next) => {
  if (req.path === '/webhooks/receive' || req.path === '/webhooks/kyc') {
    let raw = Buffer.alloc(0);
    req.on('data', (chunk: Buffer) => { raw = Buffer.concat([raw, chunk]); });
    req.on('end', () => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = raw;
      try { (req as express.Request & { body: unknown }).body = JSON.parse(raw.toString('utf-8')); } catch { /* not JSON */ }
      next();
    });
  } else {
    next();
  }
});
app.use(express.json({ limit: '8mb' })); // KYC upload routes send base64 images (~200–600 KB each)
app.use(requestId);    // attach x-request-id to every request
app.use(httpLogger);   // log every HTTP request

// ── Public routes (no API key needed) ─────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Root → redirect to docs
app.get('/', (_req, res) => res.redirect('/docs'));

// Raw OpenAPI spec
app.get('/openapi.json', (_req, res) => res.json(openapiSpec));

// Interactive docs
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'Zeeh Africa — Payments API',
  customfavIcon: 'https://zeehfi.ca/favicon.ico',
  customCss: `
    /* ── Base ── */
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important; }
    .swagger-ui { background: #0f1117; }

    /* ── Topbar ── */
    .swagger-ui .topbar { background: #1a1d27; border-bottom: 1px solid #2a2d3a; padding: 10px 0; }
    .swagger-ui .topbar .download-url-wrapper { display: none; }
    .swagger-ui .topbar-wrapper .link::after {
      content: 'Zeeh Africa — Payments API';
      color: #fff; font-size: 1.1rem; font-weight: 700; letter-spacing: -0.01em;
    }
    .swagger-ui .topbar-wrapper img { display: none; }

    /* ── Info block ── */
    .swagger-ui .info { margin: 30px 0 20px; }
    .swagger-ui .info .title { color: #e8eaf0 !important; font-size: 2rem !important; }
    .swagger-ui .info p, .swagger-ui .info li, .swagger-ui .info td, .swagger-ui .info th { color: #b0b3c6 !important; }
    .swagger-ui .info h2, .swagger-ui .info h3 { color: #e8eaf0 !important; }
    .swagger-ui .info a { color: #6c63ff !important; }
    .swagger-ui .info code { background: #1a1d27; color: #00d4aa; padding: 2px 6px; border-radius: 4px; }
    .swagger-ui .info table { border-collapse: collapse; width: 100%; }
    .swagger-ui .info td, .swagger-ui .info th { border: 1px solid #2a2d3a !important; padding: 6px 12px !important; }
    .swagger-ui .info pre { background: #1a1d27 !important; border: 1px solid #2a2d3a; border-radius: 8px; padding: 16px; }

    /* ── Scheme / authorize button ── */
    .swagger-ui .scheme-container { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 8px; padding: 16px; margin-bottom: 20px; box-shadow: none; }
    .swagger-ui .auth-wrapper .authorize { background: #6c63ff; border-color: #6c63ff; color: #fff; border-radius: 6px; }
    .swagger-ui .auth-wrapper .authorize:hover { background: #5a52e0; }
    .swagger-ui section.models { background: #1a1d27; border: 1px solid #2a2d3a; border-radius: 8px; }

    /* ── Tags / operation groups ── */
    .swagger-ui .opblock-tag { color: #e8eaf0 !important; font-size: 1rem !important; border-bottom: 1px solid #2a2d3a !important; }
    .swagger-ui .opblock-tag:hover { background: rgba(108,99,255,0.05) !important; }
    .swagger-ui .opblock-tag small { color: #7b7f9e !important; }

    /* ── Operation blocks ── */
    .swagger-ui .opblock { border-radius: 8px !important; margin: 6px 0 !important; border: 1px solid #2a2d3a !important; box-shadow: none !important; }
    .swagger-ui .opblock .opblock-summary { border-radius: 7px !important; }
    .swagger-ui .opblock .opblock-summary-path { color: #e8eaf0 !important; font-weight: 600 !important; }
    .swagger-ui .opblock .opblock-summary-description { color: #7b7f9e !important; }
    .swagger-ui .opblock-body { background: #0f1117 !important; }

    /* GET */
    .swagger-ui .opblock.opblock-get   { background: rgba(0, 152, 255, 0.05) !important; }
    .swagger-ui .opblock.opblock-get   .opblock-summary { background: rgba(0, 152, 255, 0.08) !important; }
    .swagger-ui .opblock.opblock-get   .tab-header .tab-item.active h4 span::after { background: #0098ff; }

    /* POST */
    .swagger-ui .opblock.opblock-post  { background: rgba(0, 212, 170, 0.05) !important; }
    .swagger-ui .opblock.opblock-post  .opblock-summary { background: rgba(0, 212, 170, 0.08) !important; }

    /* PATCH */
    .swagger-ui .opblock.opblock-patch { background: rgba(255, 165, 0, 0.05) !important; }
    .swagger-ui .opblock.opblock-patch .opblock-summary { background: rgba(255, 165, 0, 0.08) !important; }

    /* DELETE */
    .swagger-ui .opblock.opblock-delete { background: rgba(255, 77, 109, 0.05) !important; }
    .swagger-ui .opblock.opblock-delete .opblock-summary { background: rgba(255, 77, 109, 0.08) !important; }

    /* ── Method badges ── */
    .swagger-ui .opblock-summary-method { border-radius: 4px !important; font-weight: 700 !important; min-width: 70px !important; }

    /* ── Params / body ── */
    .swagger-ui .parameters-col_description p,
    .swagger-ui .parameter__name,
    .swagger-ui label,
    .swagger-ui .model-title { color: #b0b3c6 !important; }
    .swagger-ui .parameter__type { color: #6c63ff !important; }
    .swagger-ui input[type=text], .swagger-ui textarea, .swagger-ui select { background: #1a1d27 !important; color: #e8eaf0 !important; border: 1px solid #2a2d3a !important; border-radius: 6px !important; }
    .swagger-ui .body-param__text { background: #1a1d27 !important; color: #e8eaf0 !important; border: 1px solid #2a2d3a !important; }

    /* ── Response codes ── */
    .swagger-ui .responses-inner h4,
    .swagger-ui .responses-inner h5 { color: #b0b3c6 !important; }
    .swagger-ui .response-col_status { color: #e8eaf0 !important; }
    .swagger-ui .response-col_description p { color: #b0b3c6 !important; }

    /* ── Code / JSON ── */
    .swagger-ui .microlight { background: #1a1d27 !important; border-radius: 6px; padding: 12px !important; }

    /* ── Models ── */
    .swagger-ui .model-box { background: #1a1d27 !important; }
    .swagger-ui .model { color: #b0b3c6 !important; }
    .swagger-ui .prop-type { color: #00d4aa !important; }
    .swagger-ui .prop-format { color: #7b7f9e !important; }
    .swagger-ui section.models .model-container { background: #0f1117 !important; border: 1px solid #2a2d3a !important; border-radius: 6px; margin: 4px 0; }

    /* ── Execute button ── */
    .swagger-ui .btn.execute { background: #6c63ff !important; border-color: #6c63ff !important; color: #fff !important; border-radius: 6px !important; }
    .swagger-ui .btn.execute:hover { background: #5a52e0 !important; }
    .swagger-ui .btn.cancel { border-color: #ff4d6d !important; color: #ff4d6d !important; border-radius: 6px !important; }
    .swagger-ui .btn { border-radius: 6px !important; }

    /* ── Try it out ── */
    .swagger-ui .try-out__btn { border-color: #6c63ff !important; color: #6c63ff !important; border-radius: 6px !important; }

    /* ── General text ── */
    .swagger-ui, .swagger-ui .renderedMarkdown p, .swagger-ui table thead tr th,
    .swagger-ui .response-col_links { color: #b0b3c6 !important; }
    .swagger-ui .tab li { color: #7b7f9e !important; }
    .swagger-ui .tab li.active { color: #e8eaf0 !important; }
    .swagger-ui select { color: #e8eaf0 !important; }
  `,
  swaggerOptions: {
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    docExpansion: 'none',
    defaultModelsExpandDepth: -1,
  },
}));

// Webhook receiver — GTP calls this, no API key needed
app.post('/webhooks/receive', async (req, res) => {
  // ── Signature verification (HMAC-SHA256) ─────────────────────────────────
  // Expedier signs every webhook with HMAC-SHA256 of the raw body using your
  // WEBHOOK_SECRET. If the secret is configured we MUST verify; if not set
  // (local dev / sandbox without secret) we warn and continue.
  const webhookSecret = process.env.WEBHOOK_SECRET;
  if (webhookSecret) {
    const { createHmac, timingSafeEqual } = await import('crypto');
    const rawBody   = (req as express.Request & { rawBody?: Buffer }).rawBody;
    const signature = req.headers['x-gtp-signature'] as string | undefined
                   ?? req.headers['x-signature']     as string | undefined
                   ?? req.headers['x-webhook-signature'] as string | undefined;
    if (!rawBody || !signature) {
      console.warn('⚠️  Webhook missing raw body or signature header — rejected');
      res.status(401).json({ error: 'Missing signature' });
      return;
    }
    const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    // Signature may arrive as "sha256=<hex>" or plain hex
    const received  = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    try {
      const match = timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
      if (!match) {
        console.warn('⚠️  Webhook signature mismatch — rejected');
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid signature format' });
      return;
    }
    console.log('✅  Webhook signature verified');
  } else {
    console.warn('⚠️  WEBHOOK_SECRET not set — skipping signature check (sandbox mode)');
  }

  const event     = req.body as Record<string, unknown>;
  const eventType = String(event.type ?? event.event ?? 'unknown');
  const ts        = new Date().toISOString();

  // ── Idempotency check — deduplicate GTP retries ───────────────────────────
  // GTP retries any webhook that doesn't get a fast 200. We derive a stable
  // event key from the event's own ID, or fall back to a content hash.
  const meta     = event.meta as Record<string, unknown> | undefined;
  const eventId  = String(meta?.request_id ?? event.event_id ?? event.id ?? '');
  const data     = event.data as Record<string, unknown> | undefined;
  const amount   = String(data?.amount   ?? event.amount   ?? '');
  const currency = String(data?.currency ?? event.currency ?? '');
  const ref      = String(data?.reference ?? data?.client_reference ?? data?.transfer_id ?? data?.swap_id ?? data?.wallet_id ?? event.reference ?? '');

  // Build a stable dedup key: prefer GTP's request_id, fall back to content hash
  const eventKey = eventId
    ? `${eventType}:${eventId}`
    : `${eventType}:${currency}:${amount}:${ref}:${String(meta?.timestamp ?? ts)}`;

  try {
    const isNew = await markWebhookProcessed(eventKey);
    if (!isNew) {
      console.log(`⏭️  Webhook duplicate — skipping already-processed event: ${eventKey}`);
      res.status(200).json({ received: true, duplicate: true });
      return;
    }
  } catch (dedupErr) {
    // If dedup table is unreachable, log and continue — better to process twice
    // than to reject a real event. Alert is loud enough for ops to notice.
    console.error('⚠️  Webhook dedup check failed — processing anyway:', dedupErr);
  }

  // ── Structured console log ────────────────────────────────────────────────
  const status   = data?.status   ?? event.status;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📨  WEBHOOK EVENT  [${ts}]`);
  console.log(`   Type   : ${eventType}`);
  if (amount)   console.log(`   Amount : ${currency} ${amount}`);
  if (status)   console.log(`   Status : ${status}`);
  if (ref)      console.log(`   Ref    : ${ref}`);
  console.log(JSON.stringify(event, null, 2));
  console.log(`${'─'.repeat(60)}\n`);

  // ── Auto-detect deposits: wallet.funded ───────────────────────────────────
  // When any wallet receives funds, GTP fires wallet.funded.
  // 1. Try to match reference to a virtual account → auto-credit + fire webhook
  // 2. If no match, create a pending deposit for admin to assign manually.
  if (
    (eventType === 'wallet.funded' || eventType === 'wallet_funded') &&
    amount && parseFloat(amount) > 0 && currency
  ) {
    let matchedVirtualAccount = false;

    // ── 1. Virtual account matching ────────────────────────────────────────
    // The sender must include the ZVA-XXXXXX reference code in the payment
    // description. We extract every token and try each one.
    if (ref) {
      const tokens = ref.toUpperCase().split(/\s+|[,;|]/);
      const zvaToken = tokens.find(t => /^ZVA-[0-9A-F]{6}$/.test(t));
      if (zvaToken) {
        try {
          const va = await getVirtualAccountByReference(zvaToken);
          if (va && va.status === 'active' && va.currency === currency) {
            // Credit the B2B client's ledger
            await creditBalance(
              va.client_id,
              currency,
              amount,
              zvaToken,
              `Virtual account deposit — ${va.customer_name} (${va.customer_id})`,
              { virtual_account_id: va.account_id, customer_id: va.customer_id },
            );
            // Update running total on the virtual account record
            await recordVirtualAccountCredit(va.account_id, amount);

            console.log(`🏦  Virtual account matched: ${zvaToken} → client=${va.client_id} customer=${va.customer_id} ${currency} ${amount}`);
            matchedVirtualAccount = true;
          } else if (va) {
            console.warn(`⚠️  Virtual account ${zvaToken} found but inactive or currency mismatch (expected ${va.currency}, got ${currency})`);
          }
        } catch (err) {
          console.error('⚠️  Virtual account credit failed:', err);
          // Fall through to pending deposit so funds aren't lost
        }
      }
    }

    // ── 2. Unmatched deposit → pending queue for admin ─────────────────────
    if (!matchedVirtualAccount) {
      try {
        const deposit = await createPendingDeposit(eventType, currency, amount, ref || ts, event);
        console.log(`💰  Pending deposit created: ${deposit.deposit_id}  (${currency} ${amount})`);
      } catch (err) {
        console.error('⚠️  Failed to create pending deposit:', err);
        // Still return 200 so GTP doesn't retry indefinitely
      }
    }
  }

  res.status(200).json({ received: true });
});

// ── KYC webhook receiver — kyc.zeehfi.ca calls this when a session completes ──
//
// Signature format:  X-KYC-Signature: t=<unix_ts>,v1=<hmac_sha256>
// HMAC input:        "<timestamp>.<raw_body>"
// Events handled:    session.approved | session.rejected | session.manual_review
//
app.post('/webhooks/kyc', async (req, res) => {
  const rawBody       = (req as express.Request & { rawBody?: Buffer }).rawBody;
  const kycWebhookSecret = process.env.KYC_WEBHOOK_SECRET;
  const sigHeader     = req.headers['x-kyc-signature'] as string | undefined;

  // ── Signature verification ─────────────────────────────────────────────────
  if (kycWebhookSecret) {
    if (!sigHeader || !rawBody) {
      console.warn('⚠️  KYC webhook missing signature or body — rejected');
      res.status(401).json({ error: 'Missing signature' }); return;
    }
    const { createHmac, timingSafeEqual } = await import('crypto');
    // Parse "t=1234567890,v1=abc123..."
    const parts = Object.fromEntries(sigHeader.split(',').map(p => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
    const ts = parts['t'];
    const v1 = parts['v1'];
    if (!ts || !v1) {
      res.status(401).json({ error: 'Malformed signature header' }); return;
    }
    const payload  = `${ts}.${rawBody.toString('utf-8')}`;
    const expected = createHmac('sha256', kycWebhookSecret).update(payload).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(v1, 'hex'))) {
        console.warn('⚠️  KYC webhook signature mismatch — rejected');
        res.status(401).json({ error: 'Invalid signature' }); return;
      }
    } catch {
      res.status(401).json({ error: 'Invalid signature format' }); return;
    }
  } else {
    console.warn('⚠️  KYC_WEBHOOK_SECRET not set — skipping KYC webhook signature check');
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let event: Record<string, unknown>;
  try {
    event = rawBody
      ? JSON.parse(rawBody.toString('utf-8'))
      : (req.body as Record<string, unknown>);
  } catch {
    res.status(400).json({ error: 'Invalid JSON' }); return;
  }

  const eventType = String(event.type ?? event.event ?? '');
  const data      = event.data as Record<string, unknown> | undefined;
  const sessionId = String(data?.session_id ?? data?.id ?? event.session_id ?? '');

  // externalId is the user_id we passed when creating the session
  const externalId = String(data?.external_id ?? data?.externalId ?? event.external_id ?? '');

  console.log(`📨  KYC WEBHOOK: ${eventType}  session=${sessionId}  user=${externalId || '(unknown)'}`);

  // Ack non-actionable events (e.g. ping test)
  if (!['session.approved', 'session.rejected', 'session.manual_review'].includes(eventType)) {
    res.status(200).json({ received: true }); return;
  }

  // ── Resolve user_id ────────────────────────────────────────────────────────
  // Primary:  externalId in the webhook payload
  // Fallback: fetch the session from kyc.zeehfi.ca and read externalId from there
  let userId = externalId;
  if (!userId && sessionId) {
    try {
      const kycBase   = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
      const kycApiKey = process.env.KYC_API_KEY!;
      const { data: session } = await axios.get(`${kycBase}/v1/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${kycApiKey}` }, timeout: 8000,
      });
      userId = String((session as Record<string, unknown>).external_id ?? '');
    } catch (fetchErr) {
      console.error('⚠️  KYC webhook: failed to fetch session for externalId resolution', fetchErr);
    }
  }

  if (!userId) {
    console.error('⚠️  KYC webhook: cannot resolve user_id — acknowledging without action');
    res.status(200).json({ received: true }); return;
  }

  // ── Update kyc_status ──────────────────────────────────────────────────────
  const newStatus: KycStatus =
    eventType === 'session.approved'     ? 'approved' :
    eventType === 'session.rejected'     ? 'rejected'  :
    /* session.manual_review */            'pending';

  try {
    await updateKycStatus(userId, newStatus);
  } catch (dbErr) {
    console.error(`⚠️  KYC webhook: failed to update kyc_status for user=${userId}`, dbErr);
    // Still ack — the webhook service shouldn't keep retrying a DB error
    res.status(200).json({ received: true }); return;
  }

  // ── Notify user / ops ──────────────────────────────────────────────────────
  getUserById(userId).then(u => {
    if (!u) return;
    if (newStatus === 'approved') {
      sendKycSubmitted(u.email, u.first_name);
    } else {
      sendAdminKycAlert(u.email, u.user_id, `${u.first_name} ${u.last_name}`);
    }
  }).catch(() => {});

  console.log(`✅  KYC webhook processed: user=${userId} → ${newStatus}`);
  res.status(200).json({ received: true });
});

// ── Admin routes (x-admin-key, no client API key needed) ──────────────────
app.use('/admin', adminRouter);

// ── Admin: Treasury endpoints (inline — same admin key auth) ──────────────
import { timingSafeEqual as _tse } from 'crypto';
function timingSafeKeyCheck(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a.padEnd(256, '\0'));
    const bb = Buffer.from(b.padEnd(256, '\0'));
    return _tse(ab, bb) && a.length === b.length;
  } catch { return false; }
}
const adminKeyCheck = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const provided = String(req.headers['x-admin-key'] ?? '');
  const expected = process.env.ADMIN_KEY ?? '';
  if (!expected || !timingSafeKeyCheck(provided, expected)) {
    res.status(401).json({ success: false, message: 'Invalid admin key' }); return;
  }
  next();
};

app.get('/admin/treasury/latest', adminKeyCheck, async (_req, res) => {
  const snap = await getLatestSnapshot();
  res.json({ success: true, data: snap });
});

app.get('/admin/treasury/snapshots', adminKeyCheck, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit as string ?? '20', 10), 50);
  const snaps = await getSnapshots(limit);
  res.json({ success: true, data: { snapshots: snaps, count: snaps.length } });
});

app.post('/admin/treasury/reconcile', adminKeyCheck, async (_req, res) => {
  const snap = await runReconciliation('manual');
  res.json({ success: true, message: 'Reconciliation complete', data: snap });
});

// ── B2C auth (public — register / login / refresh / logout) ───────────────
// authLimiter: 10 attempts per 15 min per IP — brute-force protection
app.use('/auth', authLimiter, authRouter);

// ── B2C user routes (JWT protected) ───────────────────────────────────────
// userLimiter: 60 req/min per JWT sub — applied to all /me routes
app.use('/me', requireUser, userLimiter, meRouter);

// ── B2B protected routes (API key) ────────────────────────────────────────
app.use(requireApiKey);
app.use(apiLimiter);                                  // 120 req/min global limit

app.use('/api/rates', quoteLimiter, ratesRouter);     // 300 req/min for quotes
app.use('/api/swaps', transferLimiter, swapsRouter);  // 20 req/min for swaps
app.use('/api/transfers', transferLimiter, transfersRouter); // 20 req/min for transfers
app.use('/api/wallets', walletsRouter);
app.use('/api/balance', balanceRouter);
app.use('/api/account', accountRouter);
app.use('/api/webhooks', webhooksRouter);
app.use('/api/virtual-accounts', virtualAccountsRouter);

app.use(errorHandler);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`\n🚀  Zeeh Africa Payments API`);
  console.log(`   Server  : http://localhost:${PORT}`);
  console.log(`   Docs    : http://localhost:${PORT}/docs`);
  console.log(`   Health  : http://localhost:${PORT}/health\n`);

  // ── Treasury reconciliation scheduler ─────────────────────────────────────
  // Runs every TREASURY_INTERVAL_MS (default 15 min). Logs to CloudWatch.
  // Any critical flag (shortfall, fraud) prints bold error lines.
  const intervalMs = parseInt(process.env.TREASURY_INTERVAL_MS ?? String(15 * 60 * 1000), 10);
  console.log(`🏦  Treasury reconciliation scheduled every ${intervalMs / 1000}s`);

  // Warm the wallet ID cache — resolves Expedier wallet IDs by currency code
  // so swap callers don't need to know or pass wallet IDs themselves.
  warmWalletCache().catch(err =>
    console.warn('⚠️  Wallet cache warm failed (non-fatal):', err),
  );

  // Initial run after 30s (give server time to stabilise)
  setTimeout(() => {
    runReconciliation('scheduled').catch(err =>
      console.error('Treasury reconciliation failed:', err),
    );
  }, 30_000);

  setInterval(() => {
    runReconciliation('scheduled').catch(err =>
      console.error('Treasury reconciliation failed:', err),
    );
  }, intervalMs);
});

export default app;
