-- Remove a stray test artifact from recurring_patterns: a manually-created pattern named
-- "TEST Paycheck" that was later dismissed and never backed by real transactions. Manual
-- patterns legitimately carry transaction_count = 0 (createRecurringPattern seeds them
-- confirmed so they surface immediately), so the guard is deliberately narrow — it also
-- requires the pattern to be unconfirmed/dismissed (is_confirmed = 0) and count 0, a
-- combination that only a discarded test row has. On a fresh DB this matches nothing.
DELETE FROM recurring_patterns
WHERE merchant_name = 'TEST Paycheck'
  AND transaction_count = 0
  AND is_confirmed = 0;
