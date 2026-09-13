import type { EventBus, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { HostSettingsSource } from "../index.js";
export { parseConfig, readConfig, engineConfig, type NuncConfig, parseNuncSettings, validateNuncSettings, resolveMemoryTools, type NuncSettings } from "./config.js";
export { project, eligibleStarts, withEffectiveMemory, carrierIndexIn, injectedCarrierIndex, isNuncCarrier, peekMemoryAnchor, currentMemoryIndex, clearMemoryAnchors, setObserverMemoryLayout, MANUAL_MEMORY_TYPE, memoryRevision, revisionApplies } from "./projection.js";
export { createMemorySurface, memorySurface, type MemorySurface, type MemoryView, type ManualSaveResult, type MemoryPatchParams, type MemoryPatchResult, type MemoryBudgetView, type MemoryFreeze } from "./manual.js";
export { createContextSurface, contextSurface, type ContextSurface, type ContextView, type CurrentContext, type LastMainContext, type LastMaintenanceContext, type ContextLayout, type ContextBudget, type ToolsLayer, type ToolDefinitionView } from "./context.js";
export type { HostSettingsSource, MaintenanceEvent } from "../index.js";

/** Call after resource loading, before bindExtensions, again after each reload.
 * The bus must be the loader's eventBus. No settings or session writes occur here.
 */
export function bindHostSettings(bus: EventBus, manager: SettingsManager): void {
  bus.emit("nunc:host-settings", {
    readSettings: () => {
      const g = manager.getGlobalSettings() as Record<string, unknown>;
      const p = manager.getProjectSettings() as Record<string, unknown>;
      return {
        compaction: manager.getCompactionSettings(),
        blockImages: manager.getBlockImages(),
        nunc: p.nunc ?? g.nunc,
      };
    },
    getGlobalSettings: () => manager.getGlobalSettings() as Record<string, unknown>,
    getProjectSettings: () => manager.getProjectSettings() as Record<string, unknown>,
    isProjectTrusted: () => manager.isProjectTrusted(),
  } satisfies HostSettingsSource);
}
