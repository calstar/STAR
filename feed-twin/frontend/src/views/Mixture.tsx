import { BalancePanel } from '../components/BalancePanel';
import { useStand } from '../stand';

export function Mixture() {
  const { history, model } = useStand();

  if (!history?.balance) {
    return (
      <p className="p-6 text-sm text-text-muted">
        {model?.report.coupled
          ? 'No flow through the injector yet — press the stand up and open the mains.'
          : 'Attach an engine from the Library and the O/F split appears here: what the injector face sets, and what the plumbing does to it.'}
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <div className="bg-card rounded-lg border border-gray-800">
        <h2 className="border-b border-gray-800 px-4 py-2.5 text-sm font-bold uppercase tracking-wider text-text-muted">
          Mixture ratio
          <span className="ml-2 font-normal normal-case tracking-normal text-gray-600">
            the half the injector owns, and the half the stand does
          </span>
        </h2>
        <BalancePanel balance={history.balance} />
      </div>
    </div>
  );
}
