import { useEffect, useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { SITE } from '../data/site';
import wordmark from '../assets/star-wordmark.png';

const LINKS = [
  { to: '/projects', label: 'Projects' },
  { to: '/leads', label: 'Leads' },
  { to: '/sponsors', label: 'Sponsors' },
  { to: '/join', label: 'Join' },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Lock scroll while the mobile menu is open.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  return (
    <header
      style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100,
        height: 'var(--nav-h)',
        borderBottom: `1px solid ${scrolled ? 'var(--border)' : 'transparent'}`,
        background: scrolled ? 'rgba(5,6,10,0.72)' : 'transparent',
        backdropFilter: scrolled ? 'blur(14px)' : 'none',
        WebkitBackdropFilter: scrolled ? 'blur(14px)' : 'none',
        transition: 'background .3s ease, border-color .3s ease',
      }}
    >
      <nav className="container" style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Link to="/" onClick={() => setOpen(false)} style={{ display: 'flex', alignItems: 'center' }}>
          <img src={wordmark} alt="STAR" style={{ height: 34, width: 'auto', display: 'block' }} />
        </Link>

        {/* Desktop links */}
        <div className="nav-desktop" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} className="nav-link" style={navLinkStyle}>
              {l.label}
            </NavLink>
          ))}
          <a href={SITE.donateUrl} className="nav-link" style={navLinkStyle}>Donate</a>
          <a href={SITE.applyUrl} className="btn btn-primary" style={{ marginLeft: 10, padding: '10px 18px', fontSize: 14 }}>
            Apply
          </a>
        </div>

        {/* Mobile toggle */}
        <button
          className="nav-burger"
          aria-label="Menu"
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'none', background: 'none', border: 0, cursor: 'pointer',
            width: 40, height: 40, position: 'relative', color: 'var(--text)',
          }}
        >
          <span style={burgerLine(open, 0)} />
          <span style={burgerLine(open, 1)} />
          <span style={burgerLine(open, 2)} />
        </button>
      </nav>

      {/* Mobile drawer */}
      <div
        className="nav-mobile"
        style={{
          position: 'fixed', inset: 'var(--nav-h) 0 0 0', zIndex: 99,
          background: 'rgba(5,6,10,0.97)', backdropFilter: 'blur(16px)',
          display: open ? 'flex' : 'none', flexDirection: 'column',
          padding: '24px', gap: 6,
        }}
      >
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} onClick={() => setOpen(false)} style={mobileLinkStyle}>
            {l.label}
          </NavLink>
        ))}
        <a href={SITE.donateUrl} onClick={() => setOpen(false)} style={mobileLinkStyle}>Donate</a>
        <a href={SITE.applyUrl} className="btn btn-primary" style={{ marginTop: 16, justifyContent: 'center' }}>
          Apply to STAR
        </a>
      </div>
    </header>
  );
}

const navLinkStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 15,
  fontWeight: 500,
  color: 'var(--text-dim)',
  padding: '8px 14px',
  borderRadius: 4,
  transition: 'color .2s ease',
};

const mobileLinkStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 22,
  fontWeight: 600,
  color: 'var(--text)',
  padding: '14px 8px',
  borderBottom: '1px solid var(--border)',
};

function burgerLine(open: boolean, i: number): React.CSSProperties {
  const base: React.CSSProperties = {
    position: 'absolute', left: 9, right: 9, height: 2, borderRadius: 2,
    background: 'currentColor', transition: 'transform .3s ease, opacity .2s ease',
  };
  const y = [14, 20, 26][i];
  if (!open) return { ...base, top: y };
  if (i === 1) return { ...base, top: 20, opacity: 0 };
  return { ...base, top: 20, transform: `rotate(${i === 0 ? 45 : -45}deg)` };
}
