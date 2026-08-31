import type { ReactNode } from 'react';

/** Compact hero for inner pages: eyebrow + title + optional lead. */
export default function PageHeader({
  eyebrow,
  title,
  lead,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lead?: string;
  children?: ReactNode;
}) {
  return (
    <section style={{ paddingTop: 'calc(var(--nav-h) + 72px)', paddingBottom: 8 }}>
      <div className="container">
        <span className="eyebrow">{eyebrow}</span>
        <h1 style={{ fontSize: 'clamp(38px, 6vw, 68px)', margin: '18px 0 0', maxWidth: '16ch' }}>{title}</h1>
        {lead && <p className="section-lead" style={{ fontSize: 19 }}>{lead}</p>}
        {children}
      </div>
    </section>
  );
}
