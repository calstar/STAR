import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import Reveal from '../components/Reveal';
import { ArrowRight } from '../components/icons';
import { SUBTEAMS } from '../data/subteams';
import { SITE } from '../data/site';

const STEPS = [
  {
    n: '01',
    title: 'Come to an infosession',
    body: 'Recruitment opens at the start of every semester. Come meet the team, see the hardware, and find out what we build.',
  },
  {
    n: '02',
    title: 'Apply, no experience needed',
    body: "What makes STAR special is that we're education-focused. New members need zero prior experience; we teach you everything you need to know.",
  },
  {
    n: '03',
    title: 'Get a mentor & an intro project',
    body: 'Every new member is paired with a mentor and completes a hands-on intro project that turns you into a fully functional member of the team.',
  },
  {
    n: '04',
    title: 'Pick your subteam & fly',
    body: 'Join one (or more) of our subteams and start contributing to real rockets, from injectors to avionics to recovery.',
  },
];

export default function Join() {
  return (
    <>
      <PageHeader
        eyebrow="Join STAR"
        title={<>Build rockets. <span className="ink-gradient">Learn everything.</span></>}
        lead="All majors, all backgrounds, no experience required. We welcome anyone passionate about aerospace, and we'll teach you the rest."
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 30 }}>
          <a href={SITE.applyUrl} className="btn btn-primary" style={{ fontSize: 16 }}>
            Apply now <ArrowRight />
          </a>
          <a href={SITE.wikiUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost" style={{ fontSize: 16 }}>
            Read the team wiki
          </a>
        </div>
      </PageHeader>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 64 }}>
        <div className="container">
          <Reveal>
            <span className="eyebrow">How it works</span>
            <h2 className="section-title">From zero to launch crew.</h2>
          </Reveal>
          <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: 44 }}>
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 90}>
                <div className="card" style={{ padding: 28, height: '100%' }}>
                  <div className="ink-gradient" style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 34 }}>{s.n}</div>
                  <h3 style={{ fontSize: 20, marginTop: 14 }}>{s.title}</h3>
                  <p style={{ color: 'var(--text-dim)', fontSize: 14.5, marginTop: 10, lineHeight: 1.6 }}>{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Subteams in full ─────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal>
            <span className="eyebrow">Find your subteam</span>
            <h2 className="section-title">Where do you want to build?</h2>
            <p className="section-lead">Every subteam, one vehicle. Pick the discipline that excites you most.</p>
          </Reveal>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20, marginTop: 44 }}>
            {SUBTEAMS.map((t, i) => (
              <Reveal key={t.id} delay={(i % 3) * 80} style={{ flex: '0 1 340px' }}>
                <article className="card" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div style={{ aspectRatio: '16 / 9', overflow: 'hidden' }}>
                    <img src={t.image} alt={t.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  </div>
                  <div style={{ padding: 24 }}>
                    <h3 style={{ fontSize: 21 }}>{t.name}</h3>
                    <p style={{ color: 'var(--text-dim)', fontSize: 14.5, marginTop: 10, lineHeight: 1.6 }}>{t.description}</p>
                  </div>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal>
            <div style={{ textAlign: 'center', border: '1px solid var(--border-strong)', borderRadius: 24, padding: 'clamp(40px, 7vw, 80px)', background: 'radial-gradient(120% 140% at 50% 0%, rgba(255,182,72,0.12), transparent 60%)' }}>
              <h2 style={{ fontSize: 'clamp(28px, 5vw, 48px)' }}>Ready to reach space?</h2>
              <p style={{ color: 'var(--text-dim)', fontSize: 18, margin: '16px auto 0', maxWidth: '46ch' }}>
                Applications open every semester. Come build the next record-breaking vehicle with us.
              </p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, justifyContent: 'center', marginTop: 30 }}>
                <a href={SITE.applyUrl} className="btn btn-primary" style={{ fontSize: 16 }}>
                  Apply to STAR <ArrowRight />
                </a>
                <Link to="/projects" className="btn btn-ghost" style={{ fontSize: 16 }}>See what we've built</Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
