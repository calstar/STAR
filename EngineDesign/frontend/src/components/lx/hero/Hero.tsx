import type { LayerXResult } from '../../../api/layerx';
import type { ChamberGeometryResponse } from '../../../api/client';
import { Panel } from '../ui';
import type { DrawingDocument } from './drawing';
import { EngineSection } from './EngineSection';
import { PidView } from './PidView';

/**
 * The hero (GUI-SPEC "Hero (B4)"): the feed system as drawn and the engine in section, side by
 * side in one panel, both following the page's time cursor (the docked timeline drives it; the hero
 * has no play control of its own).
 *
 * `drawing` and `geometry` are for tests and the harness: the page passes only `result` and
 * `drawingId`, and the hero fetches the rest.
 */
/** Both cards' drawing height [px]: a stand drawing is tall, and so is an engine on its end. */
const HEIGHT = 540;

export function Hero({ result, drawingId, drawing, geometry }: {
  result: LayerXResult;
  drawingId: string;
  drawing?: DrawingDocument | null;
  geometry?: ChamberGeometryResponse | null;
}) {
  // Two cards side by side, both reading top to bottom the way the propellant goes: the feed
  // system as drawn, and the engine it feeds pointing down with the gas's state along it.
  return (
    <div className="grid grid-cols-1 gap-4 lg:col-span-12 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Panel title="Feed system">
        <PidView result={result} drawingId={drawingId} doc={drawing} height={HEIGHT} />
      </Panel>
      <Panel title="Engine">
        <EngineSection result={result} geometry={geometry} vertical height={HEIGHT} />
      </Panel>
    </div>
  );
}
