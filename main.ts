import { readFileSync, writeFileSync } from 'node:fs';

import { parse } from './parse.js';

// The harness runs this as `node /bot/main.ts` with /input and /output; a local
// grade with the process driver passes MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// instead, and argv overrides both.
const input = process.argv[2] ?? (process.env.MAKEFUN_INPUT_DIR ?? '/input') + '/cases.json';
const output = process.argv[3] ?? (process.env.MAKEFUN_OUTPUT_DIR ?? '/output') + '/html.json';

const cases: { id: string; markdown: string }[] = JSON.parse(readFileSync(input, 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(output, JSON.stringify(html));
