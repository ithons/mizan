/** Which chat turn owns `isStreaming` and the active conversation; a turn superseded by stop, load or clear may still settle its own message. */
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
