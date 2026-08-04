# CEDAR WordPress Runbook

How to publish and maintain posts on the public CEDAR site at **https://metadatacenter.org** — where
to sign in, how the categories are wired, how to author a post so it matches the existing ones, and
which saves silently do not stick. Written to be followed by a human with a browser, or read by an
LLM agent driving one.

This is the **public-site** counterpart to [RELEASE-RUNBOOK.md](./RELEASE-RUNBOOK.md) (cutting a
release) and [PROD-DEPLOY-RUNBOOK.md](./PROD-DEPLOY-RUNBOOK.md) (standing that release up). Nothing
here touches CEDAR itself; the site is an ordinary WordPress install that happens to announce CEDAR
work.

## What the Site Is

WordPress 7.x on PHP 7.4, running the **Enfold** theme (Avia framework — it supplies the post
byline, the tag footer, and the share box you see on every post). The block editor (Gutenberg) is
what authors posts. Elementor is installed and offers an "Edit with Elementor" button on every post,
but **no news post uses it** — they are all plain Gutenberg blocks, and staying on blocks is what
keeps a new post visually identical to the old ones.

The plugins that matter while posting:

- **Yoast SEO** adds a metabox below the editor with its own slug field and its SEO/readability
  scores. Existing posts mostly score "Focus keyphrase not set", so the scores are advisory.
- **W3 Total Cache** fronts the public pages. Post rows in the admin list carry a "Purge from cache"
  action, which is how you force a stale public page to refresh.
- **UpdraftPlus** and **WPBackItUp** handle backups; **WPForms** handles the contact forms. Neither
  is involved in posting.

Sign in at `https://metadatacenter.org/wp-admin/` with the shared **CEDAR admin** account, which
authors every post. Credentials live in the team password store, not here.

## How the Categories Are Wired

This is the part that is easy to get wrong. **Happenings is a parent category**, not a sibling of the
others:

```
Happenings (57)
├── Events    (60)
├── News      (58)
└── Releases  (59)
```

`Startups` (19) and `Uncategorized` (1) are unused leftovers. The archive the team links to,
`/category/happenings/`, lists posts filed under Happenings itself.

Because permalinks are category-based, the parent shows up in the URL. A post in Happenings + News
publishes at `/happenings/news/<slug>/`.

**A feature or capability announcement goes in Happenings *and* News**, matching the most recent
posts. Release notes go in Happenings + Releases. Clear `Uncategorized` if WordPress has left it
checked — it is the default and it will otherwise ride along into the byline.

Tags are free-form and reused loosely. The heavily used ones are `metadata templates`, `CEDAR`,
`CEDAR Features`, `ontology-based metadata`, `FAIR Data`, `FAIR metadata`, `metadata tools`,
`JSON-LD`, and `open source`. Four to six tags per post is typical; prefer an existing tag over a new
near-duplicate.

You can read the live vocabularies without logging in, which is the fastest way to check an ID or
spelling before you start:

```bash
curl -s "https://metadatacenter.org/wp-json/wp/v2/categories?per_page=50&_fields=id,name,slug,parent"
```

```bash
curl -s "https://metadatacenter.org/wp-json/wp/v2/tags?per_page=100&_fields=id,name,slug,count&orderby=count&order=desc"
```

## House Style for a Post

Read the two or three most recent posts before writing. The established shape is short, technical,
and unadorned:

- **No headings.** Posts are a sequence of paragraphs. A four-item bulleted list or a blockquote is
  fine; `<h2>`s are not used.
- **400–650 words.** Long enough to explain the thing, short enough to read in one sitting.
- **Open with the problem, not the announcement.** The strongest recent posts spend two paragraphs
  on why the reader should care before naming the feature.
- **Show, with one or two code blocks.** YAML and JSON examples are the norm; keep them trimmed to
  what illustrates the point.
- **Close with links out** to the documentation, the GitHub release, or the paper. Links are inline
  in prose, never a "Further reading" list.
- **No featured image is required.** The two most recent posts have none; the theme falls back to
  the CEDAR logo. Older posts announcing papers do set one.

