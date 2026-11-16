// Practice bench: correctness against expected.json plus CPU timings.
//   node tools/bench.mjs                 # candidate only, 3 rounds
//   node tools/bench.mjs --baseline      # alternate candidate and the kit's marked baseline
//   node tools/bench.mjs --rounds 5 --kit <kit dir>
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const baseline = args.includes('--baseline');
const rounds = Number(flag('--rounds', '3'));
const kit = resolve(flag('--kit', process.env.KIT_DIR ??
  resolve(root, '..', '..', 'makefun-markdown-render-speed-02', 'markdown-render-speed-02-kit')));

const cases = JSON.parse(readFileSync(join(kit, 'practice/input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8'));

const mod = await import(pathToFileURL(join(root, 'parse.js')).href);
const { parse } = mod;

function compare(render, label) {
  let matches = 0;
  for (let i = 0; i < cases.length; i++) {
    const want = expected.cases[i].html;
    let got;
    try {
      got = render(cases[i].markdown);
    } catch (err) {
      console.log(`  ${label} threw on ${cases[i].id}: ${err}`);
      got = undefined;
    }
    if (got === want) {
      matches++;
    } else if (matches === i) {
      let at = 0;
      const n = Math.min(got?.length ?? 0, want.length);
      while (at < n && got[at] === want[at]) at++;
      console.log(`  mismatch ${cases[i].id} at char ${at}`);
      console.log(`    want ${JSON.stringify(want.slice(Math.max(0, at - 40), at + 60))}`);
      console.log(`    got  ${JSON.stringify((got ?? '').slice(Math.max(0, at - 40), at + 60))}`);
    }
  }
  return matches;
}

console.log(`cases ${cases.length}`);
console.log(`match ${compare(parse, 'candidate')}/${cases.length}`);
if (typeof mod.stats === 'function') console.log(`fallbacks ${mod.stats()}`);

function time(run) {
  const before = process.cpuUsage();
  run();
  const after = process.cpuUsage(before);
  return (after.user + after.system) / 1000;
}

const loop = (render) => {
  const out = new Array(cases.length);
  for (let i = 0; i < cases.length; i++) out[i] = render(cases[i].markdown);
  return out.length;
};

// Warm up JIT once for each side before timing.
loop(parse);
let baseParse = null;
if (baseline) {
  baseParse = (await import(pathToFileURL(join(kit, 'baselines/parse.js')).href)).parse;
  loop(baseParse);
}

const mine = [];
const theirs = [];
for (let r = 0; r < rounds; r++) {
  if (baseParse) theirs.push(time(() => loop(baseParse)));
  mine.push(time(() => loop(parse)));
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = (x) => `${x.toFixed(1)} ms`;
console.log(`candidate cpu ${mine.map(ms).join(', ')} | median ${ms(median(mine))}`);
if (baseParse) {
  console.log(`baseline  cpu ${theirs.map(ms).join(', ')} | median ${ms(median(theirs))}`);
  console.log(`speedup ${(median(theirs) / median(mine)).toFixed(3)}x`);
}
