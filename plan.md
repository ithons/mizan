# Mizān Execution Plan: The "Windshield" Paradigm

## Core Philosophy
Mizān will move from a reactive "rearview mirror" reporting tool to a proactive "windshield" financial co-pilot. Instead of generic dashboards summarizing the past, the app will focus on the present and immediate future: "Safe to Spend" pacing, upcoming cash flow radar, and 1-click AI-driven insights directly in the inbox.

---

## Phase 2: Cleanup (Prerequisite)
Clean up stray development scripts from the root directory to ensure a clean workspace.

*   **Files to remove:** 
    *   `fix_plaid_redirect.sh`
    *   `fix_recurring.sh`
    *   `temp_plaid_routes.ts`
    *   `test_url.js`

---

## Phase 3: Data Integrity & Tech Debt

### 3.1 Cross-Provider Duplicate Detection
When migrating from Plaid to Teller or SimpleFIN, overlapping transaction histories will artificially inflate spending and net flow.
*   **Target:** `server/src/services/transactionIntegrity.ts`
*   **Action:** 
    *   Currently, duplicate detection strictly groups by `account_id`, `date`, `amount`, and `merchant`.
    *   We need to expand the duplicate detection window to match transactions across *different* accounts if they are functionally the same (e.g., a Plaid Chase account and a Teller Chase account during a migration window).
    *   Implement fuzzy date matching (+/- 3 days) and exact amount matching for cross-account duplicate candidates.
    *   Auto-dismiss or auto-merge if an exact match exists across two providers to prevent duplicate net worth inflation.

### 3.2 Stale State Degradation
If sync fails, "Safe to Spend" math becomes dangerous to trust.
*   **Target:** `server/src/services/syncHealth.ts`, `shared/types/index.ts`
*   **Action:**
    *   Add a `confidence_interval` or `staleness_flag` warning when primary liquid accounts haven't synced in >48 hours.
    *   Pass this flag up through the API so the UI can visually degrade the "Safe to Spend" metric (e.g., greying it out or adding a warning icon).

---

## Phase 4: The Proactive Engine

### 4.1 "Safe to Spend" & Velocity Pacing
Shift budgeting from static monthly limits to velocity and pacing.
*   **Target:** `server/src/services/budgetProjection.ts`, `shared/types/index.ts`
*   **Action:**
    *   Add `pacing_velocity` calculation to budgets: `(Spent / Total Budget) / (Days Elapsed / Total Days in Month)`.
    *   If velocity > 1.0, the user is pacing to overspend.
    *   Calculate the global **Safe to Spend**: `(Total Liquid Cash) - (Upcoming Forecasted Bills in next 30 days) - (Remaining Allocated Budgets)`.

### 4.2 Woven AI (Proactive Inbox)
The AI should act as a background worker, not just a chatbot.
*   **Target:** `server/src/services/syncManager.ts`, `server/src/services/advisorDrafts.ts`, `server/src/services/transactionReview.ts`
*   **Action:**
    *   After `runFullSync()` completes, trigger a background AI review pass on the new transaction delta.
    *   Automatically generate `advisor_drafts` (e.g., "Approve new recurring baseline?", "Create rule for Target?") and push them directly into the Review Inbox.
    *   Ensure these drafts are surfaced in `getTransactionReviewSummary` so the UI knows there are pending AI insights.

---

## Phase 5: Design & UI ("Morning Briefing")

### 5.1 The Windshield Redesign
Replace the generic SaaS dashboard with a highly opinionated, action-oriented briefing.
*   **Target:** `client/src/views/Dashboard.tsx`, `client/src/lib/dashboardLayout.ts`
*   **Action:**
    *   Remove modular card clutter. Demote "Sync Health" and "Data Quality" to subtle header icons.
    *   **Top Section:** "Safe to Spend" (Hero metric) with a progress bar indicating pacing velocity.
    *   **Left Section:** Inbox Zero. "X items need review" (transactions + AI drafts).
    *   **Right Section:** Upcoming Radar. A clean list of the next 7-14 days of cash flow.
    *   Use `JetBrains Mono` for all numbers to give it a precision-instrument feel.

### 5.2 Action-Oriented Inbox
*   **Target:** `client/src/views/ReviewInbox.tsx`
*   **Action:**
    *   Redesign to favor 1-click approvals for AI suggestions. 
    *   Instead of a generic list of uncategorized transactions, group them by AI confidence: "Mizān suggests Groceries for these 5 transactions. [Approve All]".

---

## Phase 6: Optimization

### 6.1 Decouple Sync from Boot
*   **Target:** `server/src/index.ts`, `client/src/hooks/useSyncStatus.ts`
*   **Action:**
    *   The `MIZAN_AUTO_SYNC_ON_STARTUP` logic currently runs on a 2000ms timeout but can still cause the UI to load in a "stale" or "loading" state if providers are slow.
    *   Ensure the React client paints immediately using local SQLite data. 
    *   Use a subtle "Syncing in background..." indicator in the UI that resolves silently, rather than blocking the dashboard from rendering its initial state.

---

## Execution Rules
1. Work sequentially through the phases.
2. Define "Done" for each file before modifying the next.
3. Validate with TypeScript type-checking (`npm run typecheck` or equivalent) and tests.
4. Keep commits/changes small and atomic where possible.