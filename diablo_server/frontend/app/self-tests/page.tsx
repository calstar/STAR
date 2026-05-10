'use client'

import { useSensorStore } from '@/lib/store';
import { selfTestBoardIdsFromSensorData } from '@/lib/self-test-keys';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { useEffect, useMemo, useState } from 'react';
import { MessageType, SensorUpdate, BoardStatus, BoardStatusPayload } from '@/lib/types';

type BoardSelfTestEntry = {
    key: string;
    name: string;
    sortRank: number;
    sortNum: number;
    value: number | null;
    passed: boolean | null;
};

type ConfigBoardMeta = {
    connectors: number[];
};

function parseSelfTestEntry(fullKey: string, value: number, _boardMeta?: ConfigBoardMeta): BoardSelfTestEntry {
    const suffix = fullKey.replace(/^SELF_TEST\.BOARD_\d+\./, '');
    const sensorMatch = /^sensor_(\d+)$/i.exec(suffix);
    if (sensorMatch) {
        const idx = Number(sensorMatch[1]);
        if (idx === 0) {
            return {
                key: fullKey,
                name: 'TDAC',
                sortRank: 1,
                sortNum: 0,
                value,
                passed: value === 1,
            };
        }
        // sensor_id IS the connector/channel number (not an index into connectors)
        return {
            key: fullKey,
            name: `CH ${idx}`,
            sortRank: 2,
            sortNum: idx,
            value,
            passed: value === 1,
        };
    }

    if (/tdac/i.test(suffix)) {
        return {
            key: fullKey,
            name: 'TDAC',
            sortRank: 1,
            sortNum: 0,
            value,
            passed: value === 1,
        };
    }

    return {
        key: fullKey,
        name: suffix.replace(/_/g, ' ').toUpperCase(),
        sortRank: 3,
        sortNum: Number.MAX_SAFE_INTEGER,
        value,
        passed: value === 1,
    };
}

function buildExpectedEntries(boardId: number, boardMeta?: ConfigBoardMeta): BoardSelfTestEntry[] {
    const expected: BoardSelfTestEntry[] = [
        {
            key: `SELF_TEST.BOARD_${boardId}.sensor_0`,
            name: 'TDAC',
            sortRank: 1,
            sortNum: 0,
            value: null,
            passed: null,
        },
    ];
    const connectors = boardMeta?.connectors ?? [];
    if (connectors.length > 0) {
        for (const ch of connectors) {
            expected.push({
                key: `SELF_TEST.BOARD_${boardId}.channel_${ch}`,
                name: `CH ${ch}`,
                sortRank: 2,
                sortNum: ch,
                value: null,
                passed: null,
            });
        }
        return expected;
    }
    for (let ch = 1; ch <= 10; ch++) {
        expected.push({
            key: `SELF_TEST.BOARD_${boardId}.channel_${ch}`,
            name: `CH ${ch}`,
            sortRank: 2,
            sortNum: ch,
            value: null,
            passed: null,
        });
    }
    return expected;
}

