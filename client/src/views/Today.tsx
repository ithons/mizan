/**
 * `/` is `Instrument` now.
 *
 * Today, Cash Flow and Reports were the same query set over three different windows, and this file
 * held the one with the window set to "now". The surface that replaced all three lives in
 * `Instrument.tsx`.
 *
 * This re-export exists only because routing is a later track and `App.tsx` is off limits in this
 * one: it is what makes `/` render the new surface without editing the router. When the router
 * moves, point it at `./Instrument` and delete this file.
 */
export { Instrument as Today } from './Instrument';
