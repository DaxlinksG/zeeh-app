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
import sendRouter from './routes/send';
import { requireUser } from './middleware/userAuth';
import { createPendingDeposit } from './lib/deposits';
import { runReconciliation, getSnapshots, getLatestSnapshot } from './lib/treasury';
import { getVirtualAccountByReference, recordVirtualAccountCredit } from './lib/virtualAccountStore';
import virtualAccountsRouter from './routes/virtualAccounts';
import currenciesRouter from './routes/currencies';
import { creditBalance } from './lib/ledger';
import { warmWalletCache } from './lib/walletCache';
import { updateKycStatus, getUserById, updateUser } from './lib/userStore';
import type { KycStatus } from './lib/userStore';
import { getPendingOrderForCustomer, getPendingReceiveOrderForCustomer, updateSendOrderStatus } from './lib/sendOrderStore';
import { rcCreatePayout, rcGetDeposit, rcGetPayout, rcExchangeQuote, rcExecuteExchange } from './lib/remitclickClient';
import { sendKycSubmitted, sendAdminKycAlert } from './lib/mailer';
import { getUserIdByKycSession } from './lib/kycSessionStore';
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
// Single express.json() call for all routes.
// For webhook routes, the `verify` callback captures the raw buffer for HMAC
// verification BEFORE JSON parsing happens — this is the correct Express pattern.
// The previous approach (custom raw-body listener + separate express.json()) caused
// "stream is not readable" because the stream was consumed twice.
app.use(express.json({
  limit: '8mb',
  verify: (req, _res, buf) => {
    const path = (req as express.Request).path;
    if (path === '/webhooks/receive' || path === '/webhooks/kyc' || path === '/webhooks/flutterwave' || path === '/webhooks/remitclick') {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    }
  },
}));
app.use(requestId);    // attach x-request-id to every request
app.use(httpLogger);   // log every HTTP request

