/**
 * Controller loop logic — runs during FIRE state to send PWM commands
 * either from the DDP controller or via open-loop duty sweep.
 * Extracted from server.ts.
 */

import { sendPWMActuatorCommandUDP, type ActuatorHost, getActuatorBoardInfo } from './actuator-control.js';
import { ControllerClient, mapSensorDataToMeasurement, ControllerCommand, ControllerDiagnostics } from './controller-client.js';
import { ElodinClient } from './elodin-client.js';
import { publishControllerActuation, publishControllerDiagnostics } from './controller-elodin-publisher.js';
import {
    MessageType,
    SensorUpdate,
    SystemState,
} from '../../shared/types.js';

/** Minimal interface for the parts of SensorSystemServer that the controller loop needs. */
export interface ControllerHost extends ActuatorHost {
    controllerClient: ControllerClient | null;
    controllerLoopInterval: NodeJS.Timeout | null;
    controllerLoopStartTime: number | null;
    CONTROLLER_LOOP_INTERVAL_MS: number;
    PWM_DURATION_MS: number;
    PWM_FREQUENCY_HZ: number;
    FALLBACK_FUEL_DUTY: number;
    FALLBACK_OX_DUTY: number;
    DUTY_SWEEP_ENABLED: boolean;
    DUTY_SWEEP_STEPS: [number, number][];
    DUTY_SWEEP_STEP_DURATION_MS: number;
    controllerCommand: ControllerCommand;
    controllerConfigPath?: string;
    sensorCache: Map<string, SensorUpdate>;
    elodin: ElodinClient;
}

/**
 * Start controller loop — runs when FIRE state is active.
 * Reads sensor data, calls DDP controller, sends PWM commands.
 */
