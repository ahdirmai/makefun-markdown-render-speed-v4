import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from './parse.js';

const input = process.argv[2] ?? '/input/cases.json';
const output = process.argv[3] ?? '/output/html.json';

const cases: { id: string; markdown: string }[] = JSON.parse(readFileSync(input, 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) html[i] = parse(cases[i].markdown);
writeFileSync(output, JSON.stringify(html));
