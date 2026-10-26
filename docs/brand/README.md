# Gilde brand

The mark is a Dutch stepped gable (trapgevel): the front of a guild house, as on the Grand-Place in Brussels or an Amsterdam canal house. Door and window are holes (negative space), so the mark works on any background.

| File | Use |
|---|---|
| `apps/web/public/brand/gilde-mark.svg` / `-dark.svg` | Mark on light / dark backgrounds (amethyst → indigo gradient) |
| `apps/web/public/brand/gilde-mark-mono.svg` | Single colour, `currentColor` |
| `apps/web/public/brand/gilde-logo.svg` / `-dark.svg` / `-mono.svg` | Mark + "Gilde" (Figtree SemiBold, outlined) |
| `apps/web/public/brand/gilde-app-icon.svg`, `icon-192.png`, `icon-512.png` | White gable on the gradient, rounded square (app icon, Slack bot avatar) |
| `apps/web/app/icon.svg`, `favicon.ico`, `apple-icon.png` | Picked up by Next.js as favicon and touch icon |

In the app, use `GildeMark` / `GildeLogoTile` from `components/gilde-mark.tsx`: they draw the same path with theme tokens.

`generate.py` regenerates the SVGs (needs fontTools and Figtree SemiBold from `@fontsource/figtree`); the PNGs and `favicon.ico` were rendered from the app icon SVG.
