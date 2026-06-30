# Mizān — Next Phase Plan

## 1. Assessment & Findings

### The "Local-First" Gap (Security & Privacy)
Mizān is architected to keep data local, but currently relies on a hardcoded Anthropic API key. This violates the non-negotiable "nothing leaving the device that doesn't have to" for users who have the hardware to run local models.
Additionally, the AES encryption key for Plaid/Coinbase credentials is stored in a plaintext `.mizan/mizan.key` file. While better than plaintext credentials, it is vulnerable to file-system exfiltration.

### The "Freelancer" Gap
Current budget projections treat all income as personal cash flow. For a freelancer, a $5k deposit is not $5k of spending power—it carries a ~30% tax liability. Without a way to isolate business expenses and withhold estimated taxes, a single-user freelancer will quietly receive wrong numbers for their true "Safe to Spend" balance. 

### AI Architecture Gaps
The backend architecture is excellent: the `aiWorker.ts` proactively generates typed, auditable `advisor_drafts` on sync. However, the *frontend* still treats the AI like a "chat panel stapled to the side" at `/advisor`. To make the AI genuinely foundational, the primary interaction model should shift from conversational chat to command-driven intent (like Raycast or Linear). 

---

## 2. Execution Plan

### Phase 1: Security & Strict Local-First (Urgent & Foundational)
*Target: Seal credential storage and eliminate hard cloud dependencies.*

* **1.1 Native Keychain Integration:** Migrate the `mizan.key` storage to the native OS keychain (e.g., using macOS Keychain/Windows Credential Manager bindings) to secure financial API tokens at rest.
* **1.2 Local LLM Provider (Ollama):** Abstract the Anthropic client in `ai.ts`/`aiWorker.ts` into a provider interface. Introduce support for local models via Ollama. If a user has a capable machine, Mizān should run its background sync reviews entirely offline.

### Phase 2: The Freelancer Reality (Closing the Competitor Gap)
*Target: Precise cash-flow and liability management for single-user businesses.*

* **2.1 Tax Liability Envelopes:** Add a `taxable` flag to income categories and a configurable estimated tax rate in settings. 
* **2.2 Automated Withholding Drafts:** Update the AI Worker to detect taxable income events and automatically generate a draft to transfer the estimated tax amount into a "Tax Liability" goal/envelope, actively subtracting it from the "Safe to Spend" dashboard metric.
* **2.3 Business/Personal Report Segmentation:** Allow categories to be marked as `business_expense`. Update the Cash Flow and Spending reports to optionally toggle business entities, revealing the true personal net yield.

### Phase 3: Ubiquitous Intelligence (Woven, Not Bolted)
*Target: Evolve the AI from a destination (`/advisor`) to an omnipresent infrastructure.*

* **3.1 The Mizān Command Palette (Cmd+K):** Build a globally accessible, keyboard-driven command palette. Users type natural language ("Move $400 from dining to travel", "Split the Amazon transaction 50/50 for business"), and the AI immediately generates a typed Draft action directly in the palette.
* **3.2 Contextual Drafts UI:** Expose generated drafts natively within their respective views (e.g., budget adjustment drafts appear directly on the Budget page, categorization drafts appear directly on the Transactions ledger), rather than forcing the user into the Review Inbox or Advisor Chat.
* **3.3 Expand AI Action Types:** Add missing draft kinds to the AI to achieve parity with the UI: `split_transaction`, `ignore_anomaly`, and `create_manual_account`.

---

## 3. Design Language & UI Constraints
- The Command Palette will mirror the existing precision-instrument aesthetic: monospace fonts for numbers, dark/restrained colors, and zero SaaS clutter.
- Drafts will use the existing `DraftActionsList` visual language but be embedded inline within tables and headers.

## Definition of Done
The plan is complete when a freelancer can run Mizān entirely locally (via Ollama), have their Plaid keys secured in the OS keychain, auto-withhold 30% of their 1099 income into a tax goal, and adjust their budget using a global Cmd+K palette without ever opening a chat window.
