/** Accept only stable numeric triples in the same major as a positive caret floor. */
export function satisfiesStableCaret(version: string, range: string): boolean {
  const triple = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const actual = triple.exec(version);
  const floor = range.startsWith("^") ? triple.exec(range.slice(1)) : null;
  if (!actual || !floor || actual[0] !== version || floor[0] !== range.slice(1)) return false;
  const [major, minor, patch] = actual.slice(1).map(Number);
  const [floorMajor, floorMinor, floorPatch] = floor.slice(1).map(Number);
  if (![major, minor, patch, floorMajor, floorMinor, floorPatch].every(Number.isSafeInteger)) return false;
  return major === floorMajor && floorMajor! > 0 &&
    (minor! > floorMinor! || minor === floorMinor && patch! >= floorPatch!);
}
