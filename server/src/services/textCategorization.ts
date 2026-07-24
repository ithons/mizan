// Best-effort local categorizer for providers (SimpleFIN, Coinbase) that don't supply
// a category themselves. Rules are checked in
// order; the first match wins, so more specific multi-word patterns are listed before
// generic single-word ones that would otherwise shadow them (e.g. "uber eats" before "uber").
interface CategoryRule {
  categoryId: string;
  keywords: string[];
}

const RULES: CategoryRule[] = [
  // Transfers / payments first — a credit-card autopay or account transfer must never fall
  // through to an income or spend bucket (this is the class of bug the audit found).
  { categoryId: 'cat_xfer_cc', keywords: [
    'automatic payment', 'autopay', 'internet payment', 'payment thank you',
    'credit card payment', 'directpay full balance', 'bill pay to',
  ] },
  { categoryId: 'cat_inv_transfer', keywords: ['electronic funds transfer', 'cash contribution', 'fidelity brokerage'] },

  // Income
  { categoryId: 'cat_income_paycheck', keywords: ['payroll', 'direct dep', 'salary', 'paycheck', 'mass inst'] },
  { categoryId: 'cat_inv_dividend', keywords: ['dividend received', 'dividend'] },
  { categoryId: 'cat_income_interest', keywords: ['interest payment', 'interest earned', 'interest paid', 'wealthfront interest'] },

  // Software & AI tools — before the generic Subscriptions bucket.
  { categoryId: 'cat_sub_software', keywords: [
    'openai', 'chatgpt', 'anthropic', 'claude.ai', 'cursor', 'google *colab', 'colab', 'github',
    'backblaze', 'porkbun', 'surfshark', 'walter ai', 'vercel', 'digitalocean', 'notion',
  ] },

  // Food-delivery brands first — before restaurants and before the generic "uber"
  // rideshare rule below (so "uber eats" is delivery, not a ride).
  { categoryId: 'cat_food_delivery', keywords: [
    'uber eats', 'ubereats', 'uber *eats', 'doordash', 'grubhub', 'postmates', 'seamless', 'caviar', 'gopuff',
  ] },
  { categoryId: 'cat_food_coffee', keywords: [
    'starbucks', "peet's", 'dunkin', 'coffee', 'blue bottle', 'philz', 'teado', 'george howell',
    'tatte', 'jaho', 'pavement', 'blank street', 'caffe nero', 'boba', 'bubble tea', 'moge tee', 'meet fresh',
  ] },
  { categoryId: 'cat_food_groceries', keywords: [
    'whole foods', 'wholefds', 'trader joe', 'safeway', 'kroger', 'wegmans', 'publix',
    'grocery', 'aldi', 'stop & shop', 'stop and shop', 'sprouts farmers', 'concord market',
    "trader joe's", 'h mart', 'harris teeter', 'star market', 'big y', 'the butcherie', 'market on camp',
  ] },
  { categoryId: 'cat_food_restaurants', keywords: [
    'chipotle', "mcdonald", 'chick-fil-a', 'chickfila', 'starbucks reserve', 'cava',
    'pizza', 'sushi', 'restaurant', 'bistro', 'taqueria', 'burger', 'diner', 'courtyard cafe',
    'mit dining', 'dig inn', 'sweetgreen', 'life alive', 'super vanak', 'taco bell', 'shake shack',
    'raising canes', 'cheesecake', 'flour bakery', 'naco taco', 'tst*', 'kabob', 'grille',
    'vending', 'nayax', 'koury', 'lestat', 'in-n-out', 'burger king',
  ] },
  { categoryId: 'cat_food_bars', keywords: ['brewery', 'brewing co', 'tavern', ' pub', 'taproom', 'lamplighter', 'wine', 'liquor', 'smoke shop'] },

  // Shopping
  { categoryId: 'cat_shop_amazon', keywords: ['amazon', 'amzn'] },
  { categoryId: 'cat_shop_electronics', keywords: [
    'best buy', 'apple.com/bill', 'apple store', 'micro center', 'newegg', 'b&h photo', 'bh photo',
    'hunt\'s photo', 'mpb.com', 'the darkroom', 'seidoshop', 'pitaka', 'back market', 'backmarket',
  ] },
  { categoryId: 'cat_shop_clothing', keywords: [
    'nike', ' gap ', 'zara', 'nordstrom', 'old navy', 'h&m', 'uniqlo', 'lululemon',
    'timberland', 'garment district', 'koton', 'lc waikiki', 'new balance',
  ] },

  // Transport — bike/car SHARE before rideshare, because the sync labels Bluebikes as
  // "BLUEBIK*n RIDE LYFT.COM" (contains 'lyft') and Zipcar trips would otherwise read as rides.
  { categoryId: 'cat_transport_share', keywords: [
    'bluebik', 'blue bike', 'zipcar', 'lime', 'bird', 'capbike', 'baywhee', 'citi bike', 'divvy', 'car share',
  ] },
  { categoryId: 'cat_transport_ride', keywords: ['uber', 'lyft', 'bolt eu', 'bolt app', 'boltapp', 'metro service'] },
  { categoryId: 'cat_transport_gas', keywords: [
    'shell oil', 'chevron', 'exxon', 'mobil ', 'speedway', 'gas station',
    'sunoco', 'valero', 'circle k', 'arco', '76 gas', 'costco gas', "love's",
  ] },
  { categoryId: 'cat_transport_parking', keywords: ['parking', 'parkmobile', 'spothero', 'parkwhiz', 'etollbgt', 'toll'] },
  { categoryId: 'cat_transport_transit', keywords: [
    'mbta', 'mta*nyct', 'nyct paygo', 'metro card', 'metrocard', 'bart', 'septa', 'caltrain',
    'transit auth', 'clipper', 'green mountain transit', 'njt-paygo', 'path tapp', 'nyc ferry',
  ] },
  { categoryId: 'cat_transport_auto', keywords: ['auto loan', 'car payment', 'auto finance'] },

  // Newer top-level categories
  { categoryId: 'cat_pets', keywords: ['chewy', 'petco', 'petsmart', 'trupanion', 'veterinary', ' vet ', 'pet supplies', 'aspca'] },
  { categoryId: 'cat_fees', keywords: ['overdraft', 'atm fee', 'service charge', 'wire fee', 'foreign transaction fee', 'bank fee', 'late fee', 'rmv e-service', 'rmv boston', 'registry of motor'] },
  { categoryId: 'cat_gifts', keywords: ['gofundme', 'donation', 'red cross', 'charity', 'patreon'] },

  // Home
  { categoryId: 'cat_home_rent', keywords: ['rent payment', 'property mgmt', 'apartments', 'realpage'] },
  { categoryId: 'cat_home_utilities', keywords: [
    'electric co', 'water utility', 'pg&e', 'con edison', 'coned', 'utility bill', 'power company', 'gas & electric',
  ] },
  { categoryId: 'cat_home_internet', keywords: ['comcast', 'xfinity', 'spectrum internet', 'fios'] },
  { categoryId: 'cat_home_phone', keywords: ['verizon wireless', 'at&t', 'att.com', 't-mobile', 'tmobile', 'mint mobile'] },

  // Health
  { categoryId: 'cat_health_pharmacy', keywords: ['cvs', 'walgreens', 'rite aid', 'pharmacy'] },
  { categoryId: 'cat_health_medical', keywords: ['medical', 'clinic', 'hospital', 'urgent care', 'physician', 'dental', 'dentist', 'mit med', 'cambridge health'] },
  { categoryId: 'cat_health_fitness', keywords: ['planet fitness', 'equinox', 'peloton', ' gym', 'yoga studio', 'crossfit', 'mit recreation'] },

  // Entertainment
  { categoryId: 'cat_ent_movies', keywords: ['amc ', 'amc theat', 'cinema', 'cinemark', 'regal cinema', 'somerville theat', 'movie theat'] },
  { categoryId: 'cat_ent_streaming', keywords: [
    'netflix', 'spotify', 'hulu', 'disney+', 'disney plus', 'hbo max', 'max.com',
    'youtube premium', 'youtube tv', 'apple tv', 'paramount+', 'peacock',
  ] },
  { categoryId: 'cat_ent_games', keywords: ['steam', 'playstation', 'xbox', 'nintendo', 'epic games'] },
  { categoryId: 'cat_ent_events', keywords: ['ticketmaster', 'eventbrite', 'stubhub', 'live nation', 'seatgeek', 'tcktweb', 'six flags', 'symphony', 'gogol bordello', 'admit one', 'mit dsl', 'museum', 'aquarium', 'zoo'] },

  // Travel — intercity carriers and car rental before local transit / rideshare above.
  { categoryId: 'cat_travel_intercity', keywords: ['wanderu', 'amtrak', 'peter pan bus', 'greyhound', 'megabus', 'flixbus', 'lirr'] },
  { categoryId: 'cat_travel_rental', keywords: ['enterprise rent', 'budget rent', 'hertz', 'avis', 'national car rental', 'budget rent-a-car'] },
  { categoryId: 'cat_travel_flights', keywords: [
    'delta air', 'united air', 'american air', 'southwest air', 'jetblue', 'spirit air', 'airlines', 'frontier ai', 'dufry', 'studentuniverse', 'turkish airl', 'swa excess',
  ] },
  { categoryId: 'cat_travel_hotels', keywords: ['marriott', 'hilton', 'hyatt', 'airbnb', 'hotel', 'motel', 'campground', 'samesun'] },

  // Shopping catch-alls (after more specific categories above so e.g. Target pharmacy runs still win)
  { categoryId: 'cat_shop_general', keywords: ['target', 'walmart', 'wal-mart', 'costco wholesale', 'miniso', 'newbury comics', 'sticker mule', 'firstleaf', ' rei ', 'converse', 'ikea', 'goodwill', 'usps'] },

  // Misc
  { categoryId: 'cat_subscriptions', keywords: ['subscription', 'nytimes', 'collegeboard*profile'] },
  { categoryId: 'cat_personal_care', keywords: ['hair salon', 'barber shop', ' spa ', 'kendall barbers', 'streetsalon', 'lush'] },
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
