// The body of the second update: docs/release-notes/v0.2.0.md below its title line, as plain HTML,
// with no Markdown library. The operator's words are kept as they are, typos included: do not correct them.
// test/updates.node.test.ts fails if this text and the notes differ.

export const RELEASE_0_2_0_BODY = `<p>TLDR; ⚡</p>
<p>Uploading many works is much easier now. You can drop a whole folder's worth of epubs, or a zip of them, onto the upload page. You can upload PDFs too, which we turn into text. New accounts can upload 100 files a day instead of 20. Adult works stay readable by everyone, behind a click-through warning, and readers can tell us when a work's rating is too low.</p>
<p>We have a <a href="https://discord.gg/538ME6Jabu">Discord server</a> now, linked from the footer of every page. 💬</p>
<h2>📖 The long of it.</h2>
<p>Some quality of life updates so that uploading isn't a pain, and that we can cover the two largest formats of backups. After some feedback we reeled in the Adult gate to align with the archive I was a little heavy handed on that.</p>
<h2>💬 Come say hi</h2>
<ul>
<li>🗨️ <strong>Join the Discord:</strong> <a href="https://discord.gg/538ME6Jabu">discord.gg/538ME6Jabu</a> is the place to ask questions, report bugs, and tell us what to change. It's linked from the footer of every page, next to GitHub.</li>
<li>📬 <strong>Email still works:</strong> removal requests, copyright notices, and anything private should still go through the site's forms or admin@rarepair.fans, not Discord.</li>
</ul>
<h2>📤 For uploaders</h2>
<ul>
<li>🗂️ <strong>Drop files on the page:</strong> the upload page has a dropzone and a list of the files you picked. You can remove files from the list before sending, and add more. However many you add, they are sent 10 at a time, and the page waits and carries on if it has to slow down.</li>
<li>🤐 <strong>Upload a zip:</strong> pick or drop a zip of epubs, up to 100 MB, and the page opens it in your browser. Each epub in it joins the list as if you had picked it. Mac resource-fork files are skipped, and damaged or unusual zips are refused with a message.</li>
<li>📄 <strong>Upload a PDF:</strong> if you only kept a PDF of a work, you can upload that now, up to 10 MB. It must be a PDF of a work from the original archive, with the "Posted originally on" line, so scanned PDFs won't work. We turn it into text, so it won't look as good as an epub would. If you have the epub, upload that instead.</li>
<li>🥇 <strong>An epub always wins:</strong> an epub replaces a PDF of the same work, unless the epub is older. A PDF of a work we already have as an epub is a duplicate, or is held for a moderator if it has more chapters.</li>
<li>🕵️ <strong>Some PDFs are held:</strong> when we can't be sure we read a PDF's byline correctly, a moderator checks it first, even if it's the work's first upload. That way author opt-outs still apply.</li>
<li>📈 <strong>100 uploads a day:</strong> new accounts can upload 100 files a day, up from 20. Each epub is still limited to 25 MB.</li>
</ul>
<h2>📚 For readers</h2>
<ul>
<li>🔞 <strong>Adult works get a warning, not a sign-in:</strong> we've dropped the plan to put NSFW works behind a sign-in and an age statement. Every work can be read without an account or JavaScript. A work rated Mature, Explicit or Not Rated, a work with any archive warning, or one with a missing or unknown rating shows the warnings screen first. The screen now names unknown ratings too.</li>
<li>📄 <strong>Works converted from a PDF:</strong> their work page says "Converted from a PDF", and the download link gives you the original PDF. Until a moderator checks a converted work, it shows "Chapters may be imperfect; a moderator will check."</li>
<li>🏷️ <strong>Report a rating that's too low:</strong> signed-in readers can report a work with "This needs a higher rating". These reports don't count toward hiding a work. A moderator reads them and can mark the work as adult, which puts it behind the warnings screen with the line "A moderator marked this work as adult." The work keeps the rating its author gave it.</li>
<li>🖥️ <strong>More room:</strong> the site is wider, up to 960 px, while chapters stay at the same comfortable line length, centred on the page. The search box in the header is smaller.</li>
<li>📰 <strong>Updates on the home page:</strong> release notes like this one are now posted on the home page, starting with v0.1.0.</li>
</ul>
<h2>✉️ Signing in</h2>
<ul>
<li>🧭 <strong>A tidier sign-in page:</strong> it's now one centred column with more space between its parts.</li>
<li>🦊 <strong>Mask your email:</strong> the sign-in page now suggests Firefox Relay, so you can sign in without giving us your real address.</li>
</ul>
<h2>🔒 Your data</h2>
<ul>
<li>🍪 <strong>Cookies, listed:</strong> the <a href="https://rarepair.fans/privacy">privacy page</a> has a new Cookies section with each cookie we set, plus Cloudflare's two, what each is for, and how long it lasts.</li>
<li>🧾 <strong>Less in the logs:</strong> stored logs no longer keep the query part of addresses, so your searches aren't kept. The privacy page says what the logs hold. We also turned tracing off on the web Worker.</li>
<li>📜 <strong>The terms apply to everyone:</strong> the terms now say they apply to everyone who uses the site, not only people who make an account. The rule against automated access always applied to everyone, and now the first line says so too.</li>
</ul>
<h2>🔜 On the way</h2>
<ul>
<li>🗒️ <strong>A public removal list:</strong> the list of removed works and pseuds.</li>
</ul>`;
