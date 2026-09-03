import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
function Svg({ children, filled }) {
    return (_jsx("svg", { viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": "true", focusable: "false", className: "tb-icon", fill: filled ? 'currentColor' : 'none', stroke: filled ? 'none' : 'currentColor', strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", children: children }));
}
export const UndoIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M7 8H12.5a3.5 3.5 0 0 1 0 7H8" }), _jsx("path", { d: "M9.5 5.5 6.5 8l3 2.5" })] }));
export const RedoIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M13 8H7.5a3.5 3.5 0 0 0 0 7H12" }), _jsx("path", { d: "M10.5 5.5 13.5 8l-3 2.5" })] }));
export const BoldIcon = () => (_jsx("span", { className: "tb-letter tb-letter-bold", "aria-hidden": "true", children: "B" }));
export const ItalicIcon = () => (_jsx("span", { className: "tb-letter tb-letter-italic", "aria-hidden": "true", children: "I" }));
export const UnderlineIcon = () => (_jsx("span", { className: "tb-letter tb-letter-underline", "aria-hidden": "true", children: "U" }));
export const StrikeIcon = () => (_jsx("span", { className: "tb-letter tb-letter-strike", "aria-hidden": "true", children: "S" }));
export const HighlightIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M4 15.5h12" }), _jsx("path", { d: "M7.5 12.5 12 4l3.5 2-4.5 8.5z" }), _jsx("path", { d: "M6.5 12.5h5l-.7 2H6z", fill: "currentColor", stroke: "none" })] }));
export const CodeIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M7.5 6.5 4 10l3.5 3.5" }), _jsx("path", { d: "M12.5 6.5 16 10l-3.5 3.5" })] }));
export const LinkIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M8.5 11.5a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4l-1 1" }), _jsx("path", { d: "M11.5 8.5a2.8 2.8 0 0 0-4 0L5.3 10.7a2.8 2.8 0 0 0 4 4l1-1" })] }));
export const CommentIcon = () => (_jsx(Svg, { children: _jsx("path", { d: "M3.5 4.5h13v9h-7l-3.5 3v-3h-2.5z" }) }));
export const ImageIcon = () => (_jsxs(Svg, { children: [_jsx("rect", { x: "3", y: "4.5", width: "14", height: "11", rx: "1.5" }), _jsx("circle", { cx: "7.5", cy: "8.5", r: "1.2" }), _jsx("path", { d: "M3.5 13 7 9.8l2.6 2.3L12.5 9l4 4.2" })] }));
export const DiagramIcon = () => (_jsxs(Svg, { children: [_jsx("rect", { x: "7", y: "3", width: "6", height: "4", rx: "1" }), _jsx("rect", { x: "2.5", y: "13", width: "6", height: "4", rx: "1" }), _jsx("rect", { x: "11.5", y: "13", width: "6", height: "4", rx: "1" }), _jsx("path", { d: "M10 7v3M10 10H5.5v3M10 10h4.5v3" })] }));
export const DesignIcon = () => (_jsxs(Svg, { children: [_jsx("rect", { x: "3", y: "3", width: "14", height: "14", rx: "2" }), _jsx("rect", { x: "6", y: "6", width: "4.5", height: "3", rx: "0.8" }), _jsx("path", { d: "M6 11.5h8M6 14h5" })] }));
export const TableIcon = () => (_jsxs(Svg, { children: [_jsx("rect", { x: "3", y: "4.5", width: "14", height: "11", rx: "1.5" }), _jsx("path", { d: "M3 8.5h14M8.5 8.5v7" })] }));
export const ChecklistIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M8.5 6h8M8.5 10h8M8.5 14h8" }), _jsx("path", { d: "M3 6.2 4 7.2 6 5.2" }), _jsx("path", { d: "M3 10.2 4 11.2 6 9.2" }), _jsx("rect", { x: "2.8", y: "12.8", width: "3.4", height: "3.4", rx: "0.8" })] }));
export const BulletsIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M7 5.5h10M7 10h10M7 14.5h10" }), _jsx("circle", { cx: "3.8", cy: "5.5", r: "1.1", fill: "currentColor", stroke: "none" }), _jsx("circle", { cx: "3.8", cy: "10", r: "1.1", fill: "currentColor", stroke: "none" }), _jsx("circle", { cx: "3.8", cy: "14.5", r: "1.1", fill: "currentColor", stroke: "none" })] }));
export const NumbersIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M7.5 5.5h9.5M7.5 10H17M7.5 14.5H17" }), _jsx("text", { x: "2", y: "7.4", fontSize: "6", fill: "currentColor", stroke: "none", fontFamily: "inherit", children: "1" }), _jsx("text", { x: "2", y: "11.9", fontSize: "6", fill: "currentColor", stroke: "none", fontFamily: "inherit", children: "2" }), _jsx("text", { x: "2", y: "16.4", fontSize: "6", fill: "currentColor", stroke: "none", fontFamily: "inherit", children: "3" })] }));
export const OutdentIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M3 4.5h14M8 8.5h9M8 11.5h9M3 15.5h14" }), _jsx("path", { d: "M5.5 8.5 3 10l2.5 1.5" })] }));
export const IndentIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M3 4.5h14M8 8.5h9M8 11.5h9M3 15.5h14" }), _jsx("path", { d: "M3 8.5 5.5 10 3 11.5" })] }));
export const ClearFormatIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M7 5h9M11.5 5 9 15" }), _jsx("path", { d: "M4 15h6" }), _jsx("path", { d: "M13 12.5 17 16.5M17 12.5l-4 4" })] }));
export const QuoteIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M4 5.5v9", strokeWidth: "2.4" }), _jsx("path", { d: "M8 7h9M8 10h9M8 13h6" })] }));
export const ChevronIcon = () => (_jsx("svg", { viewBox: "0 0 20 20", width: "14", height: "14", "aria-hidden": "true", className: "tb-chevron", children: _jsx("path", { d: "M6 8l4 4 4-4", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinecap: "round", strokeLinejoin: "round" }) }));
export const CheckIcon = () => (_jsx("svg", { viewBox: "0 0 20 20", width: "16", height: "16", "aria-hidden": "true", className: "tb-check", children: _jsx("path", { d: "M4 10.5 8 14.5 16 6", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round" }) }));
export const TrashIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M4.5 6h11" }), _jsx("path", { d: "M8 6V4.5h4V6" }), _jsx("path", { d: "M6 6l.7 9a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L14 6" }), _jsx("path", { d: "M8.8 8.8v4.4M11.2 8.8v4.4" })] }));
export const DocumentIcon = () => (_jsxs(Svg, { children: [_jsx("path", { d: "M5.5 3.5h6L15 7v9.5H5.5z" }), _jsx("path", { d: "M11.5 3.5V7H15" }), _jsx("path", { d: "M7.8 10.5h4.4M7.8 13h3" })] }));
/**
 * The wordmark's glyph: three ruled lines, shortening, with a violet-free dot
 * on the last one. Lives here rather than beside its first caller because the
 * landing page and the app have to draw the same brand.
 */
export const Mark = () => (_jsxs("svg", { viewBox: "0 0 24 24", className: "mark", "aria-hidden": "true", children: [_jsx("path", { d: "M4 4h16v3H4z" }), _jsx("path", { d: "M4 10h11v3H4z" }), _jsx("path", { d: "M4 16h7v3H4z" }), _jsx("circle", { cx: "19", cy: "17.5", r: "3.2", className: "mark-dot" })] }));
//# sourceMappingURL=icons.js.map