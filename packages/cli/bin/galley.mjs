#!/usr/bin/env node
// The CLI ships as TypeScript source: `main.ts` and its neighbours use `.js`
// specifiers, which node's own type stripping does not resolve. Register tsx
// first, then load the entry point, so the binary runs from a checkout with no
// build step.
import { register } from 'tsx/esm/api';

register();

const { run } = await import('../src/main.ts');

process.exitCode = await run(process.argv.slice(2));
