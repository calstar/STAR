'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, CommandPayload } from '@/lib/types';
import { useEffect, useState, useMemo } from 'react';
import { useControlMode } from '@/lib/control-mode';

const STATE_NAMES: Record<SystemState, string> = {
  [SystemState.DEBUG]: 'DEBUG',
  [SystemState.IDLE]: 'IDLE',
  [SystemState.ARMED]: 'ARMED',
  [SystemState.FUEL_FILL]: 'FUEL FILL',
  [SystemState.OX_FILL]: 'OX FILL',
  [SystemState.GN2_LOW_PRESS]: 'GN2 LOW PRESS',
  [SystemState.GN2_VENT]: 'GN2 LOW VENT',
  [SystemState.FUEL_PRESS]: 'FUEL PRESS',
  [SystemState.FUEL_VENT]: 'FUEL VENT',
  [SystemState.OX_PRESS]: 'OX PRESS',
  [SystemState.OX_VENT]: 'OX VENT',
  [SystemState.GN2_HIGH_PRESS]: 'GN2 HIGH PRESS',
  [SystemState.GN2_HIGH_VENT]: 'GN2 HIGH VENT',
  [SystemState.VENT]: 'VENT',
  [SystemState.CALIBRATE]: 'CALIBRATE',
  [SystemState.READY]: 'READY',
  [SystemState.FIRE]: 'FIRE',
  [SystemState.ENGINE_ABORT]: 'ENGINE ABORT',
  [SystemState.GSE_ABORT]: 'GSE ABORT',
  [SystemState.EMERGENCY_ABORT]: 'EMERGENCY ABORT',
  [SystemState.PRESS_STANDBY]: 'PRESS STANDBY',
};

// States to exclude from diagram rendering
const EXCLUDED_STATES = new Set([
  SystemState.DEBUG,
  SystemState.ENGINE_ABORT,
  SystemState.GSE_ABORT,
  SystemState.EMERGENCY_ABORT,
]);

const NW = 320; // node width
const NH = 115; // node height
const COLS = 5; // Updated to accommodate 5 columns in row 2 and 3
const COL_GAP = 360;
const ROW_GAP = 155;
const PAD = 24;
const ROW_COUNT = 6; // rows 0–5

// Grid layout: [row, col] 0-based
// IMPORTANT: All states from SystemState enum must be included here to appear in the diagram
// States without positions will default to [0, 0] and may overlap
// DEBUG, ENGINE_ABORT, GSE_ABORT, EMERGENCY_ABORT are excluded from rendering
const STATE_POS: Partial<Record<SystemState, [number, number]>> = {
  // Row 0: IDLE
  [SystemState.IDLE]: [0, 0],
  // Row 1: Armed, Fuel Fill, Ox Fill
  [SystemState.ARMED]: [1, 0],
  [SystemState.FUEL_FILL]: [1, 1],
  [SystemState.OX_FILL]: [1, 2],
  // Row 2: Press Standby, GN2 Low Press, Fuel Press, OX Press, GN2 High Press
  [SystemState.PRESS_STANDBY]: [2, 0],
  [SystemState.GN2_LOW_PRESS]: [2, 1],
  [SystemState.FUEL_PRESS]: [2, 2],
  [SystemState.OX_PRESS]: [2, 3],
  [SystemState.GN2_HIGH_PRESS]: [2, 4],
  // Row 3: Vent, GN2 Low Vent, Fuel Vent, Ox Vent, GN2 High Vent
  [SystemState.VENT]: [3, 0],
  [SystemState.GN2_VENT]: [3, 1],
  [SystemState.FUEL_VENT]: [3, 2],
  [SystemState.OX_VENT]: [3, 3],
  [SystemState.GN2_HIGH_VENT]: [3, 4],
  // Row 4: Calibrate, Ready
  [SystemState.CALIBRATE]: [4, 0],
  [SystemState.READY]: [4, 1],
  // Row 5: Fire
  [SystemState.FIRE]: [5, 0],
};

/**
 * Hardcoded state transitions derived from PressureStateMachine.cpp.
 * Used as the permanent fallback so arrows are always visible even when
 * the backend hasn't loaded the CSV yet.
 */
interface Transition { from: SystemState; to: SystemState; }

