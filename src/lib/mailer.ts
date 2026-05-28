/**
 * Mailer — transactional email via Resend + Slack webhook alerts
 *
 * Every send is fire-and-forget (never throws). Failures are logged
 * to console/CloudWatch so emails don't crash the API.
 *
 * Required env vars:
 *   RESEND_API_KEY   — from resend.com dashboard
 *   EMAIL_FROM       — "Zeeh Africa <noreply@zeehfi.ca>"
 *   EMAIL_REPLY_TO   — support@zeehfi.ca
 *   ALERT_EMAIL      — internal address for critical alerts
 *   SLACK_WEBHOOK_URL — optional, for treasury/fraud alerts
 *   APP_URL          — https://app.zeehfi.ca
 */

import { Resend } from 'resend';

// Instantiated lazily so a missing RESEND_API_KEY doesn't crash the server at boot.
// All sends are no-ops when the key is absent (logged to console instead).
let _resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const FROM      = process.env.EMAIL_FROM     ?? 'Zeeh Africa <noreply@zeehfi.ca>';
const REPLY_TO  = process.env.EMAIL_REPLY_TO ?? 'support@zeehfi.ca';
const ALERT_TO  = process.env.ALERT_EMAIL    ?? '';
const APP_URL   = process.env.APP_URL        ?? 'https://app.zeehfi.ca';

// ── Base template ─────────────────────────────────────────────────────────────

function baseTemplate(title: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:#0f1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0f1117;padding:40px 16px">
<tr><td align="center">
<table width="100%" style="max-width:560px" cellpadding="0" cellspacing="0">

  <!-- Logo -->
  <tr><td style="padding-bottom:24px">
    <span style="font-size:22px;font-weight:700;color:#e8eaf0;letter-spacing:-0.3px">
      Zeeh <span style="color:#00d4aa">Africa</span>
    </span>
  </td></tr>

  <!-- Card -->
  <tr><td style="background:#1a1d27;border:1px solid #2a2d3a;border-radius:16px;overflow:hidden">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding:32px 32px 24px">
        ${body}
      </td></tr>
      <tr><td style="padding:16px 32px 20px;border-top:1px solid #2a2d3a;font-size:12px;color:#7b7f9e;line-height:1.6">
        Zeeh Africa Financial Services &nbsp;·&nbsp; <a href="${APP_URL}" style="color:#6c63ff;text-decoration:none">${APP_URL}</a><br>
        If you didn't request this email, please ignore it or <a href="mailto:${REPLY_TO}" style="color:#6c63ff;text-decoration:none">contact support</a>.
      </td></tr>
    </table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

function h1(text: string) {
  return `<h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:#e8eaf0;letter-spacing:-0.3px">${text}</h1>`;
}
function p(text: string) {
  return `<p style="margin:0 0 16px;font-size:15px;color:#b0b3c6;line-height:1.6">${text}</p>`;
}
function muted(text: string) {
  return `<p style="margin:0 0 16px;font-size:13px;color:#7b7f9e;line-height:1.6">${text}</p>`;
}
function highlight(label: string, value: string, mono = false) {
  return `
  <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:8px">
  <tr>
    <td style="background:#0f1117;border:1px solid #2a2d3a;border-radius:8px;padding:12px 16px">
      <div style="font-size:11px;color:#7b7f9e;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px">${label}</div>
      <div style="font-size:15px;font-weight:600;color:#e8eaf0;${mono ? 'font-family:monospace;letter-spacing:0.05em' : ''}">${value}</div>
    </td>
  </tr>
  </table>`;
}
function bigAmount(amount: string, currency: string, color = '#00d4aa') {
  return `<div style="text-align:center;padding:20px 0">
    <div style="font-size:36px;font-weight:700;color:${color};letter-spacing:-1px">${currency} ${amount}</div>
  </div>`;
}
function cta(text: string, url: string) {
  return `<div style="text-align:center;margin:24px 0 8px">
    <a href="${url}" style="display:inline-block;background:#6c63ff;color:#fff;font-size:15px;font-weight:600;padding:12px 32px;border-radius:8px;text-decoration:none">${text}</a>
  </div>`;
}
function divider() {
  return `<hr style="border:none;border-top:1px solid #2a2d3a;margin:20px 0">`;
}

// ── Internal send helper ─────────────────────────────────────────────────────

async function send(to: string, subject: string, html: string): Promise<void> {
  const client = getResend();
  if (!client) {
    console.log(`📧 [MAILER] No RESEND_API_KEY — would send "${subject}" to ${to}`);
    return;
  }
  try {
    const { error } = await client.emails.send({ from: FROM, replyTo: REPLY_TO, to, subject, html });
    if (error) {
      console.error(`📧 [MAILER] Resend error sending "${subject}" to ${to}:`, JSON.stringify(error));
    }
  } catch (err) {
    console.error(`📧 [MAILER] Failed to send "${subject}" to ${to}:`, err);
  }
}

// ── Slack helper ─────────────────────────────────────────────────────────────

export async function sendSlackAlert(text: string, blocks?: unknown[]): Promise<void> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
    });
  } catch (err) {
    console.error('[SLACK] Failed to send alert:', err);
  }
}

