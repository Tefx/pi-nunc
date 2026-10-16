// purpose: Compose existing maintenance observer with MAB condition guard and public asynchronous compaction.
// usage: Pi -e observer.mjs with bench observation/capture/budget flags.
// effects: Task-local observations only; /bench-compact starts native ctx.compact.
// requires: Nunc loaded BEFORE observer; installed Pi1.1 public lifecycle.
import { composeObserver } from './observe-maintenance.mjs';
import capture from './capture.mjs';
export default composeObserver(capture);
