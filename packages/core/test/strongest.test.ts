/**
 * Claims under test (`src/principals.ts`):
 *
 * Sharing composes by max. The whole point of `strongest` is that a grant
 * arriving from a second source — a per-document share, a link — may only ever
 * add access. The regression it exists to prevent is the quiet demotion: an
 * admin over the workspace who is "shared" a single document at `read` and
 * loses admin on exactly that document, by a share nobody meant as a removal.
 */
import { describe, expect, it } from 'vitest';
import { capabilityFor, strongest, type Capability, type Grant } from '../src/principals.js';

describe('strongest', () => {
  it('returns the higher capability regardless of argument order', () => {
    expect(strongest('read', 'admin')).toBe('admin');
    expect(strongest('admin', 'read')).toBe('admin');
    expect(strongest('comment', 'suggest')).toBe('suggest');
    expect(strongest('suggest', 'comment')).toBe('suggest');
    expect(strongest('write', 'suggest')).toBe('write');
    expect(strongest('suggest', 'write')).toBe('write');
  });

  it('is stable when both sides are equal', () => {
    const all: Capability[] = ['read', 'comment', 'suggest', 'write', 'admin'];
    for (const capability of all) {
      expect(strongest(capability, capability)).toBe(capability);
    }
  });

  it('treats null as weaker than every capability, in either position', () => {
    expect(strongest(null, 'read')).toBe('read');
    expect(strongest('read', null)).toBe('read');
    expect(strongest(null, 'admin')).toBe('admin');
    expect(strongest('admin', null)).toBe('admin');
  });

  it('returns null only when neither side confers anything', () => {
    expect(strongest(null, null)).toBeNull();
  });

  it('agrees with the full order across every pair', () => {
    const all: Capability[] = ['read', 'comment', 'suggest', 'write', 'admin'];
    for (let i = 0; i < all.length; i += 1) {
      for (let j = 0; j < all.length; j += 1) {
        expect(strongest(all[i]!, all[j]!)).toBe(all[Math.max(i, j)]);
      }
    }
  });

  it('never demotes a workspace admin when a single doc is shared at read', () => {
    // The regression. Priya is admin over `/` by a workspace grant; someone
    // shares one document with her at `read`, not knowing she already has more.
    const grants: Grant[] = [{ path: '/', capability: 'admin' }];
    const fromPath = capabilityFor(grants, '/specs/launch.md');
    const perDoc: Capability = 'read';

    expect(fromPath).toBe('admin');
    expect(strongest(fromPath, perDoc)).toBe('admin');
    // ...and the composition is not order-dependent, because the caller has no
    // reason to know which source it looked at first.
    expect(strongest(perDoc, fromPath)).toBe('admin');
  });

  it('still lets a share add access where the path grant is weaker', () => {
    const grants: Grant[] = [{ path: '/', capability: 'read' }];
    const fromPath = capabilityFor(grants, '/specs/launch.md');
    expect(strongest(fromPath, 'write')).toBe('write');
  });

  it('grants link access to someone with no path grant at all', () => {
    const fromPath = capabilityFor([], '/specs/launch.md');
    expect(fromPath).toBeNull();
    expect(strongest(fromPath, 'comment')).toBe('comment');
  });

  it('composes all three sources by folding, path then doc then link', () => {
    const grants: Grant[] = [
      { path: '/', capability: 'read' },
      { path: '/specs', capability: 'suggest' },
    ];
    const path = capabilityFor(grants, '/specs/launch.md');
    const docGrant: Capability = 'read';
    const link: Capability = 'write';
    expect(strongest(strongest(path, docGrant), link)).toBe('write');
    // A weaker link cannot pull the fold back down.
    expect(strongest(strongest(path, docGrant), 'read')).toBe('suggest');
  });
});
