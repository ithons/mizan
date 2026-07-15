import type { Request, Response, NextFunction, RequestHandler } from 'express';

// This app ships with no auth layer and binds to loopback by default. That is safe
// against the network, but a loopback-bound API is still reachable by (a) any other
// local process and (b) a malicious web page via DNS rebinding (it points a domain at
// 127.0.0.1, then has the browser POST to the local API). The guard below closes that
// gap without adding user-facing friction:
//   - Host allowlist: rejects any request whose Host header isn't a known local host.
//     A rebound page still sends the attacker's Host, so it fails here.
//   - Origin check on state-changing methods: rejects a cross-site fetch/form that
//     carries a foreign Origin. Same-origin client requests are unaffected.

export interface LocalGuardConfig {
  allowedHosts: Set<string>;
  allowedOrigins: Set<string>;
}

export interface LocalGuardOptions {
  port: number;
  host: string;
  hostIsLoopback: boolean;
  corsOrigin?: string;
  extraHosts?: string;
}

export function buildLocalGuardConfig(opts: LocalGuardOptions): LocalGuardConfig {
  const allowedHosts = new Set<string>();
  for (const h of ['localhost', '127.0.0.1', '[::1]']) {
    allowedHosts.add(h);
    allowedHosts.add(`${h}:${opts.port}`);
  }
  // Allow the explicitly configured bind host (e.g. a LAN IP) when the operator has
  // deliberately bound beyond loopback.
  if (!opts.hostIsLoopback) {
    allowedHosts.add(opts.host.toLowerCase());
    allowedHosts.add(`${opts.host.toLowerCase()}:${opts.port}`);
  }
  // Allow the hosts behind any deliberately configured cross-origin.
  if (opts.corsOrigin) {
    for (const o of splitList(opts.corsOrigin)) {
      try {
        allowedHosts.add(new URL(o).host.toLowerCase());
      } catch {
        /* ignore malformed origins */
      }
    }
  }
  // Operator escape hatch for custom host[:port] values.
  if (opts.extraHosts) {
    for (const h of splitList(opts.extraHosts)) allowedHosts.add(h.toLowerCase());
  }

  const allowedOrigins = new Set<string>();
  for (const h of allowedHosts) {
    allowedOrigins.add(`http://${h}`);
    allowedOrigins.add(`https://${h}`);
  }
  return { allowedHosts, allowedOrigins };
}

function splitList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function evaluateLocalRequest(
  req: { host?: string; method: string; origin?: string },
  config: LocalGuardConfig
): { allowed: boolean; reason?: string } {
  const host = (req.host ?? '').toLowerCase();
  if (!config.allowedHosts.has(host)) {
    return { allowed: false, reason: 'unrecognized Host header' };
  }
  if (STATE_CHANGING.has(req.method.toUpperCase()) && req.origin) {
    if (!config.allowedOrigins.has(req.origin.toLowerCase())) {
      return { allowed: false, reason: 'cross-origin request rejected' };
    }
  }
  return { allowed: true };
}

export function localOriginGuard(config: LocalGuardConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = evaluateLocalRequest(
      { host: req.headers.host, method: req.method, origin: req.headers.origin },
      config
    );
    if (!verdict.allowed) {
      res.status(403).json({ error: `Forbidden: ${verdict.reason}` });
      return;
    }
    next();
  };
}
