-- Detection previously rejected any pattern whose AMOUNT moved more than 25%, which threw away the
-- most important recurring items a forecast needs: a weekly paycheck that tracks hours worked, a
-- monthly interest credit, a utility bill. Cadence, not amount, is the signal for those.
--
-- Patterns admitted on cadence alone need to say so, or the forecast quietly presents a median as if
-- it were a known amount. This column records the coefficient of variation of the pattern's amounts
-- so the UI can render "~$544 · varies" instead of "$544".
ALTER TABLE recurring_patterns ADD COLUMN amount_variance REAL NOT NULL DEFAULT 0;
