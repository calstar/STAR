'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, MessageType, CommandPayload } from '@/lib/types';
import { useEffect, useState, useMemo } from 'react';

const STATE_NAMES: Record<SystemState, string> = {
  [SystemState.DEBUG]: 'DEBUG',
  [SystemState.IDLE]: 'IDLE',
  [SystemState.ARMED]: 'ARMED',
  [SystemState.FUEL_FILL]: 'Fuel Fill',
  [SystemState.OX_FILL]: 'Ox Fill',
  [SystemState.GN2_LOW_PRESS]: 'GN2 Press',
  [SystemState.GN2_VENT]: 'GN2 Vent',
  [SystemState.FUEL_PRESS]: 'Fuel Press',
  [SystemState.FUEL_VENT]: 'Fuel Vent',
  [SystemState.OX_PRESS]: 'Ox Press',
  [SystemState.OX_VENT]: 'Ox Vent',
  [SystemState.GN2_HIGH_PRESS]: 'High Press',
  [SystemState.GN2_HIGH_VENT]: 'GN2 High Vent',
  [SystemState.VENT]: 'VENT',
  [SystemState.CALIBRATE]: 'CALIBRATE',
  [SystemState.READY]: 'READY',
  [SystemState.FIRE]: 'FIRE',
  [SystemState.ABORT]: 'ABORT',
};

// Professional hierarchical layout - rocket launch sequence flow
// Organized by operational phase: Init → Fill → Pressurize → Sequence → Emergency
// Clean vertical flow with logical grouping - ordered to match CSV sequence
const STATE_LAYOUT: Record<SystemState, { x: number; y: number; width: number; height: number; group: string }> = {
  // Phase 1: Initialization (top row - left to right)
  [SystemState.IDLE]: { x: 30, y: 20, width: 100, height: 45, group: 'init' },
  [SystemState.ARMED]: { x: 150, y: 20, width: 100, height: 45, group: 'init' },
  [SystemState.DEBUG]: { x: 270, y: 20, width: 100, height: 45, group: 'init' },

  // Phase 2: Fill Operations (row 2 - sequential fill path)
  [SystemState.FUEL_FILL]: { x: 30, y: 85, width: 100, height: 45, group: 'fill' },
  [SystemState.OX_FILL]: { x: 150, y: 85, width: 100, height: 45, group: 'fill' },
  [SystemState.READY]: { x: 270, y: 85, width: 100, height: 45, group: 'fill' }, // Quick Fire → READY

  // Phase 3: GN2 Pressurization (row 3 - press/vent pair)
  [SystemState.GN2_LOW_PRESS]: { x: 30, y: 150, width: 100, height: 45, group: 'press' },
  [SystemState.GN2_VENT]: { x: 150, y: 150, width: 100, height: 45, group: 'press' },

  // Phase 4: Fuel Pressurization (row 4 - press/vent pair)
  [SystemState.FUEL_PRESS]: { x: 30, y: 215, width: 100, height: 45, group: 'press' },
  [SystemState.FUEL_VENT]: { x: 150, y: 215, width: 100, height: 45, group: 'press' },

  // Phase 5: Ox Pressurization (row 5 - press/vent pair)
  [SystemState.OX_PRESS]: { x: 30, y: 280, width: 100, height: 45, group: 'press' },
  [SystemState.OX_VENT]: { x: 150, y: 280, width: 100, height: 45, group: 'press' },

  // Phase 6: High Pressure & Launch Sequence (row 6 - critical path)
  [SystemState.GN2_HIGH_PRESS]: { x: 30, y: 345, width: 100, height: 45, group: 'sequence' },
  [SystemState.GN2_HIGH_VENT]: { x: 150, y: 345, width: 100, height: 45, group: 'sequence' },
  [SystemState.FIRE]: { x: 270, y: 345, width: 100, height: 45, group: 'sequence' },
  [SystemState.CALIBRATE]: { x: 390, y: 345, width: 100, height: 45, group: 'sequence' },

  // Phase 7: Emergency States (bottom row - always accessible)
  [SystemState.VENT]: { x: 30, y: 410, width: 100, height: 50, group: 'emergency' },
  [SystemState.ABORT]: { x: 150, y: 410, width: 100, height: 50, group: 'emergency' },
};

interface Transition {
  from: SystemState;
  to: SystemState;
}

interface StateNodeProps {
  state: SystemState;
  isActive: boolean;
  isReachable: boolean;
  onClick: () => void;
}

