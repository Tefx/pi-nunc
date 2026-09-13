import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Test-only: apply a second catalog model after session_start, like Larva defaultPersona. */
export default function applyStartupModel(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const before = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    const model = ctx.modelRegistry.find("groq", "nunc-small");
    const accepted = model ? await pi.setModel(model) : false;
    const after = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
    writeFileSync(join(process.cwd(), "../apply-startup-model.json"), JSON.stringify({ before, found: Boolean(model), accepted, after }));
    if (!model || accepted === false) throw new Error("startup apply model failed");
  });
}
