'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, MessageType, CommandPayload, StateUpdate } from '@/lib/types';
import { useEffect, useState, useMemo } from 'react';

const STATE_NAMES: Record<SystemState, string> = {
  [SystemState.DEBUG]: 'DEBUG',
  [SystemState.IDLE]: 'IDLE',
  [SystemState.ARMED]: 'ARMED',
  [SystemState.FUEL_FILL]: 'FUEL FILL',
  [SystemState.OX_FILL]: 'OX FILL',
  [SystemState.GN2_LOW_PRESS]: 'GN2 PRESS',
  [SystemState.GN2_VENT]: 'GN2 VENT',
  [SystemState.FUEL_PRESS]: 'FUEL PRESS',
  [SystemState.FUEL_VENT]: 'FUEL VENT',
  [SystemState.OX_PRESS]: 'OX PRESS',
  [SystemState.OX_VENT]: 'OX VENT',
  [SystemState.GN2_HIGH_PRESS]: 'HIGH PRESS',
  [SystemState.GN2_HIGH_VENT]: 'GN2 HI VENT',
  [SystemState.VENT]: 'VENT',
  [SystemState.CALIBRATE]: 'CALIBRATE',
  [SystemState.READY]: 'READY',
  [SystemState.FIRE]: 'FIRE',
  [SystemState.ABORT]: 'ABORT',
};

const NW = 90; // node width
const NH = 36; // node height
const COLS = 4; // columns in grid
const COL_GAP = 110;
const ROW_GAP = 56;
const PAD = 16;

// Grid layout: [row, col] 0-based
const STATE_POS: Record<SystemState, [number, number]> = {
  [SystemState.IDLE]:          [0, 0],
  [SystemState.ARMED]:         [0, 1],
  [SystemState.DEBUG]:         [0, 2],
  [SystemState.CALIBRATE]:     [0, 3],
  [SystemState.FUEL_FILL]:     [1, 0],
  [SystemState.OX_FILL]:       [1, 1],
  [SystemState.READY]:         [1, 2],
  [SystemState.GN2_LOW_PRESS]: [2, 0],
  [SystemState.GN2_VENT]:      [2, 1],
  [SystemState.FUEL_PRESS]:    [3, 0],
  [SystemState.FUEL_VENT]:     [3, 1],
  [SystemState.OX_PRESS]:      [4, 0],
  [SystemState.OX_VENT]:       [4, 1],
  [SystemState.GN2_HIGH_PRESS]:[5, 0],
  [SystemState.GN2_HIGH_VENT]: [5, 1],
  [SystemState.FIRE]:          [5, 2],
  [SystemState.VENT]:          [6, 0],
  [SystemState.ABORT]:         [6, 1],
};

function nodeX(state: SystemState) { return PAD + STATE_POS[state][1] * COL_GAP; }
function nodeY(state: SystemState) { return PAD + STATE_POS[state][0] * ROW_GAP; }
function nodeCX(state: SystemState) { return nodeX(state) + NW / 2; }
function nodeCY(state: SystemState) { return nodeY(state) + NH / 2; }

interface Transition { from: SystemState; to: SystemState; }

function parseCSVTransitions(): Transition[] {
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
  const stateNames = ['Idle','Armed','Fuel Fill','Ox Fill','Quick Fire','GN2 Press',
                      'Fuel Press','Fuel Vent','Ox Press','Ox Vent','High Press',
                      'GN2 Vent','Fire','Vent','Abort'];
  const stateMap: Record<string, SystemState> = {
    'Idle': SystemState.IDLE, 'Armed': SystemState.ARMED,
    'Fuel Fill': SystemState.FUEL_FILL, 'Ox Fill': SystemState.OX_FILL,
    'Quick Fire': SystemState.READY, 'GN2 Press': SystemState.GN2_LOW_PRESS,
    'Fuel Press': SystemState.FUEL_PRESS, 'Fuel Vent': SystemState.FUEL_VENT,
    'Ox Press': SystemState.OX_PRESS, 'Ox Vent': SystemState.OX_VENT,
    'High Press': SystemState.GN2_HIGH_PRESS, 'GN2 Vent': SystemState.GN2_VENT,
    'Fire': SystemState.FIRE, 'Vent': SystemState.VENT, 'Abort': SystemState.ABORT,
  };
  const transitions: Transition[] = [];
  csvData.forEach((row) => {
    const from = stateMap[row[0] as string];
    if (from === undefined) return;
    for (let c = 1; c < row.length; c++) {
      if (row[c] === 1) {
        const to = stateMap[stateNames[c - 1]];
        if (to !== undefined) transitions.push({ from, to });
      }
    }
  });
  return transitions;
}

