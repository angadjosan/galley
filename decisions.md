# Decisions

Technical decisions made while building Galley, and the context behind them. A
log — append, don't rewrite. Where a decision closed a fork worth remembering,
the rejected branch goes in `tradeoffs.md` and this file links to it.

Distinction from `tradeoffs.md`: that file records *forks* (what we didn't do,
and why the rejected option keeps looking attractive). This file records *what
is true about the codebase* and why a reader should not "fix" it.

---

## D1 — TypeScript monorepo, npm workspaces

**Context:** the product is a CLI, a server, and a browser editor over one
document model. The model must be *literally the same code* in all three or the
CLI and the app will drift on block identity, which is the technical thesis.

**Decision:** one TypeScript monorepo. `npm` workspaces rather than pnpm —
`pnpm` isn't on this machine and the workspace graph is small enough that npm's
hoisting is not a problem. Packages export `src/*.ts` directly and are consumed
by `tsx`/`vite`/`vitest`, so there is no build step between packages during
development; `tsc --build` exists purely as a typecheck gate.

**Consequence:** `npm run typecheck` is a required gate before every commit. A
package that only ever runs through a bundler can otherwise accumulate type
errors invisibly.

---

## D2 — Concurrency is its own package, built first

**Context:** the brief asks for a system that is robust under saturation, has
defined behavior on partial failure, and has no race conditions in the sync
path. Retrofitting that onto ad-hoc `async` code is not possible.

**Decision:** `@galley/concurrency` is written and tested before any product
code, and every shared-state mutation in the server goes through one of its
primitives. Nothing in the codebase is allowed to hand-roll a lock.

The primitive set is chosen from the actual hazards in the design doc:

| Hazard from `idea.md` | Primitive |
|---|---|
| Two clients apply ops to one doc concurrently | `Mutex` per doc, FIFO-fair |
| A doc is read while being spliced to disk | `RwLock` |
| Cross-doc operations (transclusion, move) deadlock | `KeyedMutex.acquireOrdered` — global lock order, violation throws |
| A fast producer overruns a slow WebSocket | bounded `Channel` with backpressure |
| Ops must apply in causal order per doc | `Sequencer` (serialized per key, ordered) |
| A crashed producer leaves consumers parked | `Channel.fault(cause)` → every waiter rejects with `FaultedError` |
| A wedged downstream (git, email) stalls the hub | `CircuitBreaker` + `withTimeout` |

**Rejected:** using `async-mutex` / `p-queue` off the shelf. They are fine
libraries, but none of them expose cancellation-safe acquire, fairness
guarantees we can assert on in tests, or fault propagation distinct from close.
Those three properties are exactly what the stress suite needs to test.

---

## D3 — Errors are a closed taxonomy, not strings

Cancellation, timeout, clean close, abnormal fault, capacity rejection, and lock
order violation are six *different* events, and a consumer that cannot tell them
apart will either swallow a real fault or invent one. `src/errors.ts` defines
all six; nothing in the codebase throws a bare `Error` across an async boundary.

The one that carries the most weight is `ClosedError` vs `FaultedError`. "The
stream ended" and "the stream broke" look identical to a `for await` loop unless
the primitive forces the distinction, and the difference decides whether a
consumer commits its work or rolls it back.
