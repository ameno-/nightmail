# The board's scene

The pictures behind the comparison page's board (board.css): a plaster wall lit from above, one for a wide window and one
for a phone, and the pendant lamp that lights it, hung on its cord from the window's top edge. Each is its own file the
page links to (`?no-inline` in board.css), never inlined into the stylesheet.

| File | What | Bytes |
| --- | --- | --: |
| `wall-1920.avif`, `wall-828.avif` | the wall, its pool of light about a fifth of the way down | 13 kB, 10 kB |
| `lamp.webp` | the lamp and the foot of its cord, a transparent cutout | 14 kB |

The board, its frame and the fader console are the homepage's station kit (home/kit), already on the page.

## Making them again

All were made on 22 Nov 2026 with OpenAI `gpt-image-2.5-sunburst` through the `imgen` CLI (quality high), with the
homepage's render as the reference for materials and light. The prompts are `source/*.prompt.txt` and the full-size
outputs `source/*.webp` (WebP at 92 from the PNGs). From this folder's `source/`:

```sh
H=../../../home/factory
imgen edit --prompt-file lamp.prompt.txt --image $H/poster.jpg --out lamp.png --size 1024x1536 --quality high --background transparent
imgen edit --prompt-file wall-desktop.prompt.txt --image $H/poster.jpg --out wall-desktop.png --size 2048x1152 --quality high --background opaque
imgen edit --prompt-file wall-phone.prompt.txt --image $H/poster.jpg --out wall-phone.png --size 1024x1824 --quality high --background opaque
```

Then, into this folder (ImageMagick with libheif). The walls are darkened so the headline, in the lamp's pool, keeps at
least 4.5:1 on every pixel behind it; the lamp is cut below the top of its cord (board.css draws the lamp from the
window's top edge, so the cord in the picture reaches it):

```sh
magick lamp.png -crop 1024x1086+0+450 +repage -trim +repage -resize 340x -quality 90 -define webp:alpha-quality=95 ../lamp.webp
magick wall-desktop.png -resize 1920x1080^ -gravity center -extent 1920x1080 -blur 0x0.6 -evaluate multiply 0.62 -quality 50 ../wall-1920.avif
magick wall-phone.png -resize 828x1472^ -gravity center -extent 828x1472 -blur 0x0.6 -evaluate multiply 0.55 -quality 50 ../wall-828.avif
```

No picture may hold text, a logo or another company's marks: check each by eye before it goes in.
