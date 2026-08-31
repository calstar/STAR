import { Link } from 'react-router-dom';
import Reveal from '../components/Reveal';
import { ArrowRight } from '../components/icons';
import { SITE, STATS } from '../data/site';
import { SUBTEAMS } from '../data/subteams';

const AMBITIONS = [
  { title: 'Competitions', body: 'Reaching new heights in national and international rocketry competitions.' },
  { title: 'Connections', body: 'Gaining industry-level experience and making lifelong friendships.' },
  { title: 'Community', body: 'Educating local students and residents about aerospace technology.' },
];

export default function Home() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section style={{ position: 'relative', minHeight: '100vh', display: 'flex', alignItems: 'center', overflow: 'hidden' }}>
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 0,
            backgroundImage: 'url(/img/cover.webp)',
            backgroundSize: 'cover', backgroundPosition: 'center',
          }}
        />
        <div
          style={{
            position: 'absolute', inset: 0, zIndex: 1,
            background:
              'linear-gradient(180deg, rgba(5,6,10,0.55) 0%, rgba(5,6,10,0.35) 40%, rgba(5,6,10,0.85) 82%, var(--bg) 100%)',
          }}
        />
        <div className="container" style={{ position: 'relative', zIndex: 2, paddingTop: 'var(--nav-h)' }}>
          <div style={{ maxWidth: 860 }}>
            <span className="eyebrow fade-in">UC Berkeley · Est. 2014</span>
            <h1 style={{ fontSize: 'clamp(44px, 8.5vw, 104px)', margin: '20px 0 0', lineHeight: 0.98, fontWeight: 700 }}>
              We are <span className="ink-gradient">STAR</span>
            </h1>
            <p style={{ fontSize: 'clamp(19px, 2.4vw, 26px)', color: 'var(--text)', margin: '20px 0 0', maxWidth: '24ch', fontFamily: 'var(--font-display)', fontWeight: 400, letterSpacing: '-0.01em' }}>
              Berkeley's Space Technologies and Rocketry team.
            </p>
            <p style={{ fontSize: 18, color: 'var(--text-dim)', margin: '18px 0 0', maxWidth: '52ch' }}>
              Student-designed rockets, in-house avionics, and liquid-fuel engines —
              the longest and most successful launch history on campus.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 34 }}>
              <a href={SITE.applyUrl} className="btn btn-primary" style={{ fontSize: 16 }}>
                Apply to STAR <ArrowRight />
              </a>
              <Link to="/projects" className="btn btn-ghost" style={{ fontSize: 16 }}>
                Explore our launches
              </Link>
            </div>
          </div>
        </div>

        {/* scroll cue */}
        <div style={{ position: 'absolute', bottom: 26, left: '50%', transform: 'translateX(-50%)', zIndex: 2, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', fontSize: 11, letterSpacing: '0.2em', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
          SCROLL
          <span style={{ width: 1, height: 34, background: 'linear-gradient(var(--text-faint), transparent)' }} />
        </div>
      </section>

      {/* ── Stats bar ────────────────────────────────────────────────────── */}
      <section style={{ borderBottom: '1px solid var(--border)', borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.3)' }}>
        <div className="container" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 80} style={{ padding: '40px 12px', textAlign: 'center', borderLeft: i === 0 ? 'none' : '1px solid var(--border)' }}>
              <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'clamp(30px, 4vw, 44px)', letterSpacing: '-0.02em' }} className="ink-gradient">
                {s.value}
              </div>
              <div className="mono" style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 8, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
                {s.label}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Who we are ───────────────────────────────────────────────────── */}
      <section className="section">
        <div className="container" style={{ display: 'grid', gap: 'clamp(32px, 6vw, 72px)', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', alignItems: 'center' }}>
          <Reveal>
            <span className="eyebrow">Who we are</span>
            <h2 className="section-title">A decade of student-built flight.</h2>
            <p className="section-lead">
              STAR boasts the longest and most successful launch history on campus — eighteen complete
              vehicles engineered over our decade lifetime, and three liquid engines. Every vehicle is
              completely student-designed and tested, from our in-house avionics to our liquid-fuel
              propulsion.
            </p>
            <p className="section-lead">
              Our payloads have ranged from microbial power cells to muon detectors — and even
              rocket-deployed aircraft. We've flown as NASA Student Launch and now compete at the ESRA
              Spaceport America Cup and FAR.
            </p>
            <Link to="/projects" className="link-arrow" style={{ marginTop: 24, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              See the full launch history <ArrowRight />
            </Link>
          </Reveal>
          <Reveal delay={120}>
            <div style={{ borderRadius: 20, overflow: 'hidden', border: '1px solid var(--border)', aspectRatio: '4 / 3', boxShadow: '0 30px 80px rgba(0,0,0,0.5)' }}>
              <img src="/img/team-photo-new.webp" alt="The STAR team" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Ambitions ────────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <span className="eyebrow">Our ambitions</span>
            <h2 className="section-title" style={{ maxWidth: '18ch' }}>What we're reaching for.</h2>
          </Reveal>
          <div style={{ display: 'grid', gap: 22, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', marginTop: 48 }}>
            {AMBITIONS.map((a, i) => (
              <Reveal key={a.title} delay={i * 100}>
                <div className="card" style={{ padding: 32, height: '100%' }}>
                  <div className="mono" style={{ fontSize: 13, color: 'var(--gold)' }}>0{i + 1}</div>
                  <h3 style={{ fontSize: 24, marginTop: 14 }}>{a.title}</h3>
                  <p style={{ color: 'var(--text-dim)', marginTop: 12 }}>{a.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Subteams ─────────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal>
            <span className="eyebrow">Subteams</span>
            <h2 className="section-title">Many ways to build a rocket.</h2>
            <p className="section-lead">
              We welcome all majors and backgrounds. Find the corner of the vehicle that fascinates
              you — or try a few.
            </p>
          </Reveal>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 18, marginTop: 44 }}>
            {SUBTEAMS.map((t, i) => (
              <Reveal key={t.id} delay={(i % 4) * 70} style={{ flex: '0 1 250px' }}>
                <Link to="/join" className="card subteam-card" style={{ display: 'block', height: '100%' }}>
                  <div style={{ aspectRatio: '16 / 10', overflow: 'hidden' }}>
                    <img src={t.image} alt={t.name} loading="lazy" className="subteam-img" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: '18px 20px 22px' }}>
                    <h3 style={{ fontSize: 19 }}>{t.name}</h3>
                    <p style={{ color: 'var(--text-dim)', fontSize: 14.5, marginTop: 8, lineHeight: 1.55 }}>{t.blurb}</p>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
