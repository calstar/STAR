"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { UserMenu } from "@/components/UserMenu";

type EntityLite = { id: string; name: string; color: string | null };

function IconHome() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1v-8.5Z" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.2 2.4 2.4 4.6-5" />
    </svg>
  );
}
function IconList() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      <path d="M4 6h16M4 12h16M4 18h10" />
    </svg>
  );
}
function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V7Z" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="8.5" r="3" />
      <path d="M2.75 19c0-3.2 2.8-5.5 6.25-5.5s6.25 2.3 6.25 5.5" />
      <path d="M15.5 8.75a2.5 2.5 0 1 1 3.4 2.33" />
      <path d="M15 13.7c2.35.5 4 2.15 4.4 4.55" />
    </svg>
  );
}
function IconActivity() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12h3.5l2-7 4 14 2-9.5 1.5 2.5H21" />
    </svg>
  );
}
function IconChevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
      {direction === "left" ? (
        <path fillRule="evenodd" clipRule="evenodd" d="M12.28 4.22a.75.75 0 0 1 0 1.06L7.56 10l4.72 4.72a.75.75 0 1 1-1.06 1.06l-5.25-5.25a.75.75 0 0 1 0-1.06l5.25-5.25a.75.75 0 0 1 1.06 0Z" />
      ) : (
        <path fillRule="evenodd" clipRule="evenodd" d="M7.72 4.22a.75.75 0 0 1 1.06 0l5.25 5.25a.75.75 0 0 1 0 1.06l-5.25 5.25a.75.75 0 0 1-1.06-1.06L12.44 10 7.72 5.28a.75.75 0 0 1 0-1.06Z" />
      )}
    </svg>
  );
}
function IconMenu({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden>
      {open ? (
        <path fillRule="evenodd" clipRule="evenodd" d="M4.22 4.22a.75.75 0 0 1 1.06 0L10 8.94l4.72-4.72a.75.75 0 1 1 1.06 1.06L11.06 10l4.72 4.72a.75.75 0 1 1-1.06 1.06L10 11.06l-4.72 4.72a.75.75 0 0 1-1.06-1.06L8.94 10 4.22 5.28a.75.75 0 0 1 0-1.06Z" />
      ) : (
        <path fillRule="evenodd" clipRule="evenodd" d="M2.75 5.25a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Zm0 4.75a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Zm0 4.75a.75.75 0 0 1 .75-.75h13a.75.75 0 0 1 0 1.5h-13a.75.75 0 0 1-.75-.75Z" />
      )}
    </svg>
  );
}

const SECTION_LIMIT = 6;

// One nav row: an icon, a label, and the active rule the section below decides.
// `collapsed` shrinks it to a centered icon with the label as a native tooltip.
function NavLink({
  href,
  label,
  icon,
  active,
  collapsed,
  onClick,
}: {
  href: string;
  label: string;
  icon: ReactNode;
  active: boolean;
  collapsed?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      title={collapsed ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-lg text-sm font-medium sm:min-h-9 ${
        collapsed ? "justify-center px-0" : "px-3"
      } ${
        active
          ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
      }`}
    >
      <span className={active ? "" : "text-neutral-400 dark:text-neutral-500"}>{icon}</span>
      {!collapsed && label}
    </Link>
  );
}

// A sidebar section: an icon-led label linking to the full list, then up to
// SECTION_LIMIT real records (color dot + name), then an overflow link — only
// what the workspace actually contains, never a placeholder row.
function EntitySection({
  title,
  href,
  icon,
  items,
  active,
  activeHref,
  onNavigate,
}: {
  title: string;
  href: string;
  icon: ReactNode;
  items: EntityLite[];
  active: boolean;
  activeHref: string;
  onNavigate?: () => void;
}) {
  const shown = items.slice(0, SECTION_LIMIT);
  const overflow = items.length - shown.length;
  return (
    <div className="mt-5">
      <Link
        href={href}
        onClick={onNavigate}
        className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium sm:min-h-9 ${
          active
            ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
            : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        }`}
      >
        <span className={active ? "" : "text-neutral-400 dark:text-neutral-500"}>{icon}</span>
        {title}
      </Link>
      <div className="mt-0.5 space-y-0.5">
        {shown.length === 0 && (
          <p className="px-3 py-1 pl-11 text-sm text-neutral-400 dark:text-neutral-600">None yet</p>
        )}
        {shown.map((item) => (
          <Link
            key={item.id}
            href={`${href}/${item.id}`}
            onClick={onNavigate}
            className={`flex min-h-11 items-center gap-2.5 rounded-lg py-2 pl-11 pr-3 text-sm sm:min-h-9 sm:py-0 ${
              activeHref === `${href}/${item.id}`
                ? "font-medium text-neutral-900 dark:text-neutral-100"
                : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            }`}
          >
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: item.color ?? "#a3a3a3" }}
            />
            <span className="truncate">{item.name}</span>
          </Link>
        ))}
        {overflow > 0 && (
          <Link
            href={href}
            onClick={onNavigate}
            className="flex min-h-11 items-center py-2 pl-11 pr-3 text-sm text-neutral-400 hover:text-neutral-700 sm:min-h-9 sm:py-0 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            +{overflow} more
          </Link>
        )}
      </div>
    </div>
  );
}

