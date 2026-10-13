// purpose: Reuse observers and expose native asynchronous compaction without RpcClient's fixed30s blocking-command timeout.
// usage: external Pi -e sol-observer.mjs --bench-observer-file <owned-path> --bench-capture-file <owned-path>
// effects: Same task-local observations; /bench-compact starts exactly one public ctx.compact, never writes checkpoints or model context itself.
// requires: Pi1.1 public ExtensionContext.compact and compaction_end event; controller installs event listener before prompt.
import maintenance from './observe-maintenance-medium.mjs';
import capture from './capture-openrouter-medium.mjs';
export default function(pi) {
  capture(pi);
  maintenance(pi);
  pi.registerCommand('bench-compact', {
    description: 'Start one native manual compaction; caller awaits compaction_end',
    handler: (_args,ctx) => { ctx.compact(); },
  });
}
