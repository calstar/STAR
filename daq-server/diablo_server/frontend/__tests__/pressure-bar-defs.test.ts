/**
 * Config-driven top-bar builder: resolves role→entity, pulls NOP/MEOP from the
 * [pressure_limits] map, supports chamber averaging, and falls back to the
 * built-in bar list when config is absent.
 */
import { describe, it, expect } from 'vitest';
import { buildPressureBarDefsFromSensorConfig } from '@/lib/pressure-bar-defs';
import type { SensorConfig } from '@/lib/sensor-config';
import type { PressureBarConfig } from '@/lib/gui-config';
import type { PressureLimitsMap } from '@/lib/pressure-limits';

const sensors: SensorConfig[] = [
  { type: 'PT', id: 6, role: 'GN2 High', boardId: 22, boardIp: '', isHpPt: true, inCalibrationSequence: false, entity: 'PT.GN2_High', calEntity: 'PT_Cal.GN2_High' },
  { type: 'PT', id: 4, role: 'Chamber Mid PT 1', boardId: 21, boardIp: '', isHpPt: false, inCalibrationSequence: true, entity: 'PT.Chamber_Mid_PT_1', calEntity: 'PT_Cal.Chamber_Mid_PT_1' },
  { type: 'PT', id: 8, role: 'Chamber Mid PT 2', boardId: 21, boardIp: '', isHpPt: false, inCalibrationSequence: true, entity: 'PT.Chamber_Mid_PT_2', calEntity: 'PT_Cal.Chamber_Mid_PT_2' },
];

const limits: PressureLimitsMap = {
  GN2_High: { NOP: 4000, MEOP: 5000, POP: 1000 },
  Chamber: { NOP: 500, MEOP: 650, POP: 800 },
};

describe('buildPressureBarDefsFromSensorConfig (config-driven)', () => {
  it('resolves role→calEntity and takes NOP/MEOP from [pressure_limits]', () => {
    const bars: PressureBarConfig[] = [
      { label: 'GN2 HI', role: 'GN2 High', limits: 'GN2_High', color: '#ADFF2F' },
    ];
    const [def] = buildPressureBarDefsFromSensorConfig(sensors, bars, limits);
    expect(def.label).toBe('GN2 HI');
    expect(def.entity).toBe('PT_Cal.GN2_High');
    expect(def.nop).toBe(4000);
    expect(def.meop).toBe(5000);
    expect(def.color).toBe('#ADFF2F');
  });

  it('averages avg_roles for a chamber-style gauge', () => {
    const bars: PressureBarConfig[] = [
      { label: 'CHAMBER', role: 'Chamber Mid PT 1', avg_roles: ['Chamber Mid PT 1', 'Chamber Mid PT 2'], limits: 'Chamber' },
    ];
    const [def] = buildPressureBarDefsFromSensorConfig(sensors, bars, limits);
    expect(def.avgEntities).toEqual(['PT_Cal.Chamber_Mid_PT_1', 'PT_Cal.Chamber_Mid_PT_2']);
    expect(def.meop).toBe(650);
  });

  it('falls back to a conventional entity when the role is unknown', () => {
    const bars: PressureBarConfig[] = [{ label: 'X', role: 'Fuel Upstream', limits: 'Missing' }];
    const [def] = buildPressureBarDefsFromSensorConfig([], bars, limits);
    expect(def.entity).toBe('PT_Cal.Fuel_Upstream');
    expect(def.nop).toBeUndefined(); // no matching limits key
  });

  it('uses the built-in default bars when no config list is supplied', () => {
    const defs = buildPressureBarDefsFromSensorConfig(sensors);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.map((d) => d.label)).toContain('CHAMBER');
  });
});

// [pressure_limits.<key>].show_in_top_bar: the config tab's checkbox. Absent must mean shown, so
// an untouched config draws every limit exactly as before.
describe('show_in_top_bar', () => {
  const bars: PressureBarConfig[] = [
    { label: 'GN2 HI', role: 'GN2 High', limits: 'GN2_High' },
    { label: 'CHAMBER', avg_roles: ['Chamber Mid PT 1', 'Chamber Mid PT 2'], limits: 'Chamber' },
  ];

  it('shows the limits when the key is absent or true', () => {
    const defs = buildPressureBarDefsFromSensorConfig(sensors, bars, {
      ...limits,
      Chamber: { ...limits.Chamber, show_in_top_bar: true },
    });
    expect(defs.map((d) => d.showLimits)).toEqual([true, true]);
  });

  it('hides only the gauges whose limits entry is unchecked, keeping its NOP/MEOP', () => {
    const defs = buildPressureBarDefsFromSensorConfig(sensors, bars, {
      ...limits,
      GN2_High: { ...limits.GN2_High, show_in_top_bar: false },
    });
    expect(defs.map((d) => d.showLimits)).toEqual([false, true]);
    // The thresholds are still known: the bar keeps turning amber/red past them.
    expect(defs[0].nop).toBe(4000);
    expect(defs[0].meop).toBe(5000);
  });

  it('a gauge with no limits key follows its own PT row, so unticking that row hides the lines', () => {
    const generic: PressureBarConfig[] = [
      { label: 'DR-PT-G', role: 'DR-PT-G', limits: '' },
      { label: 'GN2 HI', role: 'GN2 High' },
    ];
    const defs = buildPressureBarDefsFromSensorConfig(sensors, generic, {
      ...limits,
      'DR-PT-G': { show_in_top_bar: false } as any,
    });
    expect(defs.map((d) => d.showLimits)).toEqual([false, true]);
    // GN2 High -> GN2_High by the space-to-underscore convention.
    expect(defs[1].nop).toBe(4000);
  });
});