function Brand({ collapsed }: { collapsed?: boolean }) {
  if (collapsed) {
    return (
      <Link href="/" className="flex items-center justify-center" title="STAR Project">
        {/* The navy icon disappears on the dark rail and the white one on the
            light rail, so each theme gets its own. */}
        <Image src="/star-icon-blue.png" alt="STAR" width={32} height={32} priority unoptimized className="h-7 w-7 dark:hidden" />
        <Image src="/star-icon.svg" alt="STAR" width={32} height={32} priority unoptimized className="hidden h-7 w-7 dark:block" />
      </Link>
    );
  }
  return (
    <Link href="/" className="flex items-center gap-2 px-3 leading-none">
      <Image src="/star-blue.png" alt="STAR" width={5016} height={1772} priority unoptimized className="h-7 w-auto dark:hidden" />
      <Image src="/star-wordmark.png" alt="STAR" width={5016} height={1772} priority unoptimized className="hidden h-7 w-auto dark:block" />
      <span className="text-lg font-semibold leading-none tracking-tight text-neutral-900 dark:text-neutral-100">
        Project
      </span>
    </Link>
  );
}

const SIDEBAR_COLLAPSE_KEY = "starproject:sidebar-collapsed";

export function SidebarNav({
  userName,
  userEmail,
  isAdmin,
  projects,
  subteams,
}: {
  userName: string;
  userEmail: string;
  isAdmin: boolean;
  projects: EntityLite[];
  subteams: EntityLite[];
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Desktop-rail collapse. Starts expanded (matching the server-rendered
  // markup) and reads the viewer's saved preference after mount, so hydration
  // never has to reconcile against a value only the client can know.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1");
    } catch {
      // Private-browsing/blocked storage: stay expanded.
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // Nothing to persist to; the toggle still works for this load.
      }
      return next;
    });
  };

  useEffect(() => {
    setOpen(false);
  }, [pathname, searchParams]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: PointerEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const mine = searchParams.get("mine") === "1";
  const isHome = pathname === "/";
  const isMyTasks = pathname === "/tasks" && mine;
  const isTasks = pathname === "/tasks" && !mine;
  const isProjects = pathname === "/projects" || pathname.startsWith("/projects/");
  const isSubteams = pathname === "/subteams" || pathname.startsWith("/subteams/");
  const isActivity = pathname === "/activity";

  // Shared between the desktop rail (which alone may be `collapsed`) and the
  // mobile drawer (always full) so the two never drift apart otherwise.
  function NavContent({
    collapsed = false,
    onNavigate,
  }: {
    collapsed?: boolean;
    onNavigate?: () => void;
  }) {
    return (
      <>
        <Brand collapsed={collapsed} />
        <nav className="mt-6 space-y-0.5">
          <NavLink href="/" label="Home" icon={<IconHome />} active={isHome} collapsed={collapsed} onClick={onNavigate} />
          <NavLink href="/tasks?mine=1" label="My tasks" icon={<IconCheck />} active={isMyTasks} collapsed={collapsed} onClick={onNavigate} />
          <NavLink href="/tasks" label="Tasks" icon={<IconList />} active={isTasks} collapsed={collapsed} onClick={onNavigate} />
          <NavLink href="/activity" label="Activity" icon={<IconActivity />} active={isActivity} collapsed={collapsed} onClick={onNavigate} />
          {collapsed && (
            <>
              <NavLink href="/projects" label="Projects" icon={<IconFolder />} active={isProjects} collapsed onClick={onNavigate} />
              <NavLink href="/subteams" label="Subteams" icon={<IconUsers />} active={isSubteams} collapsed onClick={onNavigate} />
            </>
          )}
        </nav>
        {!collapsed && (
          <>
            <EntitySection
              title="Projects"
              href="/projects"
              icon={<IconFolder />}
              items={projects}
              active={isProjects}
              activeHref={pathname}
              onNavigate={onNavigate}
            />
            <EntitySection
              title="Subteams"
              href="/subteams"
              icon={<IconUsers />}
              items={subteams}
              active={isSubteams}
              activeHref={pathname}
              onNavigate={onNavigate}
            />
          </>
        )}
        <div className={`mt-auto pt-5 ${collapsed ? "px-2" : "px-3"}`}>
          {isAdmin && !collapsed && (
            <Link
              href="/workspace"
              onClick={onNavigate}
              className="mb-2 flex min-h-11 items-center px-0 text-sm text-neutral-500 hover:text-neutral-900 sm:min-h-0 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              Workspace setup
            </Link>
          )}
          <div className={collapsed ? "flex justify-center" : "px-1"}>
            <UserMenu name={userName} email={userEmail} isAdmin={isAdmin} compact={collapsed} />
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {/* Mobile top bar: only the two things a phone screen needs when the
          rail is hidden — the way in (hamburger) and the account (avatar). */}
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-3 lg:hidden dark:border-neutral-800 dark:bg-neutral-900">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="mobile-sidebar"
          aria-label="Menu"
          className="flex h-11 w-11 items-center justify-center rounded-md text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <IconMenu open={open} />
        </button>
        <Link href="/" className="flex items-center">
          <Image src="/star-blue.png" alt="STAR" width={5016} height={1772} priority unoptimized className="h-6 w-auto dark:hidden" />
          <Image src="/star-wordmark.png" alt="STAR" width={5016} height={1772} priority unoptimized className="hidden h-6 w-auto dark:block" />
        </Link>
        <UserMenu name={userName} email={userEmail} isAdmin={isAdmin} />
      </header>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/30" aria-hidden />
          <div
            ref={drawerRef}
            id="mobile-sidebar"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col overflow-y-auto border-r border-neutral-200 bg-white py-4 shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
          >
            <NavContent onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop rail. The scroll container is a nested div (not the `aside`
          itself) so the collapse toggle can hang off the right edge without
          `overflow-y-auto` on the same box clipping it. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-neutral-200 bg-white transition-[width] duration-150 lg:flex dark:border-neutral-800 dark:bg-neutral-900 ${
          collapsed ? "w-[68px]" : "w-64"
        }`}
      >
        <div className="flex h-full w-full flex-col overflow-y-auto py-5">
          <NavContent collapsed={collapsed} />
        </div>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-6 hidden h-6 w-6 items-center justify-center rounded-full border border-neutral-300 bg-white text-neutral-500 shadow-sm hover:text-neutral-900 lg:flex dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
        >
          <IconChevron direction={collapsed ? "right" : "left"} />
        </button>
      </aside>
    </>
  );
}
