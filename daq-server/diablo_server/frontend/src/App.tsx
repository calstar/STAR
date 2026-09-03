/**
 * SPA root — layout formerly in app/layout.tsx plus the route table
 * (formerly Next.js file-system routing under app/). Every view has one
 * canonical path; the legacy `/window/:view` popup URLs redirect to it so
 * operator bookmarks and older popups keep resolving.
 */
import { Suspense, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, useParams, useNavigate } from 'react-router-dom';
import TopBarWrapper from '@/components/dashboard/TopBarWrapper';
import { ControlModeProvider } from '@/lib/control-mode';
import GlobalStateSubscriber from '@/components/dashboard/GlobalStateSubscriber';
import WindowDetector from '@/components/windows/WindowDetector';
import OpenInPopupButton from '@/components/windows/OpenInPopupButton';
import { useWindowManager } from '@/components/windows/WindowManager';
import { isPopupWindow } from '@/lib/is-popup';
import { VIEW_ID_TO_PATH } from '@/lib/nav-items';
import * as P from './pages';

function PageFallback() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
      Loading…
    </div>
  );
}

/** Legacy popup dispatcher: `/window/:view` → the view's canonical path. */
function WindowRedirect() {
  const { view } = useParams();
  const target = view ? VIEW_ID_TO_PATH[view] : undefined;
  return <Navigate to={target ?? '/'} replace />;
}

/**
 * Livestream always opens in its own popup window (it's a broadcast pane meant
 * to live on a dedicated screen). Inside a popup we render it normally; in the
 * main window, hitting /livestream pops it out and bounces back to the prior view.
 */
function LivestreamRoute() {
  const popup = isPopupWindow();
  const { openWindow } = useWindowManager();
  const navigate = useNavigate();
  const opened = useRef(false);

  useEffect(() => {
    if (popup || opened.current) return;
    opened.current = true;
    openWindow('popout:/livestream', 'Livestream Stats', '/livestream');
    // Return to where they came from; fall back to Single Pane on a direct load.
    if (window.history.length > 1) navigate(-1);
    else navigate('/single-pane', { replace: true });
  }, [popup, openWindow, navigate]);

  if (popup) return <P.LivestreamPage />;
  return (
    <div className="flex-1 flex items-center justify-center text-gray-500 text-sm">
      Opening Livestream in a popup…
    </div>
  );
}

export default function App() {
  return (
    <>
      <GlobalStateSubscriber />
      <WindowDetector />
      <ControlModeProvider>
        <TopBarWrapper />
        <div className="flex-1 min-h-0 overflow-auto flex flex-col bg-background">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* Home removed — land on the most-used view (Single Pane). */}
              <Route path="/" element={<Navigate to="/single-pane" replace />} />
              <Route path="/views" element={<P.AllViewsPage />} />

              {/* ── Full-window dashboards ─────────────────────────────── */}
              <Route path="/single-pane" element={<P.UnifiedWindowPage />} />
              <Route path="/ipad" element={<P.IpadWindowPage />} />
              <Route path="/mobile" element={<P.MobileGuiPage />} />

              {/* ── Panes / tools ──────────────────────────────────────── */}
              <Route path="/boards" element={<P.BoardsPage />} />
              <Route path="/calibration" element={<P.CalibrationPage />} />
              <Route path="/calibration-cubic" element={<P.CubicCalPage />} />
              <Route path="/config" element={<P.ConfigPage />} />
              <Route path="/controller" element={<P.ControllerPage />} />
              <Route path="/controls" element={<P.ControlsPage />} />
              <Route path="/encoders" element={<P.EncodersPage />} />
              <Route path="/flash" element={<P.FlashPage />} />
              <Route path="/livestream" element={<LivestreamRoute />} />
              <Route path="/self-tests" element={<P.SelfTestsPage />} />
              <Route path="/sensor-info" element={<P.SensorInfoPage />} />
              <Route path="/status" element={<P.StatusPage />} />
              <Route path="/session" element={<P.SessionPage />} />

              {/* ── Plot pages: short canonical path + legacy /plots alias ── */}
              <Route path="/chamber" element={<P.ChamberPage />} />
              <Route path="/copv" element={<P.CopvPage />} />
              <Route path="/feed-char" element={<P.FeedCharPage />} />
              <Route path="/fuel" element={<P.FuelPage />} />
              <Route path="/gse" element={<P.GsePage />} />
              <Route path="/lcs-tcs-rtd" element={<P.LcsTcsRtdPage />} />
              <Route path="/lox" element={<P.LoxPage />} />
              <Route path="/raw" element={<P.RawPage />} />
              <Route path="/solenoid-char" element={<P.SolenoidCharPage />} />

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

              {/* ── Legacy popup URLs → canonical path ─────────────────── */}
              <Route path="/window/:view" element={<WindowRedirect />} />

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
        <OpenInPopupButton />
      </ControlModeProvider>
    </>
  );
}
