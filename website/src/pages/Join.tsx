import PageHeader from '../components/PageHeader';
import { ArrowRight } from '../components/icons';
import { SUBTEAMS } from '../data/subteams';
import { SITE } from '../data/site';

const STEPS = [
  {
    title: 'Come to an infosession',
    body: 'Recruitment opens at the start of every semester. Come meet the team, see the hardware, and find out what we build.',
  },
  {
    title: 'Apply, no experience needed',
    body: "What makes STAR special is that we're education-focused. New members need zero prior experience; we teach you everything you need to know.",
  },
  {
    title: 'Get a mentor and an intro project',
    body: 'Every new member is paired with a mentor and completes a hands-on intro project that turns you into a fully functional member of the team.',
  },
  {
    title: 'Pick your subteam and fly',
    body: 'Join one (or more) of our subteams and start contributing to real rockets, from injectors to avionics to recovery.',
  },
];

export default function Join() {
  return (
    <>
      <PageHeader
        title={<>Build rockets. <span className="ink">Learn everything.</span></>}
        lead="All majors, all backgrounds, no experience required. We welcome anyone passionate about aerospace, and we'll teach you the rest."
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 30 }}>
          <a href={SITE.applyUrl} className="btn btn-primary" style={{ fontSize: 16 }}>
            Apply to STAR <ArrowRight />
          </a>
          <a href={SITE.wikiUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost" style={{ fontSize: 16 }}>
            Read the team wiki
          </a>
        </div>
      </PageHeader>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 64 }}>
        <div className="container">
          <h2 className="section-title">From zero to launch crew.</h2>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="mono" style={{ color: 'var(--gold)', fontSize: 13 }}>{i + 1}.</span>
                <h3 style={{ fontSize: 21, marginTop: 6 }}>{s.title}</h3>
                <p style={{ color: 'var(--text-dim)', fontSize: 15, marginTop: 10, lineHeight: 1.6, maxWidth: '52ch' }}>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* ── Subteams in full ─────────────────────────────────────────────── */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <h2 className="section-title">Where do you want to build?</h2>
          <p className="section-lead">Every subteam, one vehicle. Pick the discipline that excites you most.</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20, marginTop: 44 }}>
            {SUBTEAMS.map((t) => (
              <article key={t.id} className="card" style={{ display: 'flex', flexDirection: 'column', flex: '0 1 340px' }}>
                <div style={{ aspectRatio: '16 / 9', overflow: 'hidden' }}>
                  <img src={t.image} alt={t.name} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div style={{ padding: 24 }}>
                  <h3 style={{ fontSize: 21 }}>{t.name}</h3>
                  <p style={{ color: 'var(--text-dim)', fontSize: 14.5, marginTop: 10, lineHeight: 1.6 }}>{t.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
