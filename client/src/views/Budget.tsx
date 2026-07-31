/**
 * `/budget` is `/plan`.
 *
 * Phase 8 folds Budget and Goals into one claim sheet: a budget claims money for a month and a
 * goal claims it toward a target, and splitting them made the owner add up their own commitments.
 * This file stays only because `App.tsx` still names the route, and routing is a separate track.
 * When `/plan` is mounted, delete this file and `Goals.tsx` with it.
 */
export { Plan as Budget } from './Plan';
