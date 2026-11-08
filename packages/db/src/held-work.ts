// Whether a work is held (spec 12: its first upload waits for a moderator), read from its current
// version rather than `works.status`, which a hide overwrites. Pure SQL, so ingest can use it too.
import { sql } from "kysely";

/**
 * True for a `works` row whose current version's upload is still `held_for_review`: its first
 * upload was held and nothing has been approved or gone live since, whether it is `held` or an
 * opt-out has hidden it. Use it in a query over `works`.
 */
export const currentVersionHeld = sql<boolean>`exists (
  select 1 from work_versions held_v join uploads held_u on held_u.id = held_v.upload_id
  where held_v.id = works.current_version_id and held_u.status = 'held_for_review'
)`;
