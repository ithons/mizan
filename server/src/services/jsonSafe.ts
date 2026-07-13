// Guarded JSON.parse for TEXT columns that hold JSON blobs (advisor_drafts,
// app_preferences, net_worth_snapshots.breakdown). SQLite cannot enforce valid
// JSON, so a single corrupt row must not throw and take down a whole view.
export function safeJsonParse<T>(raw: string, fallback: T, context?: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[json] Failed to parse${context ? ` ${context}` : ''}: ${(err as Error).message}`);
    return fallback;
  }
}
