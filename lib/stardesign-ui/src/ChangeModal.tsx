/**
 * The "Change" dialog: everything you can do to the set of designs, in one
 * place. It replaces the New / Rename / Delete buttons that used to sit in the
 * bar (delete is gone entirely -- see backend/routers/documents.py).
 *
 * Two tabs, because there are two genuinely different relationships to a design:
 *
 * - **Editable** -- yours, plus anything shared with you. These open in place;
 *   editing one writes to wherever it actually lives, so co-editors see it.
 * - **View only** -- everyone else's, grouped by owner. Clicking one *copies*
 *   it to you and opens the copy. There is no read-only viewing mode: a copy is
 *   both what people actually want and the only thing that cannot surprise the
 *   original's owner.
 *
 * Sharing is symmetric on purpose: whoever is on the list is an editor, the
 * creator included, and any of them can change the list. See the backend for
 * why that is housekeeping rather than a permission boundary.
 *
 * An app that runs open to all (pid-designer) passes `openToAll`: every design
 * is editable by everyone, so sharing has nothing to say and is hidden, and the
 * tabs become **Recent** and **Older** -- the second holds designs that have
 * gone quiet, which open in place rather than only copy. One that has a main
 * design passes `featured`; admins then get Make main / Unset main.
 *
 * A curated app (pid-designer) passes `curated`. The tabs become **STAR** -- the
 * designs admins chose for everyone -- and **Other** (for an admin, everyone
 * else's; for anyone else, their own and those shared with them). Sharing is
 * the creator's or an admin's; anyone else may ask to edit, and the requests
 * head the dialog for whoever can answer them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keyOf, refOf } from './api';
import type { BrowseGroup, DesignApi, DesignMeta, DocRef, FeaturedState, TeamUser } from './api';
import { btn, ghostBtn, primaryBtn, relativeTime } from './theme';
import { Modal } from './Modal';

/** In a curated app, `editable` is the STAR tab and `viewonly` is Other. */
type Tab = 'editable' | 'viewonly';

interface Props<T> {
  open: boolean;
  onClose: () => void;
  /** This app's design API. The one thing that differs between the tools. */
  api: DesignApi<T>;
  /** Singular, lower case: "design" / "config" / "diagram". Used in copy only. */
  noun: string;
  documents: DesignMeta[];
  activeKey: string | null;
  onSelect: (ref: DocRef) => void;
  onCreate: (name: string) => Promise<void>;
  onRename: (ref: DocRef, name: string) => Promise<void>;
  /** Replaces the whole editor list. */
  onShare: (ref: DocRef, emails: string[]) => Promise<void>;
  onLeave: (ref: DocRef) => Promise<void>;
  onCopy: (ref: DocRef) => Promise<void>;
  /** Every design is editable by everyone; others' go to Older after this many days. */
  openToAll?: { recentDays: number };
  /** Open a design from Older in place. It is not in `documents`, so the row's
   *  metadata comes along for the app to add it. */
  onOpen?: (ref: DocRef, meta: DesignMeta) => void;
  /** The main design and whether the caller is an admin. */
  featured?: FeaturedState | null;
  /** Make a design the main one, or (null) unset it. Admins only. */
  onFeature?: (ref: DocRef | null, owner: string) => Promise<void>;
  /** The STAR collection: admins choose what everyone sees, editing is by request. */
  curated?: {
    /** Add to the STAR set, or take out. Admins only. */
    onStar: (ref: DocRef, on: boolean) => Promise<void>;
    /** Ask to edit, or withdraw the request. */
    onRequest: (ref: DocRef, on: boolean) => Promise<void>;
    /** Approve or deny someone's request. Creator or admin. */
    onAnswer: (ref: DocRef, email: string, approve: boolean) => Promise<void>;
  };
}

