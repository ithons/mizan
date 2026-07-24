// The floor guard that makes the one-time manual history backfill permanent.
//
// Each account may carry a `backfill_floor_date` (migration 030). Manual/imported
// history covers strictly BELOW that date; providers own everything at or above it.
// Every provider sync consults this before inserting a served transaction, so a deep
// resync can never reach back into the imported zone and duplicate it.
//
// Dates are stored as `yyyy-MM-dd` everywhere, so lexicographic compare == chronological.
export function isBelowBackfillFloor(date: string, floor: string | null | undefined): boolean {
  if (!floor) return false;
  return date < floor;
}
