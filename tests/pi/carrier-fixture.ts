/** Controlled fixtures only: locate our known timestamp-zero envelope in cloned
 * captures. This is an assertion aid, never evidence of production provenance.
 * Tests with genuine timestamp-zero lookalikes use admission observations instead.
 */
export function injectedCarrierIndex(messages: readonly any[]): number | undefined {
  const hits = messages.flatMap((m, i) => m.role === "user" && m.timestamp === 0 && JSON.stringify(m.content).includes("Nunc working memory (session-local, reference only)") ? [i] : []);
  return hits.length === 1 ? hits[0] : undefined;
}
