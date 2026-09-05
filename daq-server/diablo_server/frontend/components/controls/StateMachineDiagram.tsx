'use client'

import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, CommandPayload } from '@/lib/types';
import { useEffect, useState, useMemo } from 'react';
import { useControlMode } from '@/lib/control-mode';
import { allStates, loadStates, stateNameUpper } from '@/lib/states';
import { getApiBaseUrl } from '@/lib/websocket';


// States to exclude from diagram rendering
const EXCLUDED_STATES = new Set([
  SystemState.DEBUG,
  SystemState.ENGINE_ABORT,
  SystemState.GSE_ABORT,
  SystemState.EMERGENCY_ABORT,
]);

const NW = 320; // node width
const NH = 115; // node height
const COLS_FALLBACK = 5;
const COL_GAP = 360;
const ROW_GAP = 155;
const PAD = 24;
const ROW_COUNT_FALLBACK = 6;

// Grid layout: [row, col] 0-based
// IMPORTANT: All states from SystemState enum must be included here to appear in the diagram
// States without positions will default to [0, 0] and may overlap
// DEBUG, ENGINE_ABORT, GSE_ABORT, EMERGENCY_ABORT are excluded from rendering
/**
 * Node positions come from [[states]] panel_row / panel_col in the active config profile, not from
 * a table in this file. The old map silently defaulted a missing state to [0, 0] (`?? 0` below),
 * so any state it did not know about rendered on top of Idle. A state with no coordinates is now
 * simply not drawn.
 */
function statePos(state: SystemState): [number, number] | undefined {
  const s = allStates().find((x) => x.id === state);
  if (!s || s.panelRow === null || s.panelCol === null) return undefined;
  return [s.panelRow, s.panelCol];
}

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

// `?? 0` is deliberate here ONLY as a last resort — callers filter unplaced states out first
// (hasPos below). Previously nothing filtered, so a state the position map did not know about was
// drawn at [0, 0], stacked on top of Idle.
function nodeX(state: SystemState) { return PAD + (statePos(state)?.[1] ?? 0) * COL_GAP; }
function nodeY(state: SystemState) { return PAD + (statePos(state)?.[0] ?? 0) * ROW_GAP; }
/** True if this state has a place on the diagram; unplaced states are not drawn. */
function hasPos(state: SystemState) { return statePos(state) !== undefined; }

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
  const name = stateNameUpper(state) ?? 'UNKNOWN';
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
  // Adopt the config-declared states (names + panel positions) once.
  useEffect(() => {
    void loadStates(getApiBaseUrl());
  }, []);

  useEffect(() => {
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
      console.warn(`⚠️ Invalid transition: ${stateNameUpper(effectiveState)} → ${stateNameUpper(targetState)}`);
      alert(`Invalid transition: Cannot go from ${stateNameUpper(effectiveState)} to ${stateNameUpper(targetState)}`);
      return;
    }

    updateState({
      currentState: targetState,
      stateName: stateNameUpper(targetState) ?? `STATE ${targetState}`,
      timestamp: Date.now(),
    });
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
    s => s !== effectiveState && statePos(s) !== undefined,
  );

  // Filter out excluded states from rendering
  // Only states the config gives a position to are drawn. Enumerating the SystemState enum and
  // relying on EXCLUDED_STATES alone meant anything without a position still rendered — at [0, 0],
  // on top of Idle.
  const states = (Object.values(SystemState).filter(
    (s) => typeof s === 'number' && !EXCLUDED_STATES.has(s as SystemState) && hasPos(s as SystemState)
  ) as SystemState[]);

  // Derived from the placed states, so adding one in config widens the canvas instead of
  // drawing it off the edge.
  const placed = allStates().filter((x) => x.panelRow !== null && x.panelCol !== null);
  const COLS = placed.length ? Math.max(...placed.map((x) => x.panelCol as number)) + 1 : COLS_FALLBACK;
  const ROW_COUNT = placed.length ? Math.max(...placed.map((x) => x.panelRow as number)) + 1 : ROW_COUNT_FALLBACK;
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
          <span className="text-blue-400 font-bold">{stateNameUpper(effectiveState)}</span>
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

          {/* State nodes */}
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

    </div>
  );
}
