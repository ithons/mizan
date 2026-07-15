-- Seed the user's personal advisor context so the AI stops making wrong default
-- assumptions (e.g. asking whether card balances revolve). Stored as an app_preferences
-- row; the value is JSON (a single string), matching services/preferences.ts. Idempotent:
-- only inserts when the user has not already set their own profile. Editable in Settings.
INSERT INTO app_preferences (key, value, created_at, updated_at)
SELECT
  'advisor_user_profile',
  '"Personal context the advisor should always assume:\n- I autopay all my credit cards in full each statement period, on or before the due date, so I never carry a revolving balance and never pay interest. Do not ask whether my card balances are revolving; assume they are paid in full.\n- I am a student with unpredictable, seasonal income: I earn more in the summer when I can work full-time, and less during the school year.\n- I am a foreign resident in the US and not certain I will be able to stay long-term. Because of that, I prefer directing investments to a taxable brokerage over a Roth IRA (I may need to liquidate holdings or leave the country), though I still want to make Roth IRA contributions when they are within the annual limits."',
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
WHERE NOT EXISTS (SELECT 1 FROM app_preferences WHERE key = 'advisor_user_profile');
