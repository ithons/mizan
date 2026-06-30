# Mizān Phase 2 Roadmap

## Objective

Phase 2 turns Mizān from a functional finance dashboard into a trustworthy daily finance loop. The priority is confidence: users should understand what synced, what changed, what needs review, and what is coming next without digging through tabs.

## Current Foundation

Mizān now has the main product primitives in place:

- Connected and manual accounts
- Bank, crypto, transaction, holding, and net worth data
- Categories, merchant rules, budgets, recurring patterns, goals, reports, insights, and advisor context
- Sync health surfaced on the dashboard
- Shared services for recurring forecasts, goal progress, and report semantics

The remaining gap is product coherence. The pieces work, but the app needs stronger trust signals, fewer manual review points, and workflows that explain why numbers changed.

## Implementation Status

Phase 2 is now implemented as a first coherent product loop:

- Sync trust is centralized through shared sync-health services and visible on accounts, dashboard, and advisor context
- Transaction review is consolidated into a review summary and dedicated review panel for uncategorized items, rule suggestions, pending transactions, and recurring candidates
- Cash flow forecasts now separate confirmed, likely, and uncertain activity, with overdue and needs-review states
- Reports use shared transfer-aware semantics and include a summary layer for period comparisons, category movement, and excluded flows
- Advisor workflows are grounded in the same sync, review, forecast, and report services that power the UI
- A data-quality summary now combines sync health, transaction review, cash-flow confidence, and report caveats into one trust score for dashboard and advisor surfaces

The next phase should focus on correctness hardening, richer account-level explanations, and workflows that reduce user maintenance instead of adding more screens.

## Priority Order

1. Sync trust center
2. Transaction review and learning loop
3. Cash flow confidence
4. Reporting depth and polish
5. Integrated advisor workflows

## 1. Sync Trust Center

Problem: users cannot trust numbers if they cannot tell whether data is fresh, partial, or broken.

Build:

- Per-connection sync timeline with last attempt, last success, status, and account count
- Clear reconnect, retry, and manual refresh actions
- Data freshness badges on dashboard, accounts, reports, and advisor answers
- Sync issue history with plain-language failure reasons
- Explicit handling for partial sync success across multiple institutions

Success criteria:

- A user can answer "is my data current?" within five seconds
- Failed syncs create durable visible state
- Advisor responses can cite the freshness of the underlying data

## 2. Transaction Review And Learning Loop

Problem: raw bank data is noisy, and categorization is where finance apps either earn trust or create maintenance work.

Build:

- Review inbox for uncategorized, unusual, pending-to-posted, and merchant-changed transactions
- Rule suggestions based on repeated user edits
- One-click rule creation from transaction rows
- Rule preview before applying to historical transactions
- Merchant normalization that separates raw name, display name, and learned merchant identity

Success criteria:

- The uncategorized backlog trends down without user micromanagement
- Rule suggestions feel explainable and reversible
- Most daily transaction review happens from one screen

## 3. Cash Flow Confidence

Problem: cash flow projections become useful only when recurring income and bills are accurate and gaps are visible.

Build:

- Confirmation flow for detected recurring patterns
- Confidence score for each forecasted occurrence
- Upcoming cash flow view that separates confirmed, likely, and uncertain events
- Detection for missed expected bills and missing paycheck windows
- Data-gap warnings when a stale institution affects projections

Success criteria:

- Users can see the next 30 days of inflows and outflows with confidence levels
- The app flags missing or late recurring events before they distort cash flow
- Forecast totals explain what they include

## 4. Reporting Depth And Polish

Problem: basic category charts are necessary but not enough to beat mature personal finance tools.

Build:

- Transfer-aware spending, income, and cash flow drilldowns
- Refund and reimbursement handling
- Split transaction support
- Period comparison views for month, quarter, and year
- Category trend charts with drilldown from parent to leaf categories
- Net worth change explanations by account and asset class

Success criteria:

- Reports answer common user questions without exporting CSV
- Transfers, investments, and crypto flows do not pollute spending totals
- Large net worth changes can be traced to account-level movements

## 5. Integrated Advisor Workflows

Problem: an advisor that only chats is less useful than one that can inspect context and guide action inside the product.

Build:

- Advisor answers with cited data windows and freshness state
- Suggested follow-up actions that deep-link into reports, transactions, budgets, or goals
- Budget variance explanations using actual transactions
- Natural-language questions over categories, merchants, accounts, goals, and recurring patterns
- Guardrails for stale or incomplete data

Success criteria:

- Advisor responses are grounded in the same report services the UI uses
- The assistant refuses false precision when sync health is stale
- Users can move from answer to action in one click

## Sequencing

Milestone 1 should finish before broad feature expansion. The product cannot credibly claim clarity until sync state is transparent.

Milestone 2 and 3 form the daily loop: review what happened, understand what comes next, and teach the system as little as possible.

Milestone 4 and 5 are the differentiators. They should build on stable semantics and shared services, not duplicate finance logic in route handlers or UI components.
