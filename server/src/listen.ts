import type { Server } from 'http';

/** Anything with express's `listen(port, host, cb)` shape. */
export interface ListensOnHost {
  listen(port: number, host: string, callback: () => void): Server;
}

/**
 * Bind the HTTP socket to `host`, in every mode, and hand the bound server back to the caller.
 *
 * WHY THIS IS A FUNCTION AND NOT TWO LINES IN `index.ts`. `index.ts` runs `main()` at module
 * scope, so nothing can import it to test it, and the one property worth testing here is the one
 * that was wrong for the life of the repo: the dev branch called
 * `ViteExpress.listen(app, port, cb)`, whose signature carries no host, so Node bound `::` and
 * every interface on the machine could reach the ledger. `MIZAN_HOST` was read into a constant
 * that only the production branch used, and `NODE_ENV` is set by neither npm script, so the
 * production branch never ran.
 *
 * The host belongs to the socket, not to the mode. Vite is attached afterwards, to the server this
 * returns, via `ViteExpress.bind` (which is what `ViteExpress.listen` calls internally).
 */
export function listenOnHost(
  app: ListensOnHost,
  port: number,
  host: string,
  onListening: (server: Server) => void
): Server {
  const server = app.listen(port, host, () => onListening(server));
  return server;
}
