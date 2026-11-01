// Search over works' metadata: title, bylines, tags and summary, never chapter
// text. `refreshWorkSearch` (search-index.ts) fills the two indexed columns; `searchLiveWorks`
// reads them. Nothing here logs a query: the repo is public and readers' searches
// are private.
import { sql, type Kysely } from "kysely";
import { asListed, bylineAndTags, isCount, PAGE_SIZE, SUMMARY, type ListedWork } from "./queries";
import type { Database } from "./schema";

export interface SearchOptions {
  /** Default 20; one below 1 or not a whole number is the default. */
  pageSize?: number;
  /** Rows to skip; default 0; one below 0 or not a whole number is 0. */
  offset?: number;
}

export interface SearchResults {
  /** Ranked best first, each with its byline and tags. */
  works: ListedWork[];
  /** Matching live works in all, ignoring `pageSize` and `offset`. */
  total: number;
}

/** A longer query is cut: nobody types more, and the match cost grows with it. */
const MAX_QUERY = 200;

/**
 * The `live` works matching `query` in their title, byline, tags or summary,
 * best first. A word matches by full text (the `simple` configuration: no
 * stemming, so a name stays itself) or, for a typo, by trigram similarity.
 * Any text is safe: it never raises a syntax error, and a blank one finds nothing.
 */
export async function searchLiveWorks(
  db: Kysely<Database>,
  query: string,
  { pageSize, offset }: SearchOptions = {},
): Promise<SearchResults> {
  // Postgres refuses a NUL in text.
  // Cut by code point, so an astral character isn't split.
  const q = Array.from(query.replaceAll("\0", " ")).slice(0, MAX_QUERY).join("").trim();
  if (q === "") return { works: [], total: 0 };
  const tsq = sql`websearch_to_tsquery('simple', ${q}::text)`;
  const matches = sql<boolean>`(works.search @@ ${tsq} or works.search_text %> ${q}::text)`;
  const rank = sql<number>`(coalesce(ts_rank_cd(works.search, ${tsq}, 32), 0)
    + coalesce(word_similarity(${q}::text, works.search_text), 0))`;
  const { count } = await db
    .selectFrom("works")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("works.status", "=", "live")
    .where(matches)
    .executeTakeFirstOrThrow();
  const total = Number(count);
  const size = pageSize !== undefined && isCount(pageSize) ? pageSize : PAGE_SIZE;
  const skip = offset !== undefined && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  if (skip >= total) return { works: [], total };
  // The page is cut first, as ids in rank order; bylines and tags are then built
  // for its rows alone.
  const page = await db
    .selectFrom("works")
    .select("works.ao3_work_id")
    .where("works.status", "=", "live")
    .where(matches)
    .orderBy(rank, "desc")
    // AO3 work ID last: a total order, so pages neither repeat nor skip.
    .orderBy("works.ao3_work_id")
    .limit(size)
    .offset(skip)
    .execute();
  if (page.length === 0) return { works: [], total };
  const order = new Map(page.map((p, i) => [p.ao3_work_id, i]));
  const rows = await db
    .selectFrom("works")
    .select(SUMMARY)
    .select(bylineAndTags)
    .where("works.ao3_work_id", "in", [...order.keys()])
    // Live again: a work hidden since the page was cut must not show.
    .where("works.status", "=", "live")
    .execute();
  // Read back in no promised order, so the page is put in rank order again.
  const byRank = (w: ListedWork) => order.get(w.work.ao3_work_id) ?? 0;
  return { works: rows.map(asListed).sort((a, b) => byRank(a) - byRank(b)), total };
}
