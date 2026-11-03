# Table & Ledger

Static site with markdown-powered blog. Built with Node.js, deployed on Cloudflare Pages.

## How it works

1. Homepage (`index.html`) lives in the project root. Edit it directly.
2. Blog posts live in `posts/` as markdown files with frontmatter.
3. Run `npm run build` to generate the site into `dist/`.
4. Cloudflare Pages runs the build automatically on every git push.

## Writing a new post

Create a `.md` file in `posts/`. Name it whatever you want (the `slug` in frontmatter controls the URL).

Every post needs this frontmatter block at the top:

```
---
title: Your Post Title Here
date: 2026-03-17
category: Case Study
slug: your-url-slug
lede: A one-paragraph summary. Shows below the title and on the blog index.
---

Your markdown content here.
```

### Frontmatter fields

| Field | Required | What it does |
|-------|----------|-------------|
| `title` | Yes | Post title. Shows in header, browser tab, OG tags. |
| `date` | Yes | Publication date. Format: YYYY-MM-DD. Controls sort order. |
| `category` | Yes | Label above title. Examples: Case Study, Essay, Musing, Field Note |
| `slug` | Yes | URL path. Post will live at `/blog/{slug}/` |
| `lede` | Yes | Summary paragraph. Shows italic below title and on blog index. |
| `image` | No | Site-absolute path to the post's social-card image (e.g. `/images/my-slug/photo.jpg`). Used for `og:image` and structured data. Posts without one fall back to the portrait. |

### Photos in posts

Put image files in `static/images/{slug}/` (any subdirectory of `static/` is copied
to `dist/` on build, so `static/images/my-post/kitchen.jpg` is served at
`/images/my-post/kitchen.jpg`).

Embed with standard markdown:

```
![What the photo shows, for screen readers](/images/my-post/kitchen.jpg)
*Optional caption goes here, italic, on the very next line.*
```

Images render centered at article width with a border; the italic line directly
after an image renders as a centered caption. Keep files web-sized — aim for
300 KB or less (resize to ~1400px wide before committing).

To use a photo as the post's link-preview card on LinkedIn/X, also set it in
frontmatter: `image: /images/my-post/kitchen.jpg`.

### Custom HTML in markdown

You can embed raw HTML in your markdown for special elements. The CSS supports:

- `.pullquote` - Large serif text with top/bottom borders
- `.stat-row` > `.stat` - Grid of big numbers with labels
- `.stack-block` > `.stack-item` - Tool/role description grid
- `.flow-block` > `.flow-step` - Numbered step sequence

See existing posts for examples.

## Categories used so far

- **Case Study** - Documented implementations with results
- **Essay** - Longer analytical pieces
- **Musing** - Shorter opinion/observation pieces

## Local development

```bash
npm install
npm run build
# Open dist/index.html in a browser, or use any static server:
npx serve dist
```

## Cloudflare Pages settings

| Setting | Value |
|---------|-------|
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node.js version | 18+ |

## Sign Concierge intake (/sign/)

`sign/index.html` is the intake form for Sign Concierge, the done-for-you e-signature service. A client uploads one PDF (20 MB and 50 pages max), lists up to 5 signers with an optional signing order, adds an optional due date and notes, confirms the document has no medical or patient information, and passes a Cloudflare Turnstile check. The form posts multipart data to `functions/api/sign.js` at `/api/sign`, which checks the honeypot, verifies Turnstile, validates everything (including the `%PDF-` header and a best-effort page count), assigns a job id, and returns it to the client. The page is `noindex` for now.

This is Option A, the email handoff: `storeAndNotify()` in `functions/api/sign.js` sends one Resend email to the back room with the upload attached as `source.pdf` and the manifest attached as `job.json`. An R2 swap is planned. When it happens, only `storeAndNotify()` changes.

Known limit during Option A: Pages Functions run on the Workers plan of the account. The Free plan allows 10 ms of CPU per request, and base64-encoding a 20 MB upload takes longer than that, so large uploads may fail with a 1102 error until the project is on Workers Paid or the R2 swap lands. Small PDFs are unaffected. Test with a real upload before opening the page to clients.

Function logs carry the job id only. Never log names, email addresses, or document contents.

### Environment variables

| Variable | Status | What it does |
|----------|--------|-------------|
| `RESEND_API_KEY` | Existing (shared with `/api/contact`) | Sends the handoff email. |
| `TURNSTILE_SECRET` | New, required | Turnstile widget secret key. Without it the function returns 500. |
| `SIGN_NOTIFY_TO` | New, optional | Where the handoff email goes. Defaults to `info@tableandledger.com`. |

### Dashboard steps (Donnie)

1. Cloudflare dashboard, Turnstile, Add widget. Name it "Sign Concierge". Add the hostnames `tableandledger.com` and the Pages preview host `<project>.pages.dev` (a hostname covers its subdomains, so this covers `www.` and every preview deployment). Widget mode: Managed.
2. Copy the site key into `sign/index.html`, replacing the test key `1x00000000000000000000AA` in the `data-sitekey` attribute (look for the HTML comment right above it).
3. Copy the secret key. Workers & Pages, the tableandledger project, Settings, Variables and Secrets. Add `TURNSTILE_SECRET` as an encrypted secret for both Production and Preview.
4. Optional: add `SIGN_NOTIFY_TO` the same way if the handoff should go somewhere other than `info@tableandledger.com`.
5. Redeploy so the new variables take effect.

### Local testing

Create `.dev.vars` in the repo root (it is git-ignored, never commit it):

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
RESEND_API_KEY=<a real Resend key>
SIGN_NOTIFY_TO=<your own inbox>
```

`1x0000000000000000000000000000000AA` is Cloudflare's always-pass test secret: it accepts any token, including the dummy one the test site key in `sign/index.html` produces, so it cannot exercise the failure path. Use the always-fail secret `2x0000000000000000000000000000000AA` to test rejection. A production secret rejects the dummy token.

Then build and serve with the functions running:

```bash
npm run build
npx wrangler pages dev dist
```

Wrangler reads `.dev.vars` from the directory you run it in. Open the local URL it prints and go to `/sign/`.

## File structure

```
tableandledger/
  index.html          # Homepage (hand-edited, copied to dist on build)
  donnie.jpg          # Headshot (copied to dist on build)
  sign/               # Sign Concierge intake form (/sign/)
    index.html
  functions/          # Cloudflare Pages Functions (copied to dist on build)
    api/
      contact.js      # /api/contact, Ask and Waitlist forms
      sign.js         # /api/sign, Sign Concierge intake
  package.json
  posts/              # Markdown blog posts
    food-cost-visibility-one-day.md
    distributed-computing-restaurant.md
    the-last-thing-you-need-to-learn.md
  templates/          # HTML templates for generated pages
    article.html      # Single post template
    blog-index.html   # Blog listing page template
  static/             # CSS and static assets
    style.css         # Shared design system
  scripts/
    build.js          # Build script
  dist/               # Generated output (gitignored, built by Cloudflare)
```
