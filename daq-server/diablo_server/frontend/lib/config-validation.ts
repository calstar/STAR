// Re-export the shared config validation rules — the same module the backend's session-start gate
// evaluates, so the editor's inline issues and what blocks a run can never drift apart.
export * from '../../shared/config-validation.js'
