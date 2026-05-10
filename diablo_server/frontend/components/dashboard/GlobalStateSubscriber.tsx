'use client'

import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import {
    MessageType,
    SensorUpdate,
    StateUpdate,
    BoardStatusPayload,
    BoardStatus,
    MissionStartTime,
    CountdownTargetUpdate,
    NotificationPayload,
    ActuatorUpdate
} from '@/lib/types';
import { startDataCache, getDataCache } from '@/lib/data-cache';

export default function GlobalStateSubscriber() {
    const updateSensor = useSensorStore((state) => state.updateSensor);
    const updateState = useSensorStore((state) => state.updateState);
    const updateActuator = useSensorStore((state) => state.updateActuator);
    const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
    const updateMissionStartTime = useSensorStore((state) => state.updateMissionStartTime);
    const updateCountdownTargetTime = useSensorStore((state) => state.updateCountdownTargetTime);
    const updateBoards = useSensorStore((state) => state.updateBoards);
    const updateNotification = useSensorStore((state) => state.updateNotification);
    const updateActuatorExpectedPositions = useSensorStore((state) => state.updateActuatorExpectedPositions);

    useEffect(() => {
        console.log('[WS] GlobalStateSubscriber effect start');
        const ws = getWebSocketClient();

        try {
            startDataCache(); // Initialize the background data cache properly
        } catch (err) {
            console.error('[GlobalStateSubscriber] Failed to start data cache:', err);
        }

        const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
            const update = p as SensorUpdate;
            updateSensor(update);
            if (Number.isFinite(update.value)) {
                getDataCache().addDataPoint(update.entity, update.component, update.value);
            }
        });
        const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => {
            updateState(p as StateUpdate);
        });
        const u3 = ws.on(MessageType.MISSION_START_TIME, (p: unknown) => {
            const payload = p as MissionStartTime;
            updateMissionStartTime(payload.missionStartTime);
        });
        const u4 = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
            const payload = p as BoardStatusPayload;
            if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
        });
        const u5 = ws.onConnectionStatus((s) => updateConnectionStatus(s));
        const u6 = ws.on(MessageType.NOTIFICATION, (p: unknown) => {
            updateNotification(p as NotificationPayload);
        });
        const u7 = ws.on(MessageType.ACTUATOR_UPDATE, (p: unknown) => {
            updateActuator(p as ActuatorUpdate);
        });
        const u8 = ws.on(MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE, (p: unknown) => {
            updateActuatorExpectedPositions(p as Record<number, Record<string, 'open' | 'closed' | null>>);
        });
        const u9 = ws.on(MessageType.COUNTDOWN_TARGET_UPDATE, (p: unknown) => {
            const payload = p as CountdownTargetUpdate;
            updateCountdownTargetTime(payload.targetTimeMs);
        });

        // Register listeners before opening socket to avoid missing first status/data burst.
        ws.connect('GlobalStateSubscriber');
        console.log('[WS] GlobalStateSubscriber connect invoked');

        return () => {
            console.log('[WS] GlobalStateSubscriber cleanup');
            u1(); u2(); u3(); u4(); u5(); u6(); u7(); u8(); u9();
        };
    }, [
        updateSensor, updateState, updateActuator, updateConnectionStatus,
        updateMissionStartTime, updateCountdownTargetTime, updateBoards, updateNotification, updateActuatorExpectedPositions
    ]);

    // Drive _staleRenderTick so useSensorValue / useGetSensorValue re-check SENSOR_DATA_STALE_MS
    // even when sensorData values are unchanged (same Zustand subscription as the rest of the UI).
    useEffect(() => {
        const id = setInterval(() => {
            useSensorStore.setState((s) => ({
                _staleRenderTick: (s._staleRenderTick ?? 0) + 1,
            }));
        }, 250);
        return () => clearInterval(id);
    }, []);

    return null;
}
