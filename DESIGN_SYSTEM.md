# Design System — Ultra Minimal

> Generated from archetype DNA. **Radical restraint — one idea per viewport, vast whitespace, black on white, no ornament.**
> Theme: `light` · Mood: _restrained, confident, quiet_ · Density: `spacious` · Contrast: `high`

This file is the single source of truth for the visual language of this app.
Archetypes define **look and feel** — typography, color, spacing, component
aesthetics, motion. They do **not** define layout: which pages exist and how
they are structured comes from the product's functional requirements. Build
each page for its own job, but style every element per the rules below.

All values below are exposed as CSS custom properties in `app/globals.css`.
Reference them with `var(--token)` — never hard-code a hex, px, or font name.

## a. Color system

The palette is the Campaign Creators brand (CC Web UI Kit v2.0), as defined in
`src/app/globals.css`. Prefer the short tokens (`--primary`, `--ink`, `--line`…);
the `--color-*` names are aliases kept for older styles.

| Role | Token | Value |
|------|-------|-------|
| Primary (navy) | `--primary` / `--color-primary` | `#0E3860` |
| Primary (hover, dark navy) | `--primary-700` | `#0C2237` |
| Secondary (accent green) | `--secondary` / `--color-secondary` / `--color-accent` | `#35FFD8` |
| Violet / Blue (brand extras) | `--color-violet` / `--color-blue` | `#8D11ED` / `#1084FF` |
| Background | `--bg` / `--color-background` | `#FFFFFF` |
| Surface | `--tint-1` / `--color-surface` | `#F8F9FC` |
| Surface (raised) | `--color-surface-2` | `#F1F3F5` |
| Text | `--ink` / `--color-text` | `#0C2237` |
| Text (secondary) | `--ink-2` / `--color-text-secondary` | `#485059` |
| Text (muted) | `--ink-3` / `--color-text-muted` | `#868E96` |
| Border | `--line` / `--color-border` | `#DEE2E6` |
| Border (strong) | `--line-strong` | `#CED4DA` |
| Good / Warn / Bad | `--good` / `--warn` / `--bad` (`--color-error`) | `#35FFD8` / `#F59E0B` / `#EE3B27` |

Primary is used for the main CTA, active states, and focus rings. Secondary and
accent are supporting — never let them compete with primary. Status colors are
ONLY for success/warning/error/info states, never decoration.

## b. Typography system

- **Display font:** Inter — headings, hero text, primary buttons. `var(--font-display)`
- **Body font:** Inter — paragraphs, labels, UI text. `var(--font-body)`
- **Modular scale ratio:** 1.5

| Step | Token | Size |
|------|-------|------|
| Display / H1 | `--text-display` | `54px` |
| H2 | `--text-h2` | `36px` |
| H3 | `--text-h3` | `24px` |
| Body | `--text-body` | `16px` |
| Small / caption | `--text-small` | `13px` |

**Weights:** display `500`, headings `500`, body `400`, emphasis `600`.
**Letter-spacing:** headings `-0.03em`, body `-0.005em`, uppercase labels/eyebrows `0.04em`.
This archetype uses a single sans family — do not introduce a monospace face.

## c. Spacing system

Base unit: **8px** · rhythm: **airy**.
Section padding ≈ `120px`, gap between sibling components ≈ `48px`.

| Token | Value | Typical use |
|-------|-------|-------------|
| `--space-xs` | `8px` | icon gaps, tight inline spacing |
| `--space-sm` | `16px` | button padding, input padding |
| `--space-md` | `32px` | card padding, component gaps |
| `--space-lg` | `48px` | gaps between groups |
| `--space-xl` | `80px` | sub-section spacing |
| `--space-2xl` | `128px` | section spacing |
| `--space-3xl` | `192px` | major page-section spacing |

## d. Component patterns

Use these exact class combinations. They reference the tokens above, so they
recolor and re-scale automatically. Customise by adjusting tokens, not classes.

### Buttons — _rounded-md, small footprint, solid black/ink primary, plain ghost link_
```
inline-flex items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] text-white font-[var(--font-display)] font-semibold px-[var(--space-md)] py-[var(--space-sm)] transition-all duration-[var(--transition-normal)] hover:bg-[var(--color-primary-hover)]
```
Hover: background → accent, no movement. Secondary buttons swap the fill for
`bg-transparent border border-[var(--color-border)] text-[var(--color-text)]`.

