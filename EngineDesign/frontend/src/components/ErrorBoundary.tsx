import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Catches render-time exceptions so one bad value cannot blank the whole app.
 *
 * Without a boundary anywhere in the tree, React unmounts EVERYTHING when a
 * render throws -- the user sees a white page with no message, no stack, and no
 * way to report what happened. Every render bug then looks identical, which is
 * exactly how "press Optimize, page goes blank" got reported with nothing to go
 * on. This keeps the failure on screen and legible instead.
 */
interface Props {
  children: ReactNode;
  /** Shown above the error, e.g. "Flight Simulation". */
  label?: string;
}
interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the console record: the boundary stops the crash from propagating,
    // so without this the stack would be swallowed entirely.
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack);
    this.setState({ info });
  }

  private reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const detail = [error.stack || String(error), info?.componentStack]
      .filter(Boolean)
      .join('\n\nComponent stack:');

    return (
      <div className="m-4 rounded-lg border border-red-500/40 bg-red-500/5 p-4">
        <p className="font-medium text-red-300">
          {this.props.label ? `${this.props.label} hit an error` : 'Something went wrong'}
        </p>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          The rest of the app is still running. Copy the detail below when reporting this.
        </p>
        <p className="mt-2 font-mono text-sm text-red-200">{String(error.message || error)}</p>
        <details className="mt-2">
          <summary className="cursor-pointer text-xs text-[var(--color-text-secondary)]">
            Show stack
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 text-xs text-[var(--color-text-secondary)]">
            {detail}
          </pre>
        </details>
        <button
          type="button"
          onClick={this.reset}
          className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
        >
          Try again
        </button>
      </div>
    );
  }
}

export default ErrorBoundary;