The excerpt shown on archive pages is generated from the opening paragraph automatically. There is
no need to write one.

## Writing the Post

Compose the body as **Gutenberg block markup** in a local file first, then paste it in. Drafting
outside the browser means you can review the prose properly, and block markup pastes into the code
editor exactly as written, with no autoformatting to fight.

The block vocabulary these posts use is small:

```html
<!-- wp:paragraph -->
<p>Prose, with <a href="https://example.org">inline links</a>, <strong>bold</strong>,
<em>italic</em>, and <code>inline code</code>.</p>
<!-- /wp:paragraph -->

<!-- wp:list -->
<ul>
<!-- wp:list-item -->
<li>One item. Each item is its own block.</li>
<!-- /wp:list-item -->
</ul>
<!-- /wp:list -->

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>A quoted request or excerpt.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->

<!-- wp:code -->
<pre class="wp-block-code"><code>key: value
  nested: value
</code></pre>
<!-- /wp:code -->
```

Escape `<` and `>` as `&lt;` / `&gt;` inside a code block, and use `&#8220;` / `&#8221;` for curly
quotes in prose so the editor does not re-encode them on you.

Then, in the admin:

1. **Posts → Add Post.**
2. Switch to the code editor — Options (⋮) → **Code editor**, or `⌥⌘M`. The preference is sticky per
   user, so it is usually already on.
3. Type the title, then paste the block markup into the body.
4. **Exit the code editor** and confirm every block rendered. A malformed comment shows up as a
   yellow "This block contains unexpected content" warning; nothing else will tell you.
5. Set the categories and tags in the Post sidebar, and shorten the slug — WordPress derives it from
   the full title, which is usually far too long.
6. **Save draft**, then verify it stuck (below).

## Verify the Save — Do Not Skip This

**The block editor will report "Saved" while leaving category, tag, and slug changes uncommitted.**
This is not theoretical; it happened twice while writing the post that prompted this runbook, and it
is why an earlier draft on the site still sits in `Uncategorized` with no tags. The post content
saves reliably. The sidebar metadata does not.

The symptom is easy to miss: the toolbar shows "Saved", but navigating away raises a "Leave site?"
dialog, and reloading the editor shows the terms reverted.

Check the editor's own state rather than the toolbar. In the browser console, on the edit screen:

```js
wp.data.select('core/editor').isEditedPostDirty()
```

`false` means everything is committed. If it is `true` after saving, click **Save draft** again and
re-check. Then reload the edit screen and confirm the sidebar still shows what you set — a reload is
the only honest confirmation.

For a scripted check of all three at once:

```js
const e = wp.data.select('core/editor'), p = e.getCurrentPost();
({ status: p.status, slug: p.slug, dirty: e.isEditedPostDirty() })
```

Two further notes on saving. **Never leave two editor tabs open on the same post** — the stale tab
holds its own dirty state and will fight the live one. And the Yoast metabox's slug field is a
reliable way to set the slug when the sidebar's permalink popover refuses to open; it syncs straight
into the editor store.

## Preview and Publish

Preview the draft at `https://metadatacenter.org/?p=<POST_ID>&preview=true`. The post ID is in the
edit URL. Check the byline specifically — it renders the categories, so a byline reading
"in Uncategorized" means the terms did not save.

Publishing is a deliberate, public act. **Confirm with the team before clicking Publish**, and check
first that the title, categories, tags, slug, and links are all final. Publishing is two clicks — the
toolbar **Publish**, then **Publish** again in the pre-publish panel.

Afterwards, confirm the permalink resolves at `/happenings/<child>/<slug>/` and that the post appears
on `/category/happenings/`. The home page is a static landing page and lists no posts, so it never
needs checking.

### Clearing the Cache

W3 Total Cache will keep serving archive pages generated *before* the post existed, so a fresh post
routinely fails to show up on `/category/happenings/` even though it published correctly. Purge with
**Performance → Purge All Caches** in the admin bar.

One purge is often not enough. Verify, and expect to run it twice. Every cached page carries its
generation time in an HTML comment near the end, which tells you whether you are looking at a stale
copy or a real problem:

