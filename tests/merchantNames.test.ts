import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import {
  cleanProviderMerchant,
  merchantFromImportedDescriptor,
  merchantFromWalletDescriptor,
} from '../server/src/services/merchantNames';
import { applySimplefinResponse } from '../server/src/services/simplefin';
import { runMigrationsOn } from '../server/src/db/index';
import { insertAccount, insertTransaction, migratedTestDb, TEST_NOW } from './helpers/schema';

const WALLET_CASES: Array<[description: string, payee: string, expected: string]> = [
  ['MIT DINING CAFE CAMBRIDGE MAAPPLE PAY ENDING IN 8537', 'Mit Dining Cafe Cambridge Maapple Pay', 'MIT Dining Cafe'],
  ['10078 CAVA KENDALL SQR CAMBRIDGE MAAPPLE PAY ENDING IN 8537AABRCNXQACF4', 'Cava Kendall Cambridge Maapple Pay Aabrcnxqacf', 'Cava'],
  ['TST* THE FRIENDLY TOAST- CONCORD NHAPPLE PAY ENDING IN 8537', 'The Friendly Toast Concord Nhapple Pay', 'The Friendly Toast'],
  ['CHERCHER RESTAURANT WASHINGTON DCAPPLE PAY ENDING IN 8537', 'Chercher Restaurant Washington Dcapple Pay', 'Chercher Restaurant'],
  ['MARKET BASKET 0028 SOMERVILLE MAAPPLE PAY ENDING IN 8537', 'Market Basket Somerville Maapple Pay', 'Market Basket'],
  ['TST*VESTER- CAMBRIDGE CAMBRIDGE MAAPPLE PAY ENDING IN 853700048607034268733859AA', 'Vester Cambridge Maapple Pay Aa', 'Vester'],
  ['TST*EL JEFES - NORTHEA BOSTON MAAPPLE PAY ENDING IN 853700040439033973902588AA', 'El Jefes Northea Boston Maapple Pay Aa', 'El Jefes - Northea'],
  ['BOSTON DERMATOLOGY LASER BOSTON MAAPPLE PAY ENDING IN 8537', 'Boston Dermatology Laser Maapple Pay', 'Boston Dermatology Laser'],
];

test('a wallet-paid descriptor names the merchant without the city, glued state, wallet or token', () => {
  for (const [description, payee, expected] of WALLET_CASES) {
    assert.equal(cleanProviderMerchant(payee, description), expected, description);
  }
});

test('a dash inside the merchant name survives; only a dash before the repeated city is cut', () => {
  assert.equal(
    merchantFromWalletDescriptor('TST*Z- CHURNED - BAKEY CAMBRIDGE MAAPPLE PAY ENDING IN 853700209563GEUSBOYWMO9UAA'),
    'Z-Churned - Bakey'
  );
});

test('a two-word city is dropped whole', () => {
  assert.equal(
    merchantFromWalletDescriptor('SQ *BLUE BOTTLE COFFEE NEW YORK NYAPPLE PAY ENDING IN 8537'),
    'Blue Bottle Coffee'
  );
});

test('a provider payee without a wallet tail is kept exactly, casing included', () => {
  for (const [description, payee] of [
    ['EXXONMOBIL BRONX NYAPPLE PAY ENDING IN 8537', 'ExxonMobil'],
    ['TOTAL WINE AND MORE LAUREL MDAPPLE PAY ENDING IN 8537', 'Total Wine & More'],
    ['PETSMART # 0791 EVERETT MAAPPLE PAY ENDING IN 8537', 'PetSmart'],
    ['CAPITAL ONE AUTOPAY PYMT', 'CAPITAL ONE AUTOPAY PYMT'],
    ['MASS INST PAYROLL PPD ID: 9111111101', 'Mass Inst Payroll'],
  ]) {
    assert.equal(cleanProviderMerchant(payee, description), payee);
  }
});

test('a descriptor that only mentions a pay product is not a wallet tail', () => {
  assert.equal(merchantFromWalletDescriptor('CAPITAL ONE AUTOPAY PYMT'), null);
  assert.equal(merchantFromWalletDescriptor('MTS PRONTO OPEN PAY 1 SAN DIEGO CA'), null);
  assert.equal(merchantFromWalletDescriptor('GOOGLE *CLOUD 4DNMVw g.cohelppay, CA'), null);
  assert.equal(cleanProviderMerchant(null, 'DIRECTPAY FULL BALANCE'), null);
});

test('with no payee at all a wallet descriptor still yields the merchant', () => {
  assert.equal(
    cleanProviderMerchant(null, 'TST*WISHING CUP BOSTON MAAPPLE PAY ENDING IN 853700233661033971342523AA'),
    'Wishing Cup'
  );
});

test('a wallet descriptor that is nothing but a city keeps the city rather than going empty', () => {
  assert.equal(merchantFromWalletDescriptor('CAMBRIDGE MAAPPLE PAY ENDING IN 8537'), 'Cambridge');
});

const WALLET_DESCRIPTION = 'MIT DINING CAFE CAMBRIDGE MAAPPLE PAY ENDING IN 8537';

function walletResponse(payee: string): unknown {
  return {
    accounts: [{
      id: 'ACT-discover',
      name: 'Discover',
      currency: 'USD',
      balance: '-120.27',
      org: { name: 'Discover Credit Card' },
      transactions: [{
        id: 'TRN-mit-dining',
        posted: 1_791_500_000,
        amount: '-9.10',
        payee,
        description: WALLET_DESCRIPTION,
        pending: false,
      }],
    }],
  };
}

