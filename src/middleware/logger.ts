import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';

// Attach a unique request ID to every request — critical for tracing payments
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string) ?? uuidv4();
  req.headers['x-request-id'] = id;
  res.setHeader('x-request-id', id);
  next();
}

// Standard HTTP access log (all requests)
export const httpLogger = morgan(
  ':date[iso] :method :url :status :res[content-length]b :response-time ms | ip=:remote-addr id=:req[x-request-id]',
  {
    skip: (req) => req.path === '/health', // don't clutter logs with health checks
  },
);

// Audit logger — logs financial operations with full context
export function auditLog(
  action: string,
  req: Request,
  details: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString(),
    audit: true,
    action,
    request_id: req.headers['x-request-id'],
    ip: req.ip ?? req.socket.remoteAddress,
    details,
  };
  // In production these go to CloudWatch Logs automatically via the ECS log driver
  console.log(JSON.stringify(entry));
}