```bash
curl -s "https://metadatacenter.org/category/happenings/" | grep -o "Served from: .*"
```

Adding a junk query string bypasses the page cache entirely and shows what the origin actually
renders. If the buster shows the post and the plain URL does not, the content is fine and only the
cache is behind:

```bash
curl -s "https://metadatacenter.org/category/happenings/?cb=$RANDOM" | grep -c "<your-slug>"
```

Individual post pages can also be purged from the **Purge from cache** action on the post's row in
Posts → All Posts.

Cloudflare sits in front of the origin but returns `cf-cache-status: DYNAMIC` for these pages, so it
is not the layer holding anything stale. Check with `curl -sI <url> | grep -i cf-cache-status` before
suspecting it.

**Some cached pages resist purging altogether.** The `/category/happenings/` archive has been observed
pinned to one generation through two rounds of Purge All Caches *and* a Purge Modules → Page Cache,
while a cache-busted request rendered correctly. When that happens the content is genuinely fine and
the entry expires on its own. It is worth distinguishing what is actually affected: the archive shows
only the auto-generated excerpt, so a stale copy there misstates a sentence in a listing, while the
post itself — the page readers land on — is already correct. Do not keep purging in the hope it
resolves; confirm the origin with a cache-buster, then move on.

## Reading the Site Without Logging In

The public REST API answers most questions about what is already published, which is quicker than
clicking through the admin and safe to run from a script:

```bash
curl -s "https://metadatacenter.org/wp-json/wp/v2/posts?per_page=5&_fields=id,slug,title,date,link,categories,tags"
```

To study how an existing post is structured — its block classes, its link style, its code blocks —
fetch the rendered page and read the `entry-content` div:

```bash
curl -s "https://metadatacenter.org/happenings/news/cedar-now-supports-yaml-metadata/"
```

Drafts are not exposed through the public API. Use the preview URL for those.

## Driving the Admin From an Agent

Browser automation against this admin has a few sharp edges that cost real time to rediscover.

**Trust the DOM, not the accessibility tree, for checkbox state.** Element-finding tools report
Gutenberg's category checkboxes as unchecked whether or not they are. Read the real state instead:

```js
[...document.querySelectorAll('.components-checkbox-control__input')]
  .map(c => c.closest('.components-base-control').innerText.trim() + '=' + c.checked).join(', ')
```

Note that the sidebar reorders itself after a reload, floating the checked terms to the top, so never
address those checkboxes by position.

**A typing call that reports a timeout has usually still succeeded.** Pasting a long block of markup
into the code editor can exceed the automation layer's 30-second command timeout while the keystrokes
land anyway. Screenshot the end of the textarea before retrying — retyping blindly duplicates the
whole block. Splitting the paste into one block per call avoids it entirely.

**Row actions need a genuine hover.** Quick Edit, Trash, and Purge from cache are hidden until the
row is hovered, and a scripted click on the link silently does nothing. Use the full editor rather
than fighting Quick Edit.

**The permalink popover often refuses to open.** Clicking "Change link" in the sidebar toggles it open
and shut unpredictably. The Yoast metabox's slug field is the dependable path — it syncs straight into
the editor store, and the sidebar button updates to match.

**Chrome's screenshot of this admin is narrower than the window**, which clips the settings sidebar
regardless of how you resize. Work through element references and `wp.data` rather than coordinates.

## Gotchas

- **Happenings is a parent category.** Filing a post only under News keeps it off the
  `/category/happenings/` archive the team links to.
- **`Uncategorized` rides along.** WordPress checks it by default. Uncheck it explicitly.
- **The sidebar save is unreliable.** Verify with `isEditedPostDirty()` and a reload, every time.
- **A published post can be missing from `/category/happenings/`** purely because W3 Total Cache is
  serving a page generated before it existed. Purge, verify, and purge again.
- **Do not open the post in Elementor.** It will convert the post away from plain blocks, and the
  result no longer matches the rest of the site.
- **The site runs an outdated PHP (7.4) and an out-of-date WordPress.** Both nag on every admin
  screen. Updating either is a hosting decision, not something to do in passing while posting.
