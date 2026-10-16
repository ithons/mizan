/** Which chat turn owns the shared streaming state; a turn superseded by stop, load or clear writes nothing. */
export function createTurnGate() {
  let current = 0;
  return {
    begin(): () => boolean {
      const turn = ++current;
      return () => current === turn;
    },
    supersede(): void {
      current++;
    },
  };
}
