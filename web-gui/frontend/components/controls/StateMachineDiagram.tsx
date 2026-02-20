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
  [SystemState.GN2_HIGH_PRESS]: 'GN2 HIGH PRESS',
  [SystemState.GN2_HIGH_VENT]: 'GN2 HI VENT',
  [SystemState.VENT]: 'VENT',
  [SystemState.CALIBRATE]: 'CALIBRATE',
  [SystemState.READY]: 'READY',
  [SystemState.FIRE]: 'FIRE',
  [SystemState.ENGINE_ABORT]: 'ENGINE ABORT',
  [SystemState.GSE_ABORT]: 'GSE ABORT',
  [SystemState.EMERGENCY_ABORT]: 'EMERGENCY ABORT',
  // Note: ABORT is an alias for EMERGENCY_ABORT (same enum value), so we don't need to add it separately
};

const NW = 220; // node width - much bigger
const NH = 88; // node height - much bigger
const COLS = 4; // columns in grid
const COL_GAP = 280; // much wider spacing
const ROW_GAP = 140; // much taller spacing
const PAD = 40; // more padding

// Grid layout: [row, col] 0-based - includes ALL states
const STATE_POS: Partial<Record<SystemState, [number, number]>> = {
  [SystemState.DEBUG]:         [0, 0],
  [SystemState.IDLE]:          [0, 1],
  [SystemState.ARMED]:         [0, 2],
  [SystemState.CALIBRATE]:     [0, 3],
  [SystemState.FUEL_FILL]:     [1, 0],
  [SystemState.OX_FILL]:       [1, 1],
  [SystemState.READY]:         [1, 2],
  [SystemState.GN2_LOW_PRESS]: [2, 0],
  [SystemState.GN2_VENT]:      [2, 1],
  [SystemState.FUEL_PRESS]:    [2, 2],
  [SystemState.FUEL_VENT]:     [2, 3],
  [SystemState.OX_PRESS]:      [3, 0],
  [SystemState.OX_VENT]:       [3, 1],
  [SystemState.GN2_HIGH_PRESS]:[3, 2],
  [SystemState.GN2_HIGH_VENT]: [3, 3],
  [SystemState.FIRE]:          [4, 1],
  [SystemState.VENT]:          [4, 0],
  [SystemState.ENGINE_ABORT]:   [4, 2],
  [SystemState.GSE_ABORT]:     [4, 3],
  [SystemState.EMERGENCY_ABORT]: [5, 1],
  // Note: ABORT is an alias for EMERGENCY_ABORT (same enum value), so we don't need to add it separately
};

function nodeX(state: SystemState) { return PAD + STATE_POS[state][1] * COL_GAP; }
function nodeY(state: SystemState) { return PAD + STATE_POS[state][0] * ROW_GAP; }
function nodeCX(state: SystemState) { return nodeX(state) + NW / 2; }
function nodeCY(state: SystemState) { return nodeY(state) + NH / 2; }

interface Transition { from: SystemState; to: SystemState; }

/**
 * Draw a clean orthogonal arrow between two nodes.
 */
function arrowPath(from: SystemState, to: SystemState): string {
  const fx = nodeX(from); const fy = nodeY(from);
  const tx = nodeX(to);   const ty = nodeY(to);
  const fcx = fx + NW / 2; const fcy = fy + NH / 2;
  const tcx = tx + NW / 2; const tcy = ty + NH / 2;

  const dx = tcx - fcx;
  const dy = tcy - fcy;

  let sx: number, sy: number, ex: number, ey: number;

  if (Math.abs(dy) >= Math.abs(dx)) {
    if (dy > 0) {
      sx = fcx; sy = fy + NH;
      ex = tcx; ey = ty;
    } else {
      sx = fcx; sy = fy;
      ex = tcx; ey = ty + NH;
    }
  } else {
    if (dx > 0) {
      sx = fx + NW; sy = fcy;
      ex = tx;      ey = tcy;
    } else {
      sx = fx;      sy = fcy;
      ex = tx + NW; ey = tcy;
    }
  }

  if (Math.abs(dx) > 4 && Math.abs(dy) > 4) {
    const midY = (sy + ey) / 2;
    return `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`;
  }

  const cpx = (sx + ex) / 2;
  const cpy = (sy + ey) / 2 - Math.min(20, Math.abs(dx) * 0.3);
  return `M ${sx} ${sy} Q ${cpx} ${cpy} ${ex} ${ey}`;
}

