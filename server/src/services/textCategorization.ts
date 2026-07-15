// Best-effort local categorizer for providers (SimpleFIN, Coinbase) that don't supply
// a category themselves. Rules are checked in
// order; the first match wins, so more specific multi-word patterns are listed before
// generic single-word ones that would otherwise shadow them (e.g. "uber eats" before "uber").
interface CategoryRule {
  categoryId: string;
  keywords: string[];
}

const RULES: CategoryRule[] = [
  // Income
  { categoryId: 'cat_income_paycheck', keywords: ['payroll', 'direct dep', 'salary', 'paycheck'] },
  { categoryId: 'cat_income_dividends', keywords: ['dividend'] },
  { categoryId: 'cat_income_interest', keywords: ['interest payment', 'interest earned', 'interest paid'] },

  // Multi-word food-delivery brands before the generic rideshare rule below
  { categoryId: 'cat_food_restaurants', keywords: [
    'uber eats', 'ubereats', 'doordash', 'grubhub', 'postmates', 'seamless',
    'chipotle', "mcdonald", 'chick-fil-a', 'chickfila', 'starbucks reserve',
    'pizza', 'sushi', 'restaurant', 'bistro', 'taqueria', 'burger', 'diner',
  ] },
  { categoryId: 'cat_food_coffee', keywords: ['starbucks', "peet's", 'dunkin', 'coffee', 'blue bottle', 'philz'] },
  { categoryId: 'cat_food_groceries', keywords: [
    'whole foods', 'trader joe', 'safeway', 'kroger', 'wegmans', 'publix',
    'grocery', 'aldi', 'stop & shop', 'stop and shop', 'sprouts farmers',
    "trader joe's", 'h mart', 'harris teeter',
  ] },
  { categoryId: 'cat_food_bars', keywords: ['brewery', 'brewing co', 'tavern', ' pub', 'taproom'] },

  // Shopping
  { categoryId: 'cat_shop_amazon', keywords: ['amazon', 'amzn'] },
  { categoryId: 'cat_shop_electronics', keywords: ['best buy', 'apple.com/bill', 'apple store', 'micro center', 'newegg', 'b&h photo'] },
  { categoryId: 'cat_shop_clothing', keywords: ['nike', ' gap ', 'zara', 'nordstrom', 'old navy', 'h&m', 'uniqlo', 'lululemon'] },

  // Transport
  { categoryId: 'cat_transport_ride', keywords: ['uber', 'lyft'] },
  { categoryId: 'cat_transport_gas', keywords: [
    'shell oil', 'chevron', 'exxon', 'mobil', 'speedway', 'gas station',
    'sunoco', 'valero', 'circle k', 'arco', '76 gas', 'costco gas',
  ] },
  { categoryId: 'cat_transport_parking', keywords: ['parking', 'parkmobile', 'spothero', 'parkwhiz'] },
  { categoryId: 'cat_transport_transit', keywords: ['mta', 'metro card', 'metrocard', 'bart', 'septa', 'caltrain', 'transit auth'] },
  { categoryId: 'cat_transport_auto', keywords: ['auto loan', 'car payment', 'auto finance'] },

  // Home
  { categoryId: 'cat_home_rent', keywords: ['rent payment', 'property mgmt', 'apartments', 'realpage'] },
  { categoryId: 'cat_home_utilities', keywords: [
    'electric co', 'water utility', 'pg&e', 'con edison', 'coned', 'utility bill', 'power company', 'gas & electric',
  ] },
  { categoryId: 'cat_home_internet', keywords: ['comcast', 'xfinity', 'spectrum internet', 'fios'] },
  { categoryId: 'cat_home_phone', keywords: ['verizon wireless', 'at&t', 'att.com', 't-mobile', 'tmobile', 'mint mobile'] },

  // Health
  { categoryId: 'cat_health_pharmacy', keywords: ['cvs', 'walgreens', 'rite aid', 'pharmacy'] },
  { categoryId: 'cat_health_medical', keywords: ['medical', 'clinic', 'hospital', 'urgent care', 'physician', 'dental', 'dentist'] },
  { categoryId: 'cat_health_fitness', keywords: ['planet fitness', 'equinox', 'peloton', ' gym', 'yoga studio', 'crossfit'] },

  // Entertainment
  { categoryId: 'cat_ent_streaming', keywords: [
    'netflix', 'spotify', 'hulu', 'disney+', 'disney plus', 'hbo max', 'max.com',
    'youtube premium', 'apple tv', 'paramount+', 'peacock',
  ] },
  { categoryId: 'cat_ent_games', keywords: ['steam', 'playstation network', 'xbox', 'nintendo', 'epic games'] },
  { categoryId: 'cat_ent_events', keywords: ['ticketmaster', 'eventbrite', 'stubhub', 'live nation'] },

  // Travel
  { categoryId: 'cat_travel_flights', keywords: [
    'delta air', 'united air', 'american air', 'southwest air', 'jetblue', 'spirit air', 'airlines',
  ] },
  { categoryId: 'cat_travel_hotels', keywords: ['marriott', 'hilton', 'hyatt', 'airbnb', 'hotel', 'motel'] },

  // Shopping catch-alls (after more specific categories above so e.g. Target pharmacy runs still win)
  { categoryId: 'cat_shop_general', keywords: ['target', 'walmart', 'costco wholesale'] },

  // Misc
  { categoryId: 'cat_subscriptions', keywords: ['subscription'] },
  { categoryId: 'cat_personal_care', keywords: ['hair salon', 'barber shop', ' spa '] },
  { categoryId: 'cat_xfer_cc', keywords: ['credit card payment', 'card payment thank you', 'payment thank you'] },
];

function normalize(text: string): string {
  return ` ${text.toLowerCase().replace(/[^a-z0-9&+' ]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

export function guessCategoryFromText(merchantName: string | null, originalName: string): string | null {
  const haystack = normalize(`${merchantName ?? ''} ${originalName}`);
  if (haystack.trim() === '') return null;

  for (const rule of RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) {
      return rule.categoryId;
    }
  }
  return null;
}
