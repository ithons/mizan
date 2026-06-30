# OpenCode Instructions for Mizān

## Architecture & Boundaries
- **Monolithic Repository:** Single `package.json` covering the full stack.
- **Client (`client/`)**: React 18, Vite, Tailwind CSS, Zustand, and `@tanstack/react-query`.
  - **Component Structure:** Do not create monolithic view files. Large views should be decomposed into dedicated folders (e.g., `client/src/views/settings/`).
  - **Styling:** Custom UI components without heavy UI libraries. Use the semantic Tailwind palette defined in `tailwind.config.js` (e.g., `text-green`, `bg-rose`, `text-muted`). **DO NOT** use raw hex codes (like `#32bfa3`) in JSX. Use `Inter` for standard text and `JetBrains Mono` (`font-mono`) for amounts, dates, and data.
  - **Data Fetching:** Native `fetch` is used for API calls (via `client/src/lib/api.ts`).
- **Server (`server/`)**: Express, `better-sqlite3`, `zod` for request validation. External requests use `axios`.
  - **Error Handling:** The `errorHandler` middleware intelligently parses Axios/Plaid errors. Throw standard `Error` objects or attach `.status` / `.response` to pass structured payloads to the client.
- **Shared (`shared/`)**: Shared TypeScript interfaces mapped via paths.
- **Data Location**: The SQLite database (`mizan.db`), the local encryption key (`mizan.key`), encrypted credentials (`credentials.json`), and server logs are all stored in the uncommitted `.mizan/` folder. This ensures local-first portability.

## Commands & Workflow
- **Dev Server**: `npm run dev` serves both client and server via `vite-express` on `http://localhost:3001` with hot reloading.
- **Formatting/Linting**: The project does not currently have ESLint or Prettier configured. Rely on strict TypeScript checking and follow existing file styles.
- **Database Migrations**: Add plain `.sql` files to `server/src/db/migrations/` and apply them locally with `npm run db:migrate`. The backend uses raw SQL strings with `better-sqlite3`, no ORMs or query builders.

## Testing Quirks (Crucial)
- **Native Test Runner**: The project strictly uses the native Node.js test runner (`node:test` and `node:assert/strict`). **DO NOT** use `jest`, `vitest`, global `describe/it`, or `expect()`.
- **Running All Tests**: `npm run test`
- **Running a Single Test**: `node --test --import tsx tests/<filename>.test.ts`
- **Database Testing**: To keep unit tests isolated and fast, tests interacting with the DB instantiate their own in-memory sqlite connections (`new Database(':memory:')`). Instead of loading the full migration suite, test files explicitly execute the minimal `CREATE TABLE` statements they need for their fixtures inline.