// ── B2C: Welcome + OTP ───────────────────────────────────────────────────────

export async function sendWelcomeOtp(to: string, firstName: string, otp: string): Promise<void> {
  const html = baseTemplate('Verify your Zeeh Africa account', `
    ${h1(`Welcome, ${firstName}! 👋`)}
    ${p('Your account has been created. Enter the code below to verify your email address.')}
    <div style="text-align:center;margin:28px 0">
      <div style="display:inline-block;background:#0f1117;border:2px solid #6c63ff;border-radius:12px;padding:18px 36px">
        <div style="font-size:38px;font-weight:700;color:#6c63ff;letter-spacing:10px;font-family:monospace">${otp}</div>
      </div>
      <div style="margin-top:10px;font-size:13px;color:#7b7f9e">This code expires in 10 minutes</div>
    </div>
    ${p("If you didn't create an account, you can safely ignore this email.")}
  `);
  await send(to, 'Your Zeeh Africa verification code', html);
}

// ── B2C: Email verified ───────────────────────────────────────────────────────

export async function sendEmailVerified(to: string, firstName: string): Promise<void> {
  const html = baseTemplate('Email verified', `
    ${h1('Email verified ✅')}
    ${p(`Great, ${firstName}! Your email has been verified. You can now complete identity verification to unlock transfers and currency exchange.`)}
    ${cta('Complete KYC', `${APP_URL}/kyc`)}
    ${muted('KYC verification is required for cross-border transfers and currency swaps.')}
  `);
  await send(to, 'Email verified — next: complete your KYC', html);
}

// ── B2C: OTP resend ───────────────────────────────────────────────────────────

