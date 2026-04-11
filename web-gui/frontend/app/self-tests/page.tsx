'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { useEffect } from 'react';
import { MessageType, SensorUpdate, BoardStatus, BoardStatusPayload } from '@/lib/types';

export default function SelfTestsPage() {
    const boardsMap = useSensorStore((s) => s.boards as Record<number, BoardStatus>);
    const sensorData = useSensorStore((s) => s.sensorData);
    const updateSensor = useSensorStore((s) => s.updateSensor);
    const updateBoards = useSensorStore((s) => s.updateBoards);
    const ws = getWebSocketClient();

    useEffect(() => {
        ws.connect();
        const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
        const unsubBoards = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
            const payload = p as BoardStatusPayload;
            if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
        });
        return () => { unsubSensor(); unsubBoards(); };
    }, [ws, updateSensor, updateBoards]);

    const testedBoards = Object.values(boardsMap ?? {}).filter(b =>
        Object.keys(sensorData).some(k => k.startsWith(`SELF_TEST.BOARD_${b.id}.`))
    );

    return (
        <main className="h-full bg-background text-text flex flex-col overflow-auto p-8 md:p-10">
            <div className="mb-8">
                <h1 className="text-4xl font-bold text-text mb-2 tracking-tight">Self Test Dashboard</h1>
                <p className="text-lg text-text-muted max-w-2xl">
                    Detailed breakdown of diagnostic self-test passes, fails, and sensor calibrations.
                </p>
            </div>

            {testedBoards.length === 0 ? (
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
                    {testedBoards.map(b => {
                        const testKeys = Object.keys(sensorData).filter((k) => k.startsWith(`SELF_TEST.BOARD_${b.id}.`));
                        const allPassed = testKeys.every(k => sensorData[k] === 1);

                        return (
                            <div
                                key={b.id}
                                className={`rounded-xl border p-5 flex flex-col transition-all backdrop-blur-sm ${allPassed
                                        ? 'border-green-900/50 bg-green-950/10 hover:bg-green-950/20'
                                        : 'border-red-900/50 bg-red-950/10 hover:bg-red-950/20'
                                    }`}
                            >
                                <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                                    <h3 className="text-xl font-bold">
                                        {b.type || 'BOARD'} {b.boardNumber ? `#${b.boardNumber}` : ''}
                                    </h3>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xs text-gray-500 font-mono">ID {b.id}</span>
                                        <span className={`text-xs px-2 py-0.5 rounded font-black font-mono uppercase ${allPassed ? 'bg-green-900 text-green-300' : 'bg-red-900 text-red-300'
                                            }`}>
                                            {allPassed ? 'ALL PASSED' : 'FAILURES'}
                                        </span>
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
                                    {testKeys.map(k => {
                                        const sensorMatch = k.match(/sensor_(\d+)/);
                                        const sensorId = sensorMatch ? sensorMatch[1] : '?';
                                        const passed = sensorData[k] === 1;

                                        return (
                                            <div
                                                key={k}
                                                className={`flex items-center justify-between bg-black/30 px-3 py-2.5 rounded-lg border transition-colors ${passed ? 'border-green-900/30' : 'border-red-900/30'
                                                    }`}
                                            >
                                                <span className="font-mono text-sm text-text-muted">CH {sensorId}</span>
                                                <span className={`font-bold text-sm drop-shadow-sm ${passed ? 'text-green-400' : 'text-red-400'}`}>
                                                    {passed ? 'PASS' : 'FAIL'}
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
