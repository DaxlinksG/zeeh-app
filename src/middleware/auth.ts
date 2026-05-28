import { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { lookupKey } from '../lib/keyStore';

// Extend Express Request to carry the resolved client info
declare global {
  namespace Express {
    interface Request {
      apiClient?: { key_id: string; client_name: string; client_email: string };
    }
  }
}

// Timing-safe string comparison — prevents key-length leaks via response time
function timingSafeStringEqual(a: string, b: string): boolean {
  try {
    // Pad to same length so comparison time doesn't reveal length
    const aBuf = Buffer.from(a.padEnd(256, '\0'));
    const bBuf = Buffer.from(b.padEnd(256, '\0'));
    return timingSafeEqual(aBuf, bBuf) && a.length === b.length;
  } catch {
    return false;
  }
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = req.headers['x-api-key'] as string | undefined;

  if (!key) {
    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
    return;
  }

  try {
    // 1. Check DynamoDB — proper multi-tenant keys
    const record = await lookupKey(key);
    if (record) {
      req.apiClient = {
        key_id:       record.key_id,
        client_name:  record.client_name,
        client_email: record.client_email,
      };
      return next();
    }

    // 2. Fall back to SERVICE_API_KEY env var (internal access only)
    //    Timing-safe comparison prevents key-length oracle attacks
    const masterKey = process.env.SERVICE_API_KEY;
    if (masterKey && timingSafeStringEqual(key, masterKey)) {
      req.apiClient = { key_id: 'master', client_name: 'Internal', client_email: 'internal' };
      return next();
    }

    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  } catch (err) {
    // DynamoDB is unreachable — do NOT fall back to master-key-only access.
    // An attacker watching for outage windows should not gain access.
    // Log loudly and return 503 so the client retries.
    console.error('🚨 Auth: DynamoDB unreachable — rejecting all requests until recovered:', err);
    res.status(503).json({ success: false, message: 'Authentication service temporarily unavailable. Please retry in a moment.' });
  }
}
