/** Unix-millisecond wall-clock intervals; provider durations remain separate ledger facts. */
export interface WallClockInterval { startedAt: number; endedAt: number; elapsedMs: number }
export function elapsedInterval(startedAt: number): WallClockInterval {
  const endedAt = Date.now();
  return { startedAt, endedAt, elapsedMs: endedAt - startedAt };
}
