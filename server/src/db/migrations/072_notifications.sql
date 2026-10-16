-- Money inside params and payload is integer cents, like every other money column.
CREATE TABLE notification_rules (
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
    'recurring_amount_changed'
  )),
  params TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(params)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  created_by TEXT NOT NULL CHECK(created_by IN ('owner', 'advisor')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  rule_id TEXT REFERENCES notification_rules(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info', 'warning', 'critical')),
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT,
  dismissed_at TEXT,
  payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload)),
  route TEXT
);

CREATE INDEX idx_notifications_created_at ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(read_at, dismissed_at);
CREATE INDEX idx_notifications_rule_id ON notifications(rule_id);

-- The three that need an owner's own numbers ship disabled. OR IGNORE because restore replays this.
INSERT OR IGNORE INTO notification_rules (id, kind, params, enabled, created_by, created_at, updated_at) VALUES
  ('nrule_budget_90', 'budget_threshold', '{"category_id":null,"percent":90}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_bill_due_3', 'bill_due', '{"days_ahead":3}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_sync_failed', 'sync_failed', '{"include_partial":true}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_safe_to_spend', 'safe_to_spend_negative', '{}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_goal_milestones', 'goal_milestone', '{"goal_id":null,"milestones":[50,100]}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_recurring_changed', 'recurring_amount_changed', '{}', 1, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_large_transaction', 'large_transaction', '{"min_amount":50000,"account_id":null,"lookback_days":7}', 0, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_low_balance_pool', 'low_balance', '{"account_id":null,"threshold":50000}', 0, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ('nrule_unusual_spending', 'unusual_spending', '{"category_id":null,"ratio":1.5,"min_amount":10000}', 0, 'owner',
    strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
