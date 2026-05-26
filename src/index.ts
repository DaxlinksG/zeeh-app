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
import balanceRouter from './routes/balance';

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
app.use('/api/balance', balanceRouter);
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
