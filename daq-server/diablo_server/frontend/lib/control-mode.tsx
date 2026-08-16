"use client";

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { MessageType } from "./types";
import { getWebSocketClient } from "./websocket";

interface ControlModeContextValue {
  /** Armed: the backend has authorized this connection (approved operator). */
  controlEnabled: boolean;
  /** This user is on the DAQ operators allowlist (from the backend). */
  isOperator: boolean;
  unlocking: boolean;
  error: string | null;
  unlock: () => void;
  lock: () => void;
}

const ControlModeContext = createContext<ControlModeContextValue | undefined>(undefined);

/**
 * Engine-control arm state — entirely backend-driven, so the UI can never show
 * "armed" when the backend would reject the commands. The backend enforces the
 * operator allowlist server-side (see backend/src/server.ts); this context just
 * reflects its decisions:
 *   - CONTROL_STATUS (on connect): are you an approved operator?
 *   - CONTROL_UNLOCK_RESULT (reply to arm): did the backend arm control?
 * The backend resets authorization on every (re)connect, but arming is
 * identity-only server-side (no credential), so if this operator was already
 * armed we silently re-arm across a reconnect — a bounced socket while clicking
 * around must not kick them back to viewer. A full page reload starts fresh
 * (wasArmed=false) and stays locked, which is the intended reset.
 */
export function ControlModeProvider({ children }: { children: React.ReactNode }) {
  const [controlEnabled, setControlEnabled] = useState(false);
  const [isOperator, setIsOperator] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Survives WS reconnects (a ref, not state reset on remount would be a reload).
  const wasArmedRef = useRef(false);

  useEffect(() => {
    const ws = getWebSocketClient();

    const offStatus = ws.on(MessageType.CONTROL_STATUS, (payload) => {
      const p = payload as { operator?: boolean };
      setIsOperator(!!p.operator);
      setUnlocking(false);
      // (Re)connect wiped server-side authorization. If we were armed before,
      // re-arm silently (identity-only) so the UI stays armed; else stay locked.
      if (wasArmedRef.current && p.operator) {
        getWebSocketClient().send({ type: MessageType.CONTROL_UNLOCK, timestamp: Date.now(), payload: {} });
      } else {
        setControlEnabled(false);
      }
    });

    const offResult = ws.on(MessageType.CONTROL_UNLOCK_RESULT, (payload) => {
      const p = payload as { ok?: boolean; reason?: string };
      setUnlocking(false);
      if (p.ok) {
        setControlEnabled(true);
        wasArmedRef.current = true;
        setError(null);
      } else {
        setControlEnabled(false);
        wasArmedRef.current = false;
        setError("You're not an approved operator.");
      }
    });

    ws.connect("control-mode");
    return () => { offStatus(); offResult(); };
  }, []);

  const unlock = useCallback(() => {
    setUnlocking(true);
    setError(null);
    wasArmedRef.current = true; // remember intent so we re-arm across reconnects
    getWebSocketClient().send({
      type: MessageType.CONTROL_UNLOCK,
      timestamp: Date.now(),
      payload: {},
    });
  }, []);

  const lock = useCallback(() => {
    setControlEnabled(false);
    wasArmedRef.current = false; // explicit lock — do not auto-re-arm
    setError(null);
  }, []);

  const value: ControlModeContextValue = {
    controlEnabled, isOperator, unlocking, error, unlock, lock,
  };

  return <ControlModeContext.Provider value={value}>{children}</ControlModeContext.Provider>;
}

export function useControlMode(): ControlModeContextValue {
  const ctx = useContext(ControlModeContext);
  if (!ctx) {
    throw new Error("useControlMode must be used within a ControlModeProvider");
  }
  return ctx;
}