test('a SimpleFIN row paid by wallet is stored under the merchant, not the provider payee', () => {
  const db = migratedTestDb();
  applySimplefinResponse(db, walletResponse('Mit Dining Cafe Cambridge Maapple Pay'), TEST_NOW);
  const row = db.prepare('SELECT merchant_name, original_name FROM transactions').get() as {
    merchant_name: string;
    original_name: string;
  };
  assert.equal(row.merchant_name, 'MIT Dining Cafe');
  assert.equal(row.original_name, WALLET_DESCRIPTION, 'the raw descriptor is kept as evidence');
});

function rerunWalletRepair(db: Database.Database): void {
  db.prepare("DELETE FROM schema_migrations WHERE name = '062_wallet_merchant_names.sql'").run();
  runMigrationsOn(db);
}

test('the repair renames only provider-authored wallet payees and records each rename', () => {
  const db = migratedTestDb();
  const card = insertAccount(db, { account_name: 'Discover', type: 'credit', is_liability: 1 });
  const junk = insertTransaction(db, {
    account_id: card,
    merchant_name: 'Cava Kendall Cambridge Maapple Pay Aabrcnxqacf',
    original_name: '10078 CAVA KENDALL SQR CAMBRIDGE MAAPPLE PAY ENDING IN 8537AABRCNXQACF4',
  });
  const clean = insertTransaction(db, {
    account_id: card,
    merchant_name: 'ExxonMobil',
    original_name: 'EXXONMOBIL BRONX NYAPPLE PAY ENDING IN 8537',
  });
  const owned = insertTransaction(db, {
    account_id: card,
    merchant_name: 'Friendly Toast Maapple Pay (birthday)',
    original_name: 'TST* THE FRIENDLY TOAST- CONCORD NHAPPLE PAY ENDING IN 8537',
  });
  db.prepare("UPDATE transactions SET merchant_name_source = 'provider' WHERE id IN (?, ?)").run(junk, clean);
  db.prepare("UPDATE transactions SET merchant_name_source = 'human' WHERE id = ?").run(owned);

  rerunWalletRepair(db);

  const name = (id: string) =>
    (db.prepare('SELECT merchant_name FROM transactions WHERE id = ?').get(id) as { merchant_name: string })
      .merchant_name;
  assert.equal(name(junk), 'Cava');
  assert.equal(name(clean), 'ExxonMobil', 'a provider name without a wallet tail is left alone');
  assert.equal(name(owned), 'Friendly Toast Maapple Pay (birthday)', 'an owner-typed name is never rewritten');

  const revisions = db.prepare(
    "SELECT transaction_id, from_value, to_value FROM transaction_field_revisions WHERE origin = 'import_rule'"
  ).all();
  assert.deepEqual(revisions, [{
    transaction_id: junk,
    from_value: 'Cava Kendall Cambridge Maapple Pay Aabrcnxqacf',
    to_value: 'Cava',
  }]);

  rerunWalletRepair(db);
  const count = db.prepare("SELECT COUNT(*) AS n FROM transaction_field_revisions WHERE origin = 'import_rule'")
    .get() as { n: number };
  assert.equal(count.n, 1, 'a second pass over a repaired ledger writes nothing');
});

const IMPORTED_CASES: Array<[descriptor: string, expected: string]> = [
  ['10078 CAVA KENDALL SQR CAMBRIDGE MA', 'CAVA'],
  ['10078D CAVA KENDALL SQ 617-202-9396, MD', 'CAVA'],
  ['MBTA-550034792089 BOSTON MA', 'MBTA'],
  ['MBTA-550035316375-3388', 'MBTA'],
  ['CVS/PHARMACY #11242 CAMBRIDGE MA', 'CVS/PHARMACY'],
  ['SPOTIFY 877-778-1161, NY', 'SPOTIFY'],
  ['GAP ONLINE 800-4277895, OH', 'GAP ONLINE'],
  ['VENMO CASHOUT PPD ID: 1000000007', 'VENMO CASHOUT'],
  ['UBER   *TRIP HELP.UBER.COM, CA', 'UBER *TRIP'],
  ['MTA*NYCT PAYGO NEW YORK, NY', 'MTA*NYCT PAYGO'],
  ['TARGET        00018986 DORCHESTER, MA', 'TARGET'],
];

test('an imported descriptor loses its store number, phone, ACH id and city', () => {
  for (const [descriptor, expected] of IMPORTED_CASES) {
    assert.equal(merchantFromImportedDescriptor(descriptor), expected, descriptor);
  }
});

test('HEALTHY: a name whose digits or words are the name passes through unchanged', () => {
  for (const name of [
    '7-ELEVEN', '76', '1-800-FLOWERS', 'MINT MOBILE', 'Cava', 'H&M', 'WAWA 55', 'BOSTON MA',
    'BOLT.EUO2501030929 Tallinn', 'Zelle payment from A FRIEND BACq7m2k9z4w',
  ]) {
    assert.equal(merchantFromImportedDescriptor(name), name);
  }
});

test('a full-width name glued to its city keeps the whole name rather than lose part of it', () => {
  assert.equal(merchantFromImportedDescriptor('MONTAGUE STREET BAGELSBROOKLYN, NY'), 'MONTAGUE STREET BAGELSBROOKLYN, NY');
  assert.equal(merchantFromImportedDescriptor('NATIONAL ENTERTAINMENLOWELL, MA'), 'NATIONAL ENTERTAINMENLOWELL, MA');
});
