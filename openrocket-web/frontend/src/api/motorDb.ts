/**
 * A dozen common motors for the mock API's /api/motors/search. Dimensions and
 * impulses are the manufacturers' catalogue figures (rounded); the real list
 * comes from the backend's thrustcurve database.
 */
import type { MotorSearchResult } from '../types'

export interface MockMotor extends MotorSearchResult {
  /** kg, loaded. */
  launchMass: number
}

export const MOTORS: MockMotor[] = [
  { designation: 'A8', manufacturer: 'Estes', digest: '22aec01287ea1e3b8c6f66b26fe5fea6', diameter: 0.018, length: 0.07, totalImpulse: 2.5, burnTime: 0.5, avgThrust: 4.9, launchMass: 0.0162 },
  { designation: 'B4', manufacturer: 'Estes', digest: 'c15b9b96bf06e0ab896394787da3c47e', diameter: 0.018, length: 0.07, totalImpulse: 5.0, burnTime: 1.2, avgThrust: 4.2, launchMass: 0.0199 },
  { designation: 'B6', manufacturer: 'Estes', digest: 'mock-estes-b6', diameter: 0.018, length: 0.07, totalImpulse: 5.0, burnTime: 0.8, avgThrust: 5.9, launchMass: 0.0194 },
  { designation: 'C6', manufacturer: 'Estes', digest: 'c8743ef3fa99e14a89885cbe0ead47b2', diameter: 0.018, length: 0.07, totalImpulse: 8.8, burnTime: 1.86, avgThrust: 4.7, launchMass: 0.0231 },
  { designation: 'C11', manufacturer: 'Estes', digest: 'mock-estes-c11', diameter: 0.024, length: 0.07, totalImpulse: 8.8, burnTime: 0.8, avgThrust: 11.0, launchMass: 0.0332 },
  { designation: 'D12', manufacturer: 'Estes', digest: 'mock-estes-d12', diameter: 0.024, length: 0.07, totalImpulse: 16.8, burnTime: 1.65, avgThrust: 10.2, launchMass: 0.0442 },
  { designation: 'E9', manufacturer: 'Estes', digest: 'mock-estes-e9', diameter: 0.024, length: 0.095, totalImpulse: 28.5, burnTime: 3.1, avgThrust: 9.2, launchMass: 0.057 },
  { designation: 'E12', manufacturer: 'Estes', digest: 'mock-estes-e12', diameter: 0.024, length: 0.095, totalImpulse: 27.9, burnTime: 2.4, avgThrust: 11.6, launchMass: 0.058 },
  { designation: 'F15', manufacturer: 'Estes', digest: 'mock-estes-f15', diameter: 0.029, length: 0.114, totalImpulse: 49.6, burnTime: 3.45, avgThrust: 14.4, launchMass: 0.102 },
  { designation: 'F39T', manufacturer: 'AeroTech', digest: 'mock-at-f39', diameter: 0.024, length: 0.124, totalImpulse: 49.7, burnTime: 1.3, avgThrust: 37.3, launchMass: 0.0591 },
  { designation: 'G80T', manufacturer: 'AeroTech', digest: 'mock-at-g80', diameter: 0.029, length: 0.124, totalImpulse: 108, burnTime: 1.4, avgThrust: 79.6, launchMass: 0.107 },
  { designation: 'H128W', manufacturer: 'AeroTech', digest: 'mock-at-h128', diameter: 0.029, length: 0.194, totalImpulse: 176, burnTime: 1.4, avgThrust: 128, launchMass: 0.206 },
  { designation: 'I284W', manufacturer: 'AeroTech', digest: 'mock-at-i284', diameter: 0.038, length: 0.25, totalImpulse: 412, burnTime: 1.4, avgThrust: 284, launchMass: 0.42 },
  { designation: 'J350W', manufacturer: 'AeroTech', digest: 'mock-at-j350', diameter: 0.038, length: 0.335, totalImpulse: 700, burnTime: 2.0, avgThrust: 350, launchMass: 0.66 },
]

export function findMotor(designation: string, manufacturer?: string): MockMotor | null {
  const d = designation.toLowerCase()
  return (
    MOTORS.find((m) => m.designation.toLowerCase() === d && (!manufacturer || m.manufacturer === manufacturer)) ??
    MOTORS.find((m) => m.designation.toLowerCase() === d) ??
    null
  )
}

export function searchMotors(q: string, diameter?: number): MotorSearchResult[] {
  const needle = q.trim().toLowerCase()
  return MOTORS.filter((m) => {
    if (needle && !`${m.manufacturer} ${m.designation}`.toLowerCase().includes(needle)) return false
    if (diameter && Math.abs(m.diameter - diameter) > 0.0015) return false
    return true
  }).map(({ launchMass: _drop, ...rest }) => rest)
}
