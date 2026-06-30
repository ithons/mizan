import type Database from 'better-sqlite3';

interface PlaidFinanceCategory {
  primary?: string | null;
  detailed?: string | null;
  confidence_level?: string | null;
}

export interface PlaidCategorizationInput {
  amount: number;
  merchantName?: string | null;
  originalName?: string | null;
  personalFinanceCategory?: PlaidFinanceCategory | null;
  legacyCategories?: string[] | null;
}

interface StoredPlaidTransactionRow {
  id: string;
  amount: number;
  merchant_name: string | null;
  original_name: string;
  source_detail: string | null;
}

export interface KnownCategorizationResult {
  updated: number;
}

const DETAILED_CATEGORY_MAP: Record<string, string> = {
  INCOME_DIVIDENDS: 'cat_income_dividends',
  INCOME_INTEREST_EARNED: 'cat_income_interest',
  INCOME_WAGES: 'cat_income_paycheck',
  INCOME_TAX_REFUND: 'cat_income_other',
  INCOME_OTHER_INCOME: 'cat_income_other',

  TRANSFER_IN_ACCOUNT_TRANSFER: 'cat_xfer_in',
  TRANSFER_IN_CASH_ADVANCES_AND_LOANS: 'cat_xfer_in',
  TRANSFER_IN_DEPOSIT: 'cat_xfer_in',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'cat_inv_transfer',
  TRANSFER_IN_SAVINGS: 'cat_xfer_in',
  TRANSFER_IN_OTHER_TRANSFER_IN: 'cat_xfer_in',
  TRANSFER_OUT_ACCOUNT_TRANSFER: 'cat_xfer_out',
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'cat_inv_transfer',
  TRANSFER_OUT_SAVINGS: 'cat_xfer_out',
  TRANSFER_OUT_WITHDRAWAL: 'cat_xfer_out',
  TRANSFER_OUT_OTHER_TRANSFER_OUT: 'cat_xfer_out',

  LOAN_PAYMENTS_CAR_PAYMENT: 'cat_transport_auto',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'cat_xfer_cc',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'cat_home',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'cat_education',

  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'cat_food_bars',
  FOOD_AND_DRINK_COFFEE: 'cat_food_coffee',
  FOOD_AND_DRINK_FAST_FOOD: 'cat_food_restaurants',
  FOOD_AND_DRINK_GROCERIES: 'cat_food_groceries',
  FOOD_AND_DRINK_RESTAURANT: 'cat_food_restaurants',
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK: 'cat_food',

  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'cat_shop_clothing',
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: 'cat_shop_general',
  GENERAL_MERCHANDISE_DISCOUNT_STORES: 'cat_shop_general',
  GENERAL_MERCHANDISE_ELECTRONICS: 'cat_shop_electronics',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'cat_shop_amazon',
  GENERAL_MERCHANDISE_SUPERSTORES: 'cat_shop_general',
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE: 'cat_shop_general',

  HOME_IMPROVEMENT_FURNITURE: 'cat_home',
  HOME_IMPROVEMENT_HARDWARE: 'cat_home',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'cat_home',
  HOME_IMPROVEMENT_SECURITY: 'cat_home',
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT: 'cat_home',

  MEDICAL_DENTAL_CARE: 'cat_health_medical',
  MEDICAL_EYE_CARE: 'cat_health_medical',
  MEDICAL_NURSING_CARE: 'cat_health_medical',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'cat_health_pharmacy',
  MEDICAL_PRIMARY_CARE: 'cat_health_medical',
  MEDICAL_VETERINARY_SERVICES: 'cat_health_medical',
  MEDICAL_OTHER_MEDICAL: 'cat_health_medical',

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'cat_health_fitness',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'cat_personal_care',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'cat_personal_care',
  PERSONAL_CARE_OTHER_PERSONAL_CARE: 'cat_personal_care',

  ENTERTAINMENT_MUSIC_AND_AUDIO: 'cat_ent_streaming',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'cat_ent_events',
  ENTERTAINMENT_TV_AND_MOVIES: 'cat_ent_streaming',
  ENTERTAINMENT_VIDEO_GAMES: 'cat_ent_games',
  ENTERTAINMENT_OTHER_ENTERTAINMENT: 'cat_ent',

  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'cat_home_utilities',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'cat_home_internet',
  RENT_AND_UTILITIES_RENT: 'cat_home_rent',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'cat_home_utilities',
  RENT_AND_UTILITIES_TELEPHONE: 'cat_home_phone',
  RENT_AND_UTILITIES_WATER: 'cat_home_utilities',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'cat_home_utilities',

  TRANSPORTATION_GAS: 'cat_transport_gas',
  TRANSPORTATION_PARKING: 'cat_transport_parking',
  TRANSPORTATION_PUBLIC_TRANSIT: 'cat_transport_transit',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'cat_transport_ride',
  TRANSPORTATION_TOLLS: 'cat_transport',
  TRANSPORTATION_OTHER_TRANSPORTATION: 'cat_transport',

  TRAVEL_FLIGHTS: 'cat_travel_flights',
  TRAVEL_LODGING: 'cat_travel_hotels',
  TRAVEL_RENTAL_CARS: 'cat_travel',
  TRAVEL_OTHER_TRAVEL: 'cat_travel',

  GENERAL_SERVICES_AUTOMOTIVE: 'cat_transport_auto',
  GENERAL_SERVICES_EDUCATION: 'cat_education',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'cat_shop_general',
};

