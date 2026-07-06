---
paths:
  - "src/**/*.css"
  - "src/**/*.module.css"
  - "src/components/**"
  - "src/app/**/*.tsx"
---

# Brand token rules

Color tokens live in `src/app/globals.css`, not in `DESIGN_SYSTEM.md`.
DESIGN_SYSTEM.md's documented palette (`--color-primary: #2563eb`, etc.) is a
generic placeholder left over from the design-system generator — it does not
match the CC brand actually implemented in this app. Use the real tokens:

- `--color-dark-navy` / `--ink` (`#0C2237`) — primary text, dark surfaces.
- `--color-accent` / `--secondary` / `--good` (`#35FFD8`) — brand teal accent.
- `--font-display` / `--font-body` / `--font-sans` — Inter (loaded via
  `next/font/google` in `src/app/layout.tsx`).

Always reference `var(--token)` from `globals.css`; never hard-code a hex
value or introduce a new color outside this palette. DESIGN_SYSTEM.md still
governs spacing scale, radii, shadows, and component anti-patterns — only its
color section is out of date.