export function startControllerLoop(host: ControllerHost): void {
    if (host.controllerLoopInterval) {
        return; // Already running
    }

    if (!host.controllerClient && !host.DUTY_SWEEP_ENABLED) {
        console.warn('⚠️ Controller client not initialized - enable duty_sweep_enabled or set CONTROLLER_URL');
        return;
    }

    console.log('🎯 Starting controller loop (FIRE state active)');

    const startLoop = () => {
        console.log('✅ Controller loop starting' + (host.DUTY_SWEEP_ENABLED ? ' (duty sweep mode)' : ''));

        host.controllerLoopStartTime = Date.now();

        console.log(`🔄 Controller loop starting at ${host.CONTROLLER_LOOP_INTERVAL_MS}ms interval (${1000 / host.CONTROLLER_LOOP_INTERVAL_MS} Hz)`);

        host.controllerLoopInterval = setInterval(async () => {
            try {
                if (host.currentState !== SystemState.FIRE) {
                    stopControllerLoop(host);
                    return;
                }

                // Build sensor data map from cache
                const sensorDataMap = new Map<string, number>();
                for (const [key, update] of host.sensorCache.entries()) {
                    if (update.component === 'pressure_psi') {
                        sensorDataMap.set(key, update.value);
                    }
                }

                const measurement = mapSensorDataToMeasurement(sensorDataMap);
                if (!measurement) {
                    const missingSensors: string[] = [];
                    const required = ['PT_Cal.GN2_High', 'PT_Cal.GN2_Regulated', 'PT_Cal.Fuel_Upstream',
                        'PT_Cal.Ox_Upstream', 'PT_Cal.Fuel_Downstream', 'PT_Cal.Ox_Downstream'];
                    for (const sensor of required) {
                        if (!sensorDataMap.has(`${sensor}.pressure_psi`)) missingSensors.push(sensor);
                    }
                    if (Math.random() < 0.1 || (Date.now() - (host.controllerLoopStartTime || 0)) < 10000) {
                        console.warn(`⚠️ Controller: Missing sensor data (${missingSensors.join(', ')}). Using fallback/sweep PWM.`);
                    }
                }

                let duty_F: number;
                let duty_O: number;
                let diagnostics: ControllerDiagnostics | null = null;
                let controllerFailed = false;

                // Duty sweep: open-loop multi-step test
                if (host.DUTY_SWEEP_ENABLED && host.DUTY_SWEEP_STEPS.length > 0 && host.controllerLoopStartTime !== null) {
                    const elapsed = Date.now() - host.controllerLoopStartTime;
                    const stepIndex = Math.min(
                        Math.floor(elapsed / host.DUTY_SWEEP_STEP_DURATION_MS),
                        host.DUTY_SWEEP_STEPS.length - 1
                    );
                    [duty_F, duty_O] = host.DUTY_SWEEP_STEPS[stepIndex];
                } else if (measurement) {
                    let result;
                    try {
                        result = await host.controllerClient!.step(
                            measurement,
                            {},
                            host.controllerCommand
                        );
                    } catch (error) {
                        controllerFailed = true;
                        if ((Date.now() - (host.controllerLoopStartTime || 0)) < 5000 || Math.random() < 0.05) {
                            console.error('❌ Controller step error:', error);
                        }
                    }
                    if (!result || controllerFailed) {
                        duty_F = host.FALLBACK_FUEL_DUTY;
                        duty_O = host.FALLBACK_OX_DUTY;
                        if (Math.random() < 0.1) {
                            console.log(`🔄 Fallback PWM: Fuel=${(duty_F * 100).toFixed(1)}%, LOX=${(duty_O * 100).toFixed(1)}%`);
                        }
                    } else {
                        duty_F = result.actuation.duty_F;
                        duty_O = result.actuation.duty_O;
                        diagnostics = result.diagnostics;
                    }
                } else {
                    duty_F = host.FALLBACK_FUEL_DUTY;
                    duty_O = host.FALLBACK_OX_DUTY;
                }

                // Route PWM to correct actuator board via board map
                const fuelPressBoard = getActuatorBoardInfo(host, 'Fuel Press');
                const loxPressBoard = getActuatorBoardInfo(host, 'LOX Press');
                const fuelPressChannel = fuelPressBoard?.channel;
                const loxPressChannel = loxPressBoard?.channel;
                const fuelPressBoardIp = fuelPressBoard?.boardIp;
                const loxPressBoardIp = loxPressBoard?.boardIp;

                const duty_F_clamped = Math.max(0, Math.min(1, duty_F));
                const duty_O_clamped = Math.max(0, Math.min(1, duty_O));

                const shouldLogPWM = Math.random() < 0.1 || (host.controllerLoopStartTime && Date.now() - host.controllerLoopStartTime < 2000);

                try {
                    if (fuelPressChannel) {
                        const success = sendPWMActuatorCommandUDP(host, fuelPressChannel, duty_F_clamped, host.PWM_FREQUENCY_HZ, host.PWM_DURATION_MS, fuelPressBoardIp);
                        if (success) {
                            if (shouldLogPWM) {
                                console.log(`🎯 PWM sent: Fuel Press CH${fuelPressChannel} @ ${fuelPressBoardIp || host.actuatorIP} duty=${duty_F_clamped.toFixed(3)} (${(duty_F_clamped * 100).toFixed(1)}%), freq=${host.PWM_FREQUENCY_HZ}Hz, duration=${host.PWM_DURATION_MS}ms`);
                            }
                        } else {
                            console.error(`❌ Failed to send PWM command to Fuel Press CH${fuelPressChannel}`);
                        }
                    } else {
                        console.warn('⚠️ Fuel Press channel not found in ACTUATOR_CHANNEL map');
                    }
                    if (loxPressChannel) {
                        const success = sendPWMActuatorCommandUDP(host, loxPressChannel, duty_O_clamped, host.PWM_FREQUENCY_HZ, host.PWM_DURATION_MS, loxPressBoardIp);
                        if (success) {
                            if (shouldLogPWM) {
                                console.log(`🎯 PWM sent: LOX Press CH${loxPressChannel} @ ${loxPressBoardIp || host.actuatorIP} duty=${duty_O_clamped.toFixed(3)} (${(duty_O_clamped * 100).toFixed(1)}%), freq=${host.PWM_FREQUENCY_HZ}Hz, duration=${host.PWM_DURATION_MS}ms`);
                            }
                        } else {
                            console.error(`❌ Failed to send PWM command to LOX Press CH${loxPressChannel}`);
                        }
                    } else {
                        console.warn('⚠️ LOX Press channel not found in ACTUATOR_CHANNEL map');
                    }
                } catch (error) {
                    console.error('❌ Failed to send PWM actuator command:', error);
                }

                if (diagnostics && Math.random() < 0.1) {
                    console.log(`🎯 Controller: F_ref=${diagnostics.F_ref.toFixed(1)}N, F_est=${diagnostics.F_estimated.toFixed(1)}N, ` +
                        `duty_F=${duty_F_clamped.toFixed(3)}, duty_O=${duty_O_clamped.toFixed(3)}`);
                }

                const actuationValid = host.DUTY_SWEEP_ENABLED || !!diagnostics;

                // Write to Elodin DB
                if (host.elodin.isConnected() && diagnostics) {
                    try {
                        publishControllerActuation(
                            host.elodin,
                            duty_F_clamped,
                            duty_O_clamped,
                            duty_F_clamped > 0,
                            duty_O_clamped > 0,
                            actuationValid
                        );
                        publishControllerDiagnostics(
                            host.elodin,
                            diagnostics.F_ref,
                            diagnostics.MR_ref,
                            diagnostics.F_estimated,
                            diagnostics.MR_estimated,
                            diagnostics.P_ch,
                            diagnostics.cost,
                            diagnostics.safety_filtered,
                            diagnostics.cutoff_active,
                            diagnostics.solver_iters
                        );
                    } catch (error) {
                        if (Math.random() < 0.01) {
                            console.error('❌ Failed to publish controller data to Elodin:', error);
                        }
                    }
                }

                // Broadcast controller diagnostics
                host.broadcast({
                    type: MessageType.CONTROLLER_UPDATE,
                    timestamp: Date.now(),
                    payload: {
                        actuation: {
                            duty_F: duty_F_clamped,
                            duty_O: duty_O_clamped,
                            u_F_onoff: duty_F_clamped > 0,
                            u_O_onoff: duty_O_clamped > 0,
                            valid: actuationValid,
                        },
                        diagnostics: diagnostics ?? null,
                    },
                });

                // Update sensor store with duty cycles
                host.sensorCache.set('CONTROLLER.Fuel.duty_cycle', {
                    entity: 'CONTROLLER.Fuel', component: 'duty_cycle',
                    value: duty_F_clamped * 100, timestamp: Date.now(),
                });
                host.sensorCache.set('CONTROLLER.Fuel.onoff', {
                    entity: 'CONTROLLER.Fuel', component: 'onoff',
                    value: duty_F_clamped > 0 ? 1 : 0, timestamp: Date.now(),
                });
                host.sensorCache.set('CONTROLLER.Ox.duty_cycle', {
                    entity: 'CONTROLLER.Ox', component: 'duty_cycle',
                    value: duty_O_clamped * 100, timestamp: Date.now(),
                });
                host.sensorCache.set('CONTROLLER.Ox.onoff', {
                    entity: 'CONTROLLER.Ox', component: 'onoff',
                    value: duty_O_clamped > 0 ? 1 : 0, timestamp: Date.now(),
                });

                // Broadcast sensor updates for duty cycles
                host.broadcast({
                    type: MessageType.SENSOR_UPDATE, timestamp: Date.now(),
                    payload: { entity: 'CONTROLLER.Fuel', component: 'duty_cycle', value: duty_F_clamped * 100 },
                });
                host.broadcast({
                    type: MessageType.SENSOR_UPDATE, timestamp: Date.now(),
                    payload: { entity: 'CONTROLLER.Ox', component: 'duty_cycle', value: duty_O_clamped * 100 },
                });
            } catch (error) {
                if (Math.random() < 0.01) {
                    console.error('❌ Unexpected error in controller loop:', error);
                }
            }
        }, host.CONTROLLER_LOOP_INTERVAL_MS);
    };

    if (host.DUTY_SWEEP_ENABLED) {
        startLoop();
    } else {
        host.controllerClient!.initialize(host.controllerConfigPath).then((success) => {
            if (!success) {
                console.error('❌ Failed to initialize controller - controller loop will not run');
                console.error('   Start controller service or enable duty_sweep_enabled in config');
                return;
            }
            startLoop();
        });
    }
}

