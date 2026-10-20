// Fetch the daily closes every held security is missing (priceHistory.ts). Sync does the same once
// a day; this is for a backfill or a check. Only ticker symbols and dates leave the machine.
//
//   tsx scripts/backfill/refresh-prices.ts
import { getDb, closeDb } from '../../server/src/db/index';
import { refreshSecurityPrices } from '../../server/src/services/priceHistory';

async function main(): Promise<void> {
  try {
    for (const row of await refreshSecurityPrices(getDb())) {
      console.log(`${row.ticker.padEnd(6)} ${row.source.padEnd(18)} ${row.error ? `failed: ${row.error}` : `${row.stored} closes`}`);
    }
  } finally {
    closeDb();
  }
}

void main();