function StateNode({ state, isActive, isReachable, onClick }: StateNodeProps) {
  const layout = STATE_LAYOUT[state];
  const isEmergency = state === SystemState.ABORT || state === SystemState.VENT;
  const name = STATE_NAMES[state];

  // Color scheme: Active (blue), Reachable (green), Emergency (red), Normal (dark gray)
  const fillColor = isActive
    ? '#3B82F6'  // Bright blue for active
    : isReachable
    ? '#10B981'  // Green for reachable
    : isEmergency
    ? '#DC2626'  // Red for emergency
    : '#1F2937'; // Dark gray for normal

  const strokeColor = isActive
    ? '#60A5FA'  // Light blue border
    : isReachable
    ? '#34D399'  // Light green border
    : isEmergency
    ? '#EF4444'  // Light red border
    : '#374151'; // Gray border

  return (
    <g>
      {/* Main state rectangle */}
      <rect
        x={layout.x}
        y={layout.y}
        width={layout.width}
        height={layout.height}
        rx={8}
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={isActive ? 3 : isReachable ? 2.5 : isEmergency ? 2.5 : 2}
        className={(isReachable || isActive) ? "cursor-pointer transition-all hover:opacity-90" : "cursor-not-allowed opacity-50"}
        style={{
          transition: 'all 0.2s ease'
        }}
        onClick={(isReachable || isActive) ? onClick : undefined}
      />

      {/* State name text */}
      <text
        x={layout.x + layout.width / 2}
        y={layout.y + layout.height / 2 + 5}
        textAnchor="middle"
        fill="white"
        fontSize={isEmergency ? "13" : "12"}
        fontWeight={isActive || isEmergency || isReachable ? 'bold' : '600'}
        className="pointer-events-none select-none"
        style={{
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          letterSpacing: '0.02em'
        }}
      >
        {name}
      </text>
    </g>
  );
}

function TransitionArrow({
  from,
  to,
  currentState
}: {
  from: SystemState;
  to: SystemState;
  currentState: SystemState | null;
}) {
  const fromLayout = STATE_LAYOUT[from];
  const toLayout = STATE_LAYOUT[to];

  // Only show transitions FROM the current state
  if (currentState !== from) {
    return null;
  }

  // Calculate connection points
  const fromX = fromLayout.x + fromLayout.width / 2;
  const fromY = fromLayout.y + fromLayout.height;
  const toX = toLayout.x + toLayout.width / 2;
  const toY = toLayout.y;

  // Calculate direction and distance
  const dx = toX - fromX;
  const dy = toY - fromY;

  // Offset from node edges
  const offset = 25;
  const startX = fromX;
  const startY = fromY + offset;
  const endX = toX;
  const endY = toY - offset;

  // Create smooth curved path
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;
  const curvature = Math.abs(dx) > 100 ? 40 : Math.abs(dx) > 50 ? 25 : 15;

  const path = `M ${startX} ${startY} Q ${midX} ${midY - curvature} ${endX} ${endY}`;

  const isEmergency = to === SystemState.ABORT || to === SystemState.VENT;

  return (
    <path
      d={path}
      fill="none"
      stroke={isEmergency ? '#EF4444' : '#10B981'}
      strokeWidth={2.5}
      markerEnd="url(#arrowhead)"
      opacity={1}
      className="transition-all"
      style={{ transition: 'all 0.3s ease' }}
    />
  );
}

