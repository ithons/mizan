-- Budget groups, removed. Both tables were empty on 2026-07-31, three weeks after migration 005
-- created them, in a ledger carrying exactly one budget:
--   sqlite3 .mizan/mizan.db 'SELECT (SELECT COUNT(*) FROM budget_groups),
--     (SELECT COUNT(*) FROM budget_group_members), (SELECT COUNT(*) FROM budgets);'  -> 0|0|1
-- A grouping mechanism over one budget is a rollup of a single row, and Phase 8 folds Budget and
-- Goals into one claim sheet where the grouping level has nothing left to group.
--
-- No create-new/copy/drop/rename here, and that is a fact about the schema rather than an
-- omission. That pattern exists because SQLite cannot ALTER a constraint, so a table whose SHAPE
-- changes has to be rebuilt. Nothing's shape changes: no other table declares a foreign key INTO
-- either of these, so dropping them leaves no dangling reference to rewrite.
--   sqlite3 .mizan/mizan.db "SELECT name FROM sqlite_master WHERE type='table'
--     AND sql LIKE '%REFERENCES budget_group%';"  -> budget_group_members (itself, on its parent)
-- The two foreign keys that do exist point OUT of budget_group_members, at budget_groups and at
-- categories, and both go with it.
--
-- The index goes explicitly rather than by implication. DROP TABLE takes its indexes with it, but
-- naming it here is what makes the removal readable against 005, which created all three.

DROP INDEX IF EXISTS idx_budget_group_members_category;
DROP TABLE IF EXISTS budget_group_members;
DROP TABLE IF EXISTS budget_groups;
