'use client'

import { useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig, filterByRole } from '@/lib/sensor-config';

export default function ChamberGraphsPage() {
    const updateSensor = useSensorStore((s) => s.updateSensor);
    const updateState = useSensorStore((s) => s.updateState);
    const ws = getWebSocketClient();
    const allSensors = useSensorConfig();

    const lcSensors = allSensors.filter(s => s.calEntity.startsWith('LC') || s.calEntity.startsWith('LC_Cal'));
    const tcSensors = allSensors.filter(s => s.calEntity.startsWith('TC') || s.calEntity.startsWith('TC_Cal'));
    const ptSensors = filterByRole(allSensors, 'Upstream', 'Downstream');

    const ptEntities = ptSensors.map(s => s.calEntity);
    const ptLabels = ptSensors.map(s => s.role);
    const ptColors = ptEntities.map(e => getEntityColor(e));

    const tcComponent = tcSensors.some(s => s.calEntity.includes('TC.')) ? 'raw_adc_counts' : 'temperature_c';
    const tcYLabel = tcComponent === 'raw_adc_counts' ? 'Temp (Raw ADC)' : 'Temperature (°C)';
    const tcEntities = tcSensors.map(s => s.calEntity);
    const tcLabels = tcSensors.map(s => s.role);
    const tcColors = tcEntities.map(e => getEntityColor(e));

    const lcComponent = lcSensors.some(s => s.calEntity.includes('LC.')) ? 'raw_adc_counts' : 'force_lbf';
    const lcYLabel = lcComponent === 'raw_adc_counts' ? 'Force (Raw ADC)' : 'Force (lbf)';
    const lcEntities = lcSensors.map(s => s.calEntity);
    const lcLabels = lcSensors.map(s => s.role);
    const lcColors = lcEntities.map(e => getEntityColor(e));

    useEffect(() => {
        ws.connect();
        const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
        const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
        return () => { unsub1(); unsub2(); };
    }, [ws, updateSensor, updateState]);

    return (
        <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

            <div className="flex items-center flex-shrink-0 justify-between">
                <div className="flex items-center">
                    <div className="w-1 h-5 bg-orange-500 rounded-full mr-3" />
                    <h1 className="text-base font-bold text-orange-400 tracking-wider">CHAMBER SYSTEM</h1>
                </div>
                <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
                    <div className="px-4 py-1.5 text-sm font-bold rounded-md bg-gray-800 text-gray-300">
                        Unified View
                    </div>
                </div>
            </div>

            <div className="flex-shrink-0">
                <SensorReadoutStrip sensors={[
                    ...ptSensors.map((s) => ({ label: s.role, entity: s.calEntity, component: 'pressure_psi', color: getEntityColor(s.calEntity) })),
                    ...tcSensors.map((s) => ({ label: s.role, entity: s.calEntity, component: tcComponent, color: getEntityColor(s.calEntity) })),
                    ...lcSensors.map((s) => ({ label: s.role, entity: s.calEntity, component: lcComponent, color: getEntityColor(s.calEntity) }))
                ]} />
            </div>

            <div className="flex-1 min-h-0 flex flex-col gap-2">
                {/* 3 columns of graphs side-by-side */}
                <div className="flex-1 flex flex-row gap-2 min-h-0 min-w-0">
                    <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0">
                        <TimeSeriesPlot title="PT Pressures" entities={ptEntities} labels={ptLabels} component="pressure_psi" colors={ptColors} yLabel="Pressure (PSI)" />
                    </div>
                    <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0">
                        <TimeSeriesPlot title="TC Temperatures" entities={tcEntities} labels={tcLabels} component={tcComponent} colors={tcColors} yLabel={tcYLabel} />
                    </div>
                    <div className="flex-1 bg-card rounded-lg p-2 flex flex-col min-h-0 min-w-0">
                        <TimeSeriesPlot title="LC Forces" entities={lcEntities} labels={lcLabels} component={lcComponent} colors={lcColors} yLabel={lcYLabel} />
                    </div>
                </div>

                <div className="flex-shrink-0">
                    <ActuatorStatePanel
                        title="Chamber Actuators"
                        actuators={[
                            { label: 'LOX Main', entity: 'ACT.LOX_Main', color: getActuatorColor('ACT.LOX_Main') },
                            { label: 'Fuel Main', entity: 'ACT.Fuel_Main', color: getActuatorColor('ACT.Fuel_Main') },
                        ]}
                    />
                </div>
            </div>

        </main>
    );
}
