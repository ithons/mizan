import { Request, Response, NextFunction } from 'express';

interface ExtendedError extends Error {
  status?: number;
  statusCode?: number;
  response?: {
    status?: number;
    data?: unknown;
  };
}

function isPlaidErrorData(data: unknown): data is { error_message: string; error_code?: string } {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error_message' in data &&
    typeof (data as { error_message?: unknown }).error_message === 'string'
  );
}

export function errorHandler(
  err: ExtendedError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // If it's an Axios/Plaid error, it often has err.response
  if (err.response && err.response.data) {
    const status = err.response.status || err.status || err.statusCode || 500;
    const data = err.response.data;

    // Plaid specific error structure
    if (isPlaidErrorData(data)) {
      console.error(`[error] Plaid API Error (${status}): ${data.error_message} [${data.error_code}]`);
      res.status(status).json({
        error: data.error_message,
        code: data.error_code,
        details: data,
      });
      return;
    }

    console.error(`[error] API Error (${status}):`, data);
    res.status(status).json({ error: err.message || 'External API Error', details: data });
    return;
  }

  const status = err.status || err.statusCode || 500;
  console.error(`[error] ${err.message}`);
  res.status(status).json({ error: err.message || 'Internal server error' });
}
