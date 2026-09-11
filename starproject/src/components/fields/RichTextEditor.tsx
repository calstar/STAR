"use client";

import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/fields/Markdown";
import { updateField } from "@/lib/fieldUpdate";

type Sel = { start: number; end: number };

/** A single formatting-toolbar button. `onMouseDown` preventDefault keeps focus
 * in the textarea so clicking a button never blurs (and thus never saves). */
function ToolbarButton({
  title,
  onAction,
  children,
}: {
  title: string;
  onAction: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onAction}
      className="flex h-11 w-11 items-center justify-center rounded text-sm text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 sm:h-auto sm:w-auto sm:px-1.5 sm:py-0.5 sm:text-xs"
    >
      {children}
    </button>
  );
}

/**
 * Markdown-backed rich text field. Shows the rendered markdown until clicked;
 * clicking switches to a textarea + formatting toolbar. Auto-saves on blur (via
 * `updateField`, like the plain fields did) — no save button. The stored value
 * is plain markdown, so it stays backward-compatible with existing text.
 */
export function RichTextEditor({
  taskId,
  field,
  value,
  placeholder = "Add a description…",
}: {
  taskId: string;
  field: string;
  value: string;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  const pendingSel = useRef<Sel | null>(null);

  // After a toolbar edit changes `text`, restore the intended selection once the
  // controlled textarea has re-rendered with the new value.
  useEffect(() => {
    if (editing && pendingSel.current && ref.current) {
      const { start, end } = pendingSel.current;
      pendingSel.current = null;
      ref.current.focus();
      ref.current.setSelectionRange(start, end);
    }
  }, [text, editing]);

  const save = () => {
    updateField(taskId, field, text);
    setEditing(false);
  };

  const apply = (next: string, sel: Sel) => {
    pendingSel.current = sel;
    setText(next);
  };

  // Wrap the selection in `before`/`after` (toggles off if already wrapped).
  const surround = (before: string, after = before) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const inner = text.slice(s, e);
    const wrapped =
      text.slice(s - before.length, s) === before &&
      text.slice(e, e + after.length) === after;
    if (wrapped) {
      const next =
        text.slice(0, s - before.length) + inner + text.slice(e + after.length);
      apply(next, { start: s - before.length, end: e - before.length });
      return;
    }
    const next = text.slice(0, s) + before + inner + after + text.slice(e);
    apply(next, { start: s + before.length, end: e + before.length });
  };

  // Prefix every selected line with the marker from `make(lineIndex)`.
  const prefixLines = (make: (i: number) => string) => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const lineStart = text.lastIndexOf("\n", s - 1) + 1;
    const nl = text.indexOf("\n", e);
    const lineEnd = nl === -1 ? text.length : nl;
    const block = text
      .slice(lineStart, lineEnd)
      .split("\n")
      .map((ln, i) => make(i) + ln)
      .join("\n");
    const next = text.slice(0, lineStart) + block + text.slice(lineEnd);
    apply(next, { start: lineStart, end: lineStart + block.length });
  };

  const insertLink = () => {
    const ta = ref.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const inner = text.slice(s, e) || "text";
    const snippet = `[${inner}](url)`;
    const next = text.slice(0, s) + snippet + text.slice(e);
    const urlStart = s + inner.length + 3; // past "[inner]("
    apply(next, { start: urlStart, end: urlStart + 3 });
  };

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const mod = ev.metaKey || ev.ctrlKey;
    if (mod && ev.key.toLowerCase() === "b") {
      ev.preventDefault();
      surround("**");
      return;
    }
    if (mod && ev.key.toLowerCase() === "i") {
      ev.preventDefault();
      surround("*");
      return;
    }
    // Continue lists on Enter: repeat the marker, or exit an empty item.
    if (ev.key === "Enter" && !ev.shiftKey) {
      const ta = ref.current;
      if (!ta || ta.selectionStart !== ta.selectionEnd) return;
      const caret = ta.selectionStart;
      const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
      const line = text.slice(lineStart, caret);
      const m = line.match(/^(\s*)(-\s\[[ xX]\]\s|[-*+]\s|(\d+)\.\s)/);
      if (!m) return;
      const indent = m[1];
      const content = line.slice(m[0].length);
      ev.preventDefault();
      if (content.trim() === "") {
        // Empty item → drop the marker and exit the list.
        const next = text.slice(0, lineStart) + indent + text.slice(caret);
        const pos = lineStart + indent.length;
        apply(next, { start: pos, end: pos });
        return;
      }
      let marker: string;
      if (m[2].includes("[")) marker = `${indent}- [ ] `;
      else if (m[3]) marker = `${indent}${Number(m[3]) + 1}. `;
      else marker = `${indent}${m[2]}`;
      const insert = "\n" + marker;
      const next = text.slice(0, caret) + insert + text.slice(caret);
      const pos = caret + insert.length;
      apply(next, { start: pos, end: pos });
    }
  };

  if (!editing) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            setEditing(true);
          }
        }}
        className="min-h-11 cursor-text rounded border border-neutral-200 dark:border-neutral-800 px-2 py-1 hover:border-neutral-300 dark:hover:border-neutral-700 sm:border-transparent dark:sm:border-transparent"
      >
        {text.trim() ? (
          <Markdown>{text}</Markdown>
        ) : (
          <span className="text-sm text-neutral-400 dark:text-neutral-500">
            {placeholder}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-neutral-200 dark:border-neutral-800 px-1 py-1">
        <ToolbarButton title="Bold (⌘/Ctrl+B)" onAction={() => surround("**")}>
          <b>B</b>
        </ToolbarButton>
        <ToolbarButton title="Italic (⌘/Ctrl+I)" onAction={() => surround("*")}>
          <i>I</i>
        </ToolbarButton>
        <ToolbarButton title="Strikethrough" onAction={() => surround("~~")}>
          <span className="line-through">S</span>
        </ToolbarButton>
        <ToolbarButton title="Inline code" onAction={() => surround("`")}>
          <span className="font-mono">{"<>"}</span>
        </ToolbarButton>
        <span className="mx-0.5 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />
        <ToolbarButton title="Heading" onAction={() => prefixLines(() => "### ")}>
          <span className="font-semibold">H</span>
        </ToolbarButton>
        <ToolbarButton title="Bulleted list" onAction={() => prefixLines(() => "- ")}>
          •
        </ToolbarButton>
        <ToolbarButton
          title="Numbered list"
          onAction={() => prefixLines((i) => `${i + 1}. `)}
        >
          1.
        </ToolbarButton>
        <ToolbarButton title="Checklist" onAction={() => prefixLines(() => "- [ ] ")}>
          ☑
        </ToolbarButton>
        <ToolbarButton title="Quote" onAction={() => prefixLines(() => "> ")}>
          ❝
        </ToolbarButton>
        <ToolbarButton title="Link" onAction={insertLink}>
          🔗
        </ToolbarButton>
      </div>
      <textarea
        ref={ref}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={save}
        rows={5}
        placeholder="Write with markdown… **bold**, *italic*, - lists, [links](url)"
        className="w-full resize-y bg-transparent px-2 py-1.5 text-sm outline-none"
      />
    </div>
  );
}
