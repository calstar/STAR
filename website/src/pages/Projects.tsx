import PageHeader from '../components/PageHeader';
import Reveal from '../components/Reveal';
import { PROJECTS } from '../data/projects';
import type { Project } from '../data/projects';

const KIND_LABEL: Record<Project['kind'], string> = {
  vehicle: 'Vehicle',
  engine: 'Engine',
  demonstrator: 'Demonstrator',
};

export default function Projects() {
  const current = PROJECTS.filter((p) => p.current);
  const history = PROJECTS.filter((p) => !p.current).sort((a, b) => b.year - a.year);

  return (
    <>
      <PageHeader
        eyebrow="Launch History"
        title={<>Ten years, <span className="ink-gradient">eighteen vehicles.</span></>}
        lead="From our first high-powered flight in 2016 to a regeneratively cooled liquid engine today — every vehicle student-designed, built, and flown."
      />

      {/* ── Currently building ───────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 56 }}>
        <div className="container">
          <Reveal>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span className="pulse" style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--gold)', boxShadow: '0 0 12px var(--gold)' }} />
              <h2 style={{ fontSize: 'clamp(22px, 3vw, 30px)' }}>Currently Building</h2>
            </div>
          </Reveal>
          <div style={{ display: 'grid', gap: 22, gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 400px))', justifyContent: 'start', marginTop: 28 }}>
            {current.map((p, i) => (
              <Reveal key={p.id} delay={i * 100}>
                <article className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ position: 'relative', aspectRatio: '16 / 9', overflow: 'hidden' }}>
                    <img src={p.image} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <div style={{ position: 'absolute', top: 14, left: 14 }}>
                      <span className="chip chip-current">In progress</span>
                    </div>
                  </div>
                  <div style={{ padding: 28, display: 'flex', flexDirection: 'column', flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
                      <h3 style={{ fontSize: 26 }}>{p.name}</h3>
                      <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 13 }}>{p.era}</span>
                    </div>
                    <div style={{ color: 'var(--gold-soft)', fontFamily: 'var(--font-display)', fontSize: 15, marginTop: 4 }}>{p.tagline}</div>
                    <p style={{ color: 'var(--text-dim)', marginTop: 14, fontSize: 15, lineHeight: 1.6 }}>{p.description}</p>
                    {p.stat && (
                      <div style={{ marginTop: 'auto', paddingTop: 20, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span className="ink-gradient" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 22 }}>{p.stat}</span>
                        <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>{p.statLabel}</span>
                      </div>
                    )}
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Timeline ─────────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal>
            <span className="eyebrow">The archive</span>
            <h2 className="section-title">Every project, chronologically.</h2>
          </Reveal>

          <div className="timeline">
            {history.map((p) => (
              <Reveal key={p.id} className="timeline-row">
                {/* rail + node */}
                <div className="timeline-rail">
                  <div className="timeline-dot" data-kind={p.kind} />
                  <div className="timeline-year mono">{p.year}</div>
                </div>

                <div className="timeline-cards">
                  <article className="card" style={{ padding: 'clamp(22px, 3vw, 30px)' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                      <span className={`chip chip-${p.kind}`}>{KIND_LABEL[p.kind]}</span>
                      <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>{p.era}</span>
                    </div>
                    <h3 style={{ fontSize: 'clamp(22px, 3vw, 28px)', marginTop: 16 }}>{p.name}</h3>
                    <div style={{ color: 'var(--gold-soft)', fontFamily: 'var(--font-display)', fontSize: 14.5, marginTop: 4 }}>{p.tagline}</div>
                    <p style={{ color: 'var(--text-dim)', marginTop: 14, fontSize: 14.5, lineHeight: 1.6 }}>{p.description}</p>
                    {p.stat && (
                      <div style={{ marginTop: 18, display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span className="ink-gradient" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 21 }}>{p.stat}</span>
                        <span className="mono" style={{ color: 'var(--text-faint)', fontSize: 12 }}>{p.statLabel}</span>
                      </div>
                    )}
                  </article>
                  <div className="card timeline-photo">
                    <img src={p.image} alt={p.name} loading="lazy" />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
