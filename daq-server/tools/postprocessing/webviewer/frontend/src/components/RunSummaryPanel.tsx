interface Props {
  busy: boolean;
  error: string | null;
  onIndex: () => void;
}

/**
 * The plot pane before a run has been indexed: an explanation and the button that pays
 * for it. The run's facts are not repeated here — they are in the run header, in the
 * same place and the same words as they appear once indexed.
 *
 * Indexing exports the whole DB to parquet: tens of seconds and a few hundred MB of
 * cache on a big run. Doing that merely because someone clicked a run in the list spent
 * it on every mis-click; now it is asked for.
 */
export default function RunSummaryPanel({ busy, error, onIndex }: Props) {
  return (
    <div className="notice">
      {busy ? (
        <>
          <div className="notice-title busy">Exporting &amp; indexing…</div>
          <p className="notice-body">
            One-time per run: elodin-db exports every component to parquet, which the
            viewer then reads for every plot. Roughly 20&nbsp;s per GB. Leaving this tab
            will not cancel it.
          </p>
        </>
      ) : (
        <>
          <div className="notice-title">This run is not indexed yet.</div>
          <p className="notice-body">
            One-time parquet export, roughly 20&nbsp;s per GB, cached afterwards. The
            Config tab works without it.
          </p>
          <button className="btn" onClick={onIndex}>
            Index this run
          </button>
          {error && <div className="error">{error}</div>}
        </>
      )}
    </div>
  );
}
