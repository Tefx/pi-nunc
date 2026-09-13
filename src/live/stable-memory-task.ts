import { readdir, readFile, stat, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { project } from "../pi/projection.js";
import type { CheckResult } from "./scenarios.js";

/** Observe only this isolated task directory, never historical session files. */
export async function qualifyMemoryOnly(turn: string, entries: readonly SessionEntry[], cwd: string): Promise<CheckResult> {
  const values = ["cedar-17", "maple-29"];
  const active = project(entries);
  const history = JSON.stringify(active.active);
  const memory = JSON.stringify(active.memory.slots);
  let complete = true;
  const matches: string[] = [];
  async function scan(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) { complete = false; continue; }
      if (entry.isDirectory()) await scan(path);
      else if (entry.isFile()) {
        if ((await stat(path)).size > 1000000) { complete = false; continue; }
        const body = await readFile(path, "utf8");
        if (values.some(v => body.includes(v))) matches.push(path);
      }
    }
  }
  try { await scan(cwd); } catch { complete = false; }
  const historyMatches = values.filter(v => history.includes(v));
  const memoryValues = values.filter(v => memory.includes(v));
  const expected = turn === "b2" ? [values[0]] : turn === "d2" ? [values[1]] : [];
  const memoryQualified = JSON.stringify(memoryValues) === JSON.stringify(expected);
  return { check: `M-only ${turn}: source values unavailable in current R/task files and current M has the required state`,
    status: complete && !matches.length && !historyMatches.length && memoryQualified ? "PROVEN" : "UNPROVEN",
    observed: { turn, activeEntryIds: active.active.map(e => e.entryId), memory: active.memory, taskScanComplete: complete, taskMatches: matches, historyMatches, memoryValues } };
}

/** Retain observed model output outside task visibility before later continuation. */
export async function archiveMemoryArtifact(turn: string, caseRoot: string): Promise<{ path: string; value: unknown } | undefined> {
  const path = turn === "b2" ? "initial.json" : turn === "d2" ? "corrected.json" : undefined;
  if (!path) return;
  let value: unknown;
  try { value = JSON.parse(await readFile(join(caseRoot, "task", path), "utf8")); } catch { return; }
  await mkdir(join(caseRoot, "observed-artifacts"), { recursive: true });
  await rename(join(caseRoot, "task", path), join(caseRoot, "observed-artifacts", path));
  return { path, value };
}
