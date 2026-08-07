import { Component, type ErrorInfo, type JSX, type ReactNode } from 'react';

/**
 * A render error that does not take the document with it.
 *
 * React unmounts the whole tree when a render throws, so before this a mistake
 * anywhere — a bad lookup in the inspector, a null in a chart — replaced the
 * entire application with a blank white page. No message, no recovery but a
 * reload, and a reload of a writing surface is a reload of somebody's work in
 * progress.
 *
 * That is unacceptable in an editor that writes to a live document, and it is
 * the reason this is a class component: `componentDidCatch` has no hook
 * equivalent, and React has been explicit that it will not get one.
 *
 * The boundary goes around a **pane**, not the application. Wrapping everything
 * would trade a blank page for a slightly friendlier blank page; wrapping the
 * canvas means a broken inspector leaves the document list, the header and the
 * source view all still there — and the source view is the escape hatch that
 * lets someone rescue the design by hand.
 */

interface Props {
  /** What broke, in the reader's terms: "the design canvas", not "DesignEditor". */
  readonly what: string;
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

export class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed. The message on screen is for the writer;
    // this is for whoever has to fix it, and a boundary that hides the stack
    // makes the bug it caught harder to find than the crash it replaced.
    console.error('[galley] a pane failed to render', error, info.componentStack);
  }

  override render(): JSX.Element | ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pane-failed" role="alert">
        <p>
          Something went wrong in {this.props.what}. Your work is saved — nothing was lost.
        </p>
        <p className="pane-failed-detail">{error.message}</p>
        <button type="button" className="chrome-button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
