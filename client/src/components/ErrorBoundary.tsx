import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render-time throws so one bad row can't blank the whole app.
 *
 * This app had no boundary at all, so e.g. an invalid date reaching `parseISO`/`format`
 * (a malformed CSV import) threw `RangeError: Invalid time value` and white-screened every view.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ui] Unhandled render error:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="mx-auto max-w-[560px] px-6 py-16">
        <h1 className="font-serif text-figure text-ink">Something broke on this screen.</h1>
        <p className="mt-2 text-body leading-relaxed text-muted">
          Your data is safe. This is a display error. Try again, or reload the page.
        </p>
        <pre className="mt-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-line-2 bg-rail p-3 font-mono text-note text-ink">
          {error.message}
        </pre>
        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-md border border-line-2 px-3 py-1.5 text-body text-ink transition-colors hover:bg-well"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-line-2 px-3 py-1.5 text-body text-ink transition-colors hover:bg-well"
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
