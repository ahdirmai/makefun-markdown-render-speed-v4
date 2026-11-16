# Results

Practice set: 720 cases (680 CommonMark/GFM spec examples + 40 generated documents),
2,862,813 bytes of Markdown.

| | CPU time, practice set |
|---|---|
| marked 18.1.3 (house baseline) | 600 ms |
| this entry | 480 ms |
| change | −20 % (1.25× faster) |

CPU is user+system of the whole run, `node main.ts <cases> <out>`, median of nine
alternating runs, JSON read and write included (that is what the grader times).
With only the render loop timed, in a fresh process: baseline 566 ms, this entry
386 ms (−32 %, 1.47×); warm in a single process: 290 ms against 190 ms.

Match: **720 / 720** practice cases byte-identical to `marked.parse`, and the
720-case output file is byte-identical to the reference's HTML.

## Fast path versus fallback

The fast path parses everything exercised by the practice set (720/720, 0 calls
into marked) and by 26,000 random Markdown fragments checked against
`marked.parse` with no mismatch. `parse()` wraps it in `try/catch`; on any
unexpected input, or on non-string input, the whole document goes to
`marked.parse`, so a case the scanners cannot prove identical costs time, never
correctness.

Fast path (hand-written scanners emitting HTML directly, no token tree):

- blocks: ATX and setext headings, thematic breaks, indented and fenced code,
  block quotes (including lazy continuation and the merging rules), bullet,
  ordered and task lists (tight and loose, nesting, the tab-stop arithmetic),
  GFM tables (cell splitting, alignment, row termination), link reference
  definitions, raw HTML blocks (the seven kinds), paragraphs
- inline: backslash escapes, inline HTML tags and comments, links, reference
  links, images, autolinks, GFM extended autolinks (URLs and e-mail),
  emphasis/strong (marked's delimiter algorithm with its masking pass),
  strikethrough, code spans, hard line breaks, entities

Fallback: any exception, and non-string input. It is a safety net only; it does
not run on the practice set.

## What made it faster

- No token tree and no inline queue: blocks are scanned once and rendered
  straight to strings; marked allocates a token object per construct and copies
  the remaining source per token.
- Index-based scanners instead of re-slicing the document per token, and
  line-end/indent lookups cached across the tokenizers tried at one position.
- Plain text runs are found with a 128-entry character-class table instead of
  marked's large `inline.text` regex (the single hottest regex in marked).
- URL and e-mail attempts are gated on the scheme characters or a reachable
  `@`, so the URL rule no longer runs at every position.
- The emphasis delimiter search still uses marked's two closer regexes (the
  algorithm's quirky parts are easier to get exactly right that way), but the
  masked copy is only built when a delimiter can actually open, and the
  "last possible closer" scan runs once per inline string for all three
  delimiters.
- `encodeURI`, label case-folding and HTML escaping take fast paths for the
  common ASCII cases.

## Files

- `main.ts` — the entrypoint: reads `/input/cases.json`, renders each case with
  `parse`, writes `/output/html.json` (argv overrides for local runs).
- `parse.js` — `parse(markdown)`; dependency-free ES module.
- `vendor/marked/` — marked 18.1.3, byte-identical to the kit's copy (MIT), the
  reference the fallback renders with.
- `tools/bench.mjs` — practice-set bench: match count, first mismatch and its
  character index, CPU timings, `--baseline` for the kit's marked baseline.
- `tools/case.mjs` — dump one practice case's Markdown, expected and actual HTML.
