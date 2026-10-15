import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MaintenanceInput } from "../engine/types.js";
import { selectMaintenanceCalibration } from "../engine/calibration.js";
import { record } from "../engine/validation.js";

/** Non-context CustomEntry, never a memory record or a checkpoint. */
export const MAINTENANCE_CALIBRATION_TYPE = "nunc.maintenance-calibration";

/** Read only the selected getBranch() path. buildContextEntries() can omit older measurement records. */
export function projectMaintenanceCalibration(branch: readonly SessionEntry[], input: Omit<MaintenanceInput, "signal">) {
  const records = branch.flatMap(entry => {
    if (entry.type === "custom" && entry.customType === MAINTENANCE_CALIBRATION_TYPE) return [entry.data];
    if (entry.type === "compaction" && record(entry.details) && entry.details.maintenanceCalibration !== undefined) return [entry.details.maintenanceCalibration];
    return [];
  });
  return selectMaintenanceCalibration(input, records);
}
