export const ADD_ENTRY_PARAM = 'add';
export const ADD_ENTRY_ROUTE = `/ledger?${ADD_ENTRY_PARAM}=1`;

/** The params left once an add-entry request is consumed, or null when none was made. */
export function takeAddEntryRequest(params: URLSearchParams): URLSearchParams | null {
  if (params.get(ADD_ENTRY_PARAM) !== '1') return null;
  const remaining = new URLSearchParams(params);
  remaining.delete(ADD_ENTRY_PARAM);
  return remaining;
}
