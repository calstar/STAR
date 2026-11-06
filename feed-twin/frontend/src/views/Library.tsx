import { LibraryPanel } from '../components/LibraryPanel';
import { useStand } from '../stand';

export function Library() {
  const { artifacts, where, busy, pick, refresh, loadSample, leaveFor, importStandFile } = useStand();
  // A stand file dropped here is opened as a stand, as Import stand… does:
  // past Idle, after a yes in the bar above.
  const onStandFile = (file: File) =>
    new Promise<string>((resolve, reject) =>
      leaveFor(
        `Import ${file.name} and open it?`,
        'Import and open',
        () => void importStandFile(file).then(resolve, reject),
        () => resolve(`${file.name} was not imported: the stand on screen was kept.`),
      ),
    );
  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
          Library
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            drawings and engines the stand can run
          </span>
        </h2>
        <LibraryPanel
          artifacts={artifacts}
          diagramId={where.diagram}
          engineId={where.engine}
          busy={busy}
          onPick={pick}
          onChanged={() => void refresh()}
          onSample={loadSample}
          onStandFile={onStandFile}
        />
      </div>
    </div>
  );
}