function StateNode({
  state, isActive, isReachable, onClick,
}: { state: SystemState; isActive: boolean; isReachable: boolean; onClick: () => void; }) {
    const isEmergency = state === SystemState.ENGINE_ABORT || state === SystemState.GSE_ABORT || state === SystemState.EMERGENCY_ABORT || state === SystemState.ABORT || state === SystemState.VENT;
  const isClickable = isReachable || isActive || isEmergency;
  const name = STATE_NAMES[state] ?? 'UNKNOWN';
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
      <rect x={x} y={y} width={NW} height={NH} rx={12}
        fill={fill} stroke={stroke} strokeWidth={sw}
        style={{ transition: 'fill 0.15s, stroke 0.15s' }}
      />
      {isEmergency && (
        <rect x={x - 4} y={y - 4} width={NW + 8} height={NH + 8} rx={14}
          fill="none" stroke="#EF4444" strokeWidth={3} opacity={0.35}
        />
      )}
      <text
        x={x + NW / 2} y={y + NH / 2 + 2}
        textAnchor="middle" dominantBaseline="middle"
        fill={isEmergency ? '#FCA5A5' : 'white'}
        fontSize={18} fontWeight={isActive || isEmergency ? 700 : 500}
        fontFamily="ui-monospace, monospace" letterSpacing="0.05em"
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
  const [transitions, setTransitions] = useState<Transition[]>([]);

  // Fetch transitions from backend on mount
  useEffect(() => {
    ws.connect();
    const handleTransitions = (payload: unknown) => {
      const data = payload as { transitions: Transition[] };
      if (data && data.transitions && Array.isArray(data.transitions)) {
        setTransitions(data.transitions);
        console.log(`📋 Loaded ${data.transitions.length} state transitions from backend`);
      } else {
        console.warn('⚠️ Invalid transitions payload:', payload);
      }
    };

    // Listen for state_transitions message (custom message type, not in MessageType enum)
    const unsub = ws.on('state_transitions', handleTransitions);
    
    // Request transitions via WebSocket after connection is ready
    const requestTransitions = () => {
      // Send as raw message (server handles 'get_state_transitions' message type)
      (ws as any).send({
        type: 'get_state_transitions',
        timestamp: Date.now(),
        payload: {},
      });
      console.log('📤 Requested state transitions from backend via WebSocket');
    };
    
    // Request immediately if connected, otherwise wait a bit
    const timeoutId = setTimeout(() => {
      if (ws.isConnected()) {
        requestTransitions();
      } else {
        // Wait for connection
        const checkConnection = setInterval(() => {
          if (ws.isConnected()) {
            clearInterval(checkConnection);
            requestTransitions();
          }
        }, 100);
        // Cleanup after 5 seconds
        setTimeout(() => clearInterval(checkConnection), 5000);
      }
    }, 200);

    return () => {
      clearTimeout(timeoutId);
      unsub();
    };
  }, [ws]);

  const debugMode = useSensorStore((s) => s.debugMode);
  
  const sendStateTransition = (targetState: SystemState) => {
    const effectiveState = currentState ?? SystemState.IDLE;
    
    // Validate transition - check if it's allowed
    const isAllowed = transitions.some(t => t.from === effectiveState && t.to === targetState);
    const isEmergency = targetState === SystemState.ENGINE_ABORT || targetState === SystemState.GSE_ABORT || targetState === SystemState.EMERGENCY_ABORT || targetState === SystemState.ABORT || targetState === SystemState.VENT;
    const isDebug = targetState === SystemState.DEBUG;
    const isInDebugMode = debugMode || effectiveState === SystemState.DEBUG;
    
    // Allow DEBUG state from any state, allow emergency states always, allow any transition in DEBUG mode, or if transition is explicitly allowed
    if (!isAllowed && !isEmergency && !isDebug && !isInDebugMode && effectiveState !== targetState) {
      console.warn(`⚠️ Invalid transition: ${STATE_NAMES[effectiveState]} → ${STATE_NAMES[targetState]}`);
      alert(`Invalid transition: Cannot go from ${STATE_NAMES[effectiveState]} to ${STATE_NAMES[targetState]}`);
      return;
    }

    // Don't do optimistic update - let backend broadcast state update to all clients
    // This ensures all panes/windows stay in sync
    const command: CommandPayload = {
      commandType: 'state_transition',
      data: { state: targetState },
    };
    ws.sendCommand(command);
  };

  const states = Object.values(SystemState).filter((s) => typeof s === 'number') as SystemState[];

  // SVG dimensions - ensure enough space for all states (6 rows: 0-5)
  const svgW = PAD * 2 + COLS * COL_GAP;
  const svgH = PAD * 2 + 6 * ROW_GAP; // 6 rows for all states (0-5)

  // Default to IDLE when no state has been received yet
  const effectiveState = currentState ?? SystemState.IDLE;
  
  const reachableStates = useMemo(() => {
    const fromTransitions = new Set(transitions.filter(t => t.from === effectiveState && t.from !== t.to).map(t => t.to));
    // Always allow DEBUG state from any state
    fromTransitions.add(SystemState.DEBUG);
    // Always allow emergency states
    fromTransitions.add(SystemState.ABORT);
    fromTransitions.add(SystemState.VENT);
    // In DEBUG mode, allow transitions to any state
    if (debugMode || effectiveState === SystemState.DEBUG) {
      Object.values(SystemState).filter((s) => typeof s === 'number').forEach((s) => {
        fromTransitions.add(s as SystemState);
      });
    }
    return fromTransitions;
  }, [effectiveState, transitions, debugMode]);

  return (
    <div className="bg-card rounded-xl border border-gray-800 overflow-hidden flex flex-col h-full min-h-0">
      <div className="px-6 py-5 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
        <h2 className="text-lg font-bold tracking-widest text-text-muted uppercase">State Machine</h2>
        <span className="text-sm font-mono">
          <span className="text-text-muted">CURRENT: </span>
          <span className="text-blue-400 font-bold">{STATE_NAMES[effectiveState]}</span>
          <span className="text-text-muted ml-2">— click to transition</span>
        </span>
      </div>

      <div className="p-4 overflow-auto bg-background min-h-0 flex-1">
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}
          style={{ display: 'block', overflow: 'visible', width: '100%', height: 'auto', maxHeight: '100%' }}
          preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="arr-green" markerWidth="16" markerHeight="16" refX="13" refY="5" orient="auto">
              <path d="M0,0 L16,5 L0,10 Z" fill="#34D399" />
            </marker>
            <marker id="arr-red" markerWidth="16" markerHeight="16" refX="13" refY="5" orient="auto">
              <path d="M0,0 L16,5 L0,10 Z" fill="#EF4444" />
            </marker>
          </defs>

          {/* Transition arrows from effective state */}
          {transitions
            .filter(t => t.from === effectiveState && t.from !== t.to)
            .map((t, i) => {
              const isEmergency = t.to === SystemState.ENGINE_ABORT || t.to === SystemState.GSE_ABORT || t.to === SystemState.EMERGENCY_ABORT || t.to === SystemState.ABORT || t.to === SystemState.VENT;
              return (
                <path
                  key={`${t.from}-${t.to}-${i}`}
                  d={arrowPath(t.from, t.to)}
                  fill="none"
                  stroke={isEmergency ? '#EF4444' : '#34D399'}
                  strokeWidth={isEmergency ? 4 : 3.5}
                  strokeDasharray={isEmergency ? '8 5' : undefined}
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
      <div className="px-6 py-4 border-t border-gray-800 flex flex-wrap gap-5 text-sm flex-shrink-0">
        <span className="flex items-center gap-2">
          <span className="w-5 h-4 rounded-sm inline-block" style={{ background: '#2563EB', border: '2px solid #60A5FA' }} />
          <span className="text-text-muted font-semibold">Current</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="w-5 h-4 rounded-sm inline-block" style={{ background: '#059669', border: '2px solid #34D399' }} />
          <span className="text-text-muted font-semibold">Reachable (click)</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="w-5 h-4 rounded-sm inline-block" style={{ background: '#7F1D1D', border: '2px solid #EF4444' }} />
          <span className="text-text-muted font-semibold">Emergency (always active)</span>
        </span>
      </div>
    </div>
  );
}
