// Standalone migration runner: npm run db:migrate
import { runMigrations, closeDb } from './index';

runMigrations();
console.log('[db] Migrations complete');
closeDb();