/**
 * Draw a clean orthogonal arrow between two nodes.
 * Exits the source node from the edge closest to the target and enters the
 * target from the opposite edge.  Falls back to a straight quadratic bezier
 * for short/same-column connections.
 */
function arrowPath(from: SystemState, to: SystemState): string {
  const fx = nodeX(from); const fy = nodeY(from);
  const tx = nodeX(to);   const ty = nodeY(to);
  const fcx = fx + NW / 2; const fcy = fy + NH / 2;
  const tcx = tx + NW / 2; const tcy = ty + NH / 2;

  const dx = tcx - fcx;
  const dy = tcy - fcy;

  // Source exit point & target entry point
  let sx: number, sy: number, ex: number, ey: number;

  if (Math.abs(dy) >= Math.abs(dx)) {
    // Primarily vertical
    if (dy > 0) {
      sx = fcx; sy = fy + NH;     // bottom of source
      ex = tcx; ey = ty;          // top of target
    } else {
      sx = fcx; sy = fy;          // top of source
      ex = tcx; ey = ty + NH;     // bottom of target
    }
  } else {
    // Primarily horizontal
    if (dx > 0) {
      sx = fx + NW; sy = fcy;
      ex = tx;      ey = tcy;
    } else {
      sx = fx;      sy = fcy;
      ex = tx + NW; ey = tcy;
    }
  }

  // Orthogonal elbow if there's both horizontal and vertical displacement
  if (Math.abs(dx) > 4 && Math.abs(dy) > 4) {
    const midY = (sy + ey) / 2;
    return `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`;
  }

  // Straight line with slight curve
  const cpx = (sx + ex) / 2;
  const cpy = (sy + ey) / 2 - Math.min(20, Math.abs(dx) * 0.3);
  return `M ${sx} ${sy} Q ${cpx} ${cpy} ${ex} ${ey}`;
}

function StateNode({
  state, isActive, isReachable, onClick,
}: { state: SystemState; isActive: boolean; isReachable: boolean; onClick: () => void; }) {
  const isEmergency = state === SystemState.ABORT || state === SystemState.VENT;
  // Emergency states are ALWAYS clickable — they must never be locked out
  const isClickable = isReachable || isActive || isEmergency;
  const name = STATE_NAMES[state];
  const x = nodeX(state); const y = nodeY(state);

  const fill = isActive    ? '#2563EB'
             : isReachable  ? '#059669'
             : isEmergency  ? '#7F1D1D'
             : '#1F2937';
  const stroke = isActive   ? '#60A5FA'
               : isReachable ? '#34D399'
               : isEmergency ? '#EF4444'
               : '#374151';
  const sw = isActive || isReachable || isEmergency ? 2 : 1.5;

  return (
    <g
      onClick={onClick}
      className={isClickable ? 'cursor-pointer' : 'cursor-not-allowed'}
      style={{ opacity: (!isActive && !isReachable && !isEmergency) ? 0.45 : 1 }}
    >
      <rect x={x} y={y} width={NW} height={NH} rx={5}
        fill={fill} stroke={stroke} strokeWidth={sw}
        style={{ transition: 'fill 0.15s, stroke 0.15s' }}
      />
      {/* Emergency pulse ring */}
      {isEmergency && (
        <rect x={x - 2} y={y - 2} width={NW + 4} height={NH + 4} rx={7}
          fill="none" stroke="#EF4444" strokeWidth={1} opacity={0.35}
        />
      )}
      <text
        x={x + NW / 2} y={y + NH / 2 + 1}
        textAnchor="middle" dominantBaseline="middle"
        fill={isEmergency ? '#FCA5A5' : 'white'}
        fontSize={10} fontWeight={isActive || isEmergency ? 700 : 500}
        fontFamily="ui-monospace, monospace" letterSpacing="0.04em"
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {name}
      </text>
    </g>
  );
}

