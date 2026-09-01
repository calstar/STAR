import { Link } from 'react-router-dom';
import { SITE } from '../data/site';
import { Instagram, YouTube, LinkedIn, Facebook, Mail, ArrowRight } from './icons';

export default function Footer() {
  const socials = [
    { href: SITE.socials.instagram, label: 'Instagram', Icon: Instagram },
    { href: SITE.socials.youtube, label: 'YouTube', Icon: YouTube },
    { href: SITE.socials.linkedin, label: 'LinkedIn', Icon: LinkedIn },
    { href: SITE.socials.facebook, label: 'Facebook', Icon: Facebook },
  ];

  return (
    <footer style={{ borderTop: '1px solid var(--border)', background: 'rgba(0,0,0,0.35)', position: 'relative', zIndex: 1 }}>
      {/* CTA band */}
      <div className="container" style={{ padding: '72px 24px 0' }}>
        <div
          style={{
            display: 'flex', flexWrap: 'wrap', gap: 28, alignItems: 'center',
            justifyContent: 'space-between',
            border: '1px solid var(--border-strong)', borderRadius: 6,
            padding: '40px clamp(24px, 5vw, 52px)',
            background: 'linear-gradient(120deg, rgba(255,182,72,0.10), rgba(91,140,255,0.08))',
          }}
        >
          <div>
            <h2 style={{ fontSize: 'clamp(24px, 3.5vw, 34px)' }}>Build rockets with us.</h2>
            <p style={{ color: 'var(--text-dim)', margin: '10px 0 0', maxWidth: '46ch' }}>
              No experience required, we teach you everything. Recruitment opens every semester.
            </p>
          </div>
          <Link to="/join" className="btn btn-primary" style={{ fontSize: 16 }}>
            Join STAR <ArrowRight />
          </Link>
        </div>
      </div>

      {/* Link columns */}
      <div className="container" style={{ padding: '56px 24px 40px', display: 'grid', gap: 40, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <div style={{ minWidth: 200 }}>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 20, letterSpacing: '0.02em' }}>
            STAR
          </div>
          <p style={{ color: 'var(--text-faint)', fontSize: 14, margin: '12px 0 18px', maxWidth: '34ch' }}>
            {SITE.tagline}.
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            {socials.map(({ href, label, Icon }) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer" aria-label={label} className="social-btn">
                <Icon />
              </a>
            ))}
          </div>
        </div>

        <FooterCol title="Explore" links={[
          { label: 'Projects', to: '/projects' },
          { label: 'Leads', to: '/leads' },
          { label: 'Sponsors', to: '/sponsors' },
          { label: 'Join', to: '/join' },
        ]} />

        <FooterCol title="Connect" links={[
          { label: 'Apply', href: SITE.applyUrl },
          { label: 'Donate', href: SITE.donateUrl },
          { label: 'Team Wiki', href: SITE.wikiUrl },
          { label: 'Contact', href: `mailto:${SITE.contactEmail}` },
        ]} />

        <div>
          <div className="footer-col-title">Get in touch</div>
          <a href={`mailto:${SITE.contactEmail}`} className="footer-link" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Mail /> {SITE.contactEmail}
          </a>
        </div>
      </div>

      <hr className="hairline" />

      <div className="container" style={{ padding: '22px 24px 40px', display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-faint)', fontSize: 13 }}>
        <span className="mono">© {new Date().getFullYear()} Space Technologies and Rocketry</span>
        <span style={{ flex: '1 1 320px', minWidth: 0, maxWidth: '70ch', lineHeight: 1.5 }}>
          We are a student group acting independently of the University of California. We take full
          responsibility for our organization and this website.
        </span>
        <a
          href="https://www.ocf.berkeley.edu/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Hosted by the Open Computing Facility"
          style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
        >
          <img src="/img/svg/ocf-hosted-penguin-dark.svg" alt="Hosted by the OCF" style={{ height: 44, width: 'auto', display: 'block' }} />
        </a>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: { label: string; to?: string; href?: string }[] }) {
  return (
    <div>
      <div className="footer-col-title">{title}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {links.map((l) => (
          <li key={l.label}>
            {l.to ? (
              <Link to={l.to} className="footer-link">{l.label}</Link>
            ) : (
              <a href={l.href} className="footer-link" target={l.href?.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{l.label}</a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
