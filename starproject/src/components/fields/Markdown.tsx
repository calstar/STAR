import { Children, cloneElement, isValidElement, type ReactElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a markdown string as formatted content. Safe by default:
 * react-markdown does NOT render raw HTML, so task text can never inject markup.
 * GitHub-flavored extras (task lists, tables, strikethrough, autolinks) come
 * from remark-gfm. Styling lives in the `.md` rules in globals.css.
 *
 * With `onToggleTask`, task-list checkboxes are clickable: a click reports the
 * source offset where that list item starts (see lib/markdown-tasks.ts) and
 * does not bubble, so it doesn't also open an editor around the text.
 */
export function Markdown({
  children,
  onToggleTask,
}: {
  children: string;
  onToggleTask?: (offset: number) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links open in a new tab; never trust rel-less external links.
          // `node` is stripped so it isn't spread onto the DOM element.
          a: ({ node, ...props }) => {
            void node;
            return <a {...props} target="_blank" rel="noreferrer noopener" />;
          },
          li: ({ node, children: kids, ...props }) => {
            const offset = node?.position?.start.offset;
            if (!onToggleTask || offset === undefined) return <li {...props}>{kids}</li>;
            return (
              <li {...props}>
                {Children.map(kids, (child) =>
                  isValidElement(child) &&
                  child.type === "input" &&
                  (child as ReactElement<{ type?: string }>).props.type === "checkbox"
                    ? cloneElement(child as ReactElement<React.InputHTMLAttributes<HTMLInputElement>>, {
                        disabled: false,
                        className: "cursor-pointer",
                        onClick: (e: React.MouseEvent) => e.stopPropagation(),
                        onKeyDown: (e: React.KeyboardEvent) => e.stopPropagation(),
                        onChange: () => onToggleTask(offset),
                      })
                    : child,
                )}
              </li>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
