# Server Central — logo

The mark is a bracketed array: two brackets enclosing a 2×2 grid of nodes. The brackets are
the management layer, the nodes are the fleet. Brackets read as scope and containment to
anyone who writes config, which makes the mark specific to *managing* servers rather than
to infrastructure generally.

Wordmark is TeX Gyre Adventor Bold (a free Avant Garde cut) at -1.2% tracking, converted to
outlines. No webfont needed at runtime, and no font redistribution question — the paths are
yours.

## Files

| File | Use |
|---|---|
| `sc-mark.svg` | Mark, `currentColor` — inherits CSS `color`. Default for in-app. |
| `sc-mark-blue.svg` | Mark, brand blue baked in. For contexts with no CSS. |
| `sc-lockup.svg` | Mark + wordmark, all `currentColor`. Monochrome lockup. |
| `sc-lockup-color.svg` | Mark in blue, wordmark in ink. Marketing / README header. |
| `sc-favicon.svg` | Rounded blue tile, white mark. |
| `favicon.ico` | 16/32/48/64 multi-size. |
| `icon-192.png`, `icon-512.png` | PWA manifest icons. |
| `apple-touch-icon.png` | 180px, iOS home screen. |
| `sc-mark-512.png`, `sc-lockup-color.png` | Raster fallbacks. |
| `sc-mark-for-search.png` | Flat white background, for image/trademark search uploads. |
| `preview.png` | Contact sheet, all sizes. |

## Geometry

Drawn on a 32-unit grid. Stroke 2.8, nodes r2.8, brackets inset 4.6 from the edge.
Visual bounds are 25.6 × 25.6 — near-square, so it centres cleanly in a square icon slot
without dead space. If you rescale, keep the stroke and node radius equal; that equality is
what stops the mark going patchy at small sizes.

## Colors

- Brand blue `#2563EB`
- Ink `#0F172A`
- On dark backgrounds use `#FFFFFF` for both mark and wordmark.

The `currentColor` files need no edit to retheme — set `color` on the parent. To change the
baked-in blue, find-and-replace `#2563EB` across the SVGs and regenerate the PNGs.

## Sizing rules

- Mark: good down to 16px as-is. No simplified variant needed — there are no thin elements
  to lose, which is why this direction beat the alternatives.
- Lockup: minimum 20px tall. Below that, drop the wordmark and use the mark alone.
- Clear space: one node diameter (≈11% of mark width) on all sides.
- Below 20px prefer `sc-favicon.svg` over the bare mark — the filled tile gives the nodes a
  background to sit against.

## Wiring it up

```css
.brand { color: #2563EB; display: inline-flex; align-items: center; gap: 8px; }
.brand svg { width: 20px; height: 20px; }
```

Inline the contents of `sc-mark.svg` inside `.brand` and it picks up the colour, including
in dark mode if you flip `color` there.

Head tags:

```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/sc-favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## Don't

- Don't add a drop shadow, gradient, or outline to the mark.
- Don't rebuild the lockup by setting the wordmark in another typeface — use the SVG.
- Don't place the bare mark on a blue background; use `sc-favicon.svg`.
- Don't fill the space between the brackets with anything but the four nodes.