// Parse CSV transitions
function parseCSVTransitions(): Transition[] {
  // CSV format: row = from_state, columns = to_states (1 = allowed, 0 = not allowed)
  const csvData = [
    ['Idle', 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    ['Armed', 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ['Fuel Fill', 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ['Ox Fill', 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ['Quick Fire', 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ['GN2 Press', 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1],
    ['Fuel Press', 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1],
    ['Fuel Vent', 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 1, 1],
    ['Ox Press', 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 1, 1],
    ['Ox Vent', 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1],
    ['High Press', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    ['GN2 Vent', 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 1],
    ['Fire', 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1],
    ['Vent', 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1],
    ['Abort', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
  ];

  const stateNames = ['Idle', 'Armed', 'Fuel Fill', 'Ox Fill', 'Quick Fire', 'GN2 Press',
                      'Fuel Press', 'Fuel Vent', 'Ox Press', 'Ox Vent', 'High Press',
                      'GN2 Vent', 'Fire', 'Vent', 'Abort'];

  const stateMap: Record<string, SystemState> = {
    'Idle': SystemState.IDLE,
    'Armed': SystemState.ARMED,
    'Fuel Fill': SystemState.FUEL_FILL,
    'Ox Fill': SystemState.OX_FILL,
    'Quick Fire': SystemState.READY, // Map Quick Fire to READY
    'GN2 Press': SystemState.GN2_LOW_PRESS,
    'Fuel Press': SystemState.FUEL_PRESS,
    'Fuel Vent': SystemState.FUEL_VENT,
    'Ox Press': SystemState.OX_PRESS,
    'Ox Vent': SystemState.OX_VENT,
    'High Press': SystemState.GN2_HIGH_PRESS,
    'GN2 Vent': SystemState.GN2_VENT,
    'Fire': SystemState.FIRE,
    'Vent': SystemState.VENT,
    'Abort': SystemState.ABORT,
  };

  const transitions: Transition[] = [];

  csvData.forEach((row, rowIdx) => {
    const fromStateName = row[0] as string;
    const fromState = stateMap[fromStateName];
    if (!fromState && fromState !== 0) return;

    // Skip header row (index 0 is state name)
    for (let colIdx = 1; colIdx < row.length; colIdx++) {
      if (row[colIdx] === 1) {
        const toStateName = stateNames[colIdx - 1];
        const toState = stateMap[toStateName];
        if (toState !== undefined) {
          transitions.push({ from: fromState, to: toState });
        }
      }
    }
  });

  return transitions;
}

export default function StateMachineDiagram() {
  const currentState = useSensorStore((state) => state.currentState);
  const ws = getWebSocketClient();

  // Parse transitions from CSV
  const transitions = useMemo(() => parseCSVTransitions(), []);

  const sendStateTransition = (targetState: SystemState) => {
    const command: CommandPayload = {
      commandType: 'state_transition',
      data: { state: targetState },
    };
    ws.sendCommand(command);
  };

  const states = Object.values(SystemState).filter((s) => typeof s === 'number') as SystemState[];

  return (
    <div className="bg-card rounded-xl p-6 border border-gray-800 shadow-xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold bg-gradient-to-r from-blue-400 to-cyan-400 bg-clip-text text-transparent">
          State Machine Diagram
        </h2>
        <div className="text-xs text-text-muted font-mono">
          Rocket Launch Sequence
        </div>
      </div>

      <div className="bg-background rounded-lg p-6 overflow-auto border border-gray-800"
           style={{ minHeight: '500px' }}>
        <svg width="520" height="470" className="w-full h-auto" viewBox="0 0 520 470" style={{ fontFamily: 'system-ui' }}>
          {/* Arrow marker definition */}
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="10"
              refX="9"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 10 3, 0 6" fill="#10B981" />
            </marker>
          </defs>

          {/* Only show transitions FROM current state - no other transitions */}
          {currentState !== null && transitions
            .filter(t => t.from === currentState && t.from !== t.to)
            .map((transition, idx) => (
              <TransitionArrow
                key={`${transition.from}-${transition.to}-${idx}`}
                from={transition.from}
                to={transition.to}
                currentState={currentState}
              />
            ))}

          {/* Draw state nodes - highlight ONLY reachable states from current state */}
          {states.map((state) => {
            // Only highlight states that can be reached from current state
            const isReachable = currentState !== null &&
              transitions.some(t => t.from === currentState && t.to === state && t.from !== t.to);

            // Only allow clicking on reachable states or current state
            const canClick = currentState === null || currentState === state || isReachable;

            return (
              <StateNode
                key={state}
                state={state}
                isActive={currentState === state}
                isReachable={isReachable}
                onClick={canClick ? () => sendStateTransition(state) : () => {}}
              />
            );
          })}
        </svg>
      </div>

      {/* Legend */}
      <div className="mt-6 flex gap-6 text-sm flex-wrap items-center justify-between bg-gray-900/50 rounded-lg p-4 border border-gray-800">
        <div className="flex gap-6 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-blue-600 border-2 border-blue-400"></div>
            <span className="font-semibold text-gray-200">Current State</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-green-600 border-2 border-green-400"></div>
            <span className="font-semibold text-gray-200">Reachable State</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-red-600 border-2 border-red-400"></div>
            <span className="font-semibold text-gray-200">Emergency State</span>
          </div>
        </div>
        <div className="text-xs text-gray-400 font-mono">
          Click state to transition →
        </div>
      </div>
    </div>
  );
}
