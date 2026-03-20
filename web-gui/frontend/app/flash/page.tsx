'use client'

import { useState, useCallback, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { getApiBaseUrl } from '@/lib/websocket'

const DEFAULT_PORT = 3232

type SourceMode = 'file' | 'project'

interface OtaProject {
  path: string
  name: string
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

function FlashPageContent() {
  const searchParams = useSearchParams()
  const [ip, setIp] = useState('192.168.2.5')
  const [port, setPort] = useState(DEFAULT_PORT)
  const [sourceMode, setSourceMode] = useState<SourceMode>('project')
  const [projects, setProjects] = useState<OtaProject[]>([])
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [file, setFile] = useState<File | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [flashAlling, setFlashAlling] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [result, setResult] = useState<{ success: boolean; message: string; buildOutput?: string } | null>(null)
  const [flashAllResult, setFlashAllResult] = useState<{
    success: boolean
    total: number
    flashed: number
    failed: number
    results: Array<{ key: string; type: string; ip: string; boardId: number; success: boolean; error?: string }>
    progressLog?: string[]
  } | null>(null)

  useEffect(() => {
    const ipParam = searchParams.get('ip')
    if (ipParam) setIp(ipParam)
  }, [searchParams])

  useEffect(() => {
    fetch(`${getApiBaseUrl()}/api/ota-flash/projects`)
      .then((r) => r.json())
      .then((data) => {
        const list = data.projects ?? []
        setProjects(list)
        if (list.length > 0 && !selectedProject) setSelectedProject(list[0].path)
      })
      .catch(() => setProjects([]))
  }, [])

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    setFile(f ?? null)
    setResult(null)
  }, [])

  const canFlash = sourceMode === 'file' ? !!file : !!selectedProject
  const buttonLabel = sourceMode === 'project'
    ? (flashing ? 'Building & flashing…' : 'Build & flash')
    : (flashing ? 'Flashing…' : 'Flash firmware')

  const handleFlash = useCallback(async () => {
    if (!ip.trim() || !canFlash) return
    setFlashing(true)
    setProgress(0)
    setResult(null)

    try {
      const body: Record<string, unknown> = {
        ip: ip.trim(),
        port: typeof port === 'number' ? port : parseInt(String(port), 10) || DEFAULT_PORT,
      }
      if (sourceMode === 'project') {
        body.projectPath = selectedProject
      } else if (file) {
        const buffer = await file.arrayBuffer()
        body.firmwareBase64 = arrayBufferToBase64(buffer)
      }

      const res = await fetch(`${getApiBaseUrl()}/api/ota-flash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json()
      if (!res.ok) {
        setResult({ success: false, message: data.error || `HTTP ${res.status}` })
        return
      }
      setProgress(100)
      setResult({
        success: data.success,
        message: data.success
          ? `Flashed ${data.bytesSent?.toLocaleString() ?? '?'} bytes in ${(data.durationMs / 1000).toFixed(1)}s — board rebooting`
          : data.error || 'Flash failed',
        buildOutput: data.buildOutput,
      })
    } catch (err: unknown) {
      setResult({
        success: false,
        message: err instanceof Error ? err.message : 'Network or upload error',
      })
    } finally {
      setFlashing(false)
    }
  }, [sourceMode, selectedProject, file, ip, port, canFlash])

  const handleFlashAll = useCallback(async () => {
    setFlashAlling(true)
    setFlashAllResult(null)
    setResult(null)
    try {
      const res = await fetch(`${getApiBaseUrl()}/api/ota-flash/flash-all`, { method: 'POST' })
      const data = await res.json()
      setFlashAllResult(data)
    } catch (err: unknown) {
      setFlashAllResult({
        success: false,
        total: 0,
        flashed: 0,
        failed: 1,
        results: [],
        progressLog: [err instanceof Error ? err.message : 'Request failed'],
      })
    } finally {
      setFlashAlling(false)
    }
  }, [])

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-8 md:p-10">
      <div className="max-w-2xl">
        <h1 className="text-4xl font-bold text-text mb-2 tracking-tight">Ethernet OTA Flash</h1>
        <p className="text-lg text-text-muted mb-8">
          Flash firmware to ESP32-S3 boards over Ethernet (W5500). Build from DiabloAvionics projects or upload a .bin file.
        </p>

        {/* Flash All - single button */}
        <div className="mb-8 rounded-xl border-2 border-cyan-800/60 bg-cyan-950/20 p-6">
          <h2 className="text-xl font-bold text-text mb-2">Flash All Boards</h2>
          <p className="text-sm text-text-muted mb-4">
            Compile latest firmware with each board&apos;s ID baked in, then flash to all enabled boards in config.toml.
          </p>
          <button
            type="button"
            onClick={handleFlashAll}
            disabled={flashAlling || flashing}
            className="min-h-[52px] px-10 py-3 text-lg font-bold rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {flashAlling ? 'Building & flashing all…' : 'Flash all boards'}
          </button>
          {flashAllResult && (
            <div className="mt-4 space-y-2">
              <div
                className={`p-4 rounded-lg font-medium ${flashAllResult.success
                  ? 'bg-emerald-950/50 text-emerald-200 border border-emerald-800'
                  : 'bg-red-950/50 text-red-200 border border-red-800'
                  }`}
              >
                {flashAllResult.flashed}/{flashAllResult.total} flashed
                {flashAllResult.failed > 0 && `, ${flashAllResult.failed} failed`}
              </div>
              {flashAllResult.progressLog && flashAllResult.progressLog.length > 0 && (
                <pre className="p-3 rounded-lg bg-gray-900 text-xs text-gray-400 overflow-auto max-h-32 font-mono">
                  {flashAllResult.progressLog.join('\n')}
                </pre>
              )}
              {flashAllResult.results.some((r) => !r.success) && (
                <ul className="text-sm text-red-300 space-y-1">
                  {flashAllResult.results
                    .filter((r) => !r.success)
                    .map((r) => (
                      <li key={r.key}>
                        {r.type} {r.ip} (ID {r.boardId}): {r.error}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <h2 className="text-xl font-bold text-text mb-3">Flash single board</h2>
        <div className="space-y-6 rounded-xl border border-gray-700 bg-card p-6">
          <div>
            <label className="block text-sm font-semibold text-text-muted uppercase tracking-wider mb-2">Board IP</label>
            <input
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.2.5"
              className="w-full px-4 py-2 rounded-lg bg-gray-900 border border-gray-700 text-text font-mono focus:border-primary focus:ring-1 focus:ring-primary"
              disabled={flashing}
            />
          </div>

          <div>
            <label className="block text-sm font-semibold text-text-muted uppercase tracking-wider mb-2">OTA Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value, 10) || DEFAULT_PORT)}
              min={1}
              max={65535}
              className="w-full px-4 py-2 rounded-lg bg-gray-900 border border-gray-700 text-text font-mono focus:border-primary focus:ring-1 focus:ring-primary"
              disabled={flashing}
            />
            <p className="text-xs text-text-muted mt-1">Default 3232 (DiabloAvionics Ethernet OTA)</p>
          </div>

          <div>
            <label className="block text-sm font-semibold text-text-muted uppercase tracking-wider mb-2">Firmware source</label>
            <div className="flex gap-4 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  checked={sourceMode === 'project'}
                  onChange={() => { setSourceMode('project'); setResult(null); }}
                  disabled={flashing}
                />
                <span>Build from DiabloAvionics project</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="source"
                  checked={sourceMode === 'file'}
                  onChange={() => { setSourceMode('file'); setResult(null); }}
                  disabled={flashing}
                />
                <span>Upload .bin file</span>
              </label>
            </div>

            {sourceMode === 'project' ? (
              projects.length === 0 ? (
                <p className="text-sm text-amber-500">
                  No DiabloAvionics projects found. Ensure <code className="text-gray-400">external/DiabloAvionics</code> exists and run backend from sensor_system root.
                </p>
              ) : (
                <select
                  value={selectedProject}
                  onChange={(e) => { setSelectedProject(e.target.value); setResult(null); }}
                  className="w-full px-4 py-2 rounded-lg bg-gray-900 border border-gray-700 text-text font-mono focus:border-primary focus:ring-1 focus:ring-primary"
                  disabled={flashing}
                >
                  <option value="">Select project…</option>
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.name} — {p.path}
                    </option>
                  ))}
                </select>
              )
            ) : (
              <>
                <input
                  type="file"
                  accept=".bin"
                  onChange={handleFileChange}
                  className="block w-full text-sm text-text-muted file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-primary/20 file:text-primary file:font-semibold file:cursor-pointer hover:file:bg-primary/30"
                  disabled={flashing}
                />
                {file && (
                  <p className="text-sm text-text-muted mt-2">
                    {file.name} — {(file.size / 1024).toFixed(1)} KB
                  </p>
                )}
              </>
            )}
          </div>

          <button
            type="button"
            onClick={handleFlash}
            disabled={flashing || !canFlash || !ip.trim()}
            className="min-h-[48px] px-8 py-3 text-lg font-bold rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
          >
            {buttonLabel}
          </button>

          {progress != null && flashing && (
            <div className="h-2 rounded-full bg-gray-800 overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          )}

          {result && (
            <div className="space-y-2">
              <div
                className={`p-4 rounded-lg font-medium ${result.success ? 'bg-emerald-950/50 text-emerald-200 border border-emerald-800' : 'bg-red-950/50 text-red-200 border border-red-800'
                  }`}
              >
                {result.message}
              </div>
              {result.buildOutput && !result.success && (
                <pre className="p-3 rounded-lg bg-gray-900 text-xs text-gray-400 overflow-auto max-h-40 font-mono">
                  {result.buildOutput}
                </pre>
              )}
            </div>
          )}
        </div>

        <p className="text-sm text-text-muted mt-6">
          Build uses PlatformIO CLI (<code className="text-gray-400">pio run</code>). Install with{' '}
          <code className="text-gray-400">pip install platformio</code> if needed.
        </p>
      </div>
    </main>
  )
}

export default function FlashPage() {
  return (
    <Suspense fallback={<div className="p-8 text-white">Loading...</div>}>
      <FlashPageContent />
    </Suspense>
  )
}