export default function SelfTestsPage() {
    const boardsMap = useSensorStore((s) => s.boards as Record<number, BoardStatus>);
    const sensorData = useSensorStore((s) => s.sensorData);
    const updateSensor = useSensorStore((s) => s.updateSensor);
    const updateBoards = useSensorStore((s) => s.updateBoards);
    const ws = getWebSocketClient();
    const [boardMetaById, setBoardMetaById] = useState<Record<number, ConfigBoardMeta>>({});

    useEffect(() => {
        const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
        const unsubBoards = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
            const payload = p as BoardStatusPayload;
            if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
        });
        return () => { unsubSensor(); unsubBoards(); };
    }, [ws, updateSensor, updateBoards]);

    useEffect(() => {
        fetch(`${getApiBaseUrl()}/api/config`)
            .then((r) => (r.ok ? r.json() : null))
            .then((data: { config?: { boards?: Record<string, { board_id?: number; enabled?: boolean; active_connectors?: number[]; num_sensors?: number }> } } | null) => {
                const boards = data?.config?.boards;
                if (!boards || typeof boards !== 'object') return;
                const next: Record<number, ConfigBoardMeta> = {};
                Object.values(boards).forEach((b) => {
                    if (b.enabled === false) return;
                    const boardId = Number(b?.board_id);
                    if (!Number.isFinite(boardId) || boardId <= 0) return;
                    const connectors = Array.isArray(b.active_connectors) && b.active_connectors.length > 0
                        ? b.active_connectors.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
                        : Array.from({ length: Math.max(0, Number(b.num_sensors) || 0) }, (_, i) => i + 1);
                    next[boardId] = { connectors };
                });
                setBoardMetaById(next);
            })
            .catch(() => { /* ignore config fetch errors on self-tests view */ });
    }, []);

    const testedIds = selfTestBoardIdsFromSensorData(sensorData);
    const boardIds = useMemo(() => {
        const configured = Object.keys(boardMetaById).map((k) => Number(k)).filter((n) => Number.isFinite(n));
        const merged = new Set<number>([...testedIds, ...configured]);
        return [...merged].sort((a, b) => a - b);
    }, [testedIds, boardMetaById]);

    return (
        <main className="h-full bg-background text-text flex flex-col overflow-auto p-8 md:p-10">
            <div className="mb-8">
                <h1 className="text-4xl font-bold text-text mb-2 tracking-tight">Self Test Dashboard</h1>
                <p className="text-lg text-text-muted max-w-2xl">
                    Detailed breakdown of diagnostic self-test passes, fails, and sensor calibrations.
                </p>
            </div>

            {boardIds.length === 0 ? (
                <div className="rounded-xl border border-gray-700 bg-card p-12 text-center text-text-muted text-lg flex flex-col items-center justify-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-gray-800 animate-pulse flex items-center justify-center">
                        <span className="text-xl">⌛</span>
                    </div>
                    <div>No self test streams received yet.</div>
                    <p className="text-sm text-gray-500 max-w-md mt-1">
                        Tests typically run during the board setup phase. Start the DAQ and boards to populate diagnostics.
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    {boardIds.map((boardId) => {
                        const b = boardsMap?.[boardId];
                        const boardMeta = boardMetaById[boardId];
                        const testKeys = Object.keys(sensorData).filter((k) => k.startsWith(`SELF_TEST.BOARD_${boardId}.`));
                        const actualEntries = testKeys
                            .map((k) => parseSelfTestEntry(k, sensorData[k], boardMeta))
                            .sort((a, b) => {
                                if (a.sortRank !== b.sortRank) return a.sortRank - b.sortRank;
                                if (a.sortNum !== b.sortNum) return a.sortNum - b.sortNum;
                                return a.name.localeCompare(b.name);
                            });
                        const expectedEntries = buildExpectedEntries(boardId, boardMeta);
                        const byName = new Map(actualEntries.map((e) => [e.name, e]));
                        const mergedEntries = expectedEntries.map((e) => byName.get(e.name) ?? e);
                        const extras = actualEntries.filter((e) => !mergedEntries.some((m) => m.name === e.name));
                        const entries = [...mergedEntries, ...extras];

                        const passCount = entries.filter((e) => e.passed === true).length;
                        const failCount = entries.filter((e) => e.passed === false).length;
                        const pendingCount = entries.filter((e) => e.passed == null).length;
                        const verdict: 'passed' | 'failed' | 'pending' =
                            failCount > 0 ? 'failed' : pendingCount > 0 ? 'pending' : 'passed';
                        const title = b
                            ? `${b.type || 'BOARD'}${b.boardNumber != null ? ` #${b.boardNumber}` : ''}`
                            : `Board ${boardId}`;
                        const verdictBorder = verdict === 'passed' ? 'border-green-900/50 bg-green-950/10 hover:bg-green-950/20'
                            : verdict === 'failed' ? 'border-red-900/50 bg-red-950/10 hover:bg-red-950/20'
                            : 'border-amber-900/50 bg-amber-950/10 hover:bg-amber-950/20';
                        const verdictBadge = verdict === 'passed' ? 'bg-green-900 text-green-300'
                            : verdict === 'failed' ? 'bg-red-900 text-red-300'
                            : 'bg-amber-900 text-amber-300';
                        const verdictLabel = verdict === 'passed' ? 'ALL PASSED'
                            : verdict === 'failed' ? 'FAILURES' : 'PENDING';

                        return (
                            <div
                                key={boardId}
                                className={`rounded-xl border p-5 flex flex-col transition-all backdrop-blur-sm ${verdictBorder}`}
                            >
                                <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                                    <h3 className="text-xl font-bold">
                                        {title}
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-500 font-mono">ID {boardId}</span>
                                        <span className={`text-xs px-2 py-0.5 rounded font-black font-mono uppercase ${verdictBadge}`}>
                                            {passCount} PASS · {failCount} FAIL · {pendingCount} PENDING
                                        </span>
                                        <span className={`text-xs px-2 py-0.5 rounded font-black font-mono uppercase ${verdictBadge}`}>
                                            {verdictLabel}
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                                    {entries.map((entry) => {
                                        return (
                                            <div
                                                key={entry.key}
                                                className={`flex items-center justify-between bg-black/30 px-3 py-2.5 rounded-lg border transition-colors ${entry.passed === true
                                                        ? 'border-green-900/30'
                                                        : entry.passed === false
                                                            ? 'border-red-900/30'
                                                            : 'border-gray-700/50'
                                                    }`}
                                            >
                                                <span className="font-mono text-sm text-text-muted">{entry.name}</span>
                                                <span className={`font-bold text-sm drop-shadow-sm ${entry.passed === true
                                                        ? 'text-green-400'
                                                        : entry.passed === false
                                                            ? 'text-red-400'
                                                            : 'text-gray-500'
                                                    }`}>
                                                    {entry.passed === true ? 'PASS' : entry.passed === false ? 'FAIL' : 'PENDING'}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </main>
    );
}
