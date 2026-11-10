/**
 * The badge for one engine on the report and print view. An engine that answered nothing
 * because every call failed is "unavailable", not "coming soon" or "pending" (`empty`).
 * Kept apart from ai-probe.ts so client components don't pull in the engine SDKs.
 */
export function engineBadge(
  probe: { results: unknown[]; status: string; failedPrompts?: number } | null,
  empty: string,
): string {
  if (probe && probe.results.length === 0 && probe.failedPrompts) return 'UNAVAILABLE';
  if (!probe || probe.results.length === 0) return empty;
  return probe.status.toUpperCase();
}
