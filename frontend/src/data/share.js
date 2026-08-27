/**
 * Getting a file off the phone.
 *
 * A backup that only exists in the app's own storage is not a backup: it dies
 * with the handset, which is most of what a backup is for. So the file is
 * written somewhere durable and then handed to the Android share sheet, where
 * the user can put it in Drive, in a mail to themselves, anywhere that is not
 * this device.
 *
 * Device-only, like capacitor.js, and just as thin - the browser branch exists
 * so `npm run dev` is still usable, not because anyone ships it.
 */

import { Capacitor } from "@capacitor/core";

/**
 * Write `text` to `filename` and offer to share it.
 *
 * @returns {Promise<{uri: string, shared: boolean}>} where it landed, and
 *   whether the share sheet was actually opened.
 */
export async function saveAndShare(filename, text, { title = filename } = {}) {
  if (!Capacitor.isNativePlatform()) return browserDownload(filename, text);

  const [{ Directory, Encoding, Filesystem }, { Share }] = await Promise.all([
    import("@capacitor/filesystem"),
    import("@capacitor/share"),
  ]);

  const write = (directory) =>
    Filesystem.writeFile({ path: filename, data: text, directory, encoding: Encoding.UTF8 });

  // Documents is the shared folder a file manager can see, which is the one
  // place the user could find this again without the app. It is also the one
  // that scoped storage is most likely to refuse, so failing back to the app's
  // own directory keeps the share - the part that actually leaves the phone.
  let uri;
  try {
    ({ uri } = await write(Directory.Documents));
  } catch {
    ({ uri } = await write(Directory.Data));
  }

  const can = await Share.canShare().catch(() => ({ value: false }));
  if (!can.value) return { uri, shared: false };

  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
    return { uri, shared: true };
  } catch {
    // The user dismissing the share sheet throws here. The file is written
    // either way, so this is not a failure worth showing them.
    return { uri, shared: false };
  }
}

function browserDownload(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return { uri: filename, shared: false };
}
