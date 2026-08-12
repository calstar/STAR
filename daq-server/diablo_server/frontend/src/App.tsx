/**
 * SPA root — layout formerly in app/layout.tsx plus the route table
 * (formerly Next.js file-system routing under app/). URLs are unchanged:
 * WindowLauncher, Playwright specs, and operator bookmarks keep working.
 */
import { Suspense } from 'react';
import { Routes, Route, useParams } from 'react-router-dom';
import TopBarWrapper from '@/components/dashboard/TopBarWrapper';
import { ControlModeProvider } from '@/lib/control-mode';
import GlobalStateSubscriber from '@/components/dashboard/GlobalStateSubscriber';
import WindowDetector from '@/components/windows/WindowDetector';
import * as P from './pages';

function PageFallback() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
      Loading…
    </div>
  );
}

/** Popup-window dispatcher: /window/:view → page from the shared registry. */
function WindowViewPage() {
  const { view } = useParams();
  const Component = view ? P.windowViews[view] : undefined;

  if (!Component) {
    return (
      <main className="min-h-screen bg-background text-text p-8">
        <WindowDetector />
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold text-red-500">Invalid View</h1>
          <p className="text-text-muted">View &quot;{view}&quot; not found</p>
        </div>
      </main>
    );
  }

  // TopBar is rendered by the root layout — just give the page remaining height.
  return (
    <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
      <WindowDetector />
      <Component />
    </div>
  );
}

export default function App() {
  return (
    <>
      <GlobalStateSubscriber />
      <ControlModeProvider>
        <TopBarWrapper />
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<P.HomePage />} />
              <Route path="/boards" element={<P.BoardsPage />} />
              <Route path="/calibration" element={<P.CalibrationPage />} />
              <Route path="/config" element={<P.ConfigPage />} />
              <Route path="/controller" element={<P.ControllerPage />} />
              <Route path="/controls" element={<P.ControlsPage />} />
              <Route path="/encoders" element={<P.EncodersPage />} />
              <Route path="/flash" element={<P.FlashPage />} />
              <Route path="/livestream" element={<P.LivestreamPage />} />
              <Route path="/self-tests" element={<P.SelfTestsPage />} />
              <Route path="/sensor-info" element={<P.SensorInfoPage />} />
              <Route path="/status" element={<P.StatusPage />} />
              <Route path="/session" element={<P.SessionPage />} />
              <Route path="/plots/all" element={<P.AllPlotsPage />} />
              <Route path="/plots/chamber" element={<P.ChamberPage />} />
              <Route path="/plots/copv" element={<P.CopvPage />} />
              <Route path="/plots/feed-characterization" element={<P.FeedCharPage />} />
              <Route path="/plots/fuel" element={<P.FuelPage />} />
              <Route path="/plots/gse" element={<P.GsePage />} />
              <Route path="/plots/lcs-tcs-rtd" element={<P.LcsTcsRtdPage />} />
              <Route path="/plots/lox" element={<P.LoxPage />} />
              <Route path="/plots/raw" element={<P.RawPage />} />
              <Route path="/plots/solenoid-characterization" element={<P.SolenoidCharPage />} />
              <Route path="/window/:view" element={<WindowViewPage />} />
              <Route
                path="*"
                element={
                  <main className="min-h-screen bg-background text-text p-8">
                    <h1 className="text-3xl font-bold text-red-500">Not Found</h1>
                  </main>
                }
              />
            </Routes>
          </Suspense>
        </div>
      </ControlModeProvider>
    </>
  );
}
