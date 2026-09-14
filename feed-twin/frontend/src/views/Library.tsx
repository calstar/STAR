import { LibraryPanel } from '../components/LibraryPanel';
import { useStand } from '../stand';

export function Library() {
  const { artifacts, where, busy, pick, refresh } = useStand();
  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-text-muted">
          Library
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            drawings and engine configs, addressed by the hash of their own bytes
          </span>
        </h2>
        <LibraryPanel
          artifacts={artifacts}
          diagramId={where.diagram}
          engineId={where.engine}
          busy={busy}
          onPick={pick}
          onChanged={() => void refresh()}
        />
      </div>
    </div>
  );
}
