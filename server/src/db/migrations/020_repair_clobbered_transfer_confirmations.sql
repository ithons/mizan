-- One-time repair for confirmed transfer pairs that were silently downgraded.
-- Before this release, transferCandidateRows() excluded only 'dismissed' rows, so
-- every integrity recompute re-selected a user-confirmed transfer pair and rewrote
-- its transfer_status from 'confirmed' back to 'candidate' (leaving review_status
-- 'reviewed'). The result: zero 'confirmed' rows survived and confirmed transfers
-- kept reappearing in the review queue on every sync.
--
-- The code fix (transferCandidateRows now excludes 'confirmed' too) stops future
-- clobbering; this migration restores the already-lost confirmations. The selector
-- is surgical: only rows that are genuine transfer-pair members (paired + a
-- cat_xfer_in/out category) AND carry review_status='reviewed' — a combination that
-- can only originate from confirmTransferPair(). On a fresh DB this matches nothing.
UPDATE transactions
SET transfer_status = 'confirmed'
WHERE transfer_status = 'candidate'
  AND review_status = 'reviewed'
  AND transfer_pair_id IS NOT NULL
  AND category_id IN ('cat_xfer_in', 'cat_xfer_out');
