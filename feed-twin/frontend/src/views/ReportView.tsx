import { useEffect, useState } from 'react';
import { getDrawing } from '../api';
import { ReportPanel } from '../components/ReportPanel';
import { useStand } from '../stand';

export function ReportView() {
  const { model } = useStand();
  // The drawing's own labels, so a line is "Eth-Tank–FM-R", not "node_15-node_38".
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!model?.diagram_id) return;
    getDrawing(model.diagram_id)
      .then((d) =>
        setLabels(
          Object.fromEntries(
            d.nodes.map((n) => [n.id, String((n.data as { label?: string } | undefined)?.label || n.id)]),
          ),
        ),
      )
      .catch(() => undefined);
  }, [model?.diagram_id]);
  if (!model) return <p className="p-6 text-sm text-text-muted">Loading…</p>;
  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 caps">
          Checks
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            what the twin read from the drawing, what it had to assume, and what is worth fixing
          </span>
        </h2>
        <ReportPanel report={model.report} labels={labels} />
      </div>
    </div>
  );
}
