import { ReportPanel } from '../components/ReportPanel';
import { useStand } from '../stand';

export function ReportView() {
  const { model } = useStand();
  if (!model) return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-text-muted">
          Assembly report
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            what the drawing said, and what had to be invented
          </span>
        </h2>
        <ReportPanel report={model.report} />
      </div>
    </div>
  );
}
