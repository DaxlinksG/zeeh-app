import { Request, Response, NextFunction } from 'express';

// Clients of YOUR service must send this key.
// Keep it separate from the GTP API key.
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] as string | undefined;
  const expected = process.env.SERVICE_API_KEY;

  if (!expected) {
    // No key configured — skip check in dev
    return next();
  }

  if (!key || key !== expected) {
    res.status(401).json({ success: false, message: 'Invalid or missing API key' });
    return;
  }

  next();
}
