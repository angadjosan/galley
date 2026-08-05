/**
 * The dev server proxies `/v1` to the API so the browser sees one origin.
 * Same-origin removes CORS from the picture entirely, and — more importantly —
 * lets the WebSocket URL be derived from `window.location` rather than
 * configured, which is one fewer thing to get wrong in a deployment.
 */
declare const _default: import("vite").UserConfig & Promise<import("vite").UserConfig> & import("vite").UserConfigFnObject & import("vite").UserConfigFnPromise & import("vite").UserConfigFn;
export default _default;
//# sourceMappingURL=vite.config.d.ts.map