export function ChangeModal<T>({
  open, onClose, api, noun, documents, activeKey,
  onSelect, onCreate, onRename, onShare, onLeave, onCopy,
  openToAll, onOpen, featured, onFeature, curated,
}: Props<T>) {
  const admin = !!(featured?.isAdmin && onFeature);
  const requests = curated
    ? documents.flatMap((d) => (d.accessRequests ?? []).map((r) => ({ d, r })))
    : [];
  // "design" -> "Design". The apps call the same thing three different names,
  // and the copy in here is the only place that shows.
  const Noun = noun[0].toUpperCase() + noun.slice(1);

  const [tab, setTab] = useState<Tab>('editable');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  // Inline editors, at most one open at a time: a row becomes a text field
  // (rename) or a people picker (share) rather than stacking a second modal.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [sharing, setSharing] = useState<string | null>(null);
  const [shareSel, setShareSel] = useState<string[]>([]);
  const [shareFilter, setShareFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  const [tree, setTree] = useState<BrowseGroup[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [users, setUsers] = useState<TeamUser[]>([]);

  const reset = useCallback(() => {
    setRenaming(null); setSharing(null); setCreating(false);
    setNewName(''); setShareFilter(''); setError('');
  }, []);

  // Mounted only while open (the parent unmounts it on close), so this runs
  // once per opening -- which is what we want: both lists go stale as soon as
  // the dialog closes, since someone else may have shared something meanwhile.
  useEffect(() => {
    let cancelled = false;
    // Curated, the list already holds everything you may see; browse is empty.
    if (curated) setTree([]);
    else void api.browse().then((t) => !cancelled && setTree(t)).catch(() => !cancelled && setTree([]));
    // A missing roster is survivable -- you can still rename, create and copy;
    // only the share picker has nothing to offer.
    void api.listUsers().then((u) => !cancelled && setUsers(u)).catch(() => !cancelled && setUsers([]));
    return () => { cancelled = true; };
  }, []);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  };

  const shareCandidates = useMemo(() => {
    const q = shareFilter.trim().toLowerCase();
    return users.filter((u) => !q || u.email.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
  }, [users, shareFilter]);

  const startShare = (d: DesignMeta) => {
    reset();
    setSharing(keyOf(refOf(d)));
    setShareSel(d.sharedWith ?? []);
  };

  const toggleShare = (email: string) =>
    setShareSel((sel) =>
      sel.some((e) => e.toLowerCase() === email.toLowerCase())
        ? sel.filter((e) => e.toLowerCase() !== email.toLowerCase())
        : [...sel, email],
    );

  const removed = (d: DesignMeta) =>
    (d.sharedWith ?? []).filter((e) => !shareSel.some((s) => s.toLowerCase() === e.toLowerCase()));

  // Curated, the one list splits across the two tabs; otherwise the first tab
  // is the whole list and the second is the browse tree.
  const rows = curated
    ? documents.filter((d) => (tab === 'editable') === !!d.star)
    : documents;

  const tabBtn = (t: Tab) =>
    `border-b-2 px-3 pb-2 text-xs font-medium transition-colors ${
      tab === t
        ? 'border-[var(--color-accent)] text-[var(--color-text-primary)]'
        : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
    }`;

  return (
    <Modal open={open} onClose={onClose} title={`${Noun}s`} width={curated ? 'w-[720px]' : 'w-[560px]'}>
      <div className="-mt-2 mb-3 flex border-b border-[var(--color-border)]">
        <button className={tabBtn('editable')} onClick={() => { setTab('editable'); reset(); }}>
          {curated ? 'STAR' : openToAll ? 'Recent' : 'Editable'}
        </button>
        <button className={tabBtn('viewonly')} onClick={() => { setTab('viewonly'); reset(); }}>
          {curated ? (featured?.isAdmin ? 'Other' : 'Yours') : openToAll ? 'Older' : 'View only'}
        </button>
      </div>

      {error && <p className="mb-2 text-xs text-red-500">{error}</p>}

      {requests.length > 0 && (
        <div className="mb-3 rounded border border-[var(--color-accent)] p-2">
          <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-[var(--color-text-muted)]">
            {`Asking to edit (${requests.length})`}
          </p>
          {requests.map(({ d, r }) => {
            const ref = refOf(d);
            const key = `req:${keyOf(ref)}:${r.email}`;
            return (
              <div key={key} className="flex items-center gap-2 py-1">
                <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]" title={r.email}>
                  <b>{r.name || r.email}</b>
                  <span className="text-[var(--color-text-muted)]">{' wants to edit '}</span>
                  {d.name}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{relativeTime(r.at ?? undefined)}</span>
                <button
                  className={primaryBtn} disabled={busy === key}
                  title={`${r.name || r.email} joins the people who can edit "${d.name}"`}
                  onClick={() => void run(key, () => curated!.onAnswer(ref, r.email, true))}
                >
                  Approve
                </button>
                <button
                  className={ghostBtn} disabled={busy === key}
                  title="Turn it down. They can still open and copy it, and may ask again."
                  onClick={() => void run(key, () => curated!.onAnswer(ref, r.email, false))}
                >
                  Deny
                </button>
              </div>
            );
          })}
        </div>
      )}

      {tab === 'editable' || curated ? (
        <div className="max-h-[55vh] overflow-y-auto">
          {curated && tab === 'editable' ? (
            <p className="mb-2 text-[10px] text-[var(--color-text-muted)]">
              {admin
                ? `The ${noun}s everyone sees. Star one in Other; Make main picks the one a new tab opens on.`
                : `The team's ${noun}s. Ask to edit one, or take your own copy.`}
            </p>
          ) : creating ? (
            <div className="mb-2 flex items-center gap-2">
              <input
                autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newName.trim()) void run('new', () => onCreate(newName.trim()));
                  if (e.key === 'Escape') reset();
                }}
                placeholder={`${Noun} name`}
                className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
              />
              <button
                className={primaryBtn} disabled={!newName.trim() || busy === 'new'}
                onClick={() => void run('new', () => onCreate(newName.trim()))}
              >
                {busy === 'new' ? 'Creating…' : 'Create'}
              </button>
              <button className={ghostBtn} onClick={reset}>Cancel</button>
            </div>
          ) : (
            <button
              className={`${btn} mb-2 w-full justify-center`}
              onClick={() => { reset(); setCreating(true); setNewName(`${Noun} ${documents.length + 1}`); }}
            >
              {`+ New ${noun}`}
            </button>
          )}

          {rows.length === 0 && (
            <p className="py-3 text-xs text-[var(--color-text-muted)]">
              {curated && tab === 'editable' ? `No STAR ${noun}s yet.` : `No ${noun}s yet.`}
            </p>
          )}

          {rows.map((d) => {
            const ref = refOf(d);
            const key = keyOf(ref);
            // Absent on an older server, which only listed what you could edit.
            const editable = d.editable !== false;
            return (
              <div key={key} className={`mb-1 rounded ${key === activeKey ? 'bg-[var(--color-bg-tertiary)]' : ''}`}>
                {/* Curated rows carry up to five actions; without nowrap and a
                    floor on the name, the name is what gives way, to nothing. */}
                <div className={`flex items-center gap-2 px-2 py-1.5 ${curated ? 'whitespace-nowrap' : ''}`}>
                  {renaming === key ? (
                    <>
                      <input
                        autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && renameValue.trim()) void run(key, () => onRename(ref, renameValue.trim()));
                          if (e.key === 'Escape') reset();
                        }}
                        className="flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
                      />
                      <button
                        className={primaryBtn} disabled={!renameValue.trim() || busy === key}
                        onClick={() => void run(key, () => onRename(ref, renameValue.trim()))}
                      >
                        Save
                      </button>
                      <button className={ghostBtn} onClick={reset}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <button
                        className="min-w-[8rem] flex-1 truncate text-left text-xs text-[var(--color-text-primary)] hover:underline"
                        onClick={() => { onSelect(ref); onClose(); }}
                        title={d.name}
                      >
                        {d.name}
                      </button>
                      {d.featured && (
                        <span
                          className="shrink-0 rounded bg-[var(--color-accent)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-bg-primary)]"
                          title={curated
                            ? `The team's main ${noun}: a new tab opens on it.`
                            : editable
                              ? `The team's main ${noun}. You are an admin, so you can change it.`
                              : `The team's main ${noun}. Only an admin can change it - take a copy to work on it.`}
                        >
                          Main
                        </span>
                      )}
                      {d.copiedFrom && (
                        <span
                          className="shrink-0 text-[10px] text-[var(--color-text-muted)]"
                          title={`Copied from "${d.copiedFrom.name}" ${relativeTime(d.copiedFrom.at)}`}
                        >
                          {`from ${d.copiedFrom.name}`}
                        </span>
                      )}
                      {!d.mine && (
                        <span
                          className="max-w-[9rem] shrink-0 truncate rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                          title={openToAll || curated
                            ? `Made by ${d.ownerName || d.owner}`
                            : `Shared with you by ${d.ownerName || d.owner}`}
                        >
                          {d.ownerName || d.owner}
                        </span>
                      )}
                      {!openToAll && (d.sharedWith?.length ?? 0) > 0 && (curated ? d.canManage : d.mine) && (
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                          shared ×{d.sharedWith?.length}
                        </span>
                      )}
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]" title={d.updatedAt}>
                        {relativeTime(d.updatedAt)}
                      </span>
                      {editable ? (
                        <button
                          className={ghostBtn}
                          onClick={() => { reset(); setRenaming(key); setRenameValue(d.name); }}
                        >
                          Rename
                        </button>
                      ) : (
                        <>
                          {curated && (
                            <button
                              className={ghostBtn} disabled={busy === `ask:${key}`}
                              title={d.requestedByMe
                                ? 'Waiting for its creator or an admin. Click to withdraw the request.'
                                : `Ask its creator or an admin to let you edit "${d.name}"`}
                              onClick={() => void run(`ask:${key}`, () => curated.onRequest(ref, !d.requestedByMe))}
                            >
                              {d.requestedByMe ? 'Requested' : 'Request edit'}
                            </button>
                          )}
                          <button
                            className={ghostBtn} disabled={busy === key}
                            title={`Take your own copy of "${d.name}" to work on`}
                            onClick={() => void run(key, async () => { await onCopy(ref); onClose(); })}
                          >
                            {busy === key ? 'Copying…' : 'Copy'}
                          </button>
                        </>
                      )}
                      {admin && (
                        <button
                          className={ghostBtn} disabled={busy === `main:${key}`}
                          title={d.featured
                            ? `Stop treating this as the main ${noun}. Nothing is deleted.`
                            : `Make this the team's main ${noun}: it opens first for everyone, and only admins can change it.`}
                          onClick={() => void run(`main:${key}`, () =>
                            onFeature!(d.featured ? null : ref, d.owner ?? ''))}
                        >
                          {d.featured ? 'Unset main' : 'Make main'}
                        </button>
                      )}
                      {(curated ? d.canManage : !openToAll && editable) && (
                        <button className={ghostBtn} onClick={() => startShare(d)}>Share</button>
                      )}
                      {(curated ? editable && !d.canManage : !openToAll && !d.mine) && (
                        <button
                          className={ghostBtn} disabled={busy === key}
                          title={curated
                            ? `Remove yourself from this ${noun}. It is not deleted, and its creator can share it with you again.`
                            : `Remove yourself from this ${noun}. It is not deleted - you can copy it from View only whenever you like.`}
                          onClick={() => void run(key, () => onLeave(ref))}
                        >
                          Leave
                        </button>
                      )}
                      {curated && (
                        <StarToggle
                          on={!!d.star}
                          busy={busy === `star:${key}`}
                          // Admins choose; everyone else just sees which are STAR.
                          onToggle={admin ? () => void run(`star:${key}`, () => curated.onStar(ref, !d.star)) : undefined}
                          title={!admin
                            ? (d.star ? `A STAR ${noun}: everyone sees it` : `Not a STAR ${noun}`)
                            : d.star
                              ? `In STAR - everyone sees it. Click to take it out${d.featured ? ' (it also stops being main)' : ''}.`
                              : 'Not in STAR. Click to add it: everyone will see it.'}
                        />
                      )}
                    </>
                  )}
                </div>

                {sharing === key && (
                  <div className="mx-2 mb-2 rounded border border-[var(--color-border)] p-2">
                    <input
                      autoFocus value={shareFilter} onChange={(e) => setShareFilter(e.target.value)}
                      placeholder="Search people"
                      className="mb-2 w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none"
                    />
                    <div className="max-h-40 overflow-y-auto">
                      {shareCandidates.length === 0 && (
                        <p className="px-1 py-2 text-[10px] text-[var(--color-text-muted)]">
                          {users.length === 0
                            ? 'No teammates found yet - people appear here once they have signed in.'
                            : 'Nobody matches that.'}
                        </p>
                      )}
                      {shareCandidates.map((u) => {
                        const checked = shareSel.some((e) => e.toLowerCase() === u.email.toLowerCase());
                        return (
                          <label key={u.email} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 hover:bg-[var(--color-bg-tertiary)]">
                            <input type="checkbox" checked={checked} onChange={() => toggleShare(u.email)} />
                            <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]">
                              {u.name || u.email}
                            </span>
                            {u.name && (
                              <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{u.email}</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                    {removed(d).length > 0 && (
                      <p className="mt-2 text-[10px] text-amber-500">
                        {curated
                          ? `Removing: ${removed(d).join(', ')} - they lose edit access${d.star ? ', but can still open and copy this STAR ' + noun : ' and stop seeing it'}.`
                          : `Removing: ${removed(d).join(', ')} - they lose edit access, but can still copy this ${noun}.`}
                      </p>
                    )}
                    <div className="mt-2 flex justify-end gap-2">
                      <button className={ghostBtn} onClick={reset}>Cancel</button>
                      <button
                        className={primaryBtn} disabled={busy === key}
                        onClick={() => void run(key, () => onShare(ref, shareSel))}
                      >
                        {busy === key ? 'Saving…' : 'Save sharing'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="max-h-[55vh] overflow-y-auto">
          <p className="mb-2 text-[10px] text-[var(--color-text-muted)]">
            {openToAll
              ? `${Noun}s nobody has touched in the last ${openToAll.recentDays} days. Open one to edit it in place, or take your own copy.`
              : `Everyone else's ${noun}s. Opening one takes your own copy of it; the original is untouched.`}
          </p>
          {tree === null && <p className="py-3 text-xs text-[var(--color-text-muted)]">Loading…</p>}
          {tree?.length === 0 && (
            <p className="py-3 text-xs text-[var(--color-text-muted)]">
              {openToAll ? `Nothing older than ${openToAll.recentDays} days.` : `Nobody else has ${noun}s yet.`}
            </p>
          )}
          {tree?.map((g) => (
            <div key={g.owner} className="mb-1">
              <button
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-[var(--color-bg-tertiary)]"
                onClick={() => setExpanded(expanded === g.owner ? null : g.owner)}
              >
                <span className="w-3 shrink-0 text-[10px] text-[var(--color-text-muted)]">
                  {expanded === g.owner ? '▾' : '▸'}
                </span>
                <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]">
                  {g.ownerName || g.owner}
                </span>
                <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">{g.designs.length}</span>
              </button>
              {expanded === g.owner &&
                g.designs.map((x) => {
                  const ref: DocRef = { id: x.id, owner: g.owner };
                  const key = keyOf(ref);
                  if (openToAll && onOpen && x.editable) {
                    return (
                      <div key={key} className="flex w-full items-center gap-2 rounded py-1 pl-7 pr-2 hover:bg-[var(--color-bg-tertiary)]">
                        <button
                          className="flex-1 truncate text-left text-xs text-[var(--color-text-primary)] hover:underline"
                          title={`Open "${x.name}"`}
                          onClick={() => {
                            onOpen(ref, {
                              id: x.id, name: x.name, owner: g.owner, ownerName: g.ownerName,
                              mine: false, editable: true, featured: false,
                              createdAt: x.updatedAt ?? '', updatedAt: x.updatedAt ?? '',
                            });
                            onClose();
                          }}
                        >
                          {x.name}
                        </button>
                        <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                          {relativeTime(x.updatedAt)}
                        </span>
                        <button
                          className={ghostBtn} disabled={busy === key}
                          title={`Take your own copy of "${x.name}"`}
                          onClick={() => void run(key, async () => { await onCopy(ref); onClose(); })}
                        >
                          {busy === key ? 'Copying…' : 'Copy'}
                        </button>
                      </div>
                    );
                  }
                  return (
                    <button
                      key={key} disabled={busy === key}
                      className="flex w-full items-center gap-2 rounded py-1.5 pl-7 pr-2 text-left hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                      title={`Take a copy of "${x.name}"`}
                      onClick={() => void run(key, async () => { await onCopy(ref); onClose(); })}
                    >
                      <span className="flex-1 truncate text-xs text-[var(--color-text-primary)]">{x.name}</span>
                      <span className="shrink-0 text-[10px] text-[var(--color-text-muted)]">
                        {busy === key ? 'Copying…' : relativeTime(x.updatedAt)}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** The STAR mark at the end of a row: filled when the design is in STAR, a grey
 *  outline when not. A button for an admin, a plain mark for anyone else. */
function StarToggle({ on, busy, onToggle, title }: {
  on: boolean;
  busy: boolean;
  onToggle?: () => void;
  title: string;
}) {
  const icon = (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'}
         stroke="currentColor" strokeWidth={1.75} strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" />
    </svg>
  );
  const color = on ? 'text-amber-400' : 'text-[var(--color-text-muted)] opacity-50';
  if (!onToggle) {
    return <span className={`shrink-0 px-1 ${color} ${on ? '' : 'invisible'}`} title={title}>{icon}</span>;
  }
  return (
    <button
      type="button" disabled={busy} onClick={onToggle} title={title}
      aria-pressed={on} aria-label={on ? 'Remove from STAR' : 'Add to STAR'}
      className={`shrink-0 rounded px-1 transition-colors hover:opacity-100 disabled:opacity-40 ${color} ${on ? 'hover:text-amber-300' : 'hover:text-amber-400'}`}
    >
      {icon}
    </button>
  );
}
