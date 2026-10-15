const WALLET_IN_PAYEE = /(?:apple|google|samsung)\s*pay\b/i;
const WALLET_TAIL = /\s*\b([A-Z]{2})?\s?(?:APPLE|GOOGLE|SAMSUNG)\s*PAY\b.*$/i;
const POS_PREFIX = /^[A-Z0-9]{2,5}\s?\*\s*/i;
const STORE_NUMBER = /^(?:#|#?\d+|[A-Z]?-\d{2,}|\d{2,}[A-Z]?)$/i;
const MULTI_WORD_CITY_LEAD = new Set([
  'NEW', 'SAN', 'LOS', 'LAS', 'SANTA', 'ST', 'SAINT', 'FORT', 'FT', 'EL', 'LA', 'PALO', 'SALT',
  'GRAND', 'BATON', 'CORPUS', 'COLORADO', 'KANSAS', 'OKLAHOMA', 'JERSEY', 'VIRGINIA', 'BEVERLY',
]);
const SQUARE_SUFFIX = /\s+\S+\s+(?:SQ|SQR|SQU|SQUARE)\.?$/i;
const ACRONYMS = new Set([
  'MIT', 'CVS', 'USA', 'UPS', 'USPS', 'MBTA', 'NYC', 'KFC', 'IHOP', 'AMC', 'REI', 'DSW', 'BJS',
  'TJ', 'BU', 'MGH', 'HSBC', 'LLC', 'BBQ', 'NYU', 'UCLA', 'MOMA', 'IKEA', 'H&M',
]);

/** Whether a provider payee carries a mobile-wallet tail ("Cambridge Maapple Pay Aabrcnxqacf"). */
export function payeeHasWalletTail(payee: string | null | undefined): boolean {
  return WALLET_IN_PAYEE.test(payee ?? '');
}

function titleWord(word: string): string {
  if (ACRONYMS.has(word.toUpperCase())) return word.toUpperCase();
  return word
    .toLowerCase()
    .replace(/(^|[-'&/.])([a-z])/g, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`)
    .replace(/'S\b/g, "'s");
}

function dropCity(tokens: string[]): { kept: string[]; city: string | null } {
  if (tokens.length < 2) return { kept: tokens, city: null };
  const kept = tokens.slice(0, -1);
  const city = [tokens[tokens.length - 1]];
  const lead = kept[kept.length - 1]?.toUpperCase();
  if (kept.length >= 2 && lead && MULTI_WORD_CITY_LEAD.has(lead)) city.unshift(kept.pop() as string);
  return { kept, city: city.join(' ') };
}

function cutRepeatedCity(name: string, city: string | null): string {
  if (!city) return name;
  const match = /^(.*\S)\s*-\s+(.+)$/.exec(name);
  return match && match[2].toUpperCase() === city.toUpperCase() ? match[1] : name;
}

/**
 * The merchant a wallet-paid card row names, from the raw descriptor.
 *
 * Returns null when the descriptor carries no wallet tail, so callers keep whatever they had.
 */
export function merchantFromWalletDescriptor(description: string): string | null {
  const tail = WALLET_TAIL.exec(description);
  if (!tail) return null;

  const head = description.slice(0, tail.index).replace(POS_PREFIX, '').trim();
  const tokens = head.split(/\s+/).filter((token) => token && !STORE_NUMBER.test(token));
  const { kept, city } = tail[1] ? dropCity(tokens) : { kept: tokens, city: null };

  let name = kept.join(' ');
  name = name.replace(SQUARE_SUFFIX, '');
  name = cutRepeatedCity(name, city);
  name = name.replace(/[\s\-,*]+$/, '').replace(/(\S)-\s+/g, '$1-');
  if (!/[A-Z]/i.test(name)) return null;

  return name.split(/\s+/).map(titleWord).join(' ');
}

/**
 * What to store as `merchant_name` for a provider row: the provider's payee, unless that payee is
 * SimpleFIN's prettified wallet descriptor, which glues the state onto "Apple Pay" and keeps the
 * city and the token id.
 */
export function cleanProviderMerchant(payee: string | null, description: string): string | null {
  if (payee && !payeeHasWalletTail(payee)) return payee;
  return merchantFromWalletDescriptor(description) ?? payee;
}
