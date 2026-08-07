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
export declare class Boundary extends Component<Props, State> {
    state: State;
    static getDerivedStateFromError(error: Error): State;
    componentDidCatch(error: Error, info: ErrorInfo): void;
    render(): JSX.Element | ReactNode;
}
export {};
//# sourceMappingURL=Boundary.d.ts.map