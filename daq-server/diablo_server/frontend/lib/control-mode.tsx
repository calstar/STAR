"use client";

import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

interface ControlModeContextValue {
  controlEnabled: boolean;
  unlocking: boolean;
  error: string | null;
  unlock: (password: string) => void;
  lock: () => void;
}

const ControlModeContext = createContext<ControlModeContextValue | undefined>(undefined);

const STORAGE_KEY = "diablo-control-enabled";

export function ControlModeProvider({ children }: { children: React.ReactNode }) {
  const [controlEnabled, setControlEnabled] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = typeof window !== "undefined" ? window.sessionStorage.getItem(STORAGE_KEY) : null;
      if (stored === "true") {
        setControlEnabled(true);
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      if (controlEnabled) {
        window.sessionStorage.setItem(STORAGE_KEY, "true");
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [controlEnabled]);

  const unlock = useCallback((password: string) => {
    setUnlocking(true);
    setError(null);
    try {
      const expected = (import.meta.env?.VITE_CONTROL_PASSWORD as string | undefined) ?? "";
      // Differentiate local vs server by Vite's build mode: `vite dev` (local)
      // permits the well-known dev password, but a production `vite build` (the
      // deployed server) REQUIRES the real secret and never falls back -- so a
      // misconfigured build fails closed instead of shipping 'diablo'.
      //
      // NOTE: this is a client-side gate; the value is baked into the bundle at
      // build time, so it only raises the bar. Real protection against
      // unauthorized engine control must be enforced server-side on the control
      // commands (allowlist keyed on X-Auth-Email). See frontend/.env.example.
      if (!expected && import.meta.env.PROD) {
        setError("Control is disabled: no control password configured for this build.");
        return;
      }
      if (!expected) {
        console.warn(
          "[ControlMode] VITE_CONTROL_PASSWORD is not set; using password 'diablo' (dev only)."
        );
      }
      const effectiveExpected = expected || "diablo";
      if (password === effectiveExpected) {
        setControlEnabled(true);
        setError(null);
      } else {
        setError("Incorrect password.");
      }
    } finally {
      setUnlocking(false);
    }
  }, []);

  const lock = useCallback(() => {
    setControlEnabled(false);
    setError(null);
  }, []);

  const value: ControlModeContextValue = {
    controlEnabled,
    unlocking,
    error,
    unlock,
    lock,
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