const STATIC_TRANSITIONS: Transition[] = [
  // Main forward sequence
  { from: SystemState.IDLE, to: SystemState.ARMED },
  { from: SystemState.ARMED, to: SystemState.IDLE },
  { from: SystemState.ARMED, to: SystemState.FUEL_FILL },
  { from: SystemState.ARMED, to: SystemState.PRESS_STANDBY },
  { from: SystemState.FUEL_FILL, to: SystemState.ARMED },
  { from: SystemState.FUEL_FILL, to: SystemState.OX_FILL },
  { from: SystemState.OX_FILL, to: SystemState.ARMED },
  { from: SystemState.OX_FILL, to: SystemState.PRESS_STANDBY },
  // Press Standby can go to all press/vent states
  { from: SystemState.PRESS_STANDBY, to: SystemState.GN2_LOW_PRESS },
  { from: SystemState.PRESS_STANDBY, to: SystemState.GN2_VENT },
  { from: SystemState.PRESS_STANDBY, to: SystemState.FUEL_PRESS },
  { from: SystemState.PRESS_STANDBY, to: SystemState.FUEL_VENT },
  { from: SystemState.PRESS_STANDBY, to: SystemState.OX_PRESS },
  { from: SystemState.PRESS_STANDBY, to: SystemState.OX_VENT },
  { from: SystemState.PRESS_STANDBY, to: SystemState.GN2_HIGH_PRESS },
  { from: SystemState.PRESS_STANDBY, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.PRESS_STANDBY, to: SystemState.FIRE },
  { from: SystemState.PRESS_STANDBY, to: SystemState.VENT },
  // GN2 low-pressure regulation loop
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.PRESS_STANDBY },
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.GN2_VENT },
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.FUEL_PRESS },
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.OX_PRESS },
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.GN2_LOW_PRESS, to: SystemState.FIRE },
  { from: SystemState.GN2_VENT, to: SystemState.PRESS_STANDBY },
  { from: SystemState.GN2_VENT, to: SystemState.GN2_LOW_PRESS },
  { from: SystemState.GN2_VENT, to: SystemState.FUEL_VENT },
  { from: SystemState.GN2_VENT, to: SystemState.OX_VENT },
  { from: SystemState.GN2_VENT, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.GN2_VENT, to: SystemState.FIRE },
  // Fuel pressurisation loop
  { from: SystemState.FUEL_PRESS, to: SystemState.PRESS_STANDBY },
  { from: SystemState.FUEL_PRESS, to: SystemState.GN2_VENT },
  { from: SystemState.FUEL_PRESS, to: SystemState.FUEL_VENT },
  { from: SystemState.FUEL_PRESS, to: SystemState.OX_PRESS },
  { from: SystemState.FUEL_PRESS, to: SystemState.OX_VENT },
  { from: SystemState.FUEL_PRESS, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.FUEL_PRESS, to: SystemState.FIRE },
  { from: SystemState.FUEL_VENT, to: SystemState.PRESS_STANDBY },
  { from: SystemState.FUEL_VENT, to: SystemState.GN2_VENT },
  { from: SystemState.FUEL_VENT, to: SystemState.FUEL_PRESS },
  { from: SystemState.FUEL_VENT, to: SystemState.OX_VENT },
  { from: SystemState.FUEL_VENT, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.FUEL_VENT, to: SystemState.FIRE },
  // Ox pressurisation loop
  { from: SystemState.OX_PRESS, to: SystemState.PRESS_STANDBY },
  { from: SystemState.OX_PRESS, to: SystemState.GN2_VENT },
  { from: SystemState.OX_PRESS, to: SystemState.FUEL_VENT },
  { from: SystemState.OX_PRESS, to: SystemState.OX_VENT },
  { from: SystemState.OX_PRESS, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.OX_PRESS, to: SystemState.FIRE },
  { from: SystemState.OX_VENT, to: SystemState.PRESS_STANDBY },
  { from: SystemState.OX_VENT, to: SystemState.GN2_VENT },
  { from: SystemState.OX_VENT, to: SystemState.FUEL_VENT },
  { from: SystemState.OX_VENT, to: SystemState.OX_PRESS },
  { from: SystemState.OX_VENT, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.OX_VENT, to: SystemState.FIRE },
  // GN2 high-pressure regulation loop
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.PRESS_STANDBY },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.GN2_VENT },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.FUEL_VENT },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.OX_VENT },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.GN2_HIGH_VENT },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.CALIBRATE },
  { from: SystemState.GN2_HIGH_PRESS, to: SystemState.VENT },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.PRESS_STANDBY },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.GN2_VENT },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.FUEL_VENT },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.OX_VENT },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.GN2_HIGH_PRESS },
  { from: SystemState.GN2_HIGH_VENT, to: SystemState.VENT },
  // Calibrate and Ready
  { from: SystemState.CALIBRATE, to: SystemState.PRESS_STANDBY },
  { from: SystemState.CALIBRATE, to: SystemState.READY },
  { from: SystemState.CALIBRATE, to: SystemState.VENT },
  { from: SystemState.READY, to: SystemState.FIRE },
  { from: SystemState.READY, to: SystemState.VENT },
  // Fire and Vent
  { from: SystemState.FIRE, to: SystemState.IDLE },
  { from: SystemState.FIRE, to: SystemState.ARMED },
  { from: SystemState.FIRE, to: SystemState.VENT },
  { from: SystemState.VENT, to: SystemState.IDLE },
];

