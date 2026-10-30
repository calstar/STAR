/**
 * What every view shows when there is no stand to show: a first run on an
 * empty library, a drawing that cannot be built, a library that cannot be
 * read, or a stand still opening. Each says what happened in one sentence and
 * offers the way out -- the sample stand, the Library -- instead of a
 * "Loading…" that never ends.
 *
 * The Library itself never waits behind this: it is where most ways out go.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStand } from '../stand';

function Frame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full items-start justify-center px-8 pt-[12vh]">
      <section className="w-full max-w-[640px] border border-[var(--line)] px-10 py-9">
        <h1 className="font-mono text-[15px] font-semibold uppercase tracking-[0.2em] text-[var(--ink)]">{title}</h1>
        <div className="mt-4 flex flex-col gap-5 text-[14px] leading-relaxed text-[var(--ink-2)]">{children}</div>
      </section>
    </div>
  );
}

const linkCls =
  'font-mono text-[13px] text-[var(--ink-2)] underline decoration-[var(--line-strong)] underline-offset-4 hover:text-[var(--ink)]';

/** The two imports, as links into the Library. */
function Imports() {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      <Link
        to="/library?import=diagram"
        className={linkCls}
        title="Bring a P&ID in from Hotbench P&ID, or upload a drawing file"
      >
        Import from P&amp;ID →
      </Link>
      <Link
        to="/library?import=engine"
        className={linkCls}
        title="Bring an engine in from Hotbench Engine, or upload an engine config"
      >
        Import an engine →
      </Link>
    </div>
  );
}

/** A count in seconds, for a wait that should be short. */
function useWaited(): number {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Math.floor((now - since) / 1000);
}

function Opening({ name }: { name: string }) {
  const waited = useWaited();
  return (
    <Frame title={`Opening ${name}`}>
      <p>
        Building the stand from its drawing
        <span className="tabular-nums text-[var(--ink-3)]"> · {waited} s</span>
      </p>
      {waited >= 20 && (
        <p className="text-[var(--color-warning)]">
          This is taking longer than it should. The twin may be busy with another stand; wait, or pick another stand.
        </p>
      )}
      <Link to="/library" className={linkCls}>
        Pick another stand in Library →
      </Link>
    </Frame>
  );
}

export function NoStand() {
  const { noStand, loadSample, artifacts, where } = useStand();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');

  const sample = async () => {
    setLoading(true);
    setFailed('');
    try {
      await loadSample();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const sampleButton = (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => void sample()}
        disabled={loading}
        className="ctl h-11 self-start px-6 text-[12px]"
        title="The LE4 stand drawing, with the team's ethalox engine and its engine card"
      >
        {loading ? 'Loading the sample…' : 'Load the sample stand'}
      </button>
      {failed && <p className="font-mono text-[12px] text-[var(--color-danger)]">{failed}</p>}
    </div>
  );

  if (!noStand) {
    const name = artifacts.find((a) => a.id === where.diagram)?.name ?? 'the stand';
    return <Opening name={name} />;
  }

  if (noStand.kind === 'library') {
    return (
      <Frame title="Reading the library">
        <p>Finding the drawings and engines this twin holds.</p>
      </Frame>
    );
  }

  if (noStand.kind === 'unreachable') {
    return (
      <Frame title="The twin is not answering">
        <p>{noStand.reason}</p>
        <p className="text-[var(--ink-3)]">Check that the Hotbench Twin server is running, then reload this page.</p>
        <button type="button" onClick={() => window.location.reload()} className="ctl h-10 self-start px-5 text-[11px]">
          Reload
        </button>
      </Frame>
    );
  }

  if (noStand.kind === 'failed') {
    return (
      <Frame title={`“${noStand.name}” cannot run`}>
        <p className="text-[var(--color-danger)]">{noStand.reason}</p>
        <p className="text-[var(--ink-3)]">
          The drawing needs fixing in Hotbench P&amp;ID before it can be a stand. Pick another one to keep working.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Link to="/library" className="ctl h-10 px-5 text-[11px]">
            Pick another in Library
          </Link>
          {sampleButton}
        </div>
      </Frame>
    );
  }

  // An empty library: the first run.
  return (
    <Frame title="No stand yet">
      <p>
        Hotbench Twin runs a feed system from its P&amp;ID: the tanks, lines, regulators and valves as drawn, with the
        engine at the end of them. Start from the sample, or bring your own drawing and engine in.
      </p>
      {sampleButton}
      <Imports />
    </Frame>
  );
}
