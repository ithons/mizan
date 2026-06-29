const PLAID_LINK_SCRIPT_ID = 'plaid-link-sdk';
const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

export interface PlaidHandler {
  open: () => void;
}

export interface PlaidCreateOptions {
  token: string;
  receivedRedirectUri?: string;
  onSuccess: (publicToken: string, metadata: unknown) => void | Promise<void>;
  onExit?: () => void;
}

interface PlaidLink {
  create: (options: PlaidCreateOptions) => PlaidHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLink;
  }
}

let plaidLinkPromise: Promise<PlaidLink> | null = null;

export function loadPlaidLink(): Promise<PlaidLink> {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (plaidLinkPromise) return plaidLinkPromise;

  plaidLinkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = PLAID_LINK_SCRIPT_ID;
    script.src = PLAID_LINK_SRC;
    script.async = true;

    script.addEventListener('load', () => {
      if (window.Plaid) {
        resolve(window.Plaid);
        return;
      }

      plaidLinkPromise = null;
      script.remove();
      reject(new Error('Plaid SDK loaded but did not initialize.'));
    }, { once: true });

    script.addEventListener('error', () => {
      plaidLinkPromise = null;
      script.remove();
      reject(new Error('Plaid SDK failed to load. Check your network connection.'));
    }, { once: true });

    const existingScript = document.getElementById(PLAID_LINK_SCRIPT_ID);
    if (existingScript) existingScript.remove();
    document.head.appendChild(script);
  });

  return plaidLinkPromise;
}
