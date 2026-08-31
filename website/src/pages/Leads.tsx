import PageHeader from '../components/PageHeader';
import Reveal from '../components/Reveal';
import { LEAD_GROUPS } from '../data/leads';
import type { Lead } from '../data/leads';

function initials(role: string) {
  return role.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
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
              <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                {group.leads.map((lead, i) => (
                  <Reveal key={lead.id} delay={(i % 4) * 70}>
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
    <div className="card" style={{ padding: 24, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div className="avatar">
          {lead.image ? (
            <img src={lead.image} alt={lead.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span>{initials(lead.role)}</span>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 11.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--gold)' }}>
            {lead.role}
          </div>
          <div style={{ fontFamily: 'var(--font-display)', fontWeight: 600, fontSize: 19, marginTop: 2, color: isTBD ? 'var(--text-faint)' : 'var(--text)' }}>
            {lead.name}
          </div>
        </div>
      </div>
      <p style={{ color: 'var(--text-dim)', fontSize: 14.5, lineHeight: 1.6, marginTop: 16 }}>{lead.bio}</p>
    </div>
  );
}
