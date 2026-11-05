import type { InjectorLayoutWarning } from '../api/client';

/**
 * The injector checks, sorted by what a person does about them.
 *
 * The layout reports three different things in one list: the hardware does not work (a thread
 * cuts a seal groove), the revolve drawing has drifted from the model (a passage 0.09 mm shorter
 * than drawn), and notes. All of them printed as one wall of "fails:" / "check:" / "note:" lines,
 * so three sub-0.2 mm drawing drifts from a 6500N-era DXF read with the same red as the one real
 * clash. A drawing difference is a drawing to update, not a part that fails; it is grouped and
 * summarised, at check (amber) severity at most. Nothing is re-graded on the hardware side.
 */
export interface InjectorChecks {
  /** Hardware: the engine as modelled, bad and warn. */
  hardware: InjectorLayoutWarning[];
  /** The revolve drawing against the model (codes drawing_*). */
  drawing: InjectorLayoutWarning[];
  /** Everything at info level that is not about the drawing. */
  notes: InjectorLayoutWarning[];
}

export function sortInjectorChecks(warnings: InjectorLayoutWarning[]): InjectorChecks {
  const out: InjectorChecks = { hardware: [], drawing: [], notes: [] };
  for (const w of warnings) {
    if (w.code.startsWith('drawing_')) out.drawing.push(w);
    else if (w.level === 'info') out.notes.push(w);
    else out.hardware.push(w);
  }
  // Worst first.
  out.hardware.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));
  return out;
}

/**
 * A check's text with the config keys it cites taken out of the sentence: "(injector.plate.port_bore)"
 * names the field to change, which the Injector hardware panel below labels in words. The keys go
 * to the hover instead, for whoever edits the file.
 */
export function splitConfigKeys(text: string): { text: string; keys: string[] } {
  const keys: string[] = [];
  const cleaned = text.replace(/\s*\(([a-z][a-z0-9]*(?:[._][a-z0-9]+)+)\)/g, (_m, key: string) => {
    // Only a dotted path or snake_case identifier; ordinary parentheticals stay.
    if (!/[._]/.test(key)) return _m;
    keys.push(key);
    return '';
  });
  return { text: cleaned, keys };
}
