/** load milestones (ms since navigation start), read by the harness as __island.timeline() */
export const timeline: { name: string; ms: number }[] = [];

export function mark(name: string) {
  timeline.push({ name, ms: Math.round(performance.now()) });
}
