import type { IncomingMessage } from 'http';

/**
 * The request path for the access log: mount prefix included, query string excluded.
 *
 * `originalUrl`, not `url`: Express rewrites `req.url` to be router-relative while a router handles
 * the request, so a response sent from inside one logged `POST /setup` instead of
 * `POST /api/simplefin/setup`. Only errors, which leave the router before the log line is written,
 * kept the prefix. The query string is dropped because the Ledger search box travels in it.
 */
export function accessLogPath(req: IncomingMessage & { originalUrl?: string }): string {
  return (req.originalUrl ?? req.url ?? '').split('?')[0];
}
