/**
 * Lazy page registry — single source for both the route table (App.tsx) and
 * the popup-window dispatcher (/window/:view). Each page loads as its own
 * chunk, so a popup window fetches only what it renders.
 *
 * Page components still live under app/ (their pre-SPA home); the folder is
 * plain components now — no framework routing semantics attached.
 */
import { lazy } from 'react';

export const HomePage           = lazy(() => import('@/app/page'));
export const BoardsPage         = lazy(() => import('@/app/boards/page'));
export const CalibrationPage    = lazy(() => import('@/app/calibration/page'));
export const ConfigPage         = lazy(() => import('@/app/config/page'));
export const ControllerPage     = lazy(() => import('@/app/controller/page'));
export const ControlsPage       = lazy(() => import('@/app/controls/page'));
export const EncodersPage       = lazy(() => import('@/app/encoders/page'));
export const FlashPage          = lazy(() => import('@/app/flash/page'));
export const LivestreamPage     = lazy(() => import('@/app/livestream/page'));
export const SelfTestsPage      = lazy(() => import('@/app/self-tests/page'));
export const SensorInfoPage     = lazy(() => import('@/app/sensor-info/page'));
export const StatusPage         = lazy(() => import('@/app/status/page'));

export const AllPlotsPage       = lazy(() => import('@/app/plots/all/page'));
export const ChamberPage        = lazy(() => import('@/app/plots/chamber/page'));
export const CopvPage           = lazy(() => import('@/app/plots/copv/page'));
export const FeedCharPage       = lazy(() => import('@/app/plots/feed-characterization/page'));
export const FuelPage           = lazy(() => import('@/app/plots/fuel/page'));
export const GsePage            = lazy(() => import('@/app/plots/gse/page'));
export const LcsTcsRtdPage      = lazy(() => import('@/app/plots/lcs-tcs-rtd/page'));
export const LoxPage            = lazy(() => import('@/app/plots/lox/page'));
export const RawPage            = lazy(() => import('@/app/plots/raw/page'));
export const SolenoidCharPage   = lazy(() => import('@/app/plots/solenoid-characterization/page'));

export const UnifiedWindowPage  = lazy(() => import('@/app/window/unified/page'));
export const IpadWindowPage     = lazy(() => import('@/app/window/ipad/page'));
export const MobileGuiPage      = lazy(() => import('@/app/window/mobile-gui/page'));

/** /window/:view registry — keys must match WindowLauncher URLs. */
export const windowViews: Record<string, React.ComponentType> = {
  fuel: FuelPage,
  lox: LoxPage,
  copv: CopvPage,
  gse: GsePage,
  raw: RawPage,
  all: AllPlotsPage,
  controls: ControlsPage,
  controller: ControllerPage,
  status: StatusPage,
  boards: BoardsPage,
  flash: FlashPage,
  config: ConfigPage,
  calibration: CalibrationPage,
  unified: UnifiedWindowPage,
  ipad: IpadWindowPage,
  'lcs-tcs-rtd': LcsTcsRtdPage,
  chamber: ChamberPage,
  'sensor-info': SensorInfoPage,
  'mobile-gui': MobileGuiPage,
  'solenoid-char': SolenoidCharPage,
  encoders: EncodersPage,
  livestream: LivestreamPage,
  'self-tests': SelfTestsPage,
  'feed-char': FeedCharPage,
};
