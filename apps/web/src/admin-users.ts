// Actions on an account under /admin: banning an uploader (ARCHITECTURE, Moderation), from
// the "Ban uploader" form on a work's admin page. Mounted in admin.ts, behind `adminGate`.

import { banUser, type BanResult } from "@archive/db";
import { Hono } from "hono";
import type { AdminEnv } from "./admin";
import { fromField } from "./admin-items";
import { resultPage } from "./admin-pages";

const MESSAGES: Record<Exclude<BanResult, "not_found">, string> = {
  banned: "The uploader is banned.",
  already_banned: "Nothing changed: the uploader is already banned.",
  protected: "Nothing changed: a moderator or an admin can't be banned.",
};

export const adminUsers = new Hono<AdminEnv>();

adminUsers.post("/users/:id{[A-Za-z0-9_-]{1,64}}/ban", async (c) => {
  const from = await fromField(c.req.raw);
  const result = await banUser(c.var.db, c.req.param("id"), { actor: c.var.userId });
  if (result === "not_found") return c.notFound();
  return c.html(resultPage(MESSAGES[result], from));
});
