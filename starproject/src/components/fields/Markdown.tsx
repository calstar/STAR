import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a markdown string as formatted, read-only content. Safe by default:
 * react-markdown does NOT render raw HTML, so task text can never inject markup.
 * GitHub-flavored extras (task lists, tables, strikethrough, autolinks) come
 * from remark-gfm. Styling lives in the `.md` rules in globals.css.
 */
export function Markdown({ children }: { children: string }) {
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
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
