/**
 * Board-scoped sensor entity names for Sensor Info and other panes.
 *
 * Elodin + thin backend emit TYPE<slot>.CH<n> (e.g. TC1.CH2, LC2.CH6), matching
 * diablo_server/backend/src/api-server.ts (buildSensorConfig) and elodin-protocol.
 * Generic names like TC.CH2 or LC.CH1 only work after alias setup in the store;
 * subscribing and displaying board-scoped names avoids races and broken string
 * replaces (e.g. LC2.CH1.replace('LC.', 'LC_Cal.') does nothing).
 */

/** Same as api-server elodinSlotFromBoardId: (board_id % 10), with 0 → 10. */
export function elodinSlotFromBoardId(boardId: number): number {
  const m = boardId % 10;
  return m === 0 ? 10 : m;
}

export interface TcRowConfig {
  entity: string;
  calEntity: string;
  label: string;
  voltageReference: number;
}

export interface RtdLcRowConfig {
  entity: string;
  calEntity: string;
  label: string;
}

export function buildTcDataFromBoards(boards: Record<string, unknown>): TcRowConfig[] {
  const out: TcRowConfig[] = [];
  for (const board of Object.values(boards)) {
    const b = board as Record<string, unknown>;
    if (b.type !== 'TC' || b.enabled === false) continue;
    const boardId = typeof b.board_id === 'number' ? b.board_id : 51;
    const bn = elodinSlotFromBoardId(boardId);
    const ref = Math.min(2, Math.max(0, (b.voltage_reference as number) ?? 0));
    const active: number[] =
      Array.isArray(b.active_connectors) && (b.active_connectors as number[]).length > 0
        ? (b.active_connectors as number[])
        : Array.from({ length: (b.num_sensors as number) ?? 10 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({
        entity: `TC${bn}.CH${ch}`,
        calEntity: `TC${bn}_Cal.CH${ch}`,
        label: `TC Ch${ch}`,
        voltageReference: ref,
      });
    }
  }
  return out;
}

export function buildRtdDataFromBoards(boards: Record<string, unknown>): RtdLcRowConfig[] {
  const out: RtdLcRowConfig[] = [];
  for (const board of Object.values(boards)) {
    const b = board as Record<string, unknown>;
    if (b.type !== 'RTD' || b.enabled === false) continue;
    const boardId = typeof b.board_id === 'number' ? b.board_id : 31;
    const bn = elodinSlotFromBoardId(boardId);
    const active: number[] =
      Array.isArray(b.active_connectors) && (b.active_connectors as number[]).length > 0
        ? (b.active_connectors as number[])
        : Array.from({ length: (b.num_sensors as number) ?? 4 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({
        entity: `RTD${bn}.CH${ch}`,
        calEntity: `RTD${bn}_Cal.CH${ch}`,
        label: `RTD Ch${ch}`,
      });
    }
  }
  return out;
}

export function buildLcDataFromBoards(boards: Record<string, unknown>): RtdLcRowConfig[] {
  const out: RtdLcRowConfig[] = [];
  for (const board of Object.values(boards)) {
    const b = board as Record<string, unknown>;
    if (b.type !== 'LC' || b.enabled === false) continue;
    const boardId = typeof b.board_id === 'number' ? b.board_id : 41;
    const bn = elodinSlotFromBoardId(boardId);
    const active: number[] =
      Array.isArray(b.active_connectors) && (b.active_connectors as number[]).length > 0
        ? (b.active_connectors as number[])
        : Array.from({ length: (b.num_sensors as number) ?? 4 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({
        entity: `LC${bn}.CH${ch}`,
        calEntity: `LC${bn}_Cal.CH${ch}`,
        label: `LC Ch${ch}`,
      });
    }
  }
  return out;
}

export interface EncoderRowConfig {
  entity: string;
  label: string;
  boardId: number;
}

/**
 * Encoder board(s): Elodin emits ENC{slot}.CH{n} + raw_angle (AS5600-style counts).
 * Optional role names from config [sensor_roles_encoder_board].
 */
export function buildEncoderDataFromBoards(
  boards: Record<string, unknown>,
  encoderRoles?: Record<string, number> | null
): EncoderRowConfig[] {
  const out: EncoderRowConfig[] = [];
  const roleLabels = new Map<number, string>();
  if (encoderRoles && typeof encoderRoles === 'object') {
    for (const [name, ch] of Object.entries(encoderRoles)) {
      const c = typeof ch === 'number' ? ch : Number(ch);
      if (Number.isFinite(c) && c >= 1) {
        roleLabels.set(c, name.replace(/_/g, ' '));
      }
    }
  }
  for (const board of Object.values(boards)) {
    const b = board as Record<string, unknown>;
    if (b.type !== 'ENCODER' || b.enabled === false) continue;
    const boardId = typeof b.board_id === 'number' ? b.board_id : 61;
    const bn = elodinSlotFromBoardId(boardId);
    const active: number[] =
      Array.isArray(b.active_connectors) && (b.active_connectors as number[]).length > 0
        ? (b.active_connectors as number[])
        : Array.from({ length: (b.num_sensors as number) ?? 2 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({
        entity: `ENC${bn}.CH${ch}`,
        label: roleLabels.get(ch) ?? `Ch${ch}`,
        boardId,
      });
    }
  }
  return out;
}

export function buildActChannelsFromBoards(boards: Record<string, unknown>): {
  entity: string;
  calEntity: string;
  label: string;
  boardId: number;
  localCh: number;
}[] {
  const out: { entity: string; calEntity: string; label: string; boardId: number; localCh: number }[] = [];
  for (const board of Object.values(boards)) {
    const b = board as Record<string, unknown>;
    if (b.type !== 'ACTUATOR' || b.enabled === false) continue;
    const boardId = typeof b.board_id === 'number' ? b.board_id : 11;
    const bn = elodinSlotFromBoardId(boardId);
    const active: number[] =
      Array.isArray(b.active_connectors) && (b.active_connectors as number[]).length > 0
        ? (b.active_connectors as number[])
        : Array.from({ length: (b.num_sensors as number) ?? 10 }, (_, i) => i + 1);
    for (const ch of active) {
      out.push({
        entity: `ACT${bn}.CH${ch}`,
        calEntity: `ACT${bn}_Cal.CH${ch}`,
        label: `B${boardId} Ch${ch}`,
        boardId,
        localCh: ch,
      });
    }
  }
  return out;
}

/** Defaults aligned with integration config.toml (tc_board 51, rtd 31, lc 42, act 12/14). */
export const SENSOR_INFO_DEFAULT_TC_DATA: TcRowConfig[] = [
  { entity: 'TC1.CH2', calEntity: 'TC1_Cal.CH2', label: 'TC Ch2', voltageReference: 0 },
  { entity: 'TC1.CH3', calEntity: 'TC1_Cal.CH3', label: 'TC Ch3', voltageReference: 0 },
  { entity: 'TC1.CH4', calEntity: 'TC1_Cal.CH4', label: 'TC Ch4', voltageReference: 0 },
  { entity: 'TC1.CH5', calEntity: 'TC1_Cal.CH5', label: 'TC Ch5', voltageReference: 0 },
];

export const SENSOR_INFO_DEFAULT_RTD_DATA: RtdLcRowConfig[] = [
  { entity: 'RTD1.CH1', calEntity: 'RTD1_Cal.CH1', label: 'RTD Ch1' },
  { entity: 'RTD1.CH2', calEntity: 'RTD1_Cal.CH2', label: 'RTD Ch2' },
  { entity: 'RTD1.CH3', calEntity: 'RTD1_Cal.CH3', label: 'RTD Ch3' },
  { entity: 'RTD1.CH4', calEntity: 'RTD1_Cal.CH4', label: 'RTD Ch4' },
];

export const SENSOR_INFO_DEFAULT_LC_DATA: RtdLcRowConfig[] = [
  { entity: 'LC2.CH1', calEntity: 'LC2_Cal.CH1', label: 'LC Ch1' },
  { entity: 'LC2.CH2', calEntity: 'LC2_Cal.CH2', label: 'LC Ch2' },
  { entity: 'LC2.CH6', calEntity: 'LC2_Cal.CH6', label: 'LC Ch6' },
];

export const SENSOR_INFO_DEFAULT_ENCODER_DATA: EncoderRowConfig[] = [
  { entity: 'ENC1.CH1', label: 'Encoder 1', boardId: 61 },
  { entity: 'ENC1.CH2', label: 'Encoder 2', boardId: 61 },
];

export const SENSOR_INFO_DEFAULT_ACT_DATA = Array.from({ length: 10 }, (_, i) => ({
  entity: `ACT2.CH${i + 1}`,
  calEntity: `ACT2_Cal.CH${i + 1}`,
  label: `B12 Ch${i + 1}`,
  boardId: 12,
  localCh: i + 1,
}));