// ── Public routes (no API key needed) ─────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PRIVACY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Privacy Policy — Zeeh Africa</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; color: #1a1a1a; line-height: 1.7; }
    header { background: #006D5B; color: #fff; padding: 40px 24px; text-align: center; }
    header h1 { font-size: 2rem; font-weight: 700; }
    header p { opacity: .8; margin-top: 8px; }
    main { max-width: 800px; margin: 40px auto; padding: 0 24px 80px; }
    h2 { font-size: 1.25rem; font-weight: 700; color: #006D5B; margin: 40px 0 12px; border-bottom: 2px solid #e8f4f2; padding-bottom: 8px; }
    p { margin-bottom: 12px; }
    ul { margin: 8px 0 12px 24px; }
    li { margin-bottom: 6px; }
    a { color: #006D5B; }
    .meta { background: #e8f4f2; border-radius: 8px; padding: 16px 20px; margin-bottom: 32px; font-size: .9rem; color: #1a3a36; }
    footer { text-align: center; padding: 24px; color: #888; font-size: .85rem; border-top: 1px solid #eee; margin-top: 60px; }
  </style>
</head>
<body>
<header>
  <h1>Zeeh Africa — Privacy Policy</h1>
  <p>Your privacy is important to us. Here's how we handle your data.</p>
</header>
<main>
  <div class="meta">
    <strong>Effective Date:</strong> July 1, 2026 &nbsp;|&nbsp;
    <strong>Last Updated:</strong> July 2026 &nbsp;|&nbsp;
    <strong>Company:</strong> Zeeh Africa Inc.
  </div>
  <h2>1. Who We Are</h2>
  <p>Zeeh Africa Inc. ("Zeeh", "we", "our", "us") is a cross-border money transfer platform that helps individuals send and receive money globally. We operate the Zeeh mobile app and the website zeehfi.ca.</p>
  <p>For privacy enquiries, contact us at: <a href="mailto:zeehafricah@gmail.com">zeehafricah@gmail.com</a></p>
  <h2>2. Information We Collect</h2>
  <p>We collect the following categories of information when you use our services:</p>
  <ul>
    <li><strong>Identity information:</strong> Full name, date of birth, government-issued ID (passport, driver's licence)</li>
    <li><strong>Contact information:</strong> Email address, phone number, residential address</li>
    <li><strong>Financial information:</strong> Bank account details of recipients, transaction amounts and history, wallet balances</li>
    <li><strong>Device information:</strong> Device type, operating system, IP address, app version</li>
    <li><strong>Usage data:</strong> How you interact with the app, features used, session duration</li>
    <li><strong>KYC/Verification data:</strong> Identity document images, selfie/liveness data collected during identity verification</li>
  </ul>
  <h2>3. How We Use Your Information</h2>
  <ul>
    <li>To process your money transfers and maintain your wallet balance</li>
    <li>To verify your identity as required by law (KYC/AML compliance)</li>
    <li>To detect and prevent fraud, money laundering, and other illegal activity</li>
    <li>To send you transaction confirmations, receipts, and account alerts</li>
    <li>To comply with regulatory obligations (FINTRAC, CBN, NDPR, PIPEDA)</li>
    <li>To improve our services and fix technical issues</li>
    <li>To respond to your support requests</li>
  </ul>
  <h2>4. Legal Basis for Processing</h2>
  <p>We process your personal data on the following legal bases:</p>
  <ul>
    <li><strong>Contract:</strong> Processing is necessary to provide the money transfer service you requested</li>
    <li><strong>Legal obligation:</strong> We are required by law to verify identities and report certain transactions to regulators</li>
    <li><strong>Legitimate interests:</strong> Fraud prevention, security, and improving our service</li>
    <li><strong>Consent:</strong> Where we have asked for and received your explicit consent</li>
  </ul>
  <h2>5. How We Share Your Information</h2>
  <p>We do not sell your personal data. We may share your information with:</p>
  <ul>
    <li><strong>Payment processors and banking partners:</strong> To execute your transfers (e.g., correspondent banks, mobile money providers)</li>
    <li><strong>Identity verification providers:</strong> To complete KYC checks as required by law</li>
    <li><strong>Regulatory authorities:</strong> FINTRAC (Canada), CBN (Nigeria), and other regulators as required by applicable law</li>
    <li><strong>Cloud service providers:</strong> AWS (data storage and infrastructure) — bound by data processing agreements</li>
    <li><strong>Professional advisors:</strong> Lawyers, accountants, and auditors under confidentiality obligations</li>
  </ul>
  <p>All third parties are vetted and contractually required to protect your data.</p>
  <h2>6. Data Retention</h2>
  <p>We retain your personal data for as long as your account is active and for a minimum of <strong>5 years</strong> after account closure, as required by anti-money laundering regulations. Transaction records are retained for at least 5 years from the date of the transaction.</p>
  <h2>7. Your Rights</h2>
  <p>Depending on your jurisdiction, you may have the right to:</p>
  <ul>
    <li>Access the personal data we hold about you</li>
    <li>Correct inaccurate or incomplete data</li>
    <li>Request deletion of your data (subject to legal retention requirements)</li>
    <li>Withdraw consent where processing is based on consent</li>
    <li>Lodge a complaint with your local data protection authority</li>
  </ul>
  <p>To exercise any of these rights, email us at <a href="mailto:zeehafricah@gmail.com">zeehafricah@gmail.com</a>. We will respond within 30 days.</p>
  <h2>8. Data Security</h2>
  <p>We implement industry-standard security measures to protect your data:</p>
  <ul>
    <li>All data is encrypted in transit (TLS 1.2+) and at rest (AES-256)</li>
    <li>Access to personal data is restricted to authorised personnel only</li>
    <li>We conduct regular security reviews and penetration testing</li>
    <li>Multi-factor authentication is enforced for all staff with data access</li>
  </ul>
  <h2>9. International Data Transfers</h2>
  <p>As a cross-border payments service, your data may be processed in Canada, Nigeria, and other countries where our service providers operate. We ensure appropriate safeguards are in place for any international transfer, including standard contractual clauses where applicable.</p>
  <h2>10. Cookies and Tracking</h2>
  <p>Our mobile app does not use tracking cookies. We collect anonymised usage analytics to improve the app. We do not share analytics data with advertisers.</p>
  <h2>11. Children's Privacy</h2>
  <p>Our services are not directed to individuals under the age of 18. We do not knowingly collect personal data from minors. If you believe we have inadvertently collected such data, please contact us immediately.</p>
  <h2>12. Changes to This Policy</h2>
  <p>We may update this Privacy Policy from time to time. We will notify you of material changes via the app or by email. Continued use of the service after changes constitutes acceptance of the updated policy.</p>
  <h2>13. Contact Us</h2>
  <p>For any privacy-related questions, requests, or complaints:</p>
  <ul>
    <li><strong>Email:</strong> <a href="mailto:zeehafricah@gmail.com">zeehafricah@gmail.com</a></li>
    <li><strong>Website:</strong> <a href="https://zeehfi.ca">zeehfi.ca</a></li>
    <li><strong>Company:</strong> Zeeh Africa Inc., Canada</li>
  </ul>
</main>
<footer>&copy; 2026 Zeeh Africa Inc. All rights reserved. &nbsp;|&nbsp; <a href="https://zeehfi.ca">zeehfi.ca</a></footer>
</body>
</html>`;

const DELETE_ACCOUNT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Delete Account — zeehfi</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; color: #1a1a1a; line-height: 1.7; }
    header { background: #006D5B; color: #fff; padding: 40px 24px; text-align: center; }
    header h1 { font-size: 1.8rem; font-weight: 700; }
    header p { opacity: .8; margin-top: 8px; }
    main { max-width: 680px; margin: 40px auto; padding: 0 24px 80px; }
    .card { background: #fff; border-radius: 12px; padding: 32px; margin-bottom: 24px; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    h2 { font-size: 1.15rem; font-weight: 700; color: #006D5B; margin-bottom: 12px; }
    p { margin-bottom: 12px; color: #333; }
    ol, ul { margin: 8px 0 12px 24px; }
    li { margin-bottom: 8px; }
    .warn { background: #fff8e1; border-left: 4px solid #f59e0b; padding: 16px 20px; border-radius: 8px; margin: 20px 0; font-size: .95rem; }
    a { color: #006D5B; font-weight: 600; }
    .btn { display: inline-block; background: #006D5B; color: #fff; padding: 14px 32px; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 8px; }
    .btn:hover { background: #005548; }
    footer { text-align: center; padding: 24px; color: #888; font-size: .85rem; border-top: 1px solid #eee; margin-top: 40px; }
  </style>
</head>
<body>
<header>
  <h1>Delete Your zeehfi Account</h1>
  <p>We're sorry to see you go. Here's how to request account deletion.</p>
</header>
<main>
  <div class="card">
    <h2>How to Request Account Deletion</h2>
    <p>To delete your zeehfi account and associated data, send an email to our support team:</p>
    <ol>
      <li>Email <a href="mailto:zeehafricah@gmail.com">zeehafricah@gmail.com</a> with the subject line: <strong>"Account Deletion Request"</strong></li>
      <li>Include the email address registered to your zeehfi account</li>
      <li>We will verify your identity and confirm the deletion within <strong>5 business days</strong></li>
    </ol>
    <a class="btn" href="mailto:zeehafricah@gmail.com?subject=Account%20Deletion%20Request&body=Please%20delete%20my%20zeehfi%20account.%20My%20registered%20email%20is%3A%20">Request Deletion via Email</a>
  </div>
  <div class="card">
    <h2>What Data Is Deleted</h2>
    <p>When your account is deleted, the following data is permanently removed:</p>
    <ul>
      <li>Your name, email address, and phone number</li>
      <li>Your profile and account settings</li>
      <li>Saved beneficiaries and preferences</li>
      <li>KYC verification data (identity documents and selfie)</li>
    </ul>
    <h2 style="margin-top: 20px;">What Data Is Retained</h2>
    <p>Certain data must be retained to comply with financial regulations (FINTRAC, CBN, AML/CFT laws):</p>
    <ul>
      <li><strong>Transaction records</strong> — retained for a minimum of 5 years as required by Canadian anti-money laundering law</li>
      <li><strong>Regulatory reports</strong> — any reports filed with FINTRAC or other authorities cannot be deleted</li>
    </ul>
    <div class="warn">&#9888;&#65039; Account deletion is permanent and cannot be undone. Any remaining wallet balance must be withdrawn before requesting deletion.</div>
  </div>
  <div class="card">
    <h2>Contact Support</h2>
    <p>If you have questions about your data or the deletion process, contact us at:</p>
    <p><a href="mailto:zeehafricah@gmail.com">zeehafricah@gmail.com</a></p>
    <p>We aim to respond within 2 business days.</p>
  </div>
</main>
<footer>&copy; 2026 Zeeh Africa Inc. &nbsp;|&nbsp; <a href="https://api.zeehfi.ca/privacy">Privacy Policy</a> &nbsp;|&nbsp; <a href="https://zeehfi.ca">zeehfi.ca</a></footer>
</body>
</html>`;

app.get('/privacy', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(PRIVACY_HTML);
});

app.get('/delete-account', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(DELETE_ACCOUNT_HTML);
});

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
// Payload:  { "event": "session.approved", "session_id": "ses_...", "timestamp": <unix>, "data": { ... } }
// Header:   X-KYC-Signature: t=<unix-timestamp>,v1=<hmac-sha256-hex>  (Stripe-style)
// HMAC key: KYC_WEBHOOK_SECRET
// HMAC input: `${t}.${rawBody}`
// Events:   session.approved | session.rejected | session.manual_review
//
app.post('/webhooks/kyc', async (req, res) => {
  const rawBody          = (req as express.Request & { rawBody?: Buffer }).rawBody;
  const kycWebhookSecret = process.env.KYC_WEBHOOK_SECRET;

  // ── Signature verification ─────────────────────────────────────────────────
  // Header: "X-KYC-Signature: t=1782039793,v1=725376909ffb5a..." (Stripe-style)
  // Parse comma-separated key=value pairs → { t, v1 }
  // HMAC is computed over "${t}.${rawBody}"
  if (kycWebhookSecret) {
    const sigHeader = (req.headers['x-kyc-signature'] ?? '') as string;
    if (!sigHeader || !rawBody) {
      console.warn('⚠️  KYC webhook missing signature or body — rejected');
      res.status(401).json({ error: 'Missing signature' }); return;
    }
    const parts: Record<string, string> = {};
    for (const pair of sigHeader.split(',')) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx === -1) continue;
      parts[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
    }
    const ts       = parts.t;
    const received = parts.v1;
    if (!ts || !received) {
      console.warn('⚠️  KYC webhook unexpected signature format:', sigHeader.slice(0, 60));
      res.status(401).json({ error: 'Unsupported signature format' }); return;
    }
    const { createHmac, timingSafeEqual } = await import('crypto');
    const signingInput = `${ts}.${rawBody.toString('utf-8')}`;
    const expected = createHmac('sha256', kycWebhookSecret).update(signingInput).digest('hex');
    try {
      if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))) {
        console.warn('⚠️  KYC webhook signature mismatch');
        res.status(401).json({ error: 'Invalid signature' }); return;
      }
    } catch {
      console.warn('⚠️  KYC webhook signature format error');
      res.status(401).json({ error: 'Invalid signature' }); return;
    }
  } else {
    console.warn('⚠️  KYC_WEBHOOK_SECRET not set — skipping signature check');
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

  // Support both "event" and "type" field names
  const eventType  = String(event.event ?? event.type ?? '');
  const data       = event.data as Record<string, unknown> | undefined;
  const sessionId  = String(event.session_id ?? data?.session_id ?? data?.id ?? '');
  // external_id is now top-level in the confirmed payload format
  const externalId = String(event.external_id ?? data?.external_id ?? '');

  console.log(`📨  KYC WEBHOOK: ${eventType}  session=${sessionId}  user=${externalId || '(unknown)'}`);

  // Ack non-actionable events (ping tests etc.)
  if (!['session.approved', 'session.rejected', 'session.manual_review'].includes(eventType)) {
    res.status(200).json({ received: true }); return;
  }

  // ── Resolve user_id — three independent paths ─────────────────────────────
  //
  // 1. Our own session table (most reliable — stored by us at session creation,
  //    completely independent of the KYC provider's external_id behaviour).
  // 2. external_id from the webhook payload (works once provider fixes their end).
  // 3. Fetch session from kyc.zeehfi.ca (last resort — may also return null).
  //
  let userId = '';

  // Path 1 — our own mapping table
  if (!userId && sessionId) {
    try {
      userId = await getUserIdByKycSession(sessionId) ?? '';
      if (userId) console.log(`✅  KYC webhook: resolved user via session table — ${userId}`);
    } catch (e) {
      console.error('⚠️  KYC webhook: session table lookup failed', e);
    }
  }

  // Path 2 — external_id from payload
  if (!userId && externalId) {
    userId = externalId;
    console.log(`✅  KYC webhook: resolved user via external_id — ${userId}`);
  }

  // Path 3 — fetch from KYC provider as last resort
  if (!userId && sessionId) {
    try {
      const kycBase   = process.env.KYC_SERVICE_URL ?? 'https://kyc.zeehfi.ca';
      const kycApiKey = process.env.KYC_API_KEY!;
      const { data: kycSession } = await axios.get(`${kycBase}/v1/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${kycApiKey}` }, timeout: 8000,
      });
      userId = String((kycSession as Record<string, unknown>).external_id ?? '');
      if (userId) console.log(`✅  KYC webhook: resolved user via provider session fetch — ${userId}`);
    } catch (fetchErr) {
      console.error('⚠️  KYC webhook: all resolution paths failed for session', sessionId, fetchErr);
    }
  }

  if (!userId) {
    console.error('⚠️  KYC webhook: cannot resolve user_id for session', sessionId);
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

// ── Flutterwave webhook ────────────────────────────────────────────────────
// Verifies HMAC-SHA256 signature (flutterwave-signature header, base64 encoded).
// Handles transfer.completed and transfer.failed events.
// FLW_WEBHOOK_HASH must match the secret hash configured in the Flutterwave dashboard.
app.post('/webhooks/flutterwave', async (req, res) => {
  const { createHmac } = await import('crypto');
  const flwWebhookHash = process.env.FLW_WEBHOOK_HASH ?? '';
  const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;

  // Verify signature if hash is configured
  if (flwWebhookHash && rawBody) {
    const signature = req.headers['flutterwave-signature'] as string | undefined;
    if (!signature) {
      console.warn('⚠️  Flutterwave webhook: missing flutterwave-signature header');
      res.status(401).json({ error: 'Missing signature' });
      return;
    }
    const expected = createHmac('sha256', flwWebhookHash)
      .update(rawBody)
      .digest('base64');
    if (signature !== expected) {
      console.warn('⚠️  Flutterwave webhook: signature mismatch');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }
  }

  const event = req.body as Record<string, unknown>;
  const eventType = event?.type as string | undefined;
  const data      = event?.data as Record<string, unknown> | undefined;

  console.log(`📨  Flutterwave webhook: type=${eventType}`);

  // transfer.completed — payout succeeded
  if (eventType === 'transfer.completed') {
    const reference  = data?.reference as string | undefined;
    const status     = data?.status    as string | undefined;
    console.log(`✅  FLW transfer completed: reference=${reference} status=${status}`);
    // Future: notify B2B client webhook here
  }

  // transfer.failed — payout failed; refund will have already been attempted
  // at the API call layer (see transfers.ts), but log it for ops visibility.
  if (eventType === 'transfer.failed') {
    const reference = data?.reference as string | undefined;
    const reason    = data?.reason    as string | undefined;
    console.error(`❌  FLW transfer failed: reference=${reference} reason=${reason}`);
    // Future: trigger refund lookup + notify B2B client
  }

  res.status(200).json({ received: true });
});

// ── RemitClick webhook ─────────────────────────────────────────────────────
// Events: deposit.completed, payout.completed, payout.failed
app.post('/webhooks/remitclick', express.json(), async (req, res) => {
  const sig = req.headers['x-remitclick-signature'] as string | undefined;
  const secret = process.env.RC_WEBHOOK_SECRET;

  // Verify HMAC-SHA256: signed material is "{timestamp}.{rawBody}"
  if (secret && sig) {
    const match = sig.match(/t=(\d+),v1=([a-f0-9]+)/);
    if (match) {
      const [, ts, v1] = match;
      const expected = require('crypto')
        .createHmac('sha256', secret)
        .update(`${ts}.${JSON.stringify(req.body)}`)
        .digest('hex');
      if (expected !== v1) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }
  }

  const { type, data } = req.body as { type: string; data: Record<string, unknown> };

  if (type === 'deposit.completed') {
    const rcCustomerId = data.customerId as string;
    const depositId = data.id as string;

    // Verify this deposit actually exists and is completed in RemitClick's system.
    // This is our primary protection against spoofed webhook events (RC has no signing secrets).
    let verifiedDeposit;
    try {
      verifiedDeposit = await rcGetDeposit(depositId);
    } catch {
      console.warn('[RC webhook] deposit.completed — deposit not found in RC, ignoring', depositId);
      return res.status(200).json({ received: true }); // ack to stop retries, but don't act
    }

    if (verifiedDeposit.status !== 'completed' || verifiedDeposit.customerId !== rcCustomerId) {
      console.warn('[RC webhook] deposit.completed — verification mismatch, ignoring', depositId);
      return res.status(200).json({ received: true });
    }

    const depositCurrency = (verifiedDeposit.currency ?? '').toUpperCase();

    // ── CAD→NGN: Interac CAD deposit matched — fire NGN payout ──
    if (depositCurrency === 'CAD') {
      const order = await getPendingOrderForCustomer(rcCustomerId).catch(() => null);
      if (order && order.direction === 'CAD_NGN') {
        try {
          await updateSendOrderStatus(order.order_id, 'cad_received', { rc_deposit_id: depositId });
          const payout = await rcCreatePayout({
            amount: order.ngn_amount,
            currency: 'NGN',
            sourceCurrency: 'CAD',
            recipient: {
              accountNumber: order.recipient_account!,
              bankCode: order.recipient_bank_code!,
              accountName: order.recipient_name!,
              bankName: order.recipient_bank_name,
              currency: 'NGN',
            },
            customerId: rcCustomerId,
            reference: order.order_id,
          });
          await updateSendOrderStatus(order.order_id, 'payout_initiated', { rc_payout_id: payout.id });
        } catch (err) {
          console.error('[RC webhook] CAD→NGN payout failed for order', order?.order_id, err);
        }
      }
    }

    // ── NGN→CAD: NGN virtual-account deposit — exchange to CAD, credit wallet ──
    if (depositCurrency === 'NGN') {
      const order = await getPendingReceiveOrderForCustomer(rcCustomerId).catch(() => null);
      if (order && order.direction === 'NGN_CAD') {
        try {
          await updateSendOrderStatus(order.order_id, 'ngn_received', { rc_deposit_id: depositId });

          // Lock exchange quote then execute (NGN business wallet → CAD business wallet)
          const exchangeQuote = await rcExchangeQuote('NGN', 'CAD', verifiedDeposit.amount);
          const exchange = await rcExecuteExchange(exchangeQuote.id);

          await updateSendOrderStatus(order.order_id, 'payout_initiated', { rc_exchange_id: exchange.id });

          // Credit the Zeeh user's CAD ledger balance
          const cadReceived = exchange.convertedAmount.toFixed(2);
          await creditBalance(order.user_id, 'CAD', cadReceived, order.order_id, `NGN→CAD receive order ${order.order_id}`);

          await updateSendOrderStatus(order.order_id, 'completed', { completed_at: new Date().toISOString() });
        } catch (err) {
          console.error('[RC webhook] NGN→CAD exchange failed for order', order?.order_id, err);
          await updateSendOrderStatus(order.order_id, 'failed', {
            failure_reason: 'Exchange failed. Contact support.',
          }).catch(() => {});
        }
      }
    }
  }

  if (type === 'payout.completed') {
    const reference = data.reference as string | undefined;
    const payoutId = data.id as string;

    // Verify payout status with RC before marking order complete
    try {
      const verifiedPayout = await rcGetPayout(payoutId);
      if (verifiedPayout.status !== 'completed' || verifiedPayout.reference !== reference) {
        return res.status(200).json({ received: true });
      }
    } catch {
      return res.status(200).json({ received: true });
    }

    if (reference) {
      await updateSendOrderStatus(reference, 'completed', {
        completed_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  if (type === 'payout.failed') {
    const reference = data.reference as string | undefined;
    const payoutId = data.id as string;

    // Verify with RC before marking failed
    try {
      const verifiedPayout = await rcGetPayout(payoutId);
      if (verifiedPayout.status !== 'failed' || verifiedPayout.reference !== reference) {
        return res.status(200).json({ received: true });
      }
    } catch {
      return res.status(200).json({ received: true });
    }

    if (reference) {
      await updateSendOrderStatus(reference, 'failed', {
        failure_reason: (data.failureReason as string) ?? 'RemitClick payout failed',
      }).catch(() => {});
    }
  }

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
app.use('/me/send', requireUser, userLimiter, sendRouter);

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
app.use('/api/currencies', currenciesRouter);

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
