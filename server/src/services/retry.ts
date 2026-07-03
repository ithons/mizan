interface AxiosLikeError {
  isAxiosError?: boolean;
  response?: { status?: number };
}

interface StatusError {
  status?: number;
}

function hasStatus(err: unknown): err is StatusError {
  return typeof err === 'object' && err !== null && 'status' in err;
}

function isAxiosLikeError(err: unknown): err is AxiosLikeError {
  return typeof err === 'object' && err !== null && 'isAxiosError' in err;
}

export function defaultIsRetryable(err: unknown): boolean {
  if (isAxiosLikeError(err)) {
    const status = err.response?.status;
    return status === undefined || status >= 500;
  }
  if (hasStatus(err)) {
    return err.status === undefined || err.status >= 500;
  }
  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  isRetryable?: (err: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 1000, isRetryable = defaultIsRetryable } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryable(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }

  throw lastErr;
}
