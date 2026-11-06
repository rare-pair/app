import { fnv1a } from "./styles";
import { EPUB_TYPE, MAX_BATCH_FILES, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

/**
 * The upload page's script, served from UPLOAD_SCRIPT_PATH and loaded with the page's
 * nonce. On Upload it asks `POST /uploads` once for every file picked, with the Turnstile
 * token and one `size` each, then sends each file to `PUT /uploads/:id` with an XMLHttpRequest
 * (`fetch` reports no upload progress), three at a time; another click on Upload sends the
 * files not yet uploaded. Each finished PUT is confirmed with `POST /uploads/:id/complete`, and
 * one that fails is reported with `DELETE /uploads/:id`, so its slot is free for that next click.
 * The server stays the authority: what the script checks first
 * (type, size, count) only saves a round trip. Built with textContent only, never innerHTML,
 * so a file name is never read as markup.
 */
export const UPLOAD_SCRIPT = `"use strict";
(() => {
  const TYPE = "${EPUB_TYPE}";
  const MAX_BYTES = ${MAX_UPLOAD_BYTES};
  const MAX_MB = ${MAX_UPLOAD_MB};
  const MAX_FILES = ${MAX_BATCH_FILES};
  const AT_ONCE = 3;
  const STALL_MS = 120000;
  // Files already uploaded and confirmed, so a second click, to retry the rest, skips them.
  const finished = new Set();
  const input = document.getElementById("file");
  const button = document.getElementById("send");
  const message = document.getElementById("message");
  const list = document.getElementById("files");
  if (!input || !button || !message || !list) return;

  const say = (text) => {
    message.textContent = text;
  };
  const addRow = (file, shown) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name + " ";
    const bar = document.createElement("progress");
    bar.setAttribute("aria-label", file.name);
    bar.max = file.size;
    bar.value = 0;
    bar.hidden = !shown;
    const note = document.createElement("span");
    item.appendChild(name);
    item.appendChild(bar);
    item.appendChild(note);
    list.appendChild(item);
    return { bar, note };
  };
  const readJson = async (res) => {
    try {
      return await res.json();
    } catch {
      return {};
    }
  };

  const pathOf = (id) => "/uploads/" + encodeURIComponent(id);

  const put = (file, id, row) =>
    new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", pathOf(id));
      xhr.setRequestHeader("Content-Type", TYPE);
      // A transfer that stops moving is ended, rather than holding the button and the
      // other files for ever.
      let watchdog = setTimeout(() => xhr.abort(), STALL_MS);
      xhr.upload.onprogress = (event) => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => xhr.abort(), STALL_MS);
        if (event.lengthComputable) {
          row.bar.max = event.total;
          row.bar.value = event.loaded;
        }
      };
      const end = (ok) => {
        clearTimeout(watchdog);
        resolve(ok);
      };
      xhr.onload = () => end(xhr.status >= 200 && xhr.status < 300);
      xhr.onerror = () => end(false);
      xhr.onabort = () => end(false);
      xhr.ontimeout = () => end(false);
      xhr.send(file);
    });

  // Tells the server an upload failed, so its slot is free for the next click. If this fails
  // too, the server's daily clean-up has it.
  const report = async (id) => {
    try {
      await fetch(pathOf(id), { method: "DELETE" });
    } catch {
      return;
    }
  };

  const confirm = async (file, id, row) => {
    row.note.textContent = "Checking the file.";
    try {
      const res = await fetch(pathOf(id) + "/complete", { method: "POST" });
      const body = await readJson(res);
      if (res.ok) finished.add(file);
      if (res.ok && body.status === "duplicate") row.note.textContent = "We already have this one.";
      else if (res.ok) row.note.textContent = "Uploaded. It will appear once it has been checked.";
      else row.note.textContent = body.error || "Something went wrong. Please try again.";
    } catch {
      row.note.textContent = "Something went wrong. Please try again.";
      // The server may never have heard of this confirm. One it did count, it keeps.
      await report(id);
    }
  };

  const runAtOnce = async (jobs) => {
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        await job();
      }
    };
    await Promise.all(Array.from({ length: Math.min(AT_ONCE, jobs.length) }, worker));
  };

  const start = async () => {
    list.replaceChildren();
    say("");
    const picked = Array.from(input.files || []);
    if (picked.length === 0) return say("Pick one or more epub files first.");
    const token = window.turnstile ? window.turnstile.getResponse() : "";
    if (!token) return say("Please wait for the anti-spam check to finish, then try again.");

    const toSend = [];
    for (const file of picked) {
      let refusal = "";
      if (finished.has(file)) refusal = "Already uploaded.";
      else if (!/\\.epub$/i.test(file.name)) refusal = "Not an epub file, so it was not uploaded.";
      else if (file.size === 0) refusal = "This file is empty, so it was not uploaded.";
      else if (file.size > MAX_BYTES) refusal = "Over the " + MAX_MB + " MB limit, so it was not uploaded.";
      const row = addRow(file, refusal === "");
      if (refusal) row.note.textContent = refusal;
      else toSend.push({ file, row });
    }
    if (toSend.length === 0) return;
    // Only the files that would be sent count towards the cap, as the server counts them.
    if (toSend.length > MAX_FILES) {
      say("You can upload " + MAX_FILES + " files at a time. Please pick fewer.");
      for (const { row } of toSend) row.note.textContent = "Not uploaded.";
      return;
    }

    const body = new URLSearchParams();
    for (const { file } of toSend) body.append("size", String(file.size));
    body.set("cf-turnstile-response", token);
    let res = null;
    let reply = {};
    try {
      res = await fetch("/uploads", { method: "POST", body });
      reply = await readJson(res);
    } catch {
      res = null;
    }
    // A token works once, however the ask went.
    window.turnstile.reset();

    const granted = res && res.ok ? (Array.isArray(reply.uploads) ? reply.uploads : [reply]) : [];
    if (
      granted.length !== toSend.length ||
      granted.some((one) => !one || typeof one.id !== "string")
    ) {
      say((res && !res.ok && reply.error) || "We couldn't start the upload. Please try again.");
      for (const { row } of toSend) row.note.textContent = "Not uploaded.";
      return;
    }

    await runAtOnce(
      toSend.map(({ file, row }, i) => async () => {
        row.note.textContent = "Uploading.";
        if (!(await put(file, granted[i].id, row))) {
          row.note.textContent = "The upload didn't finish. Please try again.";
          await report(granted[i].id);
          return;
        }
        await confirm(file, granted[i].id, row);
      }),
    );
  };

  let busy = false;
  button.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    button.disabled = true;
    try {
      await start();
    } finally {
      busy = false;
      button.disabled = false;
    }
  });
})();
`;

/** The script's URL carries a hash of it, so the response never changes under it. */
export const UPLOAD_SCRIPT_PATH = `/assets/upload.${fnv1a(UPLOAD_SCRIPT)}.js`;
