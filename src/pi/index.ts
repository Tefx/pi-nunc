import type { EventBus, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { HostSettingsSource } from "../index.js";
export { parseConfig, readConfig, engineConfig, type NuncConfig } from "./config.js";
export { project, eligibleStarts } from "./projection.js";
export type { HostSettingsSource, MaintenanceEvent } from "../index.js";

/** Call after resource loading, before bindExtensions, again after each reload.
 * The bus must be the loader's eventBus. No settings or session writes occur here.
 */
export function bindHostSettings(bus: EventBus, manager: SettingsManager): void {
  bus.emit("nunc:host-settings", { readSettings: () => ({ compaction: manager.getCompactionSettings(), blockImages: manager.getBlockImages() }) } satisfies HostSettingsSource);
}
