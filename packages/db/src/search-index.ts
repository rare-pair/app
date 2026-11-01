// Fills a work's search columns. Apart from ./search so the seed module, which
// loads in workerd, pulls in nothing beyond Kysely's types.
import { sql, type Kysely } from "kysely";
import type { Database } from "./schema";

/**
 * Rebuilds a work's `search` (tsvector) and `search_text` (trigram) from its
 * title, bylines, every tag and its summary with the markup removed. Call it in
 * the transaction that writes any of them, once they are all in. The text is
 * built in SQL, so the tsvector is never a bound string. Migration 0008's
 * backfill builds the same text.
 */
export async function refreshWorkSearch(db: Kysely<Database>, workId: string): Promise<void> {
  await sql`
    update works set
      search_text = concat_ws(' ', indexed.title, indexed.byline, indexed.tags, indexed.summary),
      search = setweight(to_tsvector('simple', indexed.title), 'A')
        || setweight(to_tsvector('simple', indexed.byline), 'B')
        || setweight(to_tsvector('simple', indexed.tags), 'B')
        || setweight(to_tsvector('simple', indexed.summary), 'C')
    from (
      select w.id,
        w.title,
        coalesce((select string_agg(a.pseud, ' ' order by a.position)
           from work_authors a where a.work_id = w.id), '') as byline,
        coalesce((select string_agg(t.name, ' ' order by wt.position)
           from work_tags wt join tags t on t.id = wt.tag_id
          where wt.work_id = w.id), '') as tags,
        -- Cut, so a tsvector never nears Postgres's 1 MB limit: that would fail the save.
        left(regexp_replace(coalesce(w.summary_html, ''), '<[^>]*>|&[#a-zA-Z0-9]+;', ' ', 'g'), 20000) as summary
      from works w
      where w.id = ${workId}
    ) indexed
    where works.id = indexed.id`.execute(db);
}
