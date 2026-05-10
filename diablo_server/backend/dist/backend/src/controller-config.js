/**
 * @file controller-config.ts
 * @brief Controller service config defaults (duty sweep, etc.)
 *
 * Default duty sweep: 5 steps × 2 s = 10 s total.
 * Used when config.controller.duty_sweep_steps or duty_sweep_step_duration_sec are missing.
 */
/** Default [fuel_duty, ox_duty] steps in 0.0–1.0; 5 steps × 2 s = 10 s. */
export const DEFAULT_DUTY_SWEEP_STEPS = [
    [0.1, 0.1],
    [0.3, 0.2],
    [0.5, 0.4],
    [0.3, 0.3],
    [0.1, 0.1],
];
/** Default duration per duty sweep step (seconds). */
export const DEFAULT_DUTY_SWEEP_STEP_DURATION_SEC = 2.0;
/**
 * Apply controller service defaults to config when keys are missing.
 * Mutates config.controller in place.
 */
export function applyControllerDefaults(config) {
    if (!config.controller)
        config.controller = {};
    const c = config.controller;
    if (c.duty_sweep_steps == null ||
        !Array.isArray(c.duty_sweep_steps) ||
        c.duty_sweep_steps.length === 0) {
        c.duty_sweep_steps = DEFAULT_DUTY_SWEEP_STEPS;
    }
    if (c.duty_sweep_step_duration_sec == null ||
        typeof c.duty_sweep_step_duration_sec !== 'number') {
        c.duty_sweep_step_duration_sec = DEFAULT_DUTY_SWEEP_STEP_DURATION_SEC;
    }
}
