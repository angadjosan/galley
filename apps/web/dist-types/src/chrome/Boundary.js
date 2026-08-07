import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
import { Component } from 'react';
export class Boundary extends Component {
    state = { error: null };
    static getDerivedStateFromError(error) {
        return { error };
    }
    componentDidCatch(error, info) {
        // Logged rather than swallowed. The message on screen is for the writer;
        // this is for whoever has to fix it, and a boundary that hides the stack
        // makes the bug it caught harder to find than the crash it replaced.
        console.error('[galley] a pane failed to render', error, info.componentStack);
    }
    render() {
        const { error } = this.state;
        if (!error)
            return this.props.children;
        return (_jsxs("div", { className: "pane-failed", role: "alert", children: [_jsxs("p", { children: ["Something went wrong in ", this.props.what, ". Your work is saved \u2014 nothing was lost."] }), _jsx("p", { className: "pane-failed-detail", children: error.message }), _jsx("button", { type: "button", className: "chrome-button", onClick: () => this.setState({ error: null }), children: "Try again" })] }));
    }
}
//# sourceMappingURL=Boundary.js.map