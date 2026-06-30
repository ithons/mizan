export function normalizePlaidRedirectUri(
  requestedUri?: string | null,
  configuredUri = process.env.PLAID_REDIRECT_URI
): string | null {
  const rawUri = configuredUri?.trim() || requestedUri?.trim();
  if (!rawUri) return null;

  try {
    const url = new URL(rawUri);
    if (url.hostname === '127.0.0.1') {
      url.hostname = 'localhost';
    }

    if (url.protocol !== 'https:') {
      return null;
    }

    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}
