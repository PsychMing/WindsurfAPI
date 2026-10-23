#!/usr/bin/env node
/**
 * UISpec P2 — dashboard palette contrast gate.
 *
 * P2-12 was "the provider swatches are hardcoded hex and 5/11 fall under 3:1 on
 * one theme or the other". The fix moved them to theme-aware tokens; this gate
 * is what keeps them honest, and it also re-checks the token pairs the account
 * UI leans on (labels, badges, dots, brand blocks).
 *
 * Floors (WCAG 2.2):
 *   4.5:1 — text (--text, --text-muted, --text-dim; badge labels; brand button text)
 *   3.0:1 — graphical objects (swatches, status dots, meter fills) (1.4.11)
 *   1.08  — surface ladder steps (UIPlan G4: a card must separate from its page)
 *
 * --text-faint is deliberately NOT checked: it is the disabled/decorative token
 * and never carries body copy (see the comment on its definition).
 *
 * Exit 0 = every pair clears its floor in BOTH themes.
 * Exported as lintDashboardContrast() for the test suite.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readStyleBlock, customProperties, resolveVar, parseColor, composite, contrastRatio,
} from './dashboard-css.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PROVIDERS = [
  'anthropic', 'openai', 'google', 'deepseek', 'xai', 'alibaba',
  'moonshot', 'zhipu', 'minimax', 'windsurf', 'other',
];

/** Hue tokens that render as dots / bars / borders — graphical floor. */
export const GRAPHICAL = ['--accent', '--success', '--warn', '--error', '--info'];

/** Soft washes that sit behind a --text label inside .badge / chips, and the
 *  hue each wash puts in the 6px dot. */
export const SOFT = {
  '--surface-3': '--text-dim',
  '--success-soft': '--success',
  '--error-soft': '--error',
  '--warn-soft': '--warn',
  '--info-soft': '--info',
  '--accent-soft': '--accent',
};

export const TEXT_FLOOR = 4.5;
export const GRAPHICAL_FLOOR = 3;
export const LADDER_FLOOR = 1.08;

function readDashboardHtml() {
  return fs.readFileSync(path.join(ROOT, 'src/dashboard/index.html'), 'utf8');
}

function themeMaps(html) {
  const css = readStyleBlock(html);
  const light = customProperties(css, ':root');
  const dark = { ...light, ...customProperties(css, '[data-theme="dark"]') };
  return { light, dark };
}

function color(vars, name) {
  const raw = resolveVar(vars[name], vars);
  const parsed = parseColor(raw);
  if (!parsed) throw new Error(`${name} is not a colour: ${raw}`);
  return parsed;
}

function onSurface(vars, name) {
  const surface = color(vars, '--surface');
  const fg = color(vars, name);
  return fg.a < 1 ? composite(fg, surface) : fg;
}

export function lintDashboardContrast(html = readDashboardHtml()) {
  const problems = [];
  const { light, dark } = themeMaps(html);

  for (const [theme, vars] of Object.entries({ light, dark })) {
    const surface = color(vars, '--surface');

    // 1. Provider swatches: 3:1 against the surface they sit on.
    for (const provider of PROVIDERS) {
      const token = `--prov-${provider}`;
      if (!(token in vars)) { problems.push(`${theme}: ${token} is not defined`); continue; }
      const ratio = contrastRatio(onSurface(vars, token), surface);
      if (ratio < GRAPHICAL_FLOOR) problems.push(`${theme}: ${token} is ${ratio}:1 on --surface (needs ${GRAPHICAL_FLOOR})`);
    }

    // 2. Text tokens.
    for (const token of ['--text', '--text-muted', '--text-dim']) {
      const ratio = contrastRatio(onSurface(vars, token), surface);
      if (ratio < TEXT_FLOOR) problems.push(`${theme}: ${token} is ${ratio}:1 on --surface (needs ${TEXT_FLOOR})`);
    }

    // 3. Graphical tokens (status dots, meter fills, focus rings).
    for (const token of GRAPHICAL) {
      const ratio = contrastRatio(onSurface(vars, token), surface);
      if (ratio < GRAPHICAL_FLOOR) problems.push(`${theme}: ${token} is ${ratio}:1 on --surface (needs ${GRAPHICAL_FLOOR})`);
    }

    // 4. Filled blocks: the label colour on the fill.
    const accent = color(vars, '--accent');
    const onAccent = color(vars, '--on-accent');
    const accentRatio = contrastRatio(onAccent, accent);
    if (accentRatio < TEXT_FLOOR) problems.push(`${theme}: --on-accent is ${accentRatio}:1 on --accent (needs ${TEXT_FLOOR})`);

    for (const brand of ['google', 'github']) {
      const fg = color(vars, `--brand-${brand}-fg`);
      for (const bg of [`--brand-${brand}-bg`, `--brand-${brand}-bg-hover`]) {
        const ratio = contrastRatio(fg, color(vars, bg));
        if (ratio < TEXT_FLOOR) problems.push(`${theme}: --brand-${brand}-fg is ${ratio}:1 on ${bg} (needs ${TEXT_FLOOR})`);
      }
    }

    // 5. Badge: --text label on the soft wash, hue dot on the same wash.
    const label = color(vars, '--text');
    for (const [soft, dot] of Object.entries(SOFT)) {
      const wash = onSurface(vars, soft);
      const labelRatio = contrastRatio(label, wash);
      if (labelRatio < TEXT_FLOOR) problems.push(`${theme}: --text is ${labelRatio}:1 on ${soft} (needs ${TEXT_FLOOR})`);
      const dotRatio = contrastRatio(color(vars, dot), wash);
      if (dotRatio < GRAPHICAL_FLOOR) problems.push(`${theme}: ${dot} is ${dotRatio}:1 on ${soft} (needs ${GRAPHICAL_FLOOR})`);
    }

    // 6. Surface ladder: each step must separate from the one below it.
    const ladder = ['--paper', '--surface', '--surface-2', '--surface-3'];
    for (let i = 1; i < ladder.length; i++) {
      const ratio = contrastRatio(color(vars, ladder[i]), color(vars, ladder[i - 1]));
      if (ratio < LADDER_FLOOR) problems.push(`${theme}: ${ladder[i]} is ${ratio}:1 against ${ladder[i - 1]} (needs ${LADDER_FLOOR})`);
    }
  }

  return { ok: problems.length === 0, problems };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const { ok, problems } = lintDashboardContrast();
  if (ok) {
    console.log('✓ dashboard palette: every token pair clears its WCAG floor in both themes');
    process.exit(0);
  }
  console.error(`✗ dashboard palette: ${problems.length} contrast failure(s)`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
