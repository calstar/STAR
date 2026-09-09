import { PIDDesigner } from './components/pid/PIDDesigner';

function App() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 h-14 flex items-center shrink-0">
        <h1 className="text-base font-semibold text-[var(--color-text-primary)]">P&amp;ID Designer</h1>
      </header>
      <main className="flex min-h-0 flex-1 flex-col px-4 py-4">
        <PIDDesigner />
      </main>
    </div>
  );
}

export default App;
