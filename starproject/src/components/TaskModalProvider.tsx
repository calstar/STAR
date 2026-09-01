"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { TaskDetail } from "@/components/TaskDetail";
import { loadTaskById, loadTaskDetail } from "@/lib/actions/task-detail";
import type { TaskDetailData } from "@/lib/task-detail";

type TaskModalContextValue = {
  /** Open a task as an in-place overlay — no navigation, no URL change. */
  openTask: (projectId: string, taskId: string) => void;
  /** Re-fetch the open task's data (after a mutation inside the modal). */
  refresh: () => void;
};

const TaskModalContext = createContext<TaskModalContextValue | null>(null);

export function useTaskModal() {
  const ctx = useContext(TaskModalContext);
  if (!ctx) throw new Error("useTaskModal must be used within TaskModalProvider");
  return ctx;
}

export function TaskModalProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  // projectId is null for share-link opens (`?task=<id>`), which loads by id.
  const [open, setOpen] = useState<{
    projectId: string | null;
    taskId: string;
  } | null>(null);
  const [data, setData] = useState<TaskDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumps to force a re-fetch of the currently open task.
  const [nonce, setNonce] = useState(0);
  const reqId = useRef(0);

  const openTask = useCallback((projectId: string, taskId: string) => {
    setData(null);
    setOpen({ projectId, taskId });
  }, []);

  const close = useCallback(() => {
    setOpen(null);
    setData(null);
    // If we arrived via a `?task=` share link, strip it so a refresh doesn't
    // reopen the modal and the URL returns clean. replace = no history entry.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (url.searchParams.has("task")) {
        url.searchParams.delete("task");
        router.replace(url.pathname + url.search + url.hash);
      }
    }
  }, [router]);

  // On first load, honor a `?task=<id>` share link by opening that task.
  useEffect(() => {
    const taskId = new URLSearchParams(window.location.search).get("task");
    if (taskId) setOpen({ projectId: null, taskId });
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // Fetch (and re-fetch) the open task's detail data.
  useEffect(() => {
    if (!open) return;
    const id = ++reqId.current;
    setLoading(true);
    const fetchData = open.projectId
      ? loadTaskDetail(open.projectId, open.taskId)
      : loadTaskById(open.taskId);
    fetchData.then((d) => {
      if (id !== reqId.current) return; // a newer open/refresh superseded this
      if (!d) {
        setOpen(null);
        setData(null);
      } else {
        setData(d);
      }
      setLoading(false);
    });
  }, [open, nonce]);

  // Esc to close + lock body scroll while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, close]);

  // Keep the underlying page fresh so board/list reflect edits made in the modal.
  useEffect(() => {
    if (!open) router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <TaskModalContext.Provider value={{ openTask, refresh }}>
      {children}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
          onClick={close}
        >
          <div
            className="relative w-full max-w-3xl rounded-xl bg-neutral-50 dark:bg-neutral-900 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={close}
              aria-label="Close"
              className="absolute right-3 top-3 z-10 rounded p-1 text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700 dark:hover:text-neutral-200"
            >
              ✕
            </button>
            <div className="p-6">
              {data ? (
                <TaskDetail data={data} />
              ) : (
                <div className="py-16 text-center text-sm text-neutral-500 dark:text-neutral-400">
                  {loading ? "Loading…" : "Task not found."}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </TaskModalContext.Provider>
  );
}
