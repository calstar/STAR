/**
 * Self-test rows arrive as sensor keys SELF_TEST.BOARD_{id}.sensor_{n}.
 */

export function selfTestBoardIdsFromSensorData(sensorData: Record<string, number>): number[] {
  const seen = new Set<number>();
  for (const k of Object.keys(sensorData)) {
    const m = /^SELF_TEST\.BOARD_(\d+)\./.exec(k);
    if (m) seen.add(Number(m[1]));
  }
  return [...seen].sort((a, b) => a - b);
}
