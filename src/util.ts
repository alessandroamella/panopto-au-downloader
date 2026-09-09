export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export type Target =
  | { kind: "session"; id: string }
  | { kind: "folder"; id: string };

/**
 * Accepts a Panopto viewer/embed URL, a folder list URL, or a bare GUID.
 * A bare GUID is treated as a session unless `defaultKind` says otherwise.
 */
export function parseTarget(input: string, defaultKind: Target["kind"] = "session"): Target {
  const raw = input.trim().replace(/^["']|["']$/g, "");

  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    return { kind: defaultKind, id: raw.toLowerCase() };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a Panopto URL or GUID: ${input}`);
  }

  // folderID can live in the query string or in the hash fragment, and Panopto's
  // own UI often wraps it in %22 quotes.
  const params = new URLSearchParams(url.search);
  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const pick = (key: string) => params.get(key) ?? hashParams.get(key);

  const folder = pick("folderID") ?? pick("folderId") ?? pick("folder");
  if (folder) {
    const m = folder.match(GUID_RE);
    if (m) return { kind: "folder", id: m[0].toLowerCase() };
  }

  const session = pick("id") ?? pick("deliveryId");
  if (session) {
    const m = session.match(GUID_RE);
    if (m) return { kind: "session", id: m[0].toLowerCase() };
  }

  // Podcast/Download style URLs: /Panopto/Podcast/Download/<guid>.mp4
  const inPath = url.pathname.match(GUID_RE);
  if (inPath) {
    const kind = /\/Sessions\/List/i.test(url.pathname) ? "folder" : "session";
    return { kind, id: inPath[0].toLowerCase() };
  }

  throw new Error(`Could not find a session or folder id in: ${input}`);
}

export function hostFromUrl(input: string): string | null {
  try {
    return new URL(input.trim()).host;
  } catch {
    return null;
  }
}

/** Strip characters that are illegal or annoying in filenames on any platform. */
export function sanitize(name: string, maxLen = 120): string {
  const cleaned = name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  const safe = cleaned.length ? cleaned : "untitled";
  return safe.length > maxLen ? safe.slice(0, maxLen).trimEnd() : safe;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const v = bytes / 1024 ** i;
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Seconds between 1601-01-01 (Windows FILETIME epoch) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET = 11_644_473_600;

/**
 * ISO date prefix (YYYY-MM-DD) for a Panopto start time, or null.
 *
 * Panopto reports start times in three shapes: an ISO string, an ASP.NET
 * `/Date(1700000000000)/` blob, or a bare number of seconds since 1601-01-01
 * (what DeliveryInfo's SessionStartTime uses).
 */
export function datePrefix(startTime: string | number | null | undefined): string | null {
  if (startTime === null || startTime === undefined || startTime === "") return null;

  let d: Date;
  if (typeof startTime === "number") {
    d = new Date((startTime - FILETIME_EPOCH_OFFSET) * 1000);
  } else {
    const aspNet = startTime.match(/\/Date\((-?\d+)/);
    d = aspNet ? new Date(Number(aspNet[1])) : new Date(startTime);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Run `worker` over `items` with at most `limit` in flight, preserving order. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await worker(items[i]!, i);
      }
    },
  );
  await Promise.all(runners);
  return results;
}
