import { describe, it } from 'vitest';
import { LatencyRecorder, Gate, monoNow } from '@galley/concurrency';
import { DocumentActor, GalleyDocument, type Principal } from '@galley/core';
const P: Principal = { id: 'u', kind: 'human', name: 'p' };
describe('probe', () => {
  it('does in-task apply cost drift over a long run?', async () => {
    const actor = new DocumentActor(GalleyDocument.create('# D\n\nSeed.\n'));
    for (let i = 0; i < 40; i++) await actor.applyOps([{ kind: 'insert', after: '@1', markdown: `B${i}.` }], P);
    const gate = new Gate();
    const N = 12000;
    let issued = 0;
    const per: number[] = [];
    const writers = Array.from({ length: 16 }, (_, w) => (async () => {
      await gate.wait();
      while (issued++ < N) {
        const t = monoNow();
        await actor.applyOps([{ kind: 'replace', target: '@1', markdown: `w${w} ${issued}.` }], P);
        per.push(monoNow() - t);
      }
    })());
    gate.open();
    const t0 = monoNow();
    await Promise.all(writers);
    console.log(`elapsed ${(monoNow()-t0).toFixed(0)}ms for ${per.length} ops`);
    const inTask = (actor.applyLatency as any).samples as number[];
    const decile = (arr: number[], i: number) => {
      const n = Math.floor(arr.length/10); const s = arr.slice(i*n, (i+1)*n);
      return s.reduce((a,b)=>a+b,0)/s.length;
    };
    for (let d = 0; d < 10; d++) {
      console.log(`decile ${d}: total ${decile(per,d).toFixed(2)}ms  in-task ${decile(inTask,d).toFixed(3)}ms  heap ${(process.memoryUsage().heapUsed/1e6).toFixed(0)}MB`);
    }
    console.log(`doc blocks now: ${actor.document.parsed().blocks.length}, bytes ${actor.document.toMarkdown().length}`);
  }, 300000);
});
