/**
 * Syntax checking for dynamic-state scripts, by spawning the sequencer's own parser.
 *
 * There is exactly ONE parser for this language, in C++, because the sequencer is the thing that
 * executes scripts. `state_script_check` is that same code built as a hermetic CLI — it opens no
 * sockets, touches no boards and starts no services, which is what makes running it from here
 * unremarkable rather than a hardware action.
 *
 * This is early warning, not enforcement. The sequencer re-parses every script at startup and is
 * the authority on whether a state becomes enterable, so a checker binary that is missing or stale
 * degrades the editing experience and never the safety of the stand. That is why every failure
 * mode below returns "could not check" rather than "invalid": refusing a save because a developer
 * has not run the build yet would be a worse bug than the one it prevents.
 */
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { getConfigPath } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface ScriptDiagnostic {
  line: number;
  col: number;
  code: string;
  message: string;
}

export interface ScriptCheckResult {
  /** false only when the checker ran AND reported problems. */
  ok: boolean;
  diagnostics: ScriptDiagnostic[];
  /** Set when the checker could not be run at all — the caller must not treat this as invalid. */
  unavailable?: string;
}

/** Where scripts/build.sh puts binaries, from wherever the backend happens to be running. */
function findChecker(): string | null {
  const candidates = [
    join(here, '../../../../build/bin/state_script_check'),
    join(here, '../../../build/bin/state_script_check'),
    join(process.cwd(), 'build/bin/state_script_check'),
    join(process.cwd(), '../build/bin/state_script_check'),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** stdout is one diagnostic per line: `<line>:<col>: <CODE> <message>`. */
function parseDiagnostics(stdout: string): ScriptDiagnostic[] {
  const out: ScriptDiagnostic[] = [];
  for (const raw of stdout.split('\n')) {
    const m = /^(\d+):(\d+):\s+(\S+)\s+(.*)$/.exec(raw.trim());
    if (m) out.push({ line: Number(m[1]), col: Number(m[2]), code: m[3], message: m[4] });
  }
  return out;
}

/**
 * Check `source` as the script belonging to `stateName`.
 *
 * The script is written to a temp file rather than passed on the command line: it is multi-line
 * operator input, and an argv round-trip is a quoting bug waiting to happen.
 */
export async function checkStateScript(
  source: string,
  stateName: string,
  transitionsCsv?: string,
): Promise<ScriptCheckResult> {
  const bin = findChecker();
  if (!bin) return { ok: true, diagnostics: [], unavailable: 'state_script_check is not built' };

  const dir = mkdtempSync(join(tmpdir(), 'daq-script-'));
  const file = join(dir, 'check.script');
  writeFileSync(file, source, 'utf-8');

  const args = ['--config', getConfigPath(), '--state', stateName];
  if (transitionsCsv) args.push('--transitions', transitionsCsv);
  args.push(file);

  try {
    return await new Promise<ScriptCheckResult>((resolve) => {
      execFile(bin, args, { timeout: 5000 }, (err, stdout, stderr) => {
        const diagnostics = parseDiagnostics(stdout);
        // Exit 0 = clean, 1 = diagnostics on stdout, anything else = the checker could not do its
        // job (config unreadable, state not declared). Only the middle case is the script's fault.
        const code = (err as any)?.code;
        if (code === undefined || code === 0) return resolve({ ok: true, diagnostics: [] });
        if (code === 1 && diagnostics.length) return resolve({ ok: false, diagnostics });
        resolve({
          ok: true,
          diagnostics: [],
          unavailable: String(stderr || '').trim() || 'state_script_check could not run',
        });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
