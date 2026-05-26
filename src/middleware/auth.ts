import { Request, Response, NextFunction } from 'express';
import { lookupKey } from '../lib/keyStore';

// Extend Express Request to carry the resolved client info
declare global {
  namespace Express {
    interface Request {
      apiClient?: { key_id: string; client_name: string; client_email: string };
    }
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

    // 2. Fall back to SERVICE_API_KEY env var (your own internal access)
    const masterKey = process.env.SERVICE_API_KEY;
    if (masterKey && key === masterKey) {
      req.apiClient = { key_id: 'master', client_name: 'Internal', client_email: 'internal' };
      return next();
    }

    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  } catch {
    // If DynamoDB is unreachable, fall back to master key only
    const masterKey = process.env.SERVICE_API_KEY;
    if (masterKey && key === masterKey) {
      req.apiClient = { key_id: 'master', client_name: 'Internal', client_email: 'internal' };
      return next();
    }
    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
  }
}
