import { PIDDesigner } from './components/pid/PIDDesigner';

function App() {
  return (
    // No header bar. It was fifty-six pixels saying the name of the app over
    // empty space; the name now sits at the left of the diagram bar and the
    // canvas has the height.
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--color-bg-primary)]">
      <main className="flex min-h-0 flex-1 flex-col px-3 py-3">
        <PIDDesigner />
      </main>
    </div>
  );
}

export default App;
