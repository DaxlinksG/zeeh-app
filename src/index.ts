import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { requireApiKey } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { requestId, httpLogger } from './middleware/logger';
import { apiLimiter, transferLimiter, quoteLimiter } from './middleware/rateLimiter';
import { openapiSpec } from './openapi';
import ratesRouter from './routes/rates';
import swapsRouter from './routes/swaps';
import transfersRouter from './routes/transfers';
import walletsRouter from './routes/wallets';
import accountRouter from './routes/account';
import webhooksRouter from './routes/webhooks';
import adminRouter from './routes/admin';

const app = express();

app.use(cors());
app.use(express.json());
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
  customCss: '.topbar { background-color: #1a1a2e; }',
  swaggerOptions: { persistAuthorization: true },
}));

// Webhook receiver — GTP calls this, no API key needed
app.post('/webhooks/receive', (req, res) => {
  const event = req.body as Record<string, unknown>;
  const eventType = event.type ?? event.event ?? 'unknown';
  const ts = new Date().toISOString();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`📨  WEBHOOK EVENT  [${ts}]`);
  console.log(`   Type   : ${eventType}`);
  const data = event.data as Record<string, unknown> | undefined;
  if (data) {
    const status   = data.status   ?? event.status;
    const amount   = data.amount   ?? event.amount;
    const currency = data.currency ?? event.currency;
    const ref      = data.reference ?? data.client_reference ?? data.transfer_id ?? data.swap_id;
    if (amount)   console.log(`   Amount : ${currency ?? ''} ${amount}`);
    if (status)   console.log(`   Status : ${status}`);
    if (ref)      console.log(`   Ref    : ${ref}`);
  }
  console.log(JSON.stringify(event, null, 2));
  console.log(`${'─'.repeat(60)}\n`);
  res.status(200).json({ received: true });
});

// ── Admin routes (x-admin-key, no client API key needed) ──────────────────
app.use('/admin', adminRouter);

// ── Protected routes ───────────────────────────────────────────────────────
app.use(requireApiKey);
app.use(apiLimiter);                                  // 120 req/min global limit

app.use('/api/rates', quoteLimiter, ratesRouter);     // 300 req/min for quotes
app.use('/api/swaps', transferLimiter, swapsRouter);  // 20 req/min for swaps
app.use('/api/transfers', transferLimiter, transfersRouter); // 20 req/min for transfers
app.use('/api/wallets', walletsRouter);
app.use('/api/account', accountRouter);
app.use('/api/webhooks', webhooksRouter);

app.use(errorHandler);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`\n🚀  Zeeh Africa Payments API`);
  console.log(`   Server  : http://localhost:${PORT}`);
  console.log(`   Docs    : http://localhost:${PORT}/docs`);
  console.log(`   Health  : http://localhost:${PORT}/health\n`);
});

export default app;
