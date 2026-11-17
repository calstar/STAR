/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" serves every /api call from src/api/mock.ts. */
  readonly VITE_MOCK?: string
}
