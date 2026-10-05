import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';
import type { EngineConfig } from '../../../../api/client';
import { updateConfig } from '../../../../api/client';
import type { ChangeRecord } from '../../../../api/layerx';
import { Badge, Button } from '../../ui';
import { plainText, fieldWords, componentWords } from './changes';

/**
 * The one write a tool's change list can make: its design-domain changes into the live design
 * (engine/layerx/diff.py design_write: `PUT /api/config?expect_sha256=`, refused with 409 when the
 * design moved since the tool ran). Only on an explicit confirmation, and only with the checkout:
 * every control here sits in a `<fieldset disabled={readOnly}>`, which the checkout audit
 * (lib/gating.test.ts) reads, and the server refuses a write without the checkout all the same.
 */
export interface DesignWriteSpec {
  method?: string;
  path?: string;
  query?: { expect_sha256?: string };
  body: Record<string, unknown>;
  requires_confirmation?: boolean;
}

export function DesignWrite({ write, changes, designName, onConfigUpdated }: {
  write: DesignWriteSpec;
  /** The design-domain rows, to say what the write changes. */
  changes: ChangeRecord[];
  designName?: string | null;
  onConfigUpdated?: (c: EngineConfig) => void;
}) {
  const readOnly = useReadOnly();
  const [state, setState] = useState<'idle' | 'confirm' | 'writing' | 'written'>('idle');
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setState('writing');
    setError(null);
    const r = await updateConfig(write.body as Partial<EngineConfig>, write.query?.expect_sha256 ?? null);
    if (r.error) {
      // A 409 says the design moved since the tool ran (the server's own words say so).
      setError(r.error);
      setState('idle');
      return;
    }
    if (r.data?.config) onConfigUpdated?.(r.data.config);
    setState('written');
  };
  const design = designName || 'the open design';
  return (
    <fieldset disabled={readOnly || state === 'writing' || state === 'written'} className="min-w-0 space-y-2">
      <legend className="sr-only">Write these changes into the design</legend>
      {state === 'confirm' ? (
        <div role="alertdialog" aria-label="Confirm the write" className="rounded-[6px] border border-[var(--lx-line-strong)] bg-[var(--lx-surface-2)] p-3">
          <p className="text-[12px] text-[var(--lx-text)]">
            Write {changes.length} change{changes.length === 1 ? '' : 's'} into <strong className="font-medium">{design}</strong>? This changes the stored design for everyone who opens it.
          </p>
          <ul className="mt-2 space-y-0.5 text-[12px] text-[var(--lx-text-2)]">
            {changes.map((c, k) => (
              <li key={`${c.target}-${c.field}-${k}`} className="lx-num">
                {componentWords(c)}, {fieldWords(c.field)}: {plainText(c.before, c.unit)} → <span className="text-[var(--lx-text)]">{plainText(c.after, c.unit)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" disabled={readOnly} onClick={() => { void go(); }}>Write into the design</Button>
            <Button size="sm" disabled={readOnly} onClick={() => setState('idle')}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" disabled={readOnly || state !== 'idle'} onClick={() => setState('confirm')}
                  title={readOnly ? 'Take the design (the bar above) to change it.' : undefined}>
            {state === 'written' ? 'Written into the design' : state === 'writing' ? 'Writing…' : 'Write into the design…'}
          </Button>
          {state === 'written'
            ? <Badge status="ok" size="sm">written</Badge>
            : readOnly
              ? <span className="text-[12px] text-[var(--lx-text-3)]">Read only: take the design to write it.</span>
              : <span className="text-[12px] text-[var(--lx-text-3)]">asks before it writes; refused if the design moved</span>}
        </div>
      )}
      {error && <div role="alert" className="text-[12px] text-[var(--lx-bad)]">{error}</div>}
    </fieldset>
  );
}
