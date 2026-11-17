/**
 * The ego browser helper's download watching, as JS source for the `ego-browser nodejs` script.
 *
 * The adapter concatenates this into its helper, which already declares `fs`, `input` and
 * `message(error)`; only `node:path` is imported here. `startDownloadWatch(page, root, directory)`
 * validates and prepares the bot's download folder and arms one `download` event waiter before
 * the caller dispatches the click or goto that may download. `collect()` is called once after that
 * action and saves the file the waiter saw. Ordinary actions call collect(false), which does not
 * wait for a missing event. Explicit downloads wait up to 3000 ms for the event, then saveAs waits
 * for the transfer to complete. The SDK disposes an outstanding waiter when its round ends.
 *
 * Names follow the computer's page browser (`infra/sandboxes/computer/rakazo-page-browser`): a
 * site's file name becomes one plain segment with shell characters replaced, and every download
 * gets its own new folder, so a name can never replace another file. A saved file's reported path
 * is relative to the workspace root, as the computer browser reports it, so the tool layer maps
 * it to the bot's own path instead of showing a local absolute path. A cleanup failure is reported
 * in the entry's error field beside the saved file, never hidden or turned into a failed download.
 */
export const EGO_DOWNLOAD_HELPERS: string = String.raw`
const EGO_DOWNLOAD_WAIT_MS = 3000;

// The characters the page browser replaces in a site's file name: the bot may put the name in a
// shell command, so "$", backticks, quotes and separators must not survive.
const EGO_DOWNLOAD_REPLACED = "/\\$" + String.fromCharCode(96) + ";|&<>!\"'";

function egoDownloadSplitExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** A site's name for a file as one short, plain path segment. */
function egoDownloadName(value) {
  let text = "";
  const source = typeof value === "string" ? value : "";
  for (const char of source.normalize("NFC")) {
    if (EGO_DOWNLOAD_REPLACED.indexOf(char) >= 0) text += "_";
    else if (/[\p{C}\p{Z}]/u.test(char)) text += " ";
    else text += char;
  }
  text = text
    .split(" ")
    .filter(Boolean)
    .join(" ")
    .replace(/^[. ]+|[. ]+$/g, "");
  const parts = egoDownloadSplitExtension(text);
  let stem = parts[0];
  let ext = parts[1];
  if (Array.from(ext).length > 12 || ext.indexOf(" ") >= 0) {
    stem += ext;
    ext = "";
  }
  const stemChars = Array.from(stem);
  while (
    stemChars.length > 0 &&
    (stemChars.length + Array.from(ext).length > 80 ||
      new TextEncoder().encode(stemChars.join("") + ext).length > 200)
  ) {
    stemChars.pop();
  }
  stem = stemChars.join("").replace(/[. ]+$/, "");
  return stem ? stem + ext : "download" + ext;
}

/** A destination this call may not save into; the caller must not dispatch its action. */
function egoDownloadPathError() {
  const error = new Error("Downloads cannot be saved in that folder.");
  error.code = "invalid-download-path";
  return error;
}

/** Cleans up only this download's own browser copy; a failure is reported, never hidden. */
async function egoDownloadDiscard(download, method) {
  try {
    if (download && typeof download[method] === "function") await download[method]();
    return undefined;
  } catch (error) {
    return message(error) || "unknown error";
  }
}

/** The event waiter's own timeout is a page that did not download; anything else is a real error. */
function egoDownloadTimedOut(error) {
  return /waitForEvent\(\s*["']download["'][^)]*\)[\s\S]*\btimed out\b/i.test(message(error));
}

/**
 * Watches one page action for one download. root is the computer's absolute workspace and
 * directory the folder the call may save into, relative to it. Validation and arming happen
 * here, before the caller dispatches the action, so an unusable folder fails the call instead of
 * losing the file.
 */
async function startDownloadWatch(page, root, directory) {
  const path = await import("node:path");
  if (typeof directory !== "string" || directory.length === 0) {
    return { collect: async () => [] };
  }
  if (typeof root !== "string" || !path.isAbsolute(root)) throw egoDownloadPathError();
  if (path.isAbsolute(directory) || directory.includes("\0")) throw egoDownloadPathError();
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    // An unreadable workspace cannot anchor a save, so the action is refused before it runs.
    throw egoDownloadPathError();
  }
  const folder = path.resolve(realRoot, directory);
  const relative = path.relative(realRoot, folder);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + path.sep) ||
    path.isAbsolute(relative)
  ) {
    throw egoDownloadPathError();
  }
  // Every folder from the workspace down is made and checked: a symlink could point the save into
  // another bot's folder. The workspace root itself may be reached through a symlink, so it is
  // fixed to its real path first; the folders below it may not be links.
  let current = realRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try {
        await fs.mkdir(current, 0o755);
      } catch (made) {
        if (made.code !== "EEXIST") throw made;
      }
      info = await fs.lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw egoDownloadPathError();
  }
  const display = relative.split(path.sep).join("/");
  // One waiter covers the call's action batch. Ordinary calls collect only an event already seen;
  // explicit downloads wait for it. Never leave multiple waiters competing for one file.
  let observed = false;
  const settled = page.waitForEvent("download", { timeout: EGO_DOWNLOAD_WAIT_MS }).then(
    (download) => { observed = true; return { download }; },
    (error) => { observed = true; return { error }; },
  );

  async function save(download) {
    let name = "download";
    let created;
    try {
      name = egoDownloadName(download.suggestedFilename());
      // A fresh folder per download: one site's name cannot land on another file, and two
      // downloads with one name both keep it.
      created = await fs.mkdtemp(path.join(folder, "download-"));
      const file = path.join(created, name);
      await download.saveAs(file);
      const info = await fs.stat(file);
      // The browser's own copy is this call's to remove once the saved one exists. A failure is
      // reported beside the saved file: the file stays, and the call did download it.
      const cleanup = await egoDownloadDiscard(download, "delete");
      return {
        name,
        path: path.join(display, path.basename(created), name),
        size: info.size,
        ...(cleanup
          ? { error: "Saved, but its temporary browser copy could not be removed: " + cleanup }
          : {}),
      };
    } catch (failure) {
      const problems = [message(failure)];
      const canceled = await egoDownloadDiscard(download, "cancel");
      if (canceled) problems.push("cancelling the download failed: " + canceled);
      if (created) {
        try {
          await fs.rm(created, { recursive: true, force: true });
        } catch (error) {
          problems.push("removing its temporary folder failed: " + message(error));
        }
      }
      return { name, error: problems.join("; ") };
    }
  }

  return {
    async collect(wait = true) {
      if (!wait && !observed) return [];
      const outcome = await settled;
      if (outcome.error) {
        if (egoDownloadTimedOut(outcome.error)) return [];
        throw outcome.error;
      }
      return [await save(outcome.download)];
    },
  };
}
`;
