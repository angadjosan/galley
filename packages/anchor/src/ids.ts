/**
 * Web Crypto rather than `node:crypto`, so ids can be minted in the browser as
 * well as on the server. `globalThis.crypto.getRandomValues` is present and
 * cryptographically strong in Node 22 and in every browser this app supports.
 */
function randomBytes(length: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID: a 26-character, lexicographically sortable, monotonic identifier.
 *
 * Used for **document** identity — the `galley:` frontmatter field that
 * survives a rename, a move, and a copy. Sortable matters because document ids
 * end up as primary keys and as the natural ordering for "recently created";
 * a UUIDv4 would force a separate timestamp column and a second index.
 *
 * Monotonicity within a millisecond is enforced by incrementing the random
 * component rather than redrawing it, so two documents created in the same tick
 * still sort in creation order.
 */
let lastTime = 0;
let lastRandom: number[] = [];

export function ulid(now = Date.now()): string {
  const time = encodeTime(now, 10);
  if (now === lastTime) {
    lastRandom = incrementRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = drawRandom(16);
  }
  return time + lastRandom.map((i) => CROCKFORD[i]!).join('');
}

function encodeTime(time: number, length: number): string {
  if (!Number.isInteger(time) || time < 0) throw new RangeError(`invalid ULID time ${time}`);
  let out = '';
  let remaining = time;
  for (let i = length - 1; i >= 0; i--) {
    out = CROCKFORD[remaining % 32]! + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

function drawRandom(length: number): number[] {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => b % 32);
}

function incrementRandom(previous: number[]): number[] {
  const next = [...previous];
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i]! < 31) {
      next[i]!++;
      return next;
    }
    next[i] = 0;
  }
  // Overflowed a full millisecond's worth of ids: redraw rather than wrap to a
  // value that would sort before its predecessor.
  return drawRandom(previous.length);
}

/**
 * A short id for a **block**.
 *
 * Blocks need something a human can read in a citation (`spec#a1b2c3`) and type
 * into a CLI. 8 Crockford base32 characters is 40 bits — with a thousand
 * annotated blocks in a document, the probability of a collision is about one
 * in two billion, and the sidecar rejects a duplicate on write anyway.
 *
 * Lower case, because it appears inline in prose and shouted ids read badly.
 */
export function blockId(): string {
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => CROCKFORD[b % 32]!)
    .join('')
    .toLowerCase();
}

const ULID_PATTERN = /^[0-7][0-9ABCDEFGHJKMNPQRSTVWXYZ]{25}$/;
const BLOCK_ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{4,32}$/;

export function isUlid(value: string): boolean {
  return ULID_PATTERN.test(value);
}

export function isBlockId(value: string): boolean {
  return BLOCK_ID_PATTERN.test(value);
}

/** Milliseconds encoded in a ULID's time component. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const ch of id.slice(0, 10)) {
    const index = CROCKFORD.indexOf(ch);
    if (index < 0) throw new RangeError(`invalid ULID character ${ch}`);
    time = time * 32 + index;
  }
  return time;
}
