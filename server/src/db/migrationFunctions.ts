import type Database from 'better-sqlite3';
import { merchantFromWalletDescriptor, payeeHasWalletTail } from '../services/merchantNames';
import { descriptorDirection, isInternalTrade } from '../services/investmentTrades';

/** SQL functions a repair migration may call, so a repair applies the same rule the importer does. */
export function registerMigrationFunctions(db: Database.Database): void {
  db.function('mizan_wallet_merchant', { deterministic: true }, (description: unknown) =>
    typeof description === 'string' ? merchantFromWalletDescriptor(description) : null
  );
  db.function('mizan_has_wallet_tail', { deterministic: true }, (payee: unknown) =>
    typeof payee === 'string' && payeeHasWalletTail(payee) ? 1 : 0
  );
  db.function('mizan_is_internal_trade', { deterministic: true }, (description: unknown) =>
    typeof description === 'string' && isInternalTrade(description) ? 1 : 0
  );
  db.function('mizan_descriptor_direction', { deterministic: true }, (description: unknown) =>
    typeof description === 'string' ? descriptorDirection(description) : 0
  );
}
