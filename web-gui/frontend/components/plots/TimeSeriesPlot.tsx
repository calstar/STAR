'use client'

import { useEffect, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, ConnectionStatus } from '@/lib/types';

interface TimeSeriesPlotProps {
  title: string;
  entities: string[]; // e.g., ['PT_Cal.GN2_Regulated', 'PT_Cal.Fuel_Upstream']
  component: string; // Default component for all entities
  components?: string[]; // Optional: specific component for each entity
  colors: string[]; // Hex colors for each entity
  yLabel?: string;
  height?: number;
}

export default function TimeSeriesPlot({
  title,
  entities,
  component,
  components,
  colors,
  yLabel = 'Value',
  height = 300,
}: TimeSeriesPlotProps) {
  // Use components array if provided, otherwise use component for all
  const componentMap = components || entities.map(() => component);
  const plotRef = useRef<HTMLDivElement>(null);
  const plotInstanceRef = useRef<uPlot | null>(null);
  const dataRef = useRef<{ time: number[]; values: number[][] }>({
    time: [],
    values: entities.map(() => []),
  });
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const ws = getWebSocketClient();
    ws.connect();
    setIsConnected(ws.isConnected());

    // Initialize plot
    if (plotRef.current && !plotInstanceRef.current) {
      const opts: uPlot.Options = {
        title,
        width: plotRef.current.offsetWidth,
        height,
        scales: {
          x: {
            time: true,
          },
          y: {
            auto: true,
          },
        },
        axes: [
          {
            stroke: '#E0E0E0',
            grid: { show: true, stroke: '#333', width: 1 },
            ticks: { show: true, stroke: '#E0E0E0' },
          },
          {
            label: yLabel,
            stroke: '#E0E0E0',
            grid: { show: true, stroke: '#333', width: 1 },
            ticks: { show: true, stroke: '#E0E0E0' },
          },
        ],
        series: [
          {
            label: 'Time',
            value: '{YYYY}-{MM}-{DD} {HH}:{mm}:{ss}',
          },
          ...entities.map((entity, idx) => ({
            label: entity.split('.').pop() || entity,
            stroke: colors[idx] || '#3498DB',
            width: 2,
            points: { show: false },
          })),
        ],
        cursor: {
          show: true,
          x: true,
          y: true,
        },
        legend: {
          show: true,
          live: true,
        },
      };

      const data: [number[], ...number[][]] = [
        dataRef.current.time,
        ...dataRef.current.values,
      ];

      plotInstanceRef.current = new uPlot(opts, data, plotRef.current);
    }

    // Subscribe to sensor updates
    console.log(`📊 TimeSeriesPlot subscribing to: ${entities.join(', ')}`);
    const unsubscribe = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      const update = payload as SensorUpdate;

      // Log every update to see what we're receiving
      console.log(`📊 Plot received: ${update.entity}.${update.component} = ${update.value.toFixed(2)}`);
      console.log(`   Looking for entities: ${entities.join(', ')}`);

      // Check if this update is for one of our entities
      const entityIndex = entities.findIndex((e) => update.entity === e);
      if (entityIndex >= 0 && update.component === componentMap[entityIndex]) {
        console.log(`   ✅ MATCH! Adding to plot series ${entityIndex}`);
        const now = Date.now();

        // Add data point
        dataRef.current.time.push(now);
        dataRef.current.values[entityIndex].push(update.value);

        // Keep only last 1000 points (adjust based on update rate)
        const maxPoints = 1000;
        if (dataRef.current.time.length > maxPoints) {
          dataRef.current.time.shift();
          dataRef.current.values.forEach((arr) => arr.shift());
        }

        // Update plot
        if (plotInstanceRef.current) {
          const data: [number[], ...number[][]] = [
            dataRef.current.time,
            ...dataRef.current.values,
          ];
          plotInstanceRef.current.setData(data);
          console.log(`   ✅ Plot updated with ${dataRef.current.time.length} points`);
        } else {
          console.warn(`   ⚠️ Plot instance not ready yet`);
        }
      } else {
        console.log(`   ❌ No match - entityIndex=${entityIndex}, component=${update.component}, expected=${componentMap[entityIndex]}`);
      }
    });

    // Handle window resize
    const handleResize = () => {
      if (plotInstanceRef.current && plotRef.current) {
        plotInstanceRef.current.setSize({
          width: plotRef.current.offsetWidth,
          height,
        });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      unsubscribe();
      window.removeEventListener('resize', handleResize);
      if (plotInstanceRef.current) {
        plotInstanceRef.current.destroy();
        plotInstanceRef.current = null;
      }
    };
  }, [title, entities, component, colors, yLabel, height]);

  // Check connection status from store
  const connectionStatus = useSensorStore((state) => state.connectionStatus);
  const actuallyConnected = connectionStatus?.connected && connectionStatus?.elodinConnected;

  // Also subscribe to connection status updates
  useEffect(() => {
    const ws = getWebSocketClient();
    const unsubscribe = ws.onConnectionStatus((status) => {
      // Status is updated in store via TopBar, this just triggers re-render
    });
    return unsubscribe;
  }, []);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        <div className="flex items-center gap-2">
          <div
            className={`w-2 h-2 rounded-full ${
              actuallyConnected ? 'bg-green-500' : 'bg-red-500'
            }`}
          />
          <span className="text-sm text-text-muted">
            {actuallyConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
      </div>
      <div ref={plotRef} className="w-full" style={{ height: `${height}px` }} />
    </div>
  );
}
