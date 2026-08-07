import { jsx as _jsx } from "react/jsx-runtime";
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_THEME } from '@galley/design';
import { applyTheme } from './design/theme.js';
import { App } from './App.js';
import 'prosemirror-view/style/prosemirror.css';
import 'prosemirror-gapcursor/style/gapcursor.css';
import './styles.css';
const host = document.getElementById('root');
if (!host)
    throw new Error('missing #root');
// The design palette has to be in the page before the first frame draws,
// or a design flashes unstyled on load.
applyTheme(DEFAULT_THEME);
createRoot(host).render(_jsx(StrictMode, { children: _jsx(App, {}) }));
//# sourceMappingURL=main.js.map