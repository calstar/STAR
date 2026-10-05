import { exportUrl } from '../contract';

/**
 * The run's server-side exports (DATA-CONTRACT 4): every signal as CSV or Parquet, and the FEA
 * bundle (a zip of Pc(t), the heat flux over x and t, thrust(t) and the loads). Fetched, then saved
 * under the server's file name. The endpoints are new: an older server answers 404, which comes
 * back as words for the page to show, never as an exception.
 */

export type ExportFormat = 'csv' | 'parquet' | 'fea';

export const EXPORTS: { fmt: ExportFormat; label: string; note: string }[] = [
  { fmt: 'csv', label: 'Every signal (CSV)', note: 'Every series the run recorded, one column each, on the burn clock' },
  { fmt: 'parquet', label: 'Every signal (Parquet)', note: 'The same, typed and compressed, for pandas or polars' },
  { fmt: 'fea', label: 'FEA bundle (zip)', note: 'Pc(t), heat flux over x and t, thrust(t) and the loads, for the structures model' },
];

export async function downloadExport(runId: string, fmt: ExportFormat): Promise<string | null> {
  try {
    const res = await fetch(exportUrl(runId, fmt));
    if (res.status === 404) return `${fmt.toUpperCase()} export: not on this server yet`;
    if (!res.ok) return `${fmt.toUpperCase()} export failed (HTTP ${res.status})`;
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `layerx_${runId}.${fmt === 'fea' ? 'zip' : fmt}`;
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return null;
  } catch {
    return `${fmt.toUpperCase()} export: the server did not answer`;
  }
}
