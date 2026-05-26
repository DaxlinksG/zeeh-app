import { Request, Response, NextFunction } from 'express';

interface AppError extends Error {
  status?: number;
  upstream?: unknown;
}

export function errorHandler(err: AppError, _req: Request, res: Response, _next: NextFunction): void {
  const status = err.status ?? 500;
  res.status(status).json({
    success: false,
    message: err.message ?? 'Internal server error',
    ...(process.env.NODE_ENV !== 'production' && err.upstream ? { upstream: err.upstream } : {}),
  });
}