const PRIMARY_CATEGORY_MAP: Record<string, string> = {
  INCOME: 'cat_income_other',
  TRANSFER_IN: 'cat_xfer_in',
  TRANSFER_OUT: 'cat_xfer_out',
  LOAN_PAYMENTS: 'cat_xfer_out',
  FOOD_AND_DRINK: 'cat_food',
  GENERAL_MERCHANDISE: 'cat_shop_general',
  HOME_IMPROVEMENT: 'cat_home',
  MEDICAL: 'cat_health_medical',
  PERSONAL_CARE: 'cat_personal_care',
  ENTERTAINMENT: 'cat_ent',
  RENT_AND_UTILITIES: 'cat_home_utilities',
  TRANSPORTATION: 'cat_transport',
  TRAVEL: 'cat_travel',
  GENERAL_SERVICES: 'cat_shop_general',
};

const LEGACY_CATEGORY_RULES: Array<{ patterns: string[]; categoryId: string }> = [
  { patterns: ['payroll', 'paycheck', 'salary', 'wages'], categoryId: 'cat_income_paycheck' },
  { patterns: ['interest'], categoryId: 'cat_income_interest' },
  { patterns: ['dividend'], categoryId: 'cat_income_dividends' },
  { patterns: ['restaurant', 'fast food', 'food and drink'], categoryId: 'cat_food_restaurants' },
  { patterns: ['coffee'], categoryId: 'cat_food_coffee' },
  { patterns: ['grocery', 'groceries', 'supermarket'], categoryId: 'cat_food_groceries' },
  { patterns: ['bar', 'beer', 'wine', 'liquor'], categoryId: 'cat_food_bars' },
  { patterns: ['gas', 'fuel'], categoryId: 'cat_transport_gas' },
  { patterns: ['parking'], categoryId: 'cat_transport_parking' },
  { patterns: ['taxi', 'rideshare'], categoryId: 'cat_transport_ride' },
  { patterns: ['public transit', 'train', 'bus'], categoryId: 'cat_transport_transit' },
  { patterns: ['rent'], categoryId: 'cat_home_rent' },
  { patterns: ['utility', 'electric', 'water'], categoryId: 'cat_home_utilities' },
  { patterns: ['internet', 'cable'], categoryId: 'cat_home_internet' },
  { patterns: ['phone', 'telecommunication'], categoryId: 'cat_home_phone' },
  { patterns: ['pharmacy'], categoryId: 'cat_health_pharmacy' },
  { patterns: ['medical', 'doctor', 'dentist'], categoryId: 'cat_health_medical' },
  { patterns: ['gym', 'fitness'], categoryId: 'cat_health_fitness' },
  { patterns: ['streaming', 'music', 'movie'], categoryId: 'cat_ent_streaming' },
  { patterns: ['game'], categoryId: 'cat_ent_games' },
  { patterns: ['flight', 'airline'], categoryId: 'cat_travel_flights' },
  { patterns: ['hotel', 'lodging'], categoryId: 'cat_travel_hotels' },
  { patterns: ['clothing', 'apparel'], categoryId: 'cat_shop_clothing' },
  { patterns: ['electronics'], categoryId: 'cat_shop_electronics' },
  { patterns: ['marketplace', 'shopping'], categoryId: 'cat_shop_general' },
  { patterns: ['education', 'school', 'tuition'], categoryId: 'cat_education' },
  { patterns: ['credit card payment'], categoryId: 'cat_xfer_cc' },
  { patterns: ['transfer'], categoryId: 'cat_xfer_out' },
];

