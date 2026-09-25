import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useSensorStore, useSensorValue } from '@/lib/store';

const MEASUREMENTS = [
  { component: 'temperature_c', label: 'Temperature', unit: '°C', color: '#F59E0B', digits: 1 },
  { component: 'humidity_rh', label: 'Relative humidity', unit: '%RH', color: '#38BDF8', digits: 1 },
  { component: 'pressure_pa', label: 'Absolute pressure', unit: 'Pa', color: '#A78BFA', digits: 0 },
] as const;

function Measurement({ entity, measurement }: {
  entity: string;
  measurement: typeof MEASUREMENTS[number];
}) {
  const value = useSensorValue(entity, measurement.component);
  return (
    <div className="rounded-lg border border-gray-700 bg-card p-4">
      <h3 className="text-sm text-text-muted">{measurement.label}</h3>
      <p className="my-2 text-3xl font-mono" style={{ color: measurement.color }}>
        {value != null && Number.isFinite(value) ? value.toFixed(measurement.digits) : '—'}
        <span className="ml-2 text-base">{measurement.unit}</span>
      </p>
      {value == null && <p className="text-sm text-text-muted">Waiting for fresh data</p>}
      <TimeSeriesPlot
        title={measurement.label}
        entities={[entity]}
        component={measurement.component}
        colors={[measurement.color]}
        labels={[measurement.label]}
        yLabel={`${measurement.label} (${measurement.unit})`}
        height={260}
        windowSeconds={60}
      />
    </div>
  );
}

export default function EnvironmentalPage() {
  const boards = useSensorStore((s) => s.boards);
  const environmentalBoards = Object.values(boards ?? {})
    .filter((b) => b.expected && b.type === 'ENVIRONMENTAL')
    .sort((a, b) => a.id - b.id);

  return (
    <main className="flex-1 overflow-auto bg-background p-6 text-text md:p-10">
      <h1 className="mb-2 text-3xl font-bold">Environmental</h1>
      <p className="mb-6 text-text-muted">BME280 readings from the last 60 seconds. Pressure is absolute.</p>
      {environmentalBoards.length === 0 && (
        <p className="rounded-lg border border-gray-700 bg-card p-6">
          No environmental boards available. Enable an ENVIRONMENTAL board in Config and connect to the DAQ server.
        </p>
      )}
      {environmentalBoards.map((board) => (
        <section key={board.id} className="mb-8" aria-label={`Environmental board ${board.id}`}>
          <h2 className="mb-3 text-xl font-semibold">Board {board.id} · {board.ip}</h2>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            {MEASUREMENTS.map((measurement) => (
              <Measurement key={measurement.component} entity={`ENV${board.id}`} measurement={measurement} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
