/**
 * Read Panopto's login cookie straight out of a local browser profile, so the
 * user doesn't have to copy it from devtools by hand.
 *
 * Firefox keeps persistent cookies in `cookies.sqlite` and session cookies
 * (which is what `.ASPXAUTH` usually is) only in the session store, a
 * "mozlz4"-compressed JSON file. Both are read, session cookies winning since
 * they are the live ones.
 */
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export interface Cookie {
  name: string;
  value: string;
}

export interface BrowserProfile {
  browser: "firefox";
  name: string;
  path: string;
}

/** Roots to scan for Firefox profiles, relative to the home directory. */
const FIREFOX_ROOTS = [
  ".mozilla/firefox",
  "snap/firefox/common/.mozilla/firefox",
  ".var/app/org.mozilla.firefox/.mozilla/firefox",
  "Library/Application Support/Firefox/Profiles",
  "AppData/Roaming/Mozilla/Firefox/Profiles",
];

/** Profiles that have a cookie store, most recently used first. */
export async function firefoxProfiles(): Promise<BrowserProfile[]> {
  const found: Array<BrowserProfile & { mtime: number }> = [];
  for (const root of FIREFOX_ROOTS) {
    const dir = join(homedir(), root);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const db = await stat(join(path, "cookies.sqlite")).catch(() => null);
      if (!db) continue;
      found.push({ browser: "firefox", name: entry.name, path, mtime: db.mtimeMs });
    }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(({ mtime, ...p }) => p);
}

/**
 * Cookies for `host` from a browser profile, as a ready-to-send Cookie header.
 * Returns null when no profile has any.
 *
 * `profileHint` selects a profile by name substring or exact path; without it
 * every profile is tried, most recently used first, and the first one holding
 * an auth cookie wins.
 */
export async function browserCookieHeader(
  host: string,
  profileHint?: string,
): Promise<{ header: string; profile: BrowserProfile } | null> {
  let profiles = await firefoxProfiles();
  if (profileHint) {
    const needle = profileHint.toLowerCase();
    profiles = profiles.filter(
      (p) => p.path === profileHint || p.name.toLowerCase().includes(needle),
    );
    if (profiles.length === 0) {
      throw new Error(`No Firefox profile matching "${profileHint}".`);
    }
  }

  let fallback: { header: string; profile: BrowserProfile } | null = null;
  for (const profile of profiles) {
    const cookies = await readFirefoxCookies(profile.path, host);
    if (cookies.length === 0) continue;
    const result = {
      header: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      profile,
    };
    // A profile that merely remembers a preference cookie is not logged in;
    // keep looking, but fall back to it if nothing better turns up.
    if (cookies.some((c) => isAuthCookie(c.name))) return result;
    fallback ??= result;
  }
  return fallback;
}

function isAuthCookie(name: string): boolean {
  return /^\.?ASPXAUTH$/i.test(name) || /auth|session/i.test(name);
}

async function readFirefoxCookies(profile: string, host: string): Promise<Cookie[]> {
  const cookies = new Map<string, string>();
  for (const c of await persistentCookies(profile, host)) cookies.set(c.name, c.value);
  // Session cookies are the live ones - they overwrite anything on disk.
  for (const c of await sessionCookies(profile, host)) cookies.set(c.name, c.value);
  return [...cookies].map(([name, value]) => ({ name, value }));
}

async function persistentCookies(profile: string, host: string): Promise<Cookie[]> {
  const src = join(profile, "cookies.sqlite");
  if (!(await stat(src).catch(() => null))) return [];

  // Firefox holds a lock on the live database and keeps recent writes in the
  // -wal sidecar, so work on a copy of both and let SQLite replay the log.
  const tmp = await mkdtemp(join(tmpdir(), "panopto-cookies-"));
  try {
    const copy = join(tmp, "cookies.sqlite");
    await copyFile(src, copy);
    await copyFile(`${src}-wal`, `${copy}-wal`).catch(() => {});
    const db = new Database(copy);
    try {
      const rows = db
        .query<{ host: string; name: string; value: string; expiry: number }, []>(
          "SELECT host, name, value, expiry FROM moz_cookies",
        )
        .all();
      const now = Date.now();
      return rows
        .filter((r) => domainMatches(host, r.host) && !isExpired(r.expiry, now))
        .map((r) => ({ name: r.name, value: r.value }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** Session cookies live only in the session store, as mozlz4-compressed JSON. */
async function sessionCookies(profile: string, host: string): Promise<Cookie[]> {
  for (const name of ["recovery.jsonlz4", "recovery.baklz4", "previous.jsonlz4"]) {
    const file = Bun.file(join(profile, "sessionstore-backups", name));
    if (!(await file.exists())) continue;
    try {
      const json = JSON.parse(mozlz4(new Uint8Array(await file.arrayBuffer())));
      const list = Array.isArray(json?.cookies) ? json.cookies : [];
      const matched = list
        .filter((c: { host?: string }) => typeof c?.host === "string" && domainMatches(host, c.host))
        .map((c: { name?: string; value?: string }) => ({
          name: String(c.name ?? ""),
          value: String(c.value ?? ""),
        }))
        .filter((c: Cookie) => c.name !== "");
      if (matched.length > 0) return matched;
    } catch {
      // Corrupt or unexpected format - try the next snapshot.
    }
  }
  return [];
}

/** Decompress Mozilla's "mozLz40\0" container to text. */
function mozlz4(buf: Uint8Array): string {
  const magic = new TextDecoder().decode(buf.subarray(0, 8));
  if (!magic.startsWith("mozLz4")) throw new Error("not a mozlz4 file");
  const size = new DataView(buf.buffer, buf.byteOffset).getUint32(8, true);
  return new TextDecoder().decode(lz4Block(buf.subarray(12), size));
}

/** Minimal LZ4 block decoder (no frame header, size known up front). */
function lz4Block(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size);
  let s = 0;
  let d = 0;
  while (s < src.length) {
    const token = src[s++]!;
    let literals = token >> 4;
    if (literals === 15) {
      let more: number;
      do {
        more = src[s++]!;
        literals += more;
      } while (more === 255);
    }
    dst.set(src.subarray(s, s + literals), d);
    s += literals;
    d += literals;
    if (s >= src.length) break; // last sequence is literals only

    const offset = src[s++]! | (src[s++]! << 8);
    let length = token & 0xf;
    if (length === 15) {
      let more: number;
      do {
        more = src[s++]!;
        length += more;
      } while (more === 255);
    }
    length += 4; // minimum match length
    if (offset === 0 || offset > d) throw new Error("corrupt lz4 stream");
    // Overlapping copies are legal and common, so copy byte by byte.
    for (let i = 0, p = d - offset; i < length; i++) dst[d++] = dst[p++]!;
  }
  return dst.subarray(0, d);
}

/** Does a cookie's host field cover `host`? ".example.com" covers subdomains. */
export function domainMatches(host: string, cookieHost: string): boolean {
  const h = host.toLowerCase();
  const c = cookieHost.toLowerCase();
  if (!c.startsWith(".")) return h === c;
  return h === c.slice(1) || h.endsWith(c);
}

/**
 * Firefox has stored `expiry` in seconds historically and in milliseconds in
 * recent versions; tell them apart by magnitude. 0 means a session cookie.
 */
export function isExpired(expiry: number, now: number): boolean {
  if (!expiry) return false;
  const ms = expiry > 1e12 ? expiry : expiry * 1000;
  return ms < now;
}
