import { useMemo, useState } from 'react';
import { api } from '../api';

interface Props {
  runId: string;
  /** The snapshot's TOML, verbatim. null = this run has none; undefined = still loading. */
  text: string | null | undefined;
  error: string | null;
}

// Line-based TOML highlighting. Deliberately not a parser: the file is shown exactly as
// it was recorded, and per-line regexes cannot mangle a value they fail to understand —
// the worst case is a line rendered plain. Colours come from the declared text tiers, so
// theme.check.mjs's contrast and undeclared-var rules keep holding.
const SECTION = /^\s*\[\[?[^\]]*\]\]?\s*$/;
const KEY_VALUE = /^(\s*)([^=]+?)(\s*=\s*)(.*)$/;

function Line({ text }: { text: string }) {
  const hash = text.indexOf('#');
  // A '#' inside a string is not a comment. Only treat a line as commented when the
  // hash is outside any quotes — cheap check: an even number of quotes before it.
  const quoted = (text.slice(0, hash).match(/"/g) ?? []).length % 2 === 1;
  if (hash >= 0 && !quoted) {
    return (
      <>
        <Line text={text.slice(0, hash)} />
        <span className="tok-comment">{text.slice(hash)}</span>
      </>
    );
  }
  if (SECTION.test(text)) return <span className="tok-section">{text}</span>;
  const kv = text.match(KEY_VALUE);
  if (kv) {
    return (
      <>
        {kv[1]}
        <span className="tok-key">{kv[2]}</span>
        {kv[3]}
        <span className="tok-val">{kv[4]}</span>
      </>
    );
  }
  return <>{text}</>;
}

export default function ConfigView({ runId, text, error }: Props) {
  const [q, setQ] = useState('');
  const [copied, setCopied] = useState(false);

  const query = q.trim().toLowerCase();

  // Filter to matching lines, each still carrying its original line number, and keep the
  // [section] a match sits under — a bare "port = 5005" tells you nothing about which
  // board it belongs to.
  const lines = useMemo(() => {
    const all = (text ?? '').split('\n').map((t, i) => ({ n: i + 1, t }));
    if (!query) return all;
    const out: { n: number; t: string }[] = [];
    let section: { n: number; t: string } | null = null;
    let sectionShown = false;
    for (const line of all) {
      if (SECTION.test(line.t)) {
        section = line;
        sectionShown = false;
      }
      if (!line.t.toLowerCase().includes(query)) continue;
      if (section && !sectionShown && section !== line) {
        out.push(section);
        sectionShown = true;
      }
      out.push(line);
    }
    return out;
  }, [text, query]);

  const copy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (error) return <div className="placeholder error">Error: {error}</div>;
  if (text === undefined) return <div className="placeholder">Loading config…</div>;
  if (text === null) {
    return (
      <div className="placeholder">
        No config snapshot for this run.
        <div className="cfg-note">
          The server started copying the config it ran to <code>&lt;run&gt;.toml</code> beside
          the DB partway through 2026; runs recorded before that have none. Channels keep
          their raw Elodin names, and state names come from the built-in table.
        </div>
      </div>
    );
  }

  const total = text.split('\n').length;

  return (
    <div className="cfg">
      <div className="cfg-toolbar">
        <input
          className="picker-search cfg-search"
          placeholder="Filter lines…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="cfg-count">
          {query ? `${lines.length} of ${total} lines` : `${total} lines`}
        </span>
        <div className="spacer" />
        <button className="btn" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a className="btn" href={api.configUrl(runId)} download={`${runId}.toml`}>
          Download .toml
        </a>
      </div>

      <pre className="cfg-pre">
        {lines.map(({ n, t }) => (
          <div key={n} className="cfg-line">
            <span className="cfg-ln">{n}</span>
            <span className="cfg-src">
              <Line text={t} />
            </span>
          </div>
        ))}
        {lines.length === 0 && <div className="picker-empty">No matching lines</div>}
      </pre>
    </div>
  );
}
