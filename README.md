# makefun-markdown-render-speed-v4

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/ahdirmai/makefun-markdown-render-speed-v4/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/ahdirmai/makefun-markdown-render-speed-v4/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A byte-exact, faster drop-in for marked 18.1.3: `parse.js` exports `parse(markdown)` and returns exactly what `marked.parse(markdown)` returns with marked's defaults, using its own block and inline scanners and building the HTML as strings instead of a token tree.

## Result

- **720/720** practice cases identical, code unit for code unit.
- **1.44×** faster than marked on the practice set (281.7 ms → 195.0 ms CPU, median of alternating runs on the same machine).
- Zero fallbacks on the whole practice set: the fast path renders every case itself.

## Run it

    node main.ts                      # reads /input/cases.json, writes /output/html.json
    node main.ts cases.json out.html  # local override

## Verify

    node tools/bench.mjs --repeat 5
    node tools/bench.mjs --baseline --repeat 5

`RESULTS.md` has the measurements, the constructs the fast path covers and the ones that fall back to marked.

Vendored marked keeps its MIT licence and notice in `vendor/marked/`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=ttzeesk6&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
