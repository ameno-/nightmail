# The board's backdrops

Pictures behind the comparison page's board (board.css, `?bg=1` to `4`), one for a wide window and one for a phone.
Each is its own file the page links to (`?no-inline` in board.css), never inlined into the stylesheet.

| File | Option | Made by | Bytes |
| --- | --- | --- | --: |
| `hall-1920.avif`, `hall-828.avif` | 1, the hall | edit of the homepage's own render (`home/factory/poster.jpg`, `home/factory/phone/poster-bare.jpg`): the machine, boards and lettering taken out | 70 kB, 48 kB |
| `wall-1920.avif`, `wall-828.avif` | 2, the lit wall | generated, with the homepage's render and the board as references | 113 kB, 64 kB |
| `quiet-1600.avif`, `quiet-720.avif` | 3, the lamp | generated | 4 kB, 3 kB |
| `lamp.webp` | 3, the lamp | generated, a transparent cutout | 14 kB |
| (none) | 4, lighter | the homepage's floor tone | 0 |

Option 4, and the page without `?bg`, add no pictures; every option also uses the homepage's station kit (home/kit),
already on the page.

## Making them again

All were made on 22 Nov 2026 with OpenAI `gpt-image-2.5-sunburst` through the `imgen` CLI (quality high). The prompts
are `source/*.prompt.txt`, the full-size outputs `source/*.webp` (WebP at 92 from the PNGs), and `source/ref-board.jpg`
is the board as it was, used as a reference. From this folder's `source/`:

```sh
H=../../../home/factory
imgen edit --prompt-file hall-desktop.prompt.txt --image $H/poster.jpg --out hall-desktop.png --size 2048x1152 --quality high --background opaque
imgen edit --prompt-file hall-phone.prompt.txt --image $H/phone/poster-bare.jpg --out hall-phone.png --size 1024x1824 --quality high --background opaque
imgen edit --prompt-file wall-desktop.prompt.txt --image $H/poster.jpg --image ref-board.jpg --out wall-desktop.png --size 2048x1152 --quality high --background opaque
imgen edit --prompt-file wall-phone.prompt.txt --image $H/poster.jpg --image ref-board.jpg --out wall-phone.png --size 1024x1824 --quality high --background opaque
imgen edit --prompt-file quiet-desktop.prompt.txt --image $H/poster.jpg --out quiet-desktop.png --size 2048x1152 --quality high --background opaque
imgen edit --prompt-file quiet-phone.prompt.txt --image $H/poster.jpg --out quiet-phone.png --size 1024x1824 --quality high --background opaque
imgen edit --prompt-file lamp.prompt.txt --image $H/poster.jpg --out lamp.png --size 1024x1024 --quality high --background transparent
```

Then, into this folder (ImageMagick with libheif):

```sh
magick hall-desktop.png -resize 1920x1080^ -gravity center -extent 1920x1080 -quality 52 ../hall-1920.avif
magick hall-phone.png -resize 828x1472^ -gravity center -extent 828x1472 -quality 52 ../hall-828.avif
magick wall-desktop.png -resize 1920x1080^ -gravity center -extent 1920x1080 -quality 50 ../wall-1920.avif
magick wall-phone.png -resize 828x1472^ -gravity center -extent 828x1472 -quality 50 ../wall-828.avif
magick quiet-desktop.png -resize 1600x900 -quality 60 ../quiet-1600.avif
magick quiet-phone.png -resize 720x1280 -quality 60 ../quiet-720.avif
magick lamp.png -trim +repage -resize 360x -quality 88 -define webp:alpha-quality=90 ../lamp.webp
```

No picture may hold text, a logo or another company's marks: check each by eye before it goes in.
