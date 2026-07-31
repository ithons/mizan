-- Three preference keys with no reader left in the codebase.
--
-- Verified dead before deletion: no file under server/, client/ or shared/ names any of them
-- outside this migration and the test that guards it. `tests/deadPreferences.test.ts` re-runs that
-- search over the tree rather than trusting this comment.
--
--   dashboard_layout                     the configurable Today dashboard. Today became `/`, whose
--                                        sections are fixed, so the stored array of {id, hidden,
--                                        pinned} steered nothing.
--   custom_report_views                  saved Reports views. Reports became a window selector on
--                                        `/`. The stored value on the owner's ledger is `[]`.
--   advisor_auto_apply_high_confidence   this one is not merely unread. It stores `true` and
--                                        asserts a confidence-gated autonomy policy that was
--                                        removed in f61109b; autonomy is by domain now, declared in
--                                        DRAFT_KIND_AUTONOMY. `app_preferences` has no allowlist in
--                                        front of `run_sql_query`, so the model could read this row
--                                        and be told its own rules are something they have not been
--                                        for months. Deleting the code without deleting the row
--                                        would leave exactly that.
--
-- A backup taken before this migration still carries all three, so `restoreLocalBackup` drops them
-- on the way in; see RETIRED_PREFERENCE_KEYS in server/src/services/preferences.ts.

DELETE FROM app_preferences
WHERE key IN (
  'dashboard_layout',
  'custom_report_views',
  'advisor_auto_apply_high_confidence'
);