/**
 * Stop controller loop.
 */
export function stopControllerLoop(host: ControllerHost): void {
    if (host.controllerLoopInterval) {
        clearInterval(host.controllerLoopInterval);
        host.controllerLoopInterval = null;
        host.controllerLoopStartTime = null;
        console.log('🛑 Stopped controller loop');

        // Send duty=0 to shut off actuators immediately when exiting FIRE state
        const fuelPressBoard = getActuatorBoardInfo(host, 'Fuel Press');
        const loxPressBoard = getActuatorBoardInfo(host, 'LOX Press');

        try {
            if (fuelPressBoard) {
                sendPWMActuatorCommandUDP(host, fuelPressBoard.channel, 0, host.PWM_FREQUENCY_HZ, host.PWM_DURATION_MS, fuelPressBoard.boardIp);
            }
            if (loxPressBoard) {
                sendPWMActuatorCommandUDP(host, loxPressBoard.channel, 0, host.PWM_FREQUENCY_HZ, host.PWM_DURATION_MS, loxPressBoard.boardIp);
            }
            console.log('🛑 Sent duty=0 PWM shutoff commands to actuators');
        } catch (error) {
            console.error('❌ Failed to send shutoff commands:', error);
        }

        // Update sensor store and broadcast that controller is off
        ['CONTROLLER.Fuel', 'CONTROLLER.Ox'].forEach(entity => {
            host.sensorCache.set(`${entity}.duty_cycle`, {
                entity, component: 'duty_cycle', value: 0, timestamp: Date.now()
            });
            host.sensorCache.set(`${entity}.onoff`, {
                entity, component: 'onoff', value: 0, timestamp: Date.now()
            });
            host.broadcast({
                type: MessageType.SENSOR_UPDATE, timestamp: Date.now(),
                payload: { entity, component: 'duty_cycle', value: 0 }
            });
        });

        // Broadcast the controller actuation state update
        host.broadcast({
            type: MessageType.CONTROLLER_UPDATE,
            timestamp: Date.now(),
            payload: {
                actuation: {
                    duty_F: 0,
                    duty_O: 0,
                    u_F_onoff: false,
                    u_O_onoff: false,
                    valid: true,
                },
                diagnostics: null,
            },
        });
    }
}