// States reachable from *any* state (emergencies + vent)
// Note: DEBUG, ENGINE_ABORT, GSE_ABORT, EMERGENCY_ABORT are handled via top bar buttons, not diagram
const ALWAYS_REACHABLE: SystemState[] = [];

function nodeX(state: SystemState) { return PAD + (STATE_POS[state]?.[1] ?? 0) * COL_GAP; }
function nodeY(state: SystemState) { return PAD + (STATE_POS[state]?.[0] ?? 0) * ROW_GAP; }

/**
 * Draw an orthogonal elbow arrow between two nodes.
 * `sideOffset` (in pixels) shifts the exit/entry point perpendicular to the
 * dominant axis, separating bidirectional arrow pairs so they don't overlap.
 */
function arrowPath(from: SystemState, to: SystemState, sideOffset = 0): string {
  const fx = nodeX(from); const fy = nodeY(from);
  const tx = nodeX(to); const ty = nodeY(to);
  const fcx = fx + NW / 2; const fcy = fy + NH / 2;
  const tcx = tx + NW / 2; const tcy = ty + NH / 2;

  const dx = tcx - fcx;
  const dy = tcy - fcy;

  let sx: number, sy: number, ex: number, ey: number;

  if (Math.abs(dy) >= Math.abs(dx)) {
    // Predominantly vertical — exit/enter through top/bottom; offset horizontally
    const ox = sideOffset;
    if (dy > 0) {
      sx = fcx + ox; sy = fy + NH;
      ex = tcx + ox; ey = ty;
    } else {
      sx = fcx + ox; sy = fy;
      ex = tcx + ox; ey = ty + NH;
    }
  } else {
    // Predominantly horizontal — exit/enter through left/right; offset vertically
    const oy = sideOffset;
    if (dx > 0) {
      sx = fx + NW; sy = fcy + oy;
      ex = tx; ey = tcy + oy;
    } else {
      sx = fx; sy = fcy + oy;
      ex = tx + NW; ey = tcy + oy;
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
  const isEmergency = false;
  const isClickable = isReachable || isActive || isEmergency;
  const name = STATE_NAMES[state] ?? 'UNKNOWN';
  const x = nodeX(state); const y = nodeY(state);

  const fill = isActive ? '#2563EB' : isReachable ? '#059669' : isEmergency ? '#7F1D1D' : '#1F2937';
  const stroke = isActive ? '#60A5FA' : isReachable ? '#34D399' : isEmergency ? '#EF4444' : '#374151';
  const sw = (isActive || isReachable || isEmergency) ? 2 : 1.5;

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
        fontSize={32} fontWeight={(isActive || isEmergency) ? 700 : 600}
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
  const [backendTransitions, setBackendTransitions] = useState<Transition[]>([]);
  const { controlEnabled } = useControlMode();

  // Request transitions from backend on mount; fall back to STATIC_TRANSITIONS if unavailable
  useEffect(() => {
    ws.connect();

    const handleTransitions = (payload: unknown) => {
      const data = payload as { transitions: Transition[] };
      if (data?.transitions && Array.isArray(data.transitions) && data.transitions.length > 0) {
        setBackendTransitions(data.transitions);
        console.log(`📋 Loaded ${data.transitions.length} state transitions from backend`);
      }
    };

    const unsub = ws.on('state_transitions', handleTransitions);

    const requestTransitions = () => {
      (ws as any).send({ type: 'get_state_transitions', timestamp: Date.now(), payload: {} });
    };

    const timeoutId = setTimeout(() => {
      if (ws.isConnected()) {
        requestTransitions();
      } else {
        const checkConnection = setInterval(() => {
          if (ws.isConnected()) {
            clearInterval(checkConnection);
            requestTransitions();
          }
        }, 100);
        setTimeout(() => clearInterval(checkConnection), 5000);
      }
    }, 200);

    return () => { clearTimeout(timeoutId); unsub(); };
  }, [ws]);

  const debugMode = useSensorStore((s) => s.debugMode);

  // Use backend transitions when available, otherwise fall back to hardcoded static transitions
  const transitions = backendTransitions.length > 0 ? backendTransitions : STATIC_TRANSITIONS;

  const sendStateTransition = (targetState: SystemState) => {
    if (!controlEnabled) return;
    const effectiveState = currentState ?? SystemState.IDLE;
    const isAllowed = transitions.some(t => t.from === effectiveState && t.to === targetState);
    const isEmergency = ALWAYS_REACHABLE.includes(targetState);
    const isInDebugMode = debugMode;

    // In debug mode, allow any transition
    if (!isAllowed && !isEmergency && !isInDebugMode && effectiveState !== targetState) {
      console.warn(`⚠️ Invalid transition: ${STATE_NAMES[effectiveState]} → ${STATE_NAMES[targetState]}`);
      alert(`Invalid transition: Cannot go from ${STATE_NAMES[effectiveState]} to ${STATE_NAMES[targetState]}`);
      return;
    }

    updateState({ currentState: targetState, stateName: STATE_NAMES[targetState], timestamp: Date.now() });

    const command: CommandPayload = {
      commandType: 'state_transition',
      data: { state: targetState },
    };
    ws.sendCommand(command);
  };

  const effectiveState = currentState ?? SystemState.IDLE;

  const reachableStates = useMemo(() => {
    const set = new Set(
      transitions
        .filter(t => t.from === effectiveState && t.from !== t.to)
        .map(t => t.to),
    );
    // Emergency states are always reachable
    ALWAYS_REACHABLE.forEach(s => set.add(s));
    // In debug mode, all non-excluded states are reachable
    if (debugMode) {
      Object.values(SystemState)
        .filter((s) => typeof s === 'number' && !EXCLUDED_STATES.has(s as SystemState))
        .forEach((s) => set.add(s as SystemState));
    }
    return set;
  }, [effectiveState, transitions, debugMode]);

  // Build a set of pairs that have arrows in BOTH directions so we can offset them
  const forwardTransitions = transitions.filter(
    t => t.from === effectiveState && t.from !== t.to,
  );
  const reverseSet = new Set(
    forwardTransitions
      .filter(t => transitions.some(r => r.from === t.to && r.to === t.from))
      .map(t => t.to),
  );

  // Emergency arrows from current state (always draw these separately)
  const emergencyTargets = ALWAYS_REACHABLE.filter(
    s => s !== effectiveState && STATE_POS[s] !== undefined,
  );

  // Filter out excluded states from rendering
  const states = Object.values(SystemState).filter(
    (s) => typeof s === 'number' && !EXCLUDED_STATES.has(s as SystemState)
  ) as SystemState[];

  const svgW = PAD * 2 + COLS * COL_GAP;
  const svgH = PAD * 2 + ROW_COUNT * ROW_GAP; // rows 0-5 (IDLE, Armed/Fill, Press, Vent, Calibrate/Ready, Fire)

  // Offset (px) used to separate bidirectional arrow pairs
  const BIDIR_OFFSET = 14;

  return (
    <div className="overflow-hidden flex flex-col h-full min-h-0">
      <div className="px-3 py-1.5 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
        <h2 className="text-[10px] font-bold tracking-widest text-text-muted uppercase">State Machine</h2>
        <span className="text-[10px] font-mono">
          <span className="text-text-muted">CURRENT: </span>
          <span className="text-blue-400 font-bold">{STATE_NAMES[effectiveState]}</span>
        </span>
      </div>

      <div className="overflow-hidden bg-background min-h-0 flex-1 p-1 flex flex-col">
        <svg viewBox={`0 0 ${svgW} ${svgH}`}
          className="min-h-0 flex-1"
          style={{ display: 'block', width: '100%', height: '100%' }}
          preserveAspectRatio="xMidYMin meet">
          <defs>
            <marker id="arr-green" markerWidth="14" markerHeight="14" refX="12" refY="5" orient="auto">
              <path d="M0,0 L14,5 L0,10 Z" fill="#34D399" />
            </marker>
            <marker id="arr-red" markerWidth="14" markerHeight="14" refX="12" refY="5" orient="auto">
              <path d="M0,0 L14,5 L0,10 Z" fill="#EF4444" />
            </marker>
            <marker id="arr-blue" markerWidth="14" markerHeight="14" refX="12" refY="5" orient="auto">
              <path d="M0,0 L14,5 L0,10 Z" fill="#60A5FA" />
            </marker>
          </defs>

          {/* Row lanes to break up deadspace and group states */}
          {Array.from({ length: ROW_COUNT }).map((_, rowIdx) => {
            const laneY = PAD + rowIdx * ROW_GAP - 18;
            const laneHeight = NH + 36;
            return (
              <rect
                key={`lane-${rowIdx}`}
                x={PAD - 16}
                y={laneY}
                width={svgW - 2 * (PAD - 16)}
                height={laneHeight}
                fill={rowIdx % 2 === 0 ? '#020617' : '#020617'}
                opacity={rowIdx % 2 === 0 ? 0.35 : 0.2}
              />
            );
          })}

          {/* Normal transition arrows from the current state - only show to reachable states that exist in diagram */}
          {forwardTransitions
            .filter(t => !ALWAYS_REACHABLE.includes(t.to) && reachableStates.has(t.to) && STATE_POS[t.to] !== undefined)
            .map((t, i) => {
              const isBidir = reverseSet.has(t.to);
              // Offset the "forward" arrow to one side so its return pair is visible
              const offset = isBidir ? -BIDIR_OFFSET : 0;
              return (
                <path
                  key={`fwd-${t.from}-${t.to}-${i}`}
                  d={arrowPath(t.from, t.to, offset)}
                  fill="none"
                  stroke="#34D399"
                  strokeWidth={3}
                  markerEnd="url(#arr-green)"
                  style={{ transition: 'all 0.2s' }}
                />
              );
            })}

          {/* Return arrows (states that can come BACK to current state) - only show if the source state exists in diagram */}
          {transitions
            .filter(t => t.to === effectiveState && t.from !== effectiveState && !ALWAYS_REACHABLE.includes(t.from) && STATE_POS[t.from] !== undefined)
            .map((t, i) => (
              <path
                key={`ret-${t.from}-${t.to}-${i}`}
                d={arrowPath(t.from, t.to, BIDIR_OFFSET)}
                fill="none"
                stroke="#60A5FA"
                strokeWidth={2}
                strokeDasharray="6 4"
                markerEnd="url(#arr-blue)"
                style={{ transition: 'all 0.2s' }}
              />
            ))}

          {/* Emergency arrows from current state */}
          {emergencyTargets.map((target, i) => (
            <path
              key={`emg-${effectiveState}-${target}-${i}`}
              d={arrowPath(effectiveState, target)}
              fill="none"
              stroke="#EF4444"
              strokeWidth={3}
              strokeDasharray="8 5"
              markerEnd="url(#arr-red)"
              style={{ transition: 'all 0.2s' }}
            />
          ))}

          {/* State nodes — rendered last so they sit on top of arrows */}
          {states.map((state) => (
            <StateNode
              key={state}
              state={state}
              isActive={effectiveState === state}
              isReachable={controlEnabled && reachableStates.has(state)}
              onClick={() => sendStateTransition(state)}
            />
          ))}
        </svg>
      </div>

      {/* Legend – ultra compact */}
      <div className="px-2 py-1.5 border-t border-gray-800 flex flex-wrap gap-2 text-[9px] flex-shrink-0">
        <span className="flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm inline-block" style={{ background: '#2563EB', border: '1px solid #60A5FA' }} />
          <span className="text-text-muted">Current</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm inline-block" style={{ background: '#059669', border: '1px solid #34D399' }} />
          <span className="text-text-muted">Reachable</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-2 rounded-sm inline-block" style={{ background: '#7F1D1D', border: '1px solid #EF4444' }} />
          <span className="text-text-muted">Emergency</span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" style={{ display: 'inline-block' }}>
            <line x1="0" y1="3" x2="14" y2="3" stroke="#34D399" strokeWidth="1.5" />
            <polygon points="14,1 18,3 14,5" fill="#34D399" />
          </svg>
          <span className="text-text-muted">Next</span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" style={{ display: 'inline-block' }}>
            <line x1="0" y1="3" x2="14" y2="3" stroke="#60A5FA" strokeWidth="1.25" strokeDasharray="4 2" />
            <polygon points="14,1 18,3 14,5" fill="#60A5FA" />
          </svg>
          <span className="text-text-muted">Return</span>
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="18" height="6" style={{ display: 'inline-block' }}>
            <line x1="0" y1="3" x2="14" y2="3" stroke="#EF4444" strokeWidth="1.5" strokeDasharray="4 2" />
            <polygon points="14,1 18,3 14,5" fill="#EF4444" />
          </svg>
          <span className="text-text-muted">Emergency</span>
        </span>
      </div>

    </div>
  );
}
