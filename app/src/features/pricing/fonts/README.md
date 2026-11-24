# The price pages' first fonts

The page each price page paints from its HTML (app/price-pages.ts) sets its words in Inter and OpenTUI Mono cut down to
Basic Latin and the few signs the pages use, so the first screen fetches about 70 kB of fonts rather than about 230 kB.
They are the app's own fonts (public/fonts) with every other glyph left out, outlines, axes and OpenType features
unchanged, so nothing looks different when the whole font is in; the page's @font-face rules name them for these
characters only (`unicode-range`), and a character outside them comes from the whole font as before.

| File | From | Bytes |
| --- | --- | --: |
| `inter-basic.woff2` | `public/fonts/inter-latin.woff2` (both axes kept) | 50 kB |
| `opentui-regular-basic.woff2`, `opentui-bold-basic.woff2` | `public/fonts/opentui-*.woff2` | 10 kB each |

Made with fonttools (`pip install fonttools brotli`), from this folder:

```sh
U="U+0020-007E,U+00A0,U+00A9,U+00AB,U+00AE,U+00B7,U+00BB,U+00D7,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2713,U+FEFF,U+FFFD"
for f in inter-latin opentui-regular opentui-bold; do
  pyftsubset ../../../../public/fonts/$f.woff2 --unicodes="$U" --layout-features='*' --flavor=woff2 --output-file=${f%-latin}-basic.woff2
done
```

The same list is `BASIC` in app/price-pages.ts: change both together.
