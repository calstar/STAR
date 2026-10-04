import type { EngineConfig } from '../../../api/client';
import type { LayerXJob } from '../useLayerXJob';
import type { Theme } from './kit';
import { ToolPage } from './tools/ToolPage';

/**
 * The Optimize tool: Set point and Hardware (pages/tools/ToolPage.tsx), each answering with a
 * change list. This file holds no control of its own: the checkout audit (lib/gating.test.ts)
 * reads any lx/ path naming an optimiser as a write path, and the one design write lives in
 * pages/tools/DesignWrite.tsx, gated there.
 */
export function Optimize({ job, isVisible, config, onConfigUpdated }: {
  job: LayerXJob; theme: Theme; isVisible: boolean; config: EngineConfig | null; onConfigUpdated?: (c: EngineConfig) => void;
}) {
  return <ToolPage job={job} isVisible={isVisible} config={config} onConfigUpdated={onConfigUpdated} />;
}
