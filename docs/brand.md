# Brand

The logo is the **NIGHTMAIL** wordmark, in wide squared-off capitals, and the **NM** monogram on a square tile. The **lockup** is the tile with the wordmark beside it. In running text the product's name stays lowercase: nightmail.

## Files

| file | use |
| --- | --- |
| `app/public/brand/nightmail-lockup.svg`, `nightmail-lockup-reversed.svg` | tile and wordmark on one line: ink for a pale background, paper (reversed) for a dark one |
| `app/public/brand/nightmail-lockup-stacked.svg`, `nightmail-lockup-stacked-reversed.svg` | the tile centred over the wordmark |
| `app/public/brand/nightmail-wordmark.svg` | the wordmark alone |
| `app/public/brand/nightmail-monogram.svg`, `nightmail-monogram-reversed.svg` | the tile alone |
| `app/public/brand/favicon-16.png`, `favicon-32.png`, `favicon-16.svg` | the tile drawn by hand for 16 and 32 px: `favicon.ico` is packed from the two PNGs |
| `app/public/favicon.svg`, `favicon-dark.svg` | the 32 px drawing as a vector: ink for a browser's pale theme, paper for its dark one |
| `app/public/favicon.ico`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `og.png` | browser and home-screen icons, and the link-preview card |
| `app/src/lib/marks.ts` | the wordmark's and the monogram's outlines, as the app draws them |
| `app/src/components/NightmailLogo.tsx` | `NightmailWordmark` (the wordmark alone) and `NightmailMark` (the tile), each one inline SVG that follows the theme |

The SVGs in `app/public/brand/`, `favicon.svg`, `favicon-dark.svg` and `apple-touch-icon.png` are the final vector set's own files, copied in unchanged. `node scripts/brand-assets.mjs` in `app/` builds the rest: it packs `favicon.ico`, draws the three manifest icons from `nightmail-monogram.svg`, and photographs `og.png` from the built homepage (`bun run build` first; `BRAND_ONLY=og` for the card alone, `BRAND_ONLY=icons` for everything but the card).

Everything is outlined, so no font is needed to render the files. Use the PNGs in email, because many mail clients don't show SVG.

## Colour

| token | light | dark | used for |
| --- | --- | --- | --- |
| `--color-logo` | ink `#0A0B0F` | paper `#F4F2EC` | the wordmark and the monogram |

The marks are set in the brand's ink on a pale ground and its paper on a dark one, and in nothing else. The app icons are the paper NM on a full square of ink. The periwinkle `--color-brand` (`#798ABA`) is an accent on the homepage's machine, not a logo colour.

## Construction

Measured with the cap height as 100:

- **Wordmark:** 1080 wide; stems 32; corners rounded by 4.
- **Tile:** a square exactly as tall as the caps, corner radius 12, with the NM cut out of it. The NM's stems are 11.9 and it stands 10 in from the tile's left and right edges.
- **Lockup:** the tile one stem (32) left of the wordmark, on the same baseline: 1212 wide in all.
- **Stacked lockup:** the tile at 240, centred over the wordmark, 96 above it.

Where the app sets them:

- **In the app, the wordmark stands alone.** The tile is kept for places that need a square mark: the browser's tab, the app icons, the support chat's avatar and the homepage's header.
- **Dashboard sidebar:** `NightmailWordmark` at 13 px cap height, so 140 px across, at the top with the theme button beside it and the workspace picker under it. Its first stem stands on the text's left edge, the same x as the picker's name and the navigation labels (`--sidebar-gutter` + `--sidebar-inset`). In the narrower sidebar (900 to 1100 px wide) it is 11 px, so it clears the theme button.
- **A phone's top bar (under 640 px):** 11 px, as tall as the caps of the workspace picker's name beside it; 10 px under 380 px. From 640 px the bar carries it at 13 px.
- **Onboarding and the legal pages:** 13 px, at the head of the page.
- **Support chat:** `NightmailMark` at 18 px beside the agent's name.
- **Homepage:** the header carries the tile alone (26 px, 24 on a phone). The wordmark stands in lit letters at the head of the sorting frame, exactly as wide as the price under it (`features/home/sorter/name.ts`), and again across the page's end as solids cut off by the page's edge (`features/home/end-band.tsx`). `og.png` sets the lockup beside the machine.

## Clear space and size

- **Clear space:** keep at least half the cap height clear on every side of the lockup, and half the tile's side round the tile alone.
- **Minimum size:** the wordmark alone at 10 px cap height, the lockup at 12 px. The tile alone at 18 px as a vector; at 16 and 32 px use the hand-drawn tiles, whose stems are whole pixels.

## Favicon and app icons

- **Browser tab:** `favicon.ico` holds the hand-drawn 16 and 32 px tiles (ink tile, paper NM). Browsers that take a vector get `favicon.svg` on a pale theme and `favicon-dark.svg` on a dark one:
  `<link rel="icon" href="/favicon.ico" sizes="32x32">`, then `<link rel="icon" type="image/svg+xml" href="/favicon.svg" media="(prefers-color-scheme: light)">` and the same for `/favicon-dark.svg` with `dark`. Keep `sizes="32x32"` on the `.ico`: with `16x16` listed too, Chrome takes the `.ico` over the vectors and a dark tab strip shows the ink tile. `app/index.html` and `app/public/signed-in/index.html` carry the links; the support Worker serves the two vectors for its own pages (`support/src/favicon.ts`: keep them the same drawing).
- **Home screen:** `apple-touch-icon.png` (180) is a full square of ink with the paper NM, eight tenths of the side across; iOS rounds it. `icon-192.png` and `icon-512.png` are the same drawing. `icon-maskable-512.png` has the NM at eight tenths of that, inside the circle a launcher may crop to.

## Don't

- Stretch, respace, redraw or rotate the marks, or set the wordmark in another typeface or in lowercase.
- Recolour them outside ink and paper, or add gradients, outlines, shadows or glows.
- Take the NM off its tile, or put the wordmark on a tile. The app icons, where the NM stands on a full square, are the one exception.
- Crop the wordmark. The homepage's end band, cut off by the page's edge as a poster's is, is the one exception; there and in the sorting frame, where the wordmark is given depth, its face stays the outline itself and its sides take a darker tone.
