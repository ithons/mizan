-- A full audit of the transaction history surfaced a federal tax payment filed under
-- "Transport / Fines" (an old rule matched it as a penalty). The auditor could only move it to
-- "Fees & Charges", because the taxonomy had nowhere for tax to live at all.
--
-- Taxes are their own kind of outflow: not a service fee, not a fine, and not discretionary. They
-- also need to be separable at reporting time, which "Fees & Charges" makes impossible.
INSERT OR IGNORE INTO categories (id, name, icon, color, parent_id, is_income, is_system, is_investment, sort_order) VALUES
  ('cat_taxes', 'Taxes', '🧾', '#8a8578', NULL, 0, 1, 0, 74);
