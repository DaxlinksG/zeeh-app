/**
 * SMS — transactional messages via Termii
 *
 * All sends are fire-and-forget (never throws). Failures are logged but
 * never propagate — a missing SMS must never crash the API.
 *
 * Required env vars:
 *   TERMII_API_KEY   — from termii.com dashboard
 *   TERMII_SENDER_ID — alphanumeric sender ID approved by Termii (max 11 chars)
 *                      e.g. "ZeehAfrica" — must be pre-registered for NGN routes
 */

const TERMII_BASE     = 'https://api.ng.termii.com/api';
const TERMII_API_KEY  = () => process.env.TERMII_API_KEY  ?? '';
const TERMII_SENDER   = () => process.env.TERMII_SENDER_ID ?? 'ZeehAfrica';

// ── Phone normalisation ────────────────────────────────────────────────────
// Termii expects E.164 without the leading +.
// Nigerian numbers stored as 080... / 081... → 2348...
// International numbers stored as +1416... → 1416...

export function normalisePhone(raw: string): string | null {
  if (!raw) return null;
  // Strip everything except digits and leading +
  const stripped = raw.replace(/[\s\-().]/g, '');
  if (!stripped) return null;

  // Already in E.164 with + prefix → just remove +
  if (stripped.startsWith('+')) return stripped.slice(1);

  // Nigerian local format: 0XXXXXXXXXX (11 digits) → 234XXXXXXXXXX
  if (/^0[789]\d{9}$/.test(stripped)) return '234' + stripped.slice(1);

  // Already looks like an E.164 number without + (starts with country code)
  if (stripped.length >= 10) return stripped;

  return null;
}

// ── Core send ─────────────────────────────────────────────────────────────

async function send(to: string, message: string): Promise<void> {
  const apiKey = TERMII_API_KEY();
  if (!apiKey) {
    console.log(`📱 [SMS] No TERMII_API_KEY — would send to ${to}: ${message.slice(0, 60)}`);
    return;
  }

  const phone = normalisePhone(to);
  if (!phone) {
    console.warn(`📱 [SMS] Invalid phone number: ${to}`);
    return;
  }

  try {
    const res = await fetch(`${TERMII_BASE}/sms/send`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        to:      phone,
        from:    TERMII_SENDER(),
        sms:     message,
        type:    'plain',
        channel: 'generic',
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`📱 [SMS] Termii error ${res.status} sending to ${phone}:`, body.slice(0, 200));
    }
  } catch (err) {
    console.error(`📱 [SMS] Network error sending to ${phone}:`, err);
  }
}

// ── OTP ──────────────────────────────────────────────────────────────────
// Sent alongside the email OTP so users on slow email clients get it fast.

export async function sendOtpSms(phone: string, otp: string, firstName: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, your Zeeh Africa verification code is: ${otp}. Valid for 10 minutes. Do not share this code.`
  );
}

// ── Transaction alerts ────────────────────────────────────────────────────

export async function sendDepositSms(phone: string, firstName: string, currency: string, amount: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, your Zeeh Africa account has been credited with ${currency} ${amount}. Login to view your balance.`
  );
}

export async function sendMoneyReceivedSms(phone: string, firstName: string, fromName: string, currency: string, amount: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, you received ${currency} ${amount} from ${fromName} on Zeeh Africa.`
  );
}

export async function sendMoneySentSms(phone: string, firstName: string, currency: string, amount: string, reference: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, your Zeeh Africa transfer of ${currency} ${amount} has been sent. Ref: ${reference}.`
  );
}

export async function sendSwapSms(phone: string, firstName: string, fromCur: string, fromAmt: string, toCur: string, toAmt: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, your Zeeh exchange is complete: ${fromCur} ${fromAmt} → ${toCur} ${toAmt}.`
  );
}

export async function sendTransferInitiatedSms(phone: string, firstName: string, currency: string, amount: string, reference: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, your ${currency} ${amount} bank transfer has been submitted. Ref: ${reference}. Usually 1-3 business days.`
  );
}

// ── Security alerts ───────────────────────────────────────────────────────

export async function sendLoginAlertSms(phone: string, firstName: string): Promise<void> {
  await send(phone,
    `Hi ${firstName}, a new login was detected on your Zeeh Africa account. If this wasn't you, contact support immediately at support@zeehfi.ca.`
  );
}