export async function sendOtpResend(to: string, firstName: string, otp: string): Promise<void> {
  const html = baseTemplate('New verification code', `
    ${h1('New verification code')}
    ${p(`Hi ${firstName}, here's your new Zeeh Africa verification code:`)}
    <div style="text-align:center;margin:28px 0">
      <div style="display:inline-block;background:#0f1117;border:2px solid #6c63ff;border-radius:12px;padding:18px 36px">
        <div style="font-size:38px;font-weight:700;color:#6c63ff;letter-spacing:10px;font-family:monospace">${otp}</div>
      </div>
      <div style="margin-top:10px;font-size:13px;color:#7b7f9e">Expires in 10 minutes</div>
    </div>
  `);
  await send(to, 'New Zeeh Africa verification code', html);
}

// ── B2C: Password reset ───────────────────────────────────────────────────────

export async function sendPasswordReset(to: string, firstName: string, resetUrl: string): Promise<void> {
  const html = baseTemplate('Reset your password', `
    ${h1('Reset your password')}
    ${p(`Hi ${firstName}, we received a request to reset your Zeeh Africa password.`)}
    ${cta('Reset Password', resetUrl)}
    ${muted('This link expires in 30 minutes. If you did not request a password reset, you can safely ignore this email — your password has not changed.')}
  `);
  await send(to, 'Reset your Zeeh Africa password', html);
}

// ── B2C: KYC submitted ───────────────────────────────────────────────────────

export async function sendKycSubmitted(to: string, firstName: string): Promise<void> {
  const html = baseTemplate('KYC under review', `
    ${h1('We\'re reviewing your documents 🔍')}
    ${p(`Hi ${firstName}, we've received your identity verification documents and our team is reviewing them.`)}
    ${p('This usually takes 1–2 business days. We\'ll email you as soon as a decision has been made.')}
    ${muted('You can continue using your account for deposits and internal transfers while verification is in progress.')}
  `);
  await send(to, 'Your KYC is under review', html);
}

// ── B2C: KYC approved ────────────────────────────────────────────────────────

export async function sendKycApproved(to: string, firstName: string): Promise<void> {
  const html = baseTemplate('KYC approved!', `
    ${h1('You\'re verified! 🎉')}
    ${p(`Congratulations ${firstName}! Your identity has been verified. You now have full access to:`)}
    <ul style="margin:0 0 20px;padding:0 0 0 20px;color:#b0b3c6;font-size:15px;line-height:2">
      <li>Cross-border bank transfers</li>
      <li>Currency exchange (CAD, USD, NGN, GBP, EUR)</li>
      <li>Higher transaction limits</li>
    </ul>
    ${cta('Start transferring', `${APP_URL}/transfer`)}
  `);
  await send(to, '✅ KYC approved — you\'re fully verified', html);
}

// ── B2C: KYC rejected ────────────────────────────────────────────────────────

export async function sendKycRejected(to: string, firstName: string, reason: string): Promise<void> {
  const html = baseTemplate('KYC not approved', `
    ${h1('Identity verification not approved')}
    ${p(`Hi ${firstName}, we were unable to verify your identity with the documents provided.`)}
    ${highlight('Reason', reason)}
    ${p('Please resubmit with clear, valid documents. Common issues: blurry photos, expired ID, name mismatch.')}
    ${cta('Resubmit KYC', `${APP_URL}/kyc`)}
    ${muted('If you believe this is an error, please contact our support team.')}
  `);
  await send(to, 'Action required: KYC verification not approved', html);
}

// ── B2C: Deposit credited ────────────────────────────────────────────────────

export async function sendDepositCredited(to: string, firstName: string, currency: string, amount: string, newBalance: string): Promise<void> {
  const html = baseTemplate('Deposit received', `
    ${h1('Funds received 💰')}
    ${p(`Hi ${firstName}, your deposit has been confirmed and credited to your account.`)}
    ${bigAmount(amount, currency)}
    ${highlight('New balance', `${currency} ${newBalance}`)}
    ${cta('View balance', `${APP_URL}/dashboard`)}
    ${muted('If you didn\'t make this deposit, contact support immediately.')}
  `);
  await send(to, `${currency} ${amount} deposited to your Zeeh account`, html);
}

// ── B2C: Money received (P2P) ────────────────────────────────────────────────

export async function sendMoneyReceived(to: string, firstName: string, fromName: string, currency: string, amount: string): Promise<void> {
  const html = baseTemplate('Money received', `
    ${h1('You received money! 🎉')}
    ${p(`Hi ${firstName}, <strong style="color:#e8eaf0">${fromName}</strong> just sent you:`)}
    ${bigAmount(amount, currency)}
    ${cta('View account', `${APP_URL}/dashboard`)}
  `);
  await send(to, `${fromName} sent you ${currency} ${amount}`, html);
}

// ── B2C: Money sent (P2P) ────────────────────────────────────────────────────

export async function sendMoneySent(to: string, firstName: string, toEmail: string, currency: string, amount: string, reference: string): Promise<void> {
  const html = baseTemplate('Transfer sent', `
    ${h1('Transfer sent ✅')}
    ${p(`Hi ${firstName}, your transfer has been processed.`)}
    ${bigAmount(amount, currency, '#ff4d6d')}
    ${highlight('Recipient', toEmail)}
    ${highlight('Reference', reference, true)}
    ${muted('If you didn\'t make this transfer, contact support immediately.')}
  `);
  await send(to, `You sent ${currency} ${amount} via Zeeh`, html);
}

// ── B2C: Swap completed ───────────────────────────────────────────────────────

export async function sendSwapCompleted(to: string, firstName: string, fromCur: string, fromAmt: string, toCur: string, toAmt: string, rate: string): Promise<void> {
  const html = baseTemplate('Currency exchange complete', `
    ${h1('Exchange complete ✅')}
    ${p(`Hi ${firstName}, your currency exchange has been executed.`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0">
    <tr>
      <td style="background:#0f1117;border:1px solid #2a2d3a;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:13px;color:#7b7f9e;margin-bottom:4px">You sent</div>
        <div style="font-size:24px;font-weight:700;color:#ff4d6d">${fromCur} ${fromAmt}</div>
      </td>
      <td style="width:32px;text-align:center;font-size:20px;color:#7b7f9e">→</td>
      <td style="background:#0f1117;border:1px solid #2a2d3a;border-radius:8px;padding:16px;text-align:center">
        <div style="font-size:13px;color:#7b7f9e;margin-bottom:4px">You received</div>
        <div style="font-size:24px;font-weight:700;color:#00d4aa">${toCur} ${toAmt}</div>
      </td>
    </tr>
    </table>
    ${highlight('Exchange rate', `1 ${fromCur} = ${rate} ${toCur}`)}
    ${cta('View account', `${APP_URL}/dashboard`)}
  `);
  await send(to, `Exchange complete: ${fromCur} ${fromAmt} → ${toCur} ${toAmt}`, html);
}

// ── B2C: Transfer initiated (bank off-ramp) ──────────────────────────────────

export async function sendTransferInitiated(to: string, firstName: string, currency: string, amount: string, reference: string): Promise<void> {
  const html = baseTemplate('Transfer initiated', `
    ${h1('Transfer in progress ⏳')}
    ${p(`Hi ${firstName}, your bank transfer has been submitted and is being processed by our network.`)}
    ${bigAmount(amount, currency, '#ff4d6d')}
    ${highlight('Reference', reference, true)}
    ${p('Bank transfers typically settle within 1–3 business days depending on the destination.')}
    ${muted('Keep this reference number for your records.')}
  `);
  await send(to, `${currency} ${amount} transfer initiated`, html);
}

// ── B2B: API key created ─────────────────────────────────────────────────────

export async function sendApiKeyCreated(to: string, clientName: string, keyId: string, rawKey: string): Promise<void> {
  const html = baseTemplate('Your Zeeh Africa API key', `
    ${h1('API key created 🔑')}
    ${p(`Hi ${clientName}, your Zeeh Africa API key has been created. This key is shown <strong style="color:#ff4d6d">once only</strong> — save it securely.`)}
    <div style="background:#0f1117;border:2px solid #ff4d6d;border-radius:8px;padding:16px;margin:16px 0;word-break:break-all;font-family:monospace;font-size:14px;color:#ff4d6d">${rawKey}</div>
    ${highlight('Key ID', keyId, true)}
    ${divider()}
    <p style="margin:0 0 8px;font-size:13px;color:#7b7f9e">Add to every request:</p>
    <div style="background:#0f1117;border:1px solid #2a2d3a;border-radius:8px;padding:14px;font-family:monospace;font-size:13px;color:#9b96ff">x-api-key: ${rawKey}</div>
    ${divider()}
    ${muted('If you didn\'t request this key or it\'s lost, contact us immediately to revoke it.')}
  `);
  await send(to, 'Your Zeeh Africa API key (save now — shown once)', html);
}

// ── B2B: API key revoked ─────────────────────────────────────────────────────

export async function sendApiKeyRevoked(to: string, clientName: string, keyId: string): Promise<void> {
  const html = baseTemplate('API key revoked', `
    ${h1('API key revoked ⛔')}
    ${p(`Hi ${clientName}, an API key on your Zeeh Africa account has been revoked.`)}
    ${highlight('Key ID', keyId, true)}
    ${p('All requests using this key will now return 401. If this was unintentional, contact support.')}
  `);
  await send(to, `Zeeh API key revoked: ${keyId}`, html);
}

// ── Admin: new KYC submission ─────────────────────────────────────────────────

export async function sendAdminKycAlert(userEmail: string, userId: string, fullName: string): Promise<void> {
  if (!ALERT_TO) return;
  const html = baseTemplate('New KYC submission', `
    ${h1('New KYC submission 🔍')}
    ${p('A user has submitted identity verification documents for review.')}
    ${highlight('Name', fullName)}
    ${highlight('Email', userEmail)}
    ${highlight('User ID', userId, true)}
    ${cta('Review in Admin', `https://admin.zeehfi.ca`)}
  `);
  await send(ALERT_TO, `KYC review needed: ${fullName} (${userEmail})`, html);
  await sendSlackAlert(`🔍 *New KYC submission*\n*${fullName}* (${userEmail})\nUser ID: \`${userId}\`\n<https://admin.zeehfi.ca|Review in admin>`);
}

// ── Admin: Treasury / fraud alert ────────────────────────────────────────────

export async function sendTreasuryAlert(
  overallStatus: string,
  flags: Array<{ type: string; severity: string; detail: string; currency?: string; amount?: string }>,
): Promise<void> {
  if (!ALERT_TO) return;
  const isCritical = overallStatus === 'critical';
  const flagRows = flags.map(f =>
    `<tr>
      <td style="padding:8px 0;border-bottom:1px solid #2a2d3a;font-size:13px;color:${f.severity === 'critical' ? '#ff4d6d' : f.severity === 'high' ? '#ff8c42' : '#ffa500'};font-weight:600;white-space:nowrap;padding-right:12px">[${f.severity.toUpperCase()}]</td>
      <td style="padding:8px 0;border-bottom:1px solid #2a2d3a;font-size:13px;color:#b0b3c6">${f.detail}</td>
    </tr>`
  ).join('');

  const html = baseTemplate(`Treasury ${overallStatus.toUpperCase()} alert`, `
    <div style="background:${isCritical ? 'rgba(255,77,109,.1)' : 'rgba(255,165,0,.1)'};border:1px solid ${isCritical ? '#ff4d6d' : '#ffa500'};border-radius:8px;padding:16px;margin-bottom:20px">
      <div style="font-size:18px;font-weight:700;color:${isCritical ? '#ff4d6d' : '#ffa500'}">${isCritical ? '🚨' : '⚠️'} Treasury ${overallStatus.toUpperCase()}</div>
    </div>
    ${p(`The automated treasury reconciliation detected ${flags.length} issue${flags.length !== 1 ? 's' : ''} requiring your attention.`)}
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px">${flagRows}</table>
    ${cta('Open Treasury Dashboard', 'https://admin.zeehfi.ca')}
    ${muted('This alert was generated automatically by the Zeeh treasury reconciliation engine.')}
  `);

  await send(ALERT_TO, `${isCritical ? '🚨 CRITICAL' : '⚠️ WARNING'}: Treasury alert — ${flags.length} issue${flags.length !== 1 ? 's' : ''} detected`, html);

  const slackText = `${isCritical ? ':rotating_light: *CRITICAL TREASURY ALERT*' : ':warning: *Treasury Warning*'}\n${flags.map(f => `• [${f.severity.toUpperCase()}] ${f.detail}`).join('\n')}\n<https://admin.zeehfi.ca|Open Treasury Dashboard>`;
  await sendSlackAlert(slackText);
}
