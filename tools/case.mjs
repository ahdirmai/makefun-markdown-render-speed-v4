// Dev helper: show one practice case's markdown, expected and actual HTML.
//   node tools/case.mjs cm-004
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const kit = resolve(process.env.KIT_DIR ?? resolve(root, '..', '..', 'makefun-markdown-render-speed-02', 'markdown-render-speed-02-kit'));
const cases = JSON.parse(readFileSync(join(kit, 'practice/input/cases.json'), 'utf8'));
const expected = JSON.parse(readFileSync(join(kit, 'practice/reference/expected.json'), 'utf8'));
const { parse } = await import(pathToFileURL(join(root, 'parse.js')).href);

const want = process.argv[2];
for (let i = 0; i < cases.length; i++) {
  const c = cases[i];
  if (want && c.id !== want) continue;
  const got = parse(c.markdown);
  const exp = expected.cases[i].html;
  if (!want) {
    if (got === exp) continue;
    console.log('MISMATCH', c.id);
  } else {
    console.log('--- markdown ---');
    console.log(JSON.stringify(c.markdown));
    console.log('--- expected ---');
    console.log(JSON.stringify(exp));
    console.log('--- actual ---');
    console.log(JSON.stringify(got));
  }
}
