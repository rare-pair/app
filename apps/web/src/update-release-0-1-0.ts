// The body of the first update: docs/release-notes/v0.1.0.md below its title line, as plain HTML,
// with no Markdown library. The operator's words are kept as they are, typos included: do not correct them.
// test/updates.node.test.ts fails if this text and the notes differ.

export const RELEASE_0_1_0_BODY = `<p>TLDR; ⚡</p>
<p><a href="https://rarepair.fans/">rarepair</a> is open. It is a temporary, community-run reading archive for fanworks while the original archive is offline. People upload the EPUB files they downloaded from the archive, and anyone can browse, search, and read them.</p>
<p>rarepair is an unofficial stopgap. It is not affiliated with or approved by the original archive or the organization behind it, and it may change or close at any time. Credit belongs to each work’s author, and every work page links back to the original.</p>
<h2>📖 The long of it.</h2>
<p>I am hoping building in public, practicing radical transparency, and constant communication will help us build something people will be okay with.</p>
<p>My motives are plain: I have been reading fics since 2001, and this was a great opportunity to jump in and help a community I've been lurking in for a generation, and secondly, to experiment with a bunch of theory regarding how software factories are done, which is my topic of obsession at the moment.</p>
<p>It was built relatively quickly using an agentic software factory; it's not a one-shot, and it's almost 200 pull requests deep in 7 days. If you know what pull requests are, you know that is impressive for one person, even agent-assisted! It is sloppy by design and ugly on purpose; it will get prettier soon once put in some time to refine things.</p>
<p>It is open source I highly recommend plopping the <a href="https://github.com/rare-pair/app">GitHub repository</a> into Google search and ask Gemini questions.</p>
<p>Magic Link Auth (Email) currently covers uploads, and will cover NSFW works soon after launch. I don't want your email I mean it please use Firefox Relay to mask it.</p>
<p>The cold start solution and problem: there's no fics right now which is also by design they need to be added by the community, if there's no adoption it gets no use.</p>
<p>🤝 Some promises,</p>
<p>It's temporary, and I mean it: when the archive is back on its feet, we'll tombstone the application and redirect works to their originals; all DB content will be removed, and user tables purged. Even if there is interest, we will rebuild the database from scratch.</p>
<p>I won't monetize it, but I am dancing around adding a Kofi link or something. I expect this endeavor to cost around $50-$100 USD for the domain and service subscriptions and a $100 Claude Max Plan, which I am using anyway. If the community vehemently feels that Kofi or any donation for this is an issue, let me know; no decision has been made yet.</p>
<h2>📚 For readers</h2>
<p>You don't need an account or JavaScript to read.</p>
<ul>
<li>🔎 <strong>Find works:</strong> browse by tag, sorted by updated date or word count, or search titles, authors, tags and summaries. Search results can be filtered by fandom and rating.</li>
<li>📖 <strong>Read:</strong> one chapter at a time or the entire work on one page, with a screen showing the rating and warnings first. Signed-in readers can turn that screen off.</li>
<li>🌗 <strong>Make it comfortable:</strong> choose the theme (match your device, light, dark or sepia), text size, line spacing and reading face.</li>
<li>🔖 <strong>Pick up where you left off:</strong> signed-in readers get a "Continue where you left off" link on the work page.</li>
<li>💾 <strong>Download:</strong> each work page links to the original epub.</li>
<li>🚩 <strong>Report a problem:</strong> signed-in readers can report a work. A work is hidden for moderators to review once three accounts report it. A "This version is wrong" report doesn't count toward that, and goes to moderators instead.</li>
</ul>
<h2>📤 For uploaders</h2>
<ul>
<li>✉️ <strong>Sign in:</strong> you sign in with a link sent to your email. There are no passwords. New accounts accept the terms once.</li>
<li>📦 <strong>What you can upload:</strong> epub files exported from the original archive, up to 25 MB each and 10 at a time. Accounts can upload 20 files a day. Uploading needs JavaScript.</li>
<li>👀 <strong>Follow your files:</strong> My uploads shows where each file is and why any file was refused or held.</li>
<li>🔄 <strong>New versions:</strong> a newer, consistent version of a work replaces the current one automatically, and earlier versions are kept. Anything else is held for a moderator to review, or marked as a duplicate.</li>
<li>🌍 <strong>Accepted uploads are public.</strong> Only upload works you are happy to have shared.</li>
</ul>
<h2>✍️ For authors and rights-holders</h2>
<ul>
<li>🙋 <strong>Remove a work or a pseud:</strong> use the "Remove my work" link in the footer or on the work page, or email admin@rarepair.fans. No proof of identity is asked for, because there is nothing to check it against while the original archive is offline.</li>
<li>📬 <strong>What happens next:</strong> we email you a link to confirm the request, which works once, for 7 days. Once you confirm, the work is hidden, or every work by that pseud, and a moderator reviews the request.</li>
<li>🗑️ <strong>Removal is permanent.</strong> Once a moderator approves a request, the work is removed for good. We can't reach copies people have already saved.</li>
<li>🎭 <strong>Opt-outs cover one pseud:</strong> an opt-out covers only the pseud you type, so if you write under several, send one request for each.</li>
<li>©️ <strong>Copyright notices:</strong> use the "Copyright notice" link in the footer.</li>
</ul>
<h2>🤖 Bots and crawlers</h2>
<p>rarepair is built by a swarm of AI coding agents, directed by a person. We know how that sounds next to fanworks, so to be plain: we are here to serve, not to steal.</p>
<ul>
<li>🚫 <strong>Bots are refused:</strong> anything that identifies itself as a bot, a crawler or an AI agent is refused the whole site. That includes search engines and link previews, so works won't show up in search, and shared links show no preview.</li>
<li>📜 <strong>We ask crawlers to stay away:</strong> robots.txt disallows everything, and the terms forbid automated access, collection and AI training.</li>
<li>🐢 <strong>Reading is rate limited:</strong> we limit how fast one network address can read or download.</li>
<li>🛡️ <strong>You may see a check:</strong> we use Cloudflare's bot protection, which now and then may ask a real reader to pass a quick check. You can't pass it with JavaScript off.</li>
<li>🕳️ <strong>This can't stop everything:</strong> the archive stays open to read, so a scraper pretending to be a browser, or an agent using someone's own browser, can still get what any reader can.</li>
</ul>
<h2>♿ Accessibility</h2>
<p>Pages are checked in a real browser against WCAG 2.2 AA and for keyboard use, and nothing should scroll sideways on a 360 px screen. Those checks are automated and won't catch everything. If something gets in your way, please write to admin@rarepair.fans.</p>
<h2>🔒 Your data</h2>
<p>The <a href="https://rarepair.fans/privacy">privacy page</a> has the details. Two things are worth knowing up front:</p>
<ul>
<li>🗄️ What you send with a removal request, opt-out or copyright notice, including your email address, is kept until the site closes, and is then deleted. It is not erased on request.</li>
<li>👋 To delete your account, write to admin@rarepair.fans from the address on it. Works you uploaded stay public, with no account attached.</li>
</ul>`;
