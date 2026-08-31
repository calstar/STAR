import PageHeader from '../components/PageHeader';
import Reveal from '../components/Reveal';
import { ArrowRight, Mail } from '../components/icons';
import { SPONSORS } from '../data/sponsors';
import { SITE } from '../data/site';

export default function Sponsors() {
  return (
    <>
      {/* Header over an ALULA-on-the-rail backdrop that fades out lower down */}
      <section style={{ position: 'relative', overflow: 'hidden', paddingBottom: 'clamp(180px, 26vw, 360px)' }}>
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            backgroundImage: 'url(/img/sponsors-hero.webp)',
            backgroundSize: 'cover', backgroundPosition: 'center 26%',
            opacity: 0.7,
          }}
        />
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0,
            background: 'linear-gradient(180deg, rgba(5,6,10,0.28) 0%, rgba(5,6,10,0.4) 45%, rgba(5,6,10,0.72) 84%, var(--bg) 100%)',
          }}
        />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <PageHeader
            eyebrow="Sponsors"
            title={<>Powered by our <span className="ink-gradient">partners.</span></>}
            lead="Your monetary and material contributions promote the growth of students as engineers and a commitment to education and the future. Thank you."
          />
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0, marginTop: 'clamp(-260px, -20vw, -140px)', position: 'relative', zIndex: 2 }}>
        <div className="container">
          <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(165px, 1fr))' }}>
            {SPONSORS.map((s, i) => (
              <Reveal key={s.name} delay={(i % 5) * 55}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className="sponsor-tile" title={s.name}>
                  <img src={s.logo} alt={s.name} loading="lazy" className="sponsor-logo" />
                  <span className="sponsor-name">{s.name}</span>
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Become a sponsor */}
      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container">
          <Reveal>
            <div
              style={{
                border: '1px solid var(--border-strong)', borderRadius: 22,
                padding: 'clamp(32px, 6vw, 60px)',
                background: 'linear-gradient(120deg, rgba(91,140,255,0.10), rgba(143,123,255,0.08))',
                display: 'grid', gap: 28, gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', alignItems: 'center',
              }}
            >
              <div>
                <span className="eyebrow">Partner with us</span>
                <h2 className="section-title" style={{ fontSize: 'clamp(26px, 4vw, 38px)' }}>Become a STAR sponsor.</h2>
                <p className="section-lead">
                  Sponsoring STAR puts your brand in front of some of Berkeley's most driven engineers
                  and directly funds hardware, test campaigns, and competition. Reach out for our
                  sponsorship packet.
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'flex-start' }}>
                <a href={`mailto:${SITE.contactEmail}?subject=STAR%20Sponsorship`} className="btn btn-primary" style={{ fontSize: 16 }}>
                  <Mail /> Get in touch <ArrowRight />
                </a>
                <a href={`mailto:${SITE.contactEmail}`} className="footer-link mono" style={{ fontSize: 14 }}>
                  {SITE.contactEmail}
                </a>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
