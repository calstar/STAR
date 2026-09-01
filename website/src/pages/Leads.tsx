import PageHeader from '../components/PageHeader';
import Reveal from '../components/Reveal';
import { LEAD_GROUPS } from '../data/leads';
import type { Lead } from '../data/leads';

function initials(s: string) {
  return s.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

function yearLabel(n: number) {
  return `${n}${['th', 'st', 'nd', 'rd'][(n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13)) ? 0 : n % 10]}`;
}

export default function Leads() {
  return (
    <>
      <PageHeader
        eyebrow="The Team"
        title={<>Meet the <span className="ink-gradient">leads.</span></>}
        lead="The students steering each subteam and the club as a whole. Have a question about joining? Reach out to any of them."
      />

      <section className="section" style={{ paddingTop: 48 }}>
        <div className="container" style={{ display: 'flex', flexDirection: 'column', gap: 64 }}>
          {LEAD_GROUPS.map((group) => (
            <div key={group.title}>
              <Reveal>
                <h2 style={{ fontSize: 'clamp(20px, 2.6vw, 26px)', marginBottom: 24 }}>{group.title}</h2>
              </Reveal>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 20 }}>
                {group.leads.map((lead, i) => (
                  <Reveal key={lead.id} delay={(i % 4) * 70} style={{ flex: '1 1 300px', maxWidth: 400 }}>
                    <LeadCard lead={lead} />
                  </Reveal>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function LeadCard({ lead }: { lead: Lead }) {
  const isTBD = lead.name === 'TBD';
  return (
    <div className="card" style={{ overflow: 'hidden', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="lead-photo">
        {lead.image ? (
          <img src={lead.image} alt={lead.name} loading="lazy" />
        ) : (
          <span className="lead-initials">{initials(isTBD ? lead.role : lead.name)}</span>
        )}
      </div>
      <div style={{ padding: 22, display: 'flex', flexDirection: 'column' }}>
        <div className="mono" style={{ fontSize: 11.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--gold)' }}>
          {lead.role}
        </div>
        <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 20, marginTop: 3, color: isTBD ? 'var(--text-faint)' : 'var(--text)' }}>
          {lead.name}
        </div>
        {(lead.year || lead.major) && (
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>
            {[lead.year && `${yearLabel(lead.year)} year`, lead.major].filter(Boolean).join(' · ')}
          </div>
        )}
        <p style={{ color: 'var(--text-dim)', fontSize: 14, lineHeight: 1.55, marginTop: 12 }}>{lead.bio}</p>
      </div>
    </div>
  );
}
