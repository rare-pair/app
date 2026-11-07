import { fnv1a } from "./styles";
import { EPUB_TYPE, MAX_BATCH_FILES, MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from "./upload-limit";

/**
 * The upload page's script, served from UPLOAD_SCRIPT_PATH and loaded with the page's
 * nonce. Files picked or dropped go into a list the uploader can edit; nothing is sent until
 * Upload. Then the list goes in groups of MAX_BATCH_FILES: each group asks `POST /uploads` once,
 * with the Turnstile token and one `size` each, sends each file to `PUT /uploads/:id` with an
 * XMLHttpRequest (`fetch` reports no upload progress), three at a time, and confirms each
 * finished PUT with `POST /uploads/:id/complete`. The next group waits for the one before to
 * finish confirming, and for a fresh Turnstile token. A PUT that fails is reported with
 * `DELETE /uploads/:id`, so its slot is free for the next click. The server stays the authority:
 * what the script checks first (type, size) only saves a round trip. Built with textContent
 * only, never innerHTML, so a file name is never read as markup.
 */
export const UPLOAD_SCRIPT = `"use strict";
(() => {
  const TYPE = "${EPUB_TYPE}";
  const MAX_BYTES = ${MAX_UPLOAD_BYTES};
  const MAX_MB = ${MAX_UPLOAD_MB};
  const MAX_FILES = ${MAX_BATCH_FILES};
  const AT_ONCE = 3;
  const STALL_MS = 120000;
  const REPORT_MS = 10000;
  const POLL_MS = 250;
  const NEEDS_YOU = "The anti-spam check needs you. Please finish it above and the upload will go on.";
  // The longest a refused ask is waited out: the rate limit's window is 60 seconds.
  const MAX_PAUSE_SECONDS = 120;
  // A fresh check still running after this many polls is probably waiting for the person.
  const SLOW_POLLS = 32;
  const GIVE_UP_POLLS = 1200;
  // The files in the list, in order: { file, row, problem, done }.
  const entries = [];
  const input = document.getElementById("file");
  const button = document.getElementById("send");
  const message = document.getElementById("message");
  const list = document.getElementById("files");
  const drop = document.getElementById("drop");
  if (!input || !button || !message || !list || !drop) return;
  let busy = false;
  let challenged = false;
  // Turnstile calls this when it needs the person to do something (data-before-interactive-callback).
  window.onTurnstileInteractive = () => {
    challenged = true;
    // Said as it happens, not when the group in flight ends, so it is heard in time.
    if (busy) say(NEEDS_YOU);
  };

  const say = (text) => {
    message.textContent = text;
  };
  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  const sizeText = (bytes) =>
    bytes < 1024
      ? bytes + " B"
      : bytes < 1048576
        ? Math.round(bytes / 1024) + " KB"
        : (bytes / 1048576).toFixed(1) + " MB";
  const problemOf = (file) => {
    if (!/\\.epub$/i.test(file.name)) return "Not an epub file, so it was not uploaded.";
    if (file.size === 0) return "This file is empty, so it was not uploaded.";
    if (file.size > MAX_BYTES) return "Over the " + MAX_MB + " MB limit, so it was not uploaded.";
    return "";
  };
  const sameFile = (a, b) => a.name === b.name && a.size === b.size;
  const setBusy = (on) => {
    busy = on;
    button.disabled = on;
    input.disabled = on;
    for (const entry of entries) entry.row.remove.disabled = on;
  };

  const addRow = (file) => {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name + " ";
    const size = document.createElement("span");
    size.textContent = "(" + sizeText(file.size) + ") ";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", "Remove " + file.name);
    const bar = document.createElement("progress");
    bar.setAttribute("aria-label", file.name);
    bar.max = file.size;
    bar.value = 0;
    bar.hidden = true;
    const note = document.createElement("span");
    for (const part of [name, size, remove, bar, note]) item.appendChild(part);
    list.appendChild(item);
    return { item, remove, bar, note };
  };
  // Adds one file to the list, with its problem if it has one. False when it is there already.
  const addFile = (file) => {
    if (entries.some((entry) => sameFile(entry.file, file))) return false;
    const row = addRow(file);
    const problem = problemOf(file);
    row.note.textContent = problem;
    const entry = { file, row, problem, done: false };
    row.remove.addEventListener("click", () => removeEntry(entry));
    entries.push(entry);
    return true;
  };
  const addFiles = (files) => {
    if (busy) return say("Wait for the upload to finish before changing the list.");
    const picked = Array.from(files);
    if (picked.length === 0) return say("No files were found. Pick or drop epub files.");
    const added = picked.filter(addFile).length;
    const repeats = picked.length - added;
    const text = [];
    if (added > 0) text.push(plural(added, "file") + " added.");
    if (repeats > 0) text.push(repeats + (repeats === 1 ? " was" : " were") + " already in the list.");
    if (text.length > 0) say(text.join(" "));
  };
  const removeEntry = (entry) => {
    if (busy) return;
    const at = entries.indexOf(entry);
    entries.splice(at, 1);
    list.removeChild(entry.row.item);
    say("Removed " + entry.file.name + ". " + plural(entries.length, "file") + " in the list.");
    const next = entries[at] || entries[at - 1];
    (next ? next.row.remove : input).focus();
  };
  input.addEventListener("change", () => {
    const picked = Array.from(input.files || []);
    // Cleared, so the same file can be picked again later.
    input.value = "";
    addFiles(picked);
  });
  for (const type of ["dragenter", "dragover"]) {
    drop.addEventListener(type, (event) => {
      event.preventDefault();
      drop.classList.add("over");
    });
  }
  // Moving over the area's own children isn't leaving it.
  drop.addEventListener("dragleave", (event) => {
    if (!event.relatedTarget || !drop.contains(event.relatedTarget)) drop.classList.remove("over");
  });
  // A file dropped beside the area would make the browser open it and lose the list.
  for (const type of ["dragover", "drop"]) {
    document.addEventListener(type, (event) => event.preventDefault());
  }
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("over");
    addFiles((event.dataTransfer && event.dataTransfer.files) || []);
  });

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
      const end = (ok, error) => {
        clearTimeout(watchdog);
        resolve({ ok, error });
      };
      const reason = () => {
        try {
          return JSON.parse(xhr.responseText).error;
        } catch {
          return undefined;
        }
      };
      // A 409 means a file is there, or the upload has ended: the confirm says which and acts on it.
      xhr.onload = () =>
        (xhr.status >= 200 && xhr.status < 300) || xhr.status === 409
          ? end(true)
          : end(false, reason());
      xhr.onerror = () => end(false);
      xhr.onabort = () => end(false);
      xhr.ontimeout = () => end(false);
      xhr.send(file);
    });

  // Tells the server an upload failed, so its slot is free for the next click. On a network that
  // has just failed this may hang, so it isn't waited on for long. If it fails too, the server's
  // daily clean-up has it.
  const report = (id) =>
    fetch(pathOf(id), { method: "DELETE", signal: AbortSignal.timeout(REPORT_MS) }).catch(
      () => undefined,
    );

  const confirm = async (entry, id) => {
    const row = entry.row;
    row.note.textContent = "Checking the file.";
    try {
      const res = await fetch(pathOf(id) + "/complete", { method: "POST" });
      const body = await readJson(res);
      if (res.ok) entry.done = true;
      if (res.ok && body.status === "duplicate") row.note.textContent = "We already have this one.";
      else if (res.ok) row.note.textContent = "Uploaded. It will appear once it has been checked.";
      else row.note.textContent = body.error || "Something went wrong. Please try again.";
      // A fault may have come from the edge, with the Worker's own clean-up never run.
      if (res.status >= 500) await report(id);
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

  // The next group's token. The check is reset after each ask and takes a moment, or the person.
  const freshToken = async () => {
    for (let polls = 0; polls < GIVE_UP_POLLS; polls++) {
      const token = window.turnstile.getResponse();
      if (token) return token;
      if (challenged || polls >= SLOW_POLLS) {
        say(NEEDS_YOU);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return "";
  };

  // Asks for one group and sends it. True when it went; false when the ask was refused, so
  // nothing in it went; or the seconds to wait, when the rate limit refused it.
  const sendGroup = async (group, token) => {
    const body = new URLSearchParams();
    for (const { file } of group) body.append("size", String(file.size));
    body.set("cf-turnstile-response", token);
    let res = null;
    let reply = {};
    try {
      res = await fetch("/uploads", { method: "POST", body });
      reply = await readJson(res);
    } catch {
      res = null;
    }
    // A token works once, however the ask went. A check that needs the person is a new one's.
    window.turnstile.reset();
    challenged = false;

    const granted = res && res.ok ? (Array.isArray(reply.uploads) ? reply.uploads : [reply]) : [];
    if (
      granted.length !== group.length ||
      granted.some((one) => !one || typeof one.id !== "string")
    ) {
      say((res && !res.ok && reply.error) || "We couldn't start the upload. Please try again.");
      // A 429 that clears within the rate-limit window is a pause to wait out, not a spent quota.
      const wait = res && res.status === 429 ? Number(reply.retryAfter) : 0;
      return wait > 0 && wait <= MAX_PAUSE_SECONDS ? wait : false;
    }

    await runAtOnce(
      group.map((entry, i) => async () => {
        const { row, file } = entry;
        row.bar.value = 0;
        row.bar.hidden = false;
        row.note.textContent = "Uploading.";
        const sent = await put(file, granted[i].id, row);
        if (!sent.ok) {
          row.note.textContent = sent.error || "The upload didn't finish. Please try again.";
          await report(granted[i].id);
          return;
        }
        await confirm(entry, granted[i].id);
      }),
    );
    return true;
  };

  const start = async () => {
    say("");
    challenged = false;
    if (entries.length === 0) return say("Pick one or more epub files first.");
    const waiting = entries.filter((entry) => !entry.done && !entry.problem);
    if (waiting.length === 0) {
      return say(
        entries.every((entry) => entry.done)
          ? "Everything in the list is already uploaded."
          : "Nothing in the list can be sent.",
      );
    }
    let token = window.turnstile ? window.turnstile.getResponse() : "";
    if (!token) return say("Please wait for the anti-spam check to finish, then try again.");

    for (const entry of waiting) entry.row.note.textContent = "Waiting.";
    const groups = [];
    for (let at = 0; at < waiting.length; at += MAX_FILES) {
      groups.push(waiting.slice(at, at + MAX_FILES));
    }
    say(
      groups.length > 1
        ? "Sending group 1 of " + groups.length + "."
        : "Sending " + plural(waiting.length, "file") + ".",
    );
    for (let g = 0; g < groups.length; g++) {
      if (g > 0) {
        token = await freshToken();
        if (token) say("Sending group " + (g + 1) + " of " + groups.length + ".");
        else say("The anti-spam check didn't finish. Press Upload to send the rest.");
      }
      // A group is sent once the one before has finished confirming.
      let outcome = token ? await sendGroup(groups[g], token) : false;
      if (typeof outcome === "number") {
        say("Too many uploads at once. Pausing " + outcome + " seconds, then it goes on.");
        await new Promise((resolve) => setTimeout(resolve, (outcome + 1) * 1000));
        token = await freshToken();
        if (token) say("Sending group " + (g + 1) + " of " + groups.length + ".");
        outcome = token ? await sendGroup(groups[g], token) : false;
      }
      if (outcome === true) continue;
      for (const entry of groups.slice(g).flat()) {
        entry.row.note.textContent = "Not uploaded. It stays in the list, and Upload will send it.";
      }
      return;
    }
    const sent = waiting.filter((entry) => entry.done).length;
    say(
      sent === waiting.length
        ? "Sent " + plural(sent, "file") + "."
        : sent + " of " + waiting.length + " files sent. Press Upload to try the rest.",
    );
  };

  button.addEventListener("click", async () => {
    if (busy) return;
    setBusy(true);
    try {
      await start();
    } finally {
      setBusy(false);
      // Disabling the button dropped focus, unless the person moved it, so put it back.
      if (!document.activeElement || document.activeElement === document.body) button.focus();
    }
  });
})();
`;

/** The script's URL carries a hash of it, so the response never changes under it. */
export const UPLOAD_SCRIPT_PATH = `/assets/upload.${fnv1a(UPLOAD_SCRIPT)}.js`;
