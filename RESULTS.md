# Results

| | CPU time, practice set |
|---|---|
| marked 18.1.3 (house baseline) | to be measured |
| this entry | to be measured |

Match: 720 / 720 practice cases byte-identical to `marked.parse`.

## Fast path versus fallback

- **Fallback** (`marked.parse`): any input where the fast parser throws, plus
  non-string input.
- **Fast path**: hand-written block and inline scanners that emit HTML directly
  (no token tree): paragraphs, ATX and setext headings, thematic breaks,
  indented and fenced code, block quotes, bullet/ordered/task lists, GFM tables,
  link reference definitions, raw HTML blocks, emphasis/strong/strikethrough,
  code spans, inline HTML, links, reference links, images, autolinks, GFM
  extended autolinks, entities, backslash escapes and hard line breaks.
