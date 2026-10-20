const WALLET_IN_PAYEE = /(?:apple|google|samsung)\s*pay\b/i;
const WALLET_TAIL = /\s*\b([A-Z]{2})?\s?(?:APPLE|GOOGLE|SAMSUNG)\s*PAY\b.*$/i;
const POS_PREFIX = /^[A-Z0-9]{2,5}\s?\*\s*/i;
const STORE_NUMBER = /^(?:#|#?\d+|[A-Z]?-\d{2,}|\d{2,}[A-Z]?)$/i;
const MULTI_WORD_CITY_LEAD = new Set([
  'NEW', 'SAN', 'LOS', 'LAS', 'SANTA', 'ST', 'SAINT', 'FORT', 'FT', 'EL', 'LA', 'PALO', 'SALT',
  'GRAND', 'BATON', 'CORPUS', 'COLORADO', 'KANSAS', 'OKLAHOMA', 'JERSEY', 'VIRGINIA', 'BEVERLY',
]);
const SQUARE_SUFFIX = /\s+\S+\s+(?:SQ|SQR|SQU|SQUARE)\.?$/i;
export const US_STATES: ReadonlySet<string> = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);
const ACH_ID_TAIL = /\s+(?:PPD|WEB|CCD)\s+ID\b.*$/i;
const PHONE_TOKEN = /^\d{3}[-.]?\d{3}[-.]?\d{4},?$/;
const STORE_NUMBER_TOKEN = /^(?:#\d+|\d{3,}[A-Z]?),?$/i;
const STORE_NUMBER_TAIL = /^([A-Z][A-Z&.']*)-\d{5,}(?:-\d+)*$/i;
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

// The card network gives the city 13 characters. A longer token, or one where an upper-case run
// runs into a capitalised word ("SANDWNew"), is a full-width name glued to the city, and dropping
// it would take part of the name with it.
function withoutCityAndState(tokens: string[]): string[] {
  if (tokens.length < 3 || !US_STATES.has(tokens[tokens.length - 1])) return tokens;
  const { kept, city } = dropCity(tokens.slice(0, -1));
  const glued = (city ?? '').split(' ').some((word) => word.replace(/,$/, '').length > 13 || /[A-Z]{2}[a-z]/.test(word));
  return glued ? tokens : kept;
}

/**
 * The merchant an imported bank descriptor names: "10078 CAVA KENDALL SQR CAMBRIDGE MA" is Cava.
 *
 * Drops only noise the backfill evidenced: a trailing city and state, a phone number, a store number
 * of three or more digits, an ACH ID segment, and a square suffix. A name whose digits are the name
 * ("7-ELEVEN", "76", "1-800-FLOWERS") passes through, and so does anything that would come out with
 * no letters left. The raw descriptor stays in `original_name`.
 */
export function merchantFromImportedDescriptor(descriptor: string): string {
  const raw = descriptor.replace(/\s+/g, ' ').trim();
  let tokens = raw.replace(ACH_ID_TAIL, '').split(' ').filter(Boolean);
  tokens = withoutCityAndState(tokens)
    .filter((token) => !PHONE_TOKEN.test(token) && !STORE_NUMBER_TOKEN.test(token))
    .map((token) => STORE_NUMBER_TAIL.exec(token)?.[1] ?? token);
  const name = tokens.join(' ').replace(SQUARE_SUFFIX, '').replace(/[\s,\-*/]+$/, '').replace(/^[\s,\-]+/, '');
  return /[A-Z]/i.test(name) ? name : raw;
}
