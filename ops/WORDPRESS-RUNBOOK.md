# CEDAR WordPress Runbook

Publish and maintain posts at **https://metadatacenter.org**. For cutting or deploying a CEDAR
release, use [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md) and
[PROD-DEPLOY-RUNBOOK.md](PROD-DEPLOY-RUNBOOK.md).

<a id="what-the-site-is"></a>

## Site and Access

The site uses WordPress with the **Enfold** theme (Avia framework), which supplies post bylines,
tag footers and share boxes. Author news posts in **Gutenberg blocks** to match existing posts;
do not use the installed Elementor editor. Hosting and software upgrades are separate maintenance.

The plugins that matter while posting:

- **Yoast SEO** adds a metabox below the editor with its own slug field and its SEO/readability
  scores. Existing posts mostly score "Focus keyphrase not set", so the scores are advisory.
- **W3 Total Cache** fronts the public pages. Post rows in the admin list carry a "Purge from cache"
  action, which is how you force a stale public page to refresh.
Sign in at `https://metadatacenter.org/wp-admin/` with the shared **CEDAR admin** account, which
authors every post. Credentials live in the team password store, not here.

## How the Categories Are Wired

**Happenings is the parent category:**

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
- **400–650 words.**
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

Draft the body as **Gutenberg block markup** in a local file, review it, then paste it into the
code editor to avoid visual-editor autoformatting.

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

<a id="verify-the-save--do-not-skip-this"></a>

## Verify Saved Content and Metadata

**The block editor can report "Saved" while category, tag or slug changes remain uncommitted.**
A "Leave site?" prompt or reverted sidebar values after reload indicates unsaved metadata.

Check the editor's own state rather than the toolbar. In the browser console, on the edit screen:

```js
wp.data.select('core/editor').isEditedPostDirty()
```

If it is `true` after saving, click **Save draft** again and recheck. Once it is `false`, reload
the edit screen and confirm the title, content, categories, tags and slug persisted.

For a scripted check of all three at once:

```js
const e = wp.data.select('core/editor'), p = e.getCurrentPost();
({ status: p.status, slug: p.slug, dirty: e.isEditedPostDirty() })
```

Keep only one editor tab open per post to avoid conflicting drafts. If the sidebar permalink
popover fails, set the slug in the Yoast metabox; it synchronizes with the editor store.

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

Verify after purging. The generation time in the page's HTML comment identifies a stale copy:

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

Check Cloudflare separately with `curl -sI <url> | grep -i cf-cache-status`; `DYNAMIC` indicates
that Cloudflare is not serving a cached page.

The Happenings archive has remained stale after repeated W3 purges while cache-busted requests
were correct. Check the post and archive separately, record which remains stale, and investigate
cache expiry if another purge fails. Do not mistake a correct preview for a refreshed public archive.

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

## Driving the Admin from an Agent

**Trust the DOM, not the accessibility tree, for checkbox state.** Element-finding tools report
Gutenberg's category checkboxes as unchecked whether or not they are. Read the real state instead:

```js
[...document.querySelectorAll('.components-checkbox-control__input')]
  .map(c => c.closest('.components-base-control').innerText.trim() + '=' + c.checked).join(', ')
```

Note that the sidebar reorders itself after a reload, floating the checked terms to the top, so never
address those checkboxes by position.

**Inspect the textarea after a typing timeout before retrying.** The paste may have succeeded;
retyping can duplicate the body. Paste one block per call if long pastes time out.

**Row actions need a genuine hover.** Quick Edit, Trash, and Purge from cache are hidden until the
row is hovered, and a scripted click on the link silently does nothing. Use the full editor rather
than fighting Quick Edit.

**Chrome's screenshot of this admin is narrower than the window**, which clips the settings sidebar
regardless of how you resize. Work through element references and `wp.data` rather than coordinates.

## Gotchas

For posting failures, check [categories](#how-the-categories-are-wired),
[saved metadata](#verify-the-save--do-not-skip-this) and [cache state](#clearing-the-cache).
