import { useEffect, useRef, useState } from 'react';
import { api } from '../api';

interface Props {
  runId: string;
  /** What the server currently holds for this run. */
  value: string;
  /** Called with the stored text once a save lands, so the run list stays in step. */
  onSaved: (text: string) => void;
}

// Matches descriptions.MAX_LEN — the input stops you at the length the server would
// silently truncate to, so what you type is what gets stored.
const MAX_LEN = 120;

/**
 * The run's shared one-liner. Unowned: anyone can write or rewrite it and everyone sees
 * the same text, which is the point — a run id says when it happened and nothing about
 * what it was.
 *
 * Saves on blur or Enter, reverts on Escape. Not on every keystroke: this is a shared
 * value, and a half-typed word landing in someone else's list is worse than waiting.
 */
export default function RunDescription({ runId, value, onSaved }: Props) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the run, and any value the server hands back (its own normalisation, or
  // somebody else's edit picked up on a reload).
  useEffect(() => {
    setDraft(value);
    setErr(null);
  }, [runId, value]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const save = () => {
    const text = draft.trim();
    if (text === value || busy) return;
    setBusy(true);
    setErr(null);
    api
      .setDescription(runId, text)
      .then((stored) => {
        setDraft(stored);
        onSaved(stored);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 1800);
      })
      .catch((e) => setErr(String(e.message || e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="run-desc">
      <input
        className="run-desc-input"
        placeholder="Add a description: what was this run? (shared with everyone)"
        value={draft}
        maxLength={MAX_LEN}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur(); // blur saves
          if (e.key === 'Escape') {
            setDraft(value);
            e.currentTarget.blur();
          }
        }}
      />
      {busy && <span className="run-desc-note">saving…</span>}
      {!busy && saved && <span className="run-desc-note">saved</span>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}
