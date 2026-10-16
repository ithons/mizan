CREATE TABLE notification_rules_new (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN (
    'budget_threshold',
    'large_transaction',
    'bill_due',
    'low_balance',
    'safe_to_spend_negative',
    'sync_failed',
    'goal_milestone',
    'unusual_spending',
    'recurring_amount_changed',
    'income_late',
    'account_shortfall',
    'card_payment_missing'
  )),
  params TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(params)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_by TEXT NOT NULL CHECK(created_by IN ('owner', 'advisor')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO notification_rules_new (id, kind, params, enabled, created_by, created_at, updated_at)
SELECT id, kind, params, enabled, created_by, created_at, updated_at FROM notification_rules;

DROP TABLE notification_rules;

ALTER TABLE notification_rules_new RENAME TO notification_rules;

INSERT OR IGNORE INTO notification_rules (id, kind, params, enabled, created_by, created_at, updated_at) VALUES
  ('nrule_card_payment_missing', 'card_payment_missing', '{"min_days_late":3}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
