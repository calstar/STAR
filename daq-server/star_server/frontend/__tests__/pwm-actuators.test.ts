/**
 * Which actuators the controller PWMs — the rule shared by the config editor and the API.
 *
 * An [actuator_roles] entry's optional 4th element ("pwm_fuel" / "pwm_ox") assigns that actuator
 * to controller_service. It is the single statement of what the controller drives, and the same
 * fact makes the sequencer stop commanding the actuator during a burn, so exactly one writer
 * drives it. That is why a duplicate or half-finished assignment is blocked at save rather than
 * warned about — the operator would otherwise find out at the next controller restart.
 *
 * The C++ side enforces the same rule in PWMTargets.hpp (test_controller_pwm_roles). What is
 * pinned here is that the TypeScript half agrees with it.
 */
import { describe, it, expect } from 'vitest';
import { validateControllerPwmActuators, pwmAssignmentMap } from '@/lib/types';

/** `assign` maps an actuator name to its 4th element; absent means sequencer-owned. */
const rig = (assign: Record<string, string> = {}) => ({
  actuator_roles: Object.fromEntries(
    ([
      ['Fuel Press', 'NC', 3, 12],
      ['LOX Press', 'NO', 8, 12],
      ['Far Side Press', 'NC', 2, 14],
    ] as const).map(([name, kind, ch, board]) =>
      [name, assign[name] ? [kind, ch, board, assign[name]] : [kind, ch, board]]
    )
  ),
});

const BOTH = { 'Fuel Press': 'pwm_fuel', 'LOX Press': 'pwm_ox' };

describe('validateControllerPwmActuators', () => {
  it('accepts exactly one actuator per output', () => {
    expect(validateControllerPwmActuators(rig(BOTH))).toEqual([]);
  });

  it('accepts assignments on different boards — that is a rig layout, not an error', () => {
    expect(validateControllerPwmActuators(
      rig({ 'Fuel Press': 'pwm_fuel', 'Far Side Press': 'pwm_ox' })
    )).toEqual([]);
  });

  it('rejects an output with no actuator assigned', () => {
    const issues = validateControllerPwmActuators(rig({ 'LOX Press': 'pwm_ox' }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('pwm_fuel');
  });

  it('rejects two actuators claiming the same output', () => {
    const issues = validateControllerPwmActuators(
      rig({ 'Fuel Press': 'pwm_fuel', 'Far Side Press': 'pwm_fuel', 'LOX Press': 'pwm_ox' })
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Fuel Press');
    expect(issues[0]).toContain('Far Side Press');
  });

  it('allows a rig that does not use the PWM controller at all', () => {
    // Neither output assigned is a real configuration — the digital-twin profile is exactly this.
    // The controller still reports it and keeps its fire gate shut; the editor must not block the
    // save over it, or that profile becomes uneditable.
    expect(validateControllerPwmActuators(rig())).toEqual([]);
  });

  it('is quiet when there is no [actuator_roles] at all', () => {
    // A config with no actuators is a different and much louder problem; this rule must not bury
    // it under derived complaints, and must not block a save on a partial config.
    expect(validateControllerPwmActuators({ controller: {} })).toEqual([]);
  });

  it('renaming an assigned actuator does not orphan anything', () => {
    // The failure mode the old design had: [controller] named "Fuel Press" by string, so an
    // Actuators-tab rename silently disabled the fire gate. The assignment now travels with the
    // entry, so the same rename is a non-event.
    const renamed = {
      actuator_roles: {
        'Fuel Press Valve': ['NC', 3, 12, 'pwm_fuel'],
        'LOX Press': ['NO', 8, 12, 'pwm_ox'],
      },
    };
    expect(validateControllerPwmActuators(renamed)).toEqual([]);
  });

  it('keeps polarity independent of assignment', () => {
    // The reason this is a 4th element and not a third `kind` value: "LOX Press" is normally open
    // AND controller-driven. Sharing one slot would silently drop the NO inversion.
    const roles = rig(BOTH).actuator_roles as Record<string, any[]>;
    expect(roles['LOX Press'][0]).toBe('NO');
    expect(roles['LOX Press'][3]).toBe('pwm_ox');
  });
});

describe('pwmAssignmentMap', () => {
  it('lists which actuator serves each output', () => {
    expect(pwmAssignmentMap(rig(BOTH))).toEqual({
      pwm_fuel: ['Fuel Press'],
      pwm_ox: ['LOX Press'],
    });
  });

  it('reports every claimant so duplicates are visible, not collapsed', () => {
    const map = pwmAssignmentMap(
      rig({ 'Fuel Press': 'pwm_fuel', 'Far Side Press': 'pwm_fuel' })
    );
    expect(map.pwm_fuel).toEqual(['Fuel Press', 'Far Side Press']);
    expect(map.pwm_ox).toEqual([]);
  });

  it('ignores an unrecognised assignment rather than inventing a slot for it', () => {
    expect(pwmAssignmentMap(rig({ 'Fuel Press': 'pwm_typo' }))).toEqual({
      pwm_fuel: [],
      pwm_ox: [],
    });
  });
});
