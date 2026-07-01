import { Request, Response, NextFunction } from 'express';

interface ExtendedError extends Error {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    data?: unknown;
  };
}

export function errorHandler(
  err: ExtendedError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // If it's an Axios error, it often has err.response
  if (err.response && err.response.data) {
    const status = err.response.status || err.status || err.statusCode || 500;
    const data = err.response.data;

    console.error(`[error] API Error (${status}):`, data);
    res.status(status).json({ error: err.message || 'External API Error', details: data });
    return;
  }

  const status = err.status || err.statusCode || 500;
  console.error(`[error] ${err.message}`);
  res.status(status).json({ error: err.message || 'Internal server error' });
}
