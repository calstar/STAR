/**
 * The product types the stubs refer to, re-exported from their real modules so every stub names
 * the same types the implementation will. Stub-only: no product file imports this, and nothing
 * here exists at runtime (`export type` only).
 *
 * Paths are relative to daq-server/docs/remaster/design-stubs/ts/src/ and target
 * backend-remastered @ 85a02f9a (before WP5's `legacy/` → `state-csv/` rename; the stubs define
 * the renamed modules' surface themselves in ./state-csv/).
 */

export type { default as WebSocket, WebSocketServer } from 'ws';
export type { IncomingMessage, ServerResponse, Server as HttpServer } from 'http';

export type {
  BoardStatus,
  CommandPayload,
  NotificationPayload,
  NotificationPayloadOngoing,
  QueryHistoricalRequest,
  SensorUpdate,
  SystemState,
} from '../../../../../diablo_server/shared/types.js';

export type { ClientOutbox, FlushPacer } from '../../../../../diablo_server/backend/src/client-outbox.js';
export type { HistoryCache } from '../../../../../diablo_server/backend/src/history-cache.js';
export type {
  EnvelopeAccumulator,
  EnvelopePoint,
  GuiStreamConfig,
} from '../../../../../diablo_server/backend/src/gui-stream.js';
export type { ElodinClient, ElodinPacketHeader } from '../../../../../diablo_server/backend/src/elodin-client.js';
export type { ParsedSensorData } from '../../../../../diablo_server/backend/src/elodin-protocol.js';
export type { CalibrationHost } from '../../../../../diablo_server/backend/src/calibration-handler.js';
export type { CalibrationCoefficients } from '../../../../../diablo_server/backend/src/calibration.js';
export type { ElodinQueryClient } from '../../../../../diablo_server/backend/src/elodin-query.js';
export type { VideoService } from '../../../../../diablo_server/backend/src/video/service.js';
export type { SubscriptionPassResult } from '../../../../../diablo_server/backend/src/elodin-vtable-registry.js';
