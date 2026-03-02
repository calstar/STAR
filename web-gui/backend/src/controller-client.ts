/**
 * Controller Client - Interfaces with Robust DDP Controller
 *
 * Maps sensor data to controller Measurement format and sends PWM commands
 * based on controller ActuationCommand output.
 */

export interface ControllerMeasurement {
  P_copv: number;      // COPV pressure [Pa]
  P_reg: number;       // Regulator pressure [Pa]
  P_u_fuel: number;    // Fuel upstream pressure [Pa]
  P_u_ox: number;      // Oxidizer upstream pressure [Pa]
  P_d_fuel: number;    // Fuel downstream pressure [Pa]
  P_d_ox: number;      // Oxidizer downstream pressure [Pa]
  timestamp?: number;  // Timestamp [ms]
}

export interface ControllerNavState {
  h?: number;          // Altitude [m]
  vz?: number;         // Vertical velocity [m/s]
  theta?: number;      // Tilt angle [rad]
  mass?: number;        // Vehicle mass [kg]
}

export interface ControllerCommand {
  command_type: 'THRUST_DESIRED' | 'ALTITUDE_GOAL' | 'PRESSURE_TARGET';
  thrust_desired?: number;  // [N]
  altitude_goal?: number;    // [m]
  P_fuel_target?: number;    // Target fuel pressure
  P_ox_target?: number;      // Target ox pressure
}

export interface ControllerActuation {
  duty_F: number;      // Fuel duty cycle [0-1]
  duty_O: number;      // Oxidizer duty cycle [0-1]
  u_F_onoff: boolean;  // Fuel binary state
  u_O_onoff: boolean;  // Oxidizer binary state
}

export interface ControllerDiagnostics {
  F_ref: number;
  MR_ref: number;
  F_estimated: number;
  MR_estimated: number;
  P_ch: number;
  cost: number;
  safety_filtered: boolean;
  cutoff_active: boolean;
  solver_iters: number;
}

export interface ControllerStepResponse {
  actuation: ControllerActuation;
  diagnostics: ControllerDiagnostics;
}

/**
 * Client for Robust DDP Controller FastAPI service
 */
export class ControllerClient {
  private baseUrl: string;
  private initialized: boolean = false;

  constructor(baseUrl: string = 'http://localhost:8000') {
    this.baseUrl = baseUrl;
  }

  /**
   * Initialize the controller with config
   */
  async initialize(configPath?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/control/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          controller_config_path: configPath || null,
          use_engine_config: true,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Controller init failed: ${error}`);
        return false;
      }

      this.initialized = true;
      console.log('✅ Controller initialized');
      return true;
    } catch (error) {
      console.error('❌ Controller init error:', error);
      return false;
    }
  }

  /**
   * Execute one controller step
   */
  async step(
    meas: ControllerMeasurement,
    nav: ControllerNavState = {},
    cmd: ControllerCommand = { command_type: 'THRUST_DESIRED', thrust_desired: 1000 }
  ): Promise<ControllerStepResponse | null> {
    if (!this.initialized) {
      console.warn('⚠️ Controller not initialized, attempting auto-init...');
      const initSuccess = await this.initialize();
      if (!initSuccess) {
        return null;
      }
    }

    try {
      const response = await fetch(`${this.baseUrl}/api/control/step`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meas: {
            P_copv: meas.P_copv,
            P_reg: meas.P_reg,
            P_u_fuel: meas.P_u_fuel,
            P_u_ox: meas.P_u_ox,
            P_d_fuel: meas.P_d_fuel,
            P_d_ox: meas.P_d_ox,
            timestamp: meas.timestamp || Date.now(),
          },
          nav: {
            h: nav.h ?? 0.0,
            vz: nav.vz ?? 0.0,
            theta: nav.theta ?? 0.0,
            mass_estimate: nav.mass ?? 10.0,
          },
          cmd: {
            command_type: cmd.command_type.toLowerCase(), // API expects lowercase: 'thrust_desired' or 'altitude_goal' or 'pressure_target'
            thrust_desired: cmd.thrust_desired ?? 0.0,
            altitude_goal: cmd.altitude_goal ?? 0.0,
            P_fuel_target: cmd.P_fuel_target ?? 0.0,
            P_ox_target: cmd.P_ox_target ?? 0.0,
          },
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error(`❌ Controller step failed: ${error}`);
        return null;
      }

      const data = await response.json();
      return data as ControllerStepResponse;
    } catch (error) {
      console.error('❌ Controller step error:', error);
      return null;
    }
  }

  /**
   * Reset controller state
   */
  async reset(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/control/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        return false;
      }

      console.log('🔄 Controller reset');
      return true;
    } catch (error) {
      console.error('❌ Controller reset error:', error);
      return false;
    }
  }

  /**
   * Get controller status
   */
  async getStatus(): Promise<any> {
    try {
      const response = await fetch(`${this.baseUrl}/api/control/status`, {
        method: 'GET',
      });

      if (!response.ok) {
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('❌ Controller status error:', error);
      return null;
    }
  }
}

/**
 * Convert PSI to Pascals
 */
export function psiToPa(psi: number): number {
  return psi * 6894.76; // 1 PSI = 6894.76 Pa
}

/**
 * Map sensor data from web-gui format to controller Measurement format
 */
export function mapSensorDataToMeasurement(sensorData: Map<string, number>): ControllerMeasurement | null {
  // Map entity names to controller measurement fields
  // Using both named aliases and PT_CH fallbacks
  const getPressure = (entity: string, ...fallbacks: string[]): number | null => {
    let v = sensorData.get(`${entity}.pressure_psi`);
    if (v !== undefined) return v;
    for (const fb of fallbacks) {
      v = sensorData.get(`${fb}.pressure_psi`);
      if (v !== undefined) return v;
    }
    return null;
  };

  let P_copv = getPressure('PT_Cal.GN2_High', 'PT_Cal.HP_PT_4', 'PT_Cal.PT_CH9');
  const P_reg = getPressure('PT_Cal.GN2_Regulated', 'PT_Cal.PT_CH6');
  const P_u_fuel = getPressure('PT_Cal.Fuel_Upstream', 'PT_Cal.PT_CH1');
  const P_u_ox = getPressure('PT_Cal.Ox_Upstream', 'PT_Cal.PT_CH5');
  const P_d_fuel = getPressure('PT_Cal.Fuel_Downstream', 'PT_Cal.PT_CH3');
  const P_d_ox = getPressure('PT_Cal.Ox_Downstream', 'PT_Cal.PT_CH7');

  // If we don't have a dedicated COPV sensor, approximate from regulator pressure.
  // This keeps the controller running on rigs with only GN2_Regulated installed.
  if (P_copv === null && P_reg !== null) {
    P_copv = P_reg; // Simple fallback: treat COPV ≈ regulator pressure
  }

  // Check if we have all required pressures
  if (P_copv === null || P_reg === null || P_u_fuel === null ||
    P_u_ox === null || P_d_fuel === null || P_d_ox === null) {
    return null; // Missing required sensor data
  }

  return {
    P_copv: psiToPa(P_copv),
    P_reg: psiToPa(P_reg),
    P_u_fuel: psiToPa(P_u_fuel),
    P_u_ox: psiToPa(P_u_ox),
    P_d_fuel: psiToPa(P_d_fuel),
    P_d_ox: psiToPa(P_d_ox),
    timestamp: Date.now(),
  };
}
