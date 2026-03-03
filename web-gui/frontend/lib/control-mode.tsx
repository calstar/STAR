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
      const expected = process.env.NEXT_PUBLIC_CONTROL_PASSWORD ?? "";
      if (!expected) {
        console.warn(
          "[ControlMode] NEXT_PUBLIC_CONTROL_PASSWORD is not set; using password 'diablo' for testing only."
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

