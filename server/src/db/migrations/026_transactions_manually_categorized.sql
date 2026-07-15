-- Distinguish transactions the user categorized by hand from ones a rule or the text
-- heuristic categorized. Without this flag the two are indistinguishable, so a full
-- "re-check all transactions" pass would silently clobber deliberate manual choices.
-- Existing rows default to 0 (not-manual): a re-check may re-evaluate them, which is the
-- intent of "double check everything"; manual edits from here on set the flag to 1.
ALTER TABLE transactions ADD COLUMN manually_categorized INTEGER NOT NULL DEFAULT 0;
