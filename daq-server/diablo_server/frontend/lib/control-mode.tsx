"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { MessageType } from "./types";
import { getWebSocketClient } from "./websocket";

interface ControlModeContextValue {
  /** Armed: the backend has authorized this connection (operator + password). */
  controlEnabled: boolean;
  /** This user is on the DAQ operators allowlist (from the backend). */
  isOperator: boolean;
  unlocking: boolean;
  error: string | null;
  unlock: (password: string) => void;
  lock: () => void;
}

const ControlModeContext = createContext<ControlModeContextValue | undefined>(undefined);

/**
 * Engine-control arm state — entirely backend-driven, so the UI can never show
 * "armed" when the backend would reject the commands. The backend enforces the
 * operator allowlist + password server-side (see backend/src/server.ts); this
 * context just reflects its decisions:
 *   - CONTROL_STATUS (on connect): are you an approved operator?
 *   - CONTROL_UNLOCK_RESULT (reply to unlock): did the password unlock control?
 * No password lives in the frontend, and nothing is persisted — each connection
 * re-arms, because the backend resets authorization on every (re)connect.
 */
export function ControlModeProvider({ children }: { children: React.ReactNode }) {
  const [controlEnabled, setControlEnabled] = useState(false);
  const [isOperator, setIsOperator] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ws = getWebSocketClient();

    const offStatus = ws.on(MessageType.CONTROL_STATUS, (payload) => {
      const p = payload as { operator?: boolean };
      setIsOperator(!!p.operator);
      // Every (re)connect resets server-side authorization → require re-arm.
      setControlEnabled(false);
      setUnlocking(false);
    });

    const offResult = ws.on(MessageType.CONTROL_UNLOCK_RESULT, (payload) => {
      const p = payload as { ok?: boolean; reason?: string };
      setUnlocking(false);
      if (p.ok) {
        setControlEnabled(true);
        setError(null);
      } else {
        setControlEnabled(false);
        setError(
          p.reason === "not_operator"
            ? "You're not an approved operator."
            : "Incorrect password."
        );
      }
    });

    ws.connect("control-mode");
    return () => { offStatus(); offResult(); };
  }, []);

  const unlock = useCallback((password: string) => {
    setUnlocking(true);
    setError(null);
    getWebSocketClient().send({
      type: MessageType.CONTROL_UNLOCK,
      timestamp: Date.now(),
      payload: { password },
    });
  }, []);

  const lock = useCallback(() => {
    setControlEnabled(false);
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