export default function StateMachineDiagram() {
  const currentState = useSensorStore((s) => s.currentState);
  const updateState = useSensorStore((s) => s.updateState);
  const ws = getWebSocketClient();
  const transitions = useMemo(() => parseCSVTransitions(), []);

  const sendStateTransition = (targetState: SystemState) => {
    // Optimistic update — show new state immediately
    updateState({ currentState: targetState, stateName: SystemState[targetState] ?? '', timestamp: Date.now() });
    const command: CommandPayload = {
      commandType: 'state_transition',
      data: { state: targetState },
    };
    ws.sendCommand(command);
  };

  const states = Object.values(SystemState).filter((s) => typeof s === 'number') as SystemState[];

  // SVG dimensions
  const svgW = PAD * 2 + COLS * COL_GAP;
  const svgH = PAD * 2 + 7 * ROW_GAP;

  // Default to IDLE when no state has been received yet
  const effectiveState = currentState ?? SystemState.IDLE;

  const reachableStates = useMemo(() => {
    return new Set(transitions.filter(t => t.from === effectiveState && t.from !== t.to).map(t => t.to));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveState, transitions]);

  return (
    <div className="bg-card rounded-xl border border-gray-800 overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-800 flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase">State Machine</h2>
        <span className="text-xs font-mono">
          <span className="text-text-muted">CURRENT: </span>
          <span className="text-blue-400 font-bold">{STATE_NAMES[effectiveState]}</span>
          <span className="text-text-muted ml-2">— click to transition</span>
        </span>
      </div>

      <div className="p-4 overflow-auto bg-background">
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ display: 'block', overflow: 'visible' }}>
          <defs>
            <marker id="arr-green" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" fill="#34D399" />
            </marker>
            <marker id="arr-red" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
              <path d="M0,0 L8,3 L0,6 Z" fill="#EF4444" />
            </marker>
          </defs>

          {/* Transition arrows from effective state */}
          {transitions
            .filter(t => t.from === effectiveState && t.from !== t.to)
            .map((t, i) => {
              const isEmergency = t.to === SystemState.ABORT || t.to === SystemState.VENT;
              return (
                <path
                  key={i}
                  d={arrowPath(t.from, t.to)}
                  fill="none"
                  stroke={isEmergency ? '#EF4444' : '#34D399'}
                  strokeWidth={isEmergency ? 2 : 1.5}
                  strokeDasharray={isEmergency ? '5 3' : undefined}
                  markerEnd={isEmergency ? 'url(#arr-red)' : 'url(#arr-green)'}
                  style={{ transition: 'all 0.2s' }}
                />
              );
            })}

          {/* State nodes */}
          {states.map((state) => (
            <StateNode
              key={state}
              state={state}
              isActive={effectiveState === state}
              isReachable={reachableStates.has(state)}
              onClick={() => sendStateTransition(state)}
            />
          ))}
        </svg>
      </div>

      {/* Legend */}
      <div className="px-5 py-3 border-t border-gray-800 flex flex-wrap gap-4 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded-sm inline-block" style={{ background: '#2563EB', border: '1.5px solid #60A5FA' }} />
          <span className="text-text-muted">Current</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded-sm inline-block" style={{ background: '#059669', border: '1.5px solid #34D399' }} />
          <span className="text-text-muted">Reachable (click)</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-4 h-3 rounded-sm inline-block" style={{ background: '#7F1D1D', border: '1.5px solid #EF4444' }} />
          <span className="text-text-muted">Emergency (always active)</span>
        </span>
      </div>
    </div>
  );
}

