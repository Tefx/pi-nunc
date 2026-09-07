import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Transparent Provider wrap after the first settled turn. Never reads bodies or credentials. */
export default function wrap(pi: ExtensionAPI): void {
  let settled = false;
  let wrapped = false;
  pi.on("agent_settled", () => { settled = true; });
  pi.on("context", (_event, ctx) => {
    if (!settled || wrapped || !ctx.model) return;
    const previous = ctx.modelRegistry.getProvider(ctx.model.provider);
    if (!previous) return;
    wrapped = true;
    pi.registerProvider({
      ...previous,
      stream: (model, context, options) => previous.stream(model, context, options),
      streamSimple: (model, context, options) => previous.streamSimple(model, context, options),
    });
  });
}
