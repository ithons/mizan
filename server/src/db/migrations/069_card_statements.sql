-- Entered by the owner: the SimpleFIN feed carries neither figure.
ALTER TABLE accounts ADD COLUMN statement_balance INTEGER;
ALTER TABLE accounts ADD COLUMN statement_due_date TEXT;