### Cards — _no cards — content floats in whitespace_
```
bg-[var(--color-surface)] rounded-[var(--radius-lg)] p-[var(--space-md)]
```
Padding 0. Borders: none. Hover: none.

### Inputs — _minimal bordered or underline field_
```
w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] px-[var(--space-sm)] py-[var(--space-sm)] transition-colors duration-[var(--transition-fast)] focus:outline-none focus:border-[var(--color-primary)]
```
Border treatment: single hairline. Focus: border → accent.

### Navigation — _wordmark + single hidden-menu link_
Spacing: maximal — nav is nearly empty. Active item: color only.
Build the nav structure to fit the app's information architecture, but style it
with the tokens and the look described here.

### Badges — _plain text_
```
inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--color-primary-subtle)] text-[var(--color-primary)] text-xs font-medium px-2 py-0.5
```
Sizing: tiny, used sparingly.

## e. Motion rules

Philosophy: **minimal**.

| Token | Value |
|-------|-------|
| `--transition-fast` | `80ms` |
| `--transition-normal` | `120ms` |
| `--transition-slow` | `180ms` |
| `--ease` | `cubic-bezier(0.4,0,0.2,1)` |

- **Hover transitions:** 120ms color
- **Page transitions:** clean fade
- **Micro-interactions:** almost none — restraint is the point

Every interactive element gets `transition` with `duration-[var(--transition-normal)]`
and `ease-[var(--ease)]`. Decorative elements for this archetype: whitespace, the occasional 1px separator — nothing else.

## f. Anti-patterns — what NOT to do

These are hard rules. Violating them breaks the archetype:

- Do NOT use Tailwind default color utilities (`bg-blue-500`, `text-gray-600`, `border-slate-200`). Every color MUST come from a `var(--color-*)` token.
- Do NOT substitute the typefaces. Display is **Inter**, body is **Inter** — load only these via `app/globals.css`.
- Do NOT use `shadow-md`, `shadow-lg`, or `drop-shadow`. This archetype is flat — surfaces are separated by borders and spacing, never by shadow.
- Do NOT box content in borders — separation is achieved with whitespace. Cards are borderless.
- Do NOT crowd elements — generous whitespace IS the design. Lean on `--space-2xl` / `--space-3xl`.
- Do NOT add scale, bounce, or staged animations — transitions are near-instant and utilitarian.

## Token reference

`src/app/globals.css` is the authoritative token list; when the two disagree,
`globals.css` wins. Colour tokens are in section a. The non-colour rows below
date from the original generated design and are kept for reference until they
are re-checked against `globals.css`.

| Token | Value |
|-------|-------|
| `--font-display` | `'Inter', system-ui, sans-serif` |
| `--font-body` | `'Inter', system-ui, sans-serif` |
| `--font-mono` | `'ui-monospace', ui-monospace, monospace` |
| `--font-weight-display` | `500` |
| `--font-weight-body` | `400` |
| `--tracking-display` | `-0.03em` |
| `--tracking-label` | `0.04em` |
| `--text-display` | `54px` |
| `--text-h2` | `36px` |
| `--text-h3` | `24px` |
| `--text-body` | `16px` |
| `--text-small` | `13px` |
| `--radius-sm` | `4px` |
| `--radius-md` | `6px` |
| `--radius-lg` | `10px` |
| `--radius-full` | `9999px` |
| `--shadow-sm` | `none` |
| `--shadow-md` | `none` |
| `--shadow-lg` | `none` |
| `--space-xs` | `8px` |
| `--space-sm` | `16px` |
| `--space-md` | `32px` |
| `--space-lg` | `48px` |
| `--space-xl` | `80px` |
| `--space-2xl` | `128px` |
| `--space-3xl` | `192px` |
| `--transition-fast` | `80ms` |
| `--transition-normal` | `120ms` |
| `--transition-slow` | `180ms` |
| `--ease` | `cubic-bezier(0.4,0,0.2,1)` |
