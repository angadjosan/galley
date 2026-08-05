import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
/**
 * The dev server proxies `/v1` to the API so the browser sees one origin.
 * Same-origin removes CORS from the picture entirely, and — more importantly —
 * lets the WebSocket URL be derived from `window.location` rather than
 * configured, which is one fewer thing to get wrong in a deployment.
 */
export default defineConfig({
    plugins: [react()],
    server: {
        port: Number(process.env.PORT ?? 5173),
        proxy: {
            '/v1': {
                target: process.env.GALLEY_API ?? 'http://127.0.0.1:8787',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: { outDir: 'dist', sourcemap: true },
});
//# sourceMappingURL=vite.config.js.map