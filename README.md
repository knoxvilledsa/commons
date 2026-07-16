# Knoxville Area DSA website

The public website for the Knoxville Area chapter of the Democratic Socialists
of America. It is a plain static site: hand-written HTML, one stylesheet, and a
small progressive-enhancement script. No build step is required to preview it.

## Preview locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Structure

- `*.html`: the pages, each self-contained and sharing `styles.css` + `app.js`
- `es/`: Spanish-language Know Your Rights pages
- `assets/`: logos, favicon, social card, and illustrations
- `functions/`: a Cloudflare Pages function (a secretless link shortener)
- `calendar.ics`: the public monthly meeting recurrence
- `robots.txt` / `_headers`: currently set to **noindex** for the preview

## Fonts

The house typeface, Manifold DSA, is **licensed for DSA use and is not included
in this repository** (`assets/fonts/` is gitignored). The stylesheet falls back
to Archivo and the system UI stack, so the site renders correctly without it.

## Before going live

- Flip `robots.txt` and `_headers` off noindex once the site is meant to be
  indexed.
- Working-group and committee contacts route through the interest forms and the
  Contact page by design; the chapter lists roles, not individuals.

## License

Dual-licensed by kind of work:

- **Code** (HTML, CSS, JavaScript, the Pages function): MIT, see `LICENSE`.
- **Content** (page text, articles, written material): CC BY-SA 4.0, see
  `LICENSE-content`.

Chapter and DSA logos and marks are not covered by either license, and the
Manifold DSA typeface is licensed for DSA use only and never ships in this
repository.
