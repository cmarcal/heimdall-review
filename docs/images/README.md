# Architecture diagram source

`architecture.svg` (embedded in the root `README.md`) is generated, not
hand-drawn — edit `generate-architecture.js` and regenerate rather than
editing the SVG directly.

```bash
cd docs/images
npm install
npm run build   # writes architecture.svg
```

The script uses [rough.js](https://roughjs.com) — the same hand-drawn
rendering engine Excalidraw is built on — to draw the Excalidraw-style shapes,
and plain SVG `<text>` for labels. Layout is a 3-column pipeline of the three
pillars of one review run (GATHER → VERIFY → REPORT); box positions are
hand-tuned coordinates in the script, grouped by column with comments. A
dashed band below the columns shows the pluggable model layer and the
self-disclosure tooling (presets, doctor, eval, the agent skill). Dashed
arrows from the band into each column are labelled "supports every stage".
