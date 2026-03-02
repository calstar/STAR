/**
 * Re-export shared types so backend can load them without ESM resolution
 * issues when importing from nested paths (tsx/node often fails on ../../shared).
 * Use dynamic import with absolute URL so the correct file is loaded.
 */
const sharedTypesUrl = new URL('../../shared/types.js', import.meta.url).href;
const mod = await import(sharedTypesUrl);

export const MessageType = mod.MessageType;
export const SensorType = mod.SensorType;
export const SystemState = mod.SystemState;
export const ActuatorId = mod.ActuatorId;
export const ActuatorState = mod.ActuatorState;
export type SensorUpdate = import('../../shared/types.js').SensorUpdate;
export type ActuatorUpdate = import('../../shared/types.js').ActuatorUpdate;
export type StateUpdate = import('../../shared/types.js').StateUpdate;
export type CommandPayload = import('../../shared/types.js').CommandPayload;
export type ConnectionStatus = import('../../shared/types.js').ConnectionStatus;
export type BoardStatus = import('../../shared/types.js').BoardStatus;
export type BoardStatusPayload = import('../../shared/types.js').BoardStatusPayload;
export type NotificationPayload = import('../../shared/types.js').NotificationPayload;