const MERCHANT_RULES: Array<{ pattern: RegExp; categoryId: string }> = [
  { pattern: /\b(payroll|paycheck|salary|direct dep(osit)?)\b/i, categoryId: 'cat_income_paycheck' },
  { pattern: /\b(interest|apy)\b/i, categoryId: 'cat_income_interest' },
  { pattern: /\b(dividend)\b/i, categoryId: 'cat_income_dividends' },
  { pattern: /\b(starbucks|dunkin|peet'?s|coffee)\b/i, categoryId: 'cat_food_coffee' },
  { pattern: /\b(restaurant|doordash|uber eats|grubhub|toast|mcdonald|chipotle|sweetgreen|cava)\b/i, categoryId: 'cat_food_restaurants' },
  { pattern: /\b(whole foods|trader joe|kroger|safeway|wegmans|grocery|instacart)\b/i, categoryId: 'cat_food_groceries' },
  { pattern: /\b(shell|exxon|chevron|bp|mobil|sunoco|gas)\b/i, categoryId: 'cat_transport_gas' },
  { pattern: /\b(uber|lyft|taxi)\b/i, categoryId: 'cat_transport_ride' },
  { pattern: /\b(parking|parkmobile)\b/i, categoryId: 'cat_transport_parking' },
  { pattern: /\b(mta|metro|transit|amtrak)\b/i, categoryId: 'cat_transport_transit' },
  { pattern: /\b(rent)\b/i, categoryId: 'cat_home_rent' },
  { pattern: /\b(electric|utility|water|sewer|gas bill)\b/i, categoryId: 'cat_home_utilities' },
  { pattern: /\b(comcast|xfinity|spectrum|internet)\b/i, categoryId: 'cat_home_internet' },
  { pattern: /\b(verizon|at&t|t-mobile|tmobile|phone)\b/i, categoryId: 'cat_home_phone' },
  { pattern: /\b(cvs|walgreens|pharmacy)\b/i, categoryId: 'cat_health_pharmacy' },
  { pattern: /\b(hospital|medical|doctor|dentist|clinic)\b/i, categoryId: 'cat_health_medical' },
  { pattern: /\b(gym|fitness|planet fitness|equinox|classpass)\b/i, categoryId: 'cat_health_fitness' },
  { pattern: /\b(netflix|hulu|spotify|disney|hbo|max|youtube|apple tv|prime video)\b/i, categoryId: 'cat_ent_streaming' },
  { pattern: /\b(steam|playstation|xbox|nintendo)\b/i, categoryId: 'cat_ent_games' },
  { pattern: /\b(delta|united|american airlines|southwest|jetblue|airline)\b/i, categoryId: 'cat_travel_flights' },
  { pattern: /\b(hotel|marriott|hilton|airbnb|lodging)\b/i, categoryId: 'cat_travel_hotels' },
  { pattern: /\b(amazon)\b/i, categoryId: 'cat_shop_amazon' },
  { pattern: /\b(best buy|apple store|micro center)\b/i, categoryId: 'cat_shop_electronics' },
  { pattern: /\b(target|walmart|costco|costco whse|department store)\b/i, categoryId: 'cat_shop_general' },
  { pattern: /\b(venmo|zelle|cash app|paypal transfer|ach transfer)\b/i, categoryId: 'cat_xfer_out' },
  { pattern: /\b(credit card payment|autopay payment)\b/i, categoryId: 'cat_xfer_cc' },
];

function normalizeToken(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
}

function categoryExists(db: Database.Database, categoryId: string): boolean {
  const row = db.prepare('SELECT 1 FROM categories WHERE id = ? LIMIT 1').get(categoryId);
  return !!row;
}

function categoryFromLegacyCategories(input: PlaidCategorizationInput): string | null {
  const haystack = (input.legacyCategories ?? []).join(' ').toLowerCase();
  if (!haystack) return null;

  for (const rule of LEGACY_CATEGORY_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      if (rule.categoryId === 'cat_xfer_out' && input.amount > 0) return 'cat_xfer_in';
      return rule.categoryId;
    }
  }

  return null;
}

function categoryFromMerchant(input: PlaidCategorizationInput): string | null {
  const merchant = `${input.merchantName ?? ''} ${input.originalName ?? ''}`.trim();
  if (!merchant) return null;

  for (const rule of MERCHANT_RULES) {
    if (rule.pattern.test(merchant)) {
      if (rule.categoryId === 'cat_xfer_out' && input.amount > 0) return 'cat_xfer_in';
      return rule.categoryId;
    }
  }

  return null;
}

export function categoryIdForPlaidTransaction(input: PlaidCategorizationInput): string | null {
  const pfc = input.personalFinanceCategory;
  const detailed = normalizeToken(pfc?.detailed);
  const primary = normalizeToken(pfc?.primary);

  return (
    DETAILED_CATEGORY_MAP[detailed] ??
    PRIMARY_CATEGORY_MAP[primary] ??
    categoryFromLegacyCategories(input) ??
    categoryFromMerchant(input)
  );
}

export function plaidSourceDetail(input: PlaidCategorizationInput): string | null {
  const detail = {
    plaid: {
      personal_finance_category: input.personalFinanceCategory ?? null,
      legacy_categories: input.legacyCategories ?? null,
    },
  };

  if (!detail.plaid.personal_finance_category && !detail.plaid.legacy_categories) {
    return null;
  }

  return JSON.stringify(detail);
}

export function safePlaidCategoryId(
  db: Database.Database,
  input: PlaidCategorizationInput
): string | null {
  const categoryId = categoryIdForPlaidTransaction(input);
  return categoryId && categoryExists(db, categoryId) ? categoryId : null;
}

function pfcFromSourceDetail(sourceDetail: string | null): PlaidFinanceCategory | null {
  if (!sourceDetail) return null;

  try {
    const parsed = JSON.parse(sourceDetail) as {
      plaid?: { personal_finance_category?: PlaidFinanceCategory | null };
    };
    return parsed.plaid?.personal_finance_category ?? null;
  } catch {
    return null;
  }
}

function legacyCategoriesFromSourceDetail(sourceDetail: string | null): string[] | null {
  if (!sourceDetail) return null;

  try {
    const parsed = JSON.parse(sourceDetail) as {
      plaid?: { legacy_categories?: string[] | null };
    };
    return parsed.plaid?.legacy_categories ?? null;
  } catch {
    return null;
  }
}

export function applyKnownPlaidCategorizationToExistingTransactions(
  db: Database.Database,
  now = new Date().toISOString()
): KnownCategorizationResult {
  const rows = db.prepare(`
    SELECT id, amount, merchant_name, original_name, source_detail
    FROM transactions
    WHERE source_type = 'plaid'
      AND category_id IS NULL
  `).all() as StoredPlaidTransactionRow[];

  const update = db.prepare(`
    UPDATE transactions
    SET category_id = ?, updated_at = ?
    WHERE id = ?
      AND category_id IS NULL
  `);

  let updated = 0;
  for (const row of rows) {
    const categoryId = safePlaidCategoryId(db, {
      amount: row.amount,
      merchantName: row.merchant_name,
      originalName: row.original_name,
      personalFinanceCategory: pfcFromSourceDetail(row.source_detail),
      legacyCategories: legacyCategoriesFromSourceDetail(row.source_detail),
    });
    if (!categoryId) continue;

    const result = update.run(categoryId, now, row.id);
    updated += result.changes;
  }

  return { updated };
}
