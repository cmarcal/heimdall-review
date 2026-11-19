const rough = require('roughjs/bundled/rough.cjs.js');

const gen = rough.generator();
const FONT = "'Comic Sans MS', 'Segoe Print', 'Bradley Hand', 'Marker Felt', cursive";

let svgParts = [];

function roundedRectPath(x, y, w, h, r) {
  return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
}

function drawPathsToSvg(drawable) {
  const paths = gen.toPaths(drawable);
  return paths.map(p => {
    const attrs = [];
    if (p.stroke && p.stroke !== 'none') attrs.push(`stroke="${p.stroke}"`);
    if (p.strokeWidth) attrs.push(`stroke-width="${p.strokeWidth}"`);
    if (p.fill && p.fill !== 'none') attrs.push(`fill="${p.fill}"`);
    else attrs.push(`fill="none"`);
    const dash = drawable.options && drawable.options.strokeLineDash;
    if (dash && p.stroke && p.stroke !== 'none' && !(p.fill && p.fill !== 'none')) {
      attrs.push(`stroke-dasharray="${dash.join(' ')}"`);
    }
    return `<path d="${p.d}" ${attrs.join(' ')} stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('\n');
}

function box(x, y, w, h, fill, stroke, roughness = 1.6, r = 14, sw = 2.2) {
  const d = roundedRectPath(x, y, w, h, r);
  const drawable = gen.path(d, {
    fill, fillStyle: 'hachure', hachureGap: 5, fillWeight: 1.4,
    stroke, strokeWidth: sw, roughness, bowing: 1.2, seed: Math.floor(x + y),
  });
  svgParts.push(drawPathsToSvg(drawable));
}

function text(x, y, str, opts = {}) {
  const {
    size = 17, weight = 'bold', color = '#1e1e2e', anchor = 'middle', italic = false,
  } = opts;
  const lines = str.split('\n');
  const lineHeight = size * 1.35;
  const startY = y - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => {
    svgParts.push(
      `<text x="${x}" y="${startY + i * lineHeight}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" ${italic ? 'font-style="italic"' : ''} fill="${color}" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(line)}</text>`
    );
  });
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function arrowHead(x, y, angle, size = 12, color = '#1e1e2e') {
  const a1 = angle + Math.PI * 0.82;
  const a2 = angle - Math.PI * 0.82;
  const p1x = x + size * Math.cos(a1);
  const p1y = y + size * Math.sin(a1);
  const p2x = x + size * Math.cos(a2);
  const p2y = y + size * Math.sin(a2);
  const drawable = gen.polygon([[x, y], [p1x, p1y], [p2x, p2y]], {
    fill: color, fillStyle: 'solid', stroke: color, strokeWidth: 1.5, roughness: 1.2, seed: Math.floor(x + y + 5),
  });
  svgParts.push(drawPathsToSvg(drawable));
}

function arrowLine(x1, y1, x2, y2, opts = {}) {
  const { color = '#1e1e2e', dashed = false, curve = null, roughness = 1.5, sw = 2.2 } = opts;
  let drawable;
  if (curve) {
    drawable = gen.curve(curve, {
      stroke: color, strokeWidth: sw, roughness, bowing: 1.5, seed: Math.floor(x1 + y1 + 3),
      strokeLineDash: dashed ? [7, 6] : undefined,
    });
  } else {
    drawable = gen.line(x1, y1, x2, y2, {
      stroke: color, strokeWidth: sw, roughness, bowing: 1, seed: Math.floor(x1 + y1 + 3),
      strokeLineDash: dashed ? [7, 6] : undefined,
    });
  }
  svgParts.push(drawPathsToSvg(drawable));
  const endSeg = curve ? [curve[curve.length - 2], curve[curve.length - 1]] : [[x1, y1], [x2, y2]];
  const angle = Math.atan2(endSeg[1][1] - endSeg[0][1], endSeg[1][0] - endSeg[0][0]);
  arrowHead(endSeg[1][0], endSeg[1][1], angle, 12, color);
}

function groupPanel(x, y, w, h, fill, stroke, label, emoji, subtitle) {
  const drawable = gen.path(roundedRectPath(x, y, w, h, 26), {
    fill, fillStyle: 'solid', stroke, strokeWidth: 3, roughness: 2.2, bowing: 2, seed: Math.floor(x),
  });
  svgParts.push(drawPathsToSvg(drawable));
  text(x + w / 2, y + 46, `${emoji}  ${label}`, { size: 26, color: stroke, weight: 'bold' });
  text(x + w / 2, y + 78, subtitle, { size: 14, color: '#57534e', weight: 'normal', italic: true });
}

// ---------- Canvas ----------
const W = 1500, H = 1000;

// Background
svgParts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="#fbf9f4"/>`);

// Title
svgParts.push(`<text x="${W/2}" y="46" font-family="${FONT}" font-size="34" font-weight="bold" fill="#1e1e2e" text-anchor="middle">Heimdall — how an AI review stays honest</text>`);
svgParts.push(`<text x="${W/2}" y="80" font-family="${FONT}" font-size="18" fill="#57534e" text-anchor="middle">gather the truth  →  verify every finding  →  publish only what is real</text>`);

// Group panels: the three pillars of one review run
const panelY = 110, panelH = 600;
groupPanel(40, panelY, 460, panelH, '#eef2ff', '#6366f1', 'GATHER', '👁️', 'step 1 — build the truth once, share it with all');
groupPanel(530, panelY, 460, panelH, '#ecfdf5', '#10b981', 'VERIFY', '⚖️', 'step 2 — six specialists × two passes, in parallel');
groupPanel(1020, panelY, 440, panelH, '#fff7ed', '#f97316', 'REPORT', '📣', 'step 3 — consolidate, gate, publish once');

// ---- GATHER column boxes ----
const specX = 70, specW = 400;
box(specX, 210, specW, 66, '#c7d2fe', '#4338ca');
text(specX + specW / 2, 243, '📥  gh: diff + PR title/body\nwhat the PR changes — and claims', { size: 15, color: '#312e81' });

box(specX, 296, specW, 66, '#c7d2fe', '#4338ca');
text(specX + specW / 2, 329, '🎫  the linked issue\nsource of truth — never a guess', { size: 15, color: '#312e81' });

box(specX, 382, specW, 66, '#c7d2fe', '#4338ca');
text(specX + specW / 2, 415, '📚  spec files + repo docs\n(.pr-review.json says where)', { size: 15, color: '#312e81' });

box(specX, 468, specW, 66, '#c7d2fe', '#4338ca');
text(specX + specW / 2, 501, '💬  existing comment threads\nreply in-thread, never re-litigate', { size: 15, color: '#312e81' });

// ReviewContext box (the shared artifact, like PLAN.md in Hefesto)
box(specX + 60, 558, specW - 120, 72, '#fef9c3', '#a16207', 1.8, 10);
text(specX + specW / 2, 594, '📦 ReviewContext\nbuilt once — shared with all six', { size: 15, color: '#713f12' });

// arrows within GATHER
arrowLine(specX + specW / 2, 276, specX + specW / 2, 294, {});
arrowLine(specX + specW / 2, 362, specX + specW / 2, 380, {});
arrowLine(specX + specW / 2, 448, specX + specW / 2, 466, {});
arrowLine(specX + specW / 2, 534, specX + specW / 2, 556, {});

// ---- VERIFY column: six specialists, then the two passes ----
const verX = 560, verW = 400, verCx = verX + verW / 2;
const agents = [
  ['🛡️ Security', 0, 0], ['📋 Requirements', 1, 0],
  ['🧪 E2E tests', 0, 1], ['🏛️ Architecture', 1, 1],
  ['🔁 Regression', 0, 2], ['⚡ Performance', 1, 2],
];
const agW = 190, agH = 52, agGap = 20;
agents.forEach(([label, col, row]) => {
  const ax = verX + col * (agW + agGap);
  const ay = 210 + row * (agH + 8);
  box(ax, ay, agW, agH, '#d1fae5', '#059669', 1.4, 10);
  text(ax + agW / 2, ay + agH / 2, label, { size: 13.5, color: '#064e3b' });
});
text(verCx, 400, 'each one runs its own prompt contract, in parallel', { size: 13, color: '#065f46', weight: 'normal', italic: true });

box(verX, 414, verW, 62, '#a7f3d0', '#047857');
text(verCx, 445, 'pass 1 — find\ncandidates as JSON: file + line + quote', { size: 14, color: '#064e3b' });

box(verX, 498, verW, 62, '#a7f3d0', '#047857');
text(verCx, 529, 'pass 2 — a fresh verifier\nre-reads the real file, must re-quote to keep', { size: 13.5, color: '#064e3b' });

// the quote gate: the core guarantee, drawn in red
box(verX, 582, verW, 88, '#fee2e2', '#dc2626', 1.8, 14, 3);
text(verCx, 626, '🚪 QUOTE GATE — enforced in code\nfileContent.includes(verifiedEvidence)\na quote not in the file is dropped, not posted', { size: 13.5, color: '#7f1d1d' });

arrowLine(verCx, 382, verCx, 412, {});
arrowLine(verCx, 476, verCx, 496, {});
arrowLine(verCx, 560, verCx, 580, {});

// ---- REPORT column boxes ----
const repX = 1050, repW = 380, repCx = repX + repW / 2;
box(repX, 210, repW, 76, '#fed7aa', '#c2410c');
text(repCx, 248, '🧹 consolidate\ndedupe close lines · merge root causes\nrewrite everything to one author voice', { size: 13.5, color: '#7c2d12' });

box(repX, 308, repW, 76, '#fed7aa', '#c2410c');
text(repCx, 346, '🔍 gap-check the silent files\ncoverage is DECLARED — what it\ndid not deeply review is listed', { size: 13.5, color: '#7c2d12' });

box(repX, 406, repW, 76, '#fed7aa', '#c2410c');
text(repCx, 444, '🎯 verdict\ncalibrated score map → tier only\nthe numeric score stays private', { size: 13.5, color: '#7c2d12' });

box(repX, 504, repW, 92, '#fed7aa', '#c2410c');
text(repCx, 550, '📣 post: review COMMENT + pinned summary\ndry-run first · never APPROVE, never block\nre-runs update their own comment in place', { size: 13, color: '#7c2d12' });

arrowLine(repCx, 286, repCx, 306, {});
arrowLine(repCx, 384, repCx, 404, {});
arrowLine(repCx, 482, repCx, 502, {});

// ---- cross-column arrows ----
// ReviewContext -> six specialists
arrowLine(specX + specW - 70, 590, verX - 4, 236, {
  color: '#a16207', curve: [[specX + specW - 70, 590], [verX - 70, 470], [verX - 4, 236]],
});
text(specX + specW + 42, 380, 'one shared\ncontext', { size: 13, color: '#a16207', italic: true });

// quote gate -> consolidate (only survivors travel)
arrowLine(verX + verW, 620, repX - 4, 248, {
  color: '#047857', curve: [[verX + verW, 620], [repX - 40, 470], [repX - 4, 248]],
});
text(repX - 30, 355, 'verified\nfindings only', { size: 13, color: '#047857', italic: true });

// ---- bottom band: pluggable brain + self-disclosure ----
const bandX = 40, bandY = 750, bandW = 1420, bandH = 190;
const bandDrawable = gen.path(roundedRectPath(bandX, bandY, bandW, bandH, 22), {
  fill: '#f0f9ff', fillStyle: 'solid', stroke: '#0284c7', strokeWidth: 2.6, roughness: 2,
  strokeLineDash: [9, 7], seed: 71,
});
svgParts.push(drawPathsToSvg(bandDrawable));
text(W / 2, 922, 'one brain, any model — and honest about its own limits', { size: 17, color: '#075985' });

const brainBoxes = [
  'any OpenAI-compatible model\n(OpenRouter free · Groq · Ollama)',
  'Anthropic adapter\n--preset anthropic',
  'ollama-local\nfully offline and private',
  'heimdall doctor\nprobes models — no over-declaring',
  'eval (offline + --live)\nrecall · precision · hallucinations',
  '/heimdall-review skill\nsame gate, script-enforced',
];
const bbW = 205, bbGap = 26, bbY = 780, bbH = 80, bbX0 = 70;
const panelBottom = panelY + panelH;
brainBoxes.forEach((label, i) => {
  const bx = bbX0 + i * (bbW + bbGap);
  box(bx, bbY, bbW, bbH, '#bae6fd', '#0369a1', 1.4);
  text(bx + bbW / 2, bbY + bbH / 2, label, { size: 13, color: '#0c4a6e' });
  // dashed edge up into the pipeline this supports
  arrowLine(bx + bbW / 2, bbY, bx + bbW / 2, panelBottom + 4, { color: '#0369a1', dashed: true });
});
[270, 760, 1211].forEach(cx => {
  text(cx, 732, 'supports every stage', { size: 13, color: '#0369a1', weight: 'normal', italic: true });
});

// legend footer
svgParts.push(`<text x="${W/2}" y="${H-24}" font-family="${FONT}" font-size="14" fill="#78716c" text-anchor="middle">a finding without a real code quote does not exist — the gate is harness-enforced, not prompted</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
${svgParts.join('\n')}
</svg>`;

require('fs').writeFileSync(process.argv[2] || `${__dirname}/architecture.svg`, svg);
console.log('wrote svg,', svgParts.length, 'parts');
