import { useEffect, useRef } from 'react';

/* ── Icons ──────────────────────────────────────────────────────────────── */
function IconEngine() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 10V3L4 14h7v7l9-11h-7z" />
    </svg>
  );
}
function IconDAQ() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
function IconPID() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
    </svg>
  );
}
function IconArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
function IconStar() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

/* ── Canvas starfield ─────────────────────────────────────────────────── */
function Starfield() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;
    const stars: { x: number; y: number; r: number; speed: number; opacity: number }[] = [];

    const resize = () => {
      canvas.width  = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    for (let i = 0; i < 120; i++) {
      stars.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.2 + 0.2,
        speed: Math.random() * 0.15 + 0.02,
        opacity: Math.random() * 0.6 + 0.1,
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of stars) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(148, 163, 184, ${s.opacity})`;
        ctx.fill();
        s.y -= s.speed;
        if (s.y < -2) { s.y = canvas.height + 2; s.x = Math.random() * canvas.width; }
      }
      animId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}
    />
  );
}

/* ── App card data ───────────────────────────────────────────────────── */
const APPS = [
  {
    id: 'engine-design',
    href: 'https://engine-design.starberkeley.org',
    label: 'Engine Design',
    subdomain: 'engine-design.starberkeley.org',
    description:
      'Physics simulation of the bipropellant engine. Input tank pressures and injector geometry, get chamber pressure, thrust, Isp, and time-series blowdown curves.',
    icon: <IconEngine />,
    colorClass: 'card-blue',
    iconBg: 'linear-gradient(135deg, #1d4ed8 0%, #3b82f6 100%)',
    iconColor: '#93c5fd',
  },
  {
    id: 'daq-server',
    href: 'https://daq-server.starberkeley.org',
    label: 'DAQ Server',
    subdomain: 'daq-server.starberkeley.org',
    description:
      'Live ground station UI. Displays sensor telemetry from the avionics boards, drives the hotfire state machine, and logs all data to Elodin DB.',
    icon: <IconDAQ />,
    colorClass: 'card-green',
    iconBg: 'linear-gradient(135deg, #15803d 0%, #22c55e 100%)',
    iconColor: '#86efac',
  },
  {
    id: 'pid-designer',
    href: 'https://pid-designer.starberkeley.org',
    label: 'P&ID Designer',
    subdomain: 'pid-designer.starberkeley.org',
    description:
      'Drag-and-drop editor for the propulsion feed system P&ID. Changes are committed directly to git.',
    icon: <IconPID />,
    colorClass: 'card-purple',
    iconBg: 'linear-gradient(135deg, #7e22ce 0%, #a855f7 100%)',
    iconColor: '#d8b4fe',
  },
] as const;

/* ── App ─────────────────────────────────────────────────────────────── */
export default function App() {
  return (
    <div style={{ position: 'relative', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <Starfield />

      {/* Grid background */}
      <div className="grid-bg" style={{ position: 'fixed', inset: 0, zIndex: 0 }} />

      {/* Glow orbs */}
      <div className="orb" style={{ width: 600, height: 600, top: -200, left: -200, background: 'radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)', zIndex: 0 }} />
      <div className="orb" style={{ width: 500, height: 500, bottom: -150, right: -150, background: 'radial-gradient(circle, rgba(168,85,247,0.10) 0%, transparent 70%)', zIndex: 0 }} />

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header style={{
        position: 'relative', zIndex: 10,
        borderBottom: '1px solid var(--color-border)',
        background: 'rgba(10,10,15,0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
      }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px', height: 64, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 34, height: 34,
              borderRadius: 8,
              background: 'linear-gradient(135deg, #1d4ed8 0%, #7e22ce 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff',
            }}>
              <IconStar />
            </div>
            <div>
              <span style={{ fontWeight: 700, fontSize: 18, letterSpacing: '-0.01em' }}>STAR Internal Tools</span>
            </div>
          </div>
          <a
            href="https://github.com/calstar/STAR"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 15, color: 'var(--color-text-secondary)',
              textDecoration: 'none', fontFamily: "'JetBrains Mono', monospace",
              padding: '6px 12px', borderRadius: 8,
              border: '1px solid var(--color-border)',
              transition: 'color 0.2s, border-color 0.2s',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-primary)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-accent)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-secondary)'; (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)'; }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
            </svg>
            calstar/STAR
          </a>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <main style={{ position: 'relative', zIndex: 10, flex: 1 }}>
        <div style={{ maxWidth: 1100, margin: '0 auto', padding: '80px 24px 60px' }}>

          {/* Hero text */}
          <div className="fade-up" style={{ textAlign: 'center', marginBottom: 72 }}>
            <h1 style={{
              fontSize: 'clamp(36px, 6vw, 64px)',
              fontWeight: 700,
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
              margin: '0 0 20px',
              background: 'linear-gradient(135deg, #f8fafc 0%, #94a3b8 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>
              Internal Tools
            </h1>
            <p style={{
              fontSize: 20,
              color: 'var(--color-text-secondary)',
              maxWidth: 520,
              margin: '0 auto',
              lineHeight: 1.7,
            }}>
              Design, simulate, and monitor the liquid-propellant rocket engine
              powering STAR's next launch.
            </p>
          </div>

          {/* App cards grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24 }}>
            {APPS.map((app, i) => (
              <a
                key={app.id}
                href={app.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`app-card ${app.colorClass} fade-up delay-${i + 2}`}
              >
                {/* Icon + label inline, URL below */}
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div className="icon-wrap" style={{ background: app.iconBg, color: app.iconColor }}>
                      {app.icon}
                    </div>
                    <div style={{ fontWeight: 600, fontSize: 19 }}>{app.label}</div>
                  </div>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 8 }}>
                    {app.subdomain}
                  </div>
                </div>

                {/* Description */}
                <p style={{ margin: 0, fontSize: 16, color: 'var(--color-text-secondary)', lineHeight: 1.65 }}>
                  {app.description}
                </p>

                {/* Arrow */}
                <div style={{ marginTop: 4 }}>
                  <span className="arrow-chip">
                    Open <IconArrow />
                  </span>
                </div>
              </a>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
