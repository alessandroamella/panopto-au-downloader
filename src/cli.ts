import { parseArgs } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  PanoptoClient,
  PanoptoError,
  captionLanguages,
  podcastStream,
  sourceStreams,
  type Delivery,
  type SessionSummary,
} from "./panopto";
import {
  downloadFile,
  downloadHls,
  ensureDir,
  fileDuration,
  fileExists,
  fileHasAudio,
  hasFfmpeg,
  muxAudioInto,
  playlistHasAudio,
  type Progress,
} from "./download";
import { browserCookieHeader } from "./cookies";
import {
  datePrefix,
  formatBytes,
  formatDuration,
  hostFromUrl,
  parseTarget,
  pool,
  sanitize,
  type Target,
} from "./util";

const DEFAULT_HOST = "au.cloud.panopto.eu";

const HELP = `panopto-au-downloader - download Panopto recordings you have access to

Usage:
  bun run index.ts [options] <url-or-guid> [...more]

Targets may be:
  - a viewer URL      https://<host>/Panopto/Pages/Viewer.aspx?id=<guid>
  - a folder URL      https://<host>/Panopto/Pages/Sessions/List.aspx?folderID=%22<guid>%22
  - a bare session guid

Options:
  -o, --out <dir>          output directory (default: current directory)
  -c, --concurrency <n>    parallel downloads (default: 2)
  -r, --recursive          for folders, also descend into subfolders
  -s, --separate-streams   save each source stream (camera, screen, slides)
                           separately instead of the combined recording. Each
                           session gets its own directory:
                             <session>/01-dv.mp4, 02-object.mp4, captions.srt
                           (alias: --all-streams)
      --no-shared-audio    with -s, don't copy the primary feed's audio into the
                           screen-capture streams (which have none of their own)
      --fix-audio          repair mode: add the missing audio track to already
                           downloaded stream files. Takes paths, not URLs:
                             bun run index.ts --fix-audio downloads/
  -l, --list               list what would be downloaded, then exit
                           (alias: --dry-run)
      --flat               no per-folder or per-session subdirectories; stream
                           files become "<session> [01-dv].mp4"
      --no-captions        skip the .srt subtitles (saved by default, in both
                           combined and separate-streams mode)
      --captions-only      download only the .srt subtitles, no video
                           (aliases: --subs-only, --subtitles-only)
  -f, --overwrite          re-download files that already exist
      --cookies-from <b>   read the login cookie from a local browser profile
                           instead of PANOPTO_COOKIE: "firefox" or "none"
                           (default: try Firefox when PANOPTO_COOKIE is unset)
      --profile <name>     which browser profile to read cookies from
                           (name substring or full path)
      --host <host>        Panopto host (default: ${DEFAULT_HOST}, or PANOPTO_HOST)
  -h, --help               show this help

Auth:
  By default the cookie is taken from your Firefox profile - just stay logged in
  at the Panopto site. Otherwise set PANOPTO_COOKIE in .env to the Cookie header
  (or just the .ASPXAUTH value) from a logged-in browser. See README.md.
`;

interface Options {
  out: string;
  concurrency: number;
  recursive: boolean;
  list: boolean;
  flat: boolean;
  separateStreams: boolean;
  sharedAudio: boolean;
  captions: boolean;
  captionsOnly: boolean;
  overwrite: boolean;
  host: string;
}

interface Job {
  session: SessionSummary;
  /** Relative directory under `out`, "" when flat. */
  subdir: string;
}

export async function main(argv: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: "string", short: "o" },
        concurrency: { type: "string", short: "c" },
        recursive: { type: "boolean", short: "r", default: false },
        "separate-streams": { type: "boolean", short: "s", default: false },
        "all-streams": { type: "boolean", default: false },
        "no-shared-audio": { type: "boolean", default: false },
        "fix-audio": { type: "boolean", default: false },
        list: { type: "boolean", short: "l", default: false },
        "dry-run": { type: "boolean", default: false },
        flat: { type: "boolean", default: false },
        captions: { type: "boolean", default: true },
        "no-captions": { type: "boolean", default: false },
        "captions-only": { type: "boolean", default: false },
        "subs-only": { type: "boolean", default: false },
        "subtitles-only": { type: "boolean", default: false },
        overwrite: { type: "boolean", short: "f", default: false },
        host: { type: "string" },
        "cookies-from": { type: "string" },
        profile: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    }) as { values: Record<string, string | boolean | undefined>; positionals: string[] });
  } catch (err) {
    console.error(`${errorMessage(err)}\n\nRun with --help to see the available options.`);
    return 2;
  }

  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (positionals.length === 0) {
    console.error("No target given.\n");
    console.error(HELP);
    return 2;
  }

  const concurrency = Number(values.concurrency ?? 2);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer, got "${values.concurrency}".`);
    return 2;
  }

  if (values["fix-audio"] === true) {
    return await fixAudio(positionals, concurrency);
  }

  const host =
    (values.host as string | undefined) ??
    process.env.PANOPTO_HOST ??
    hostFromUrl(positionals[0]!) ??
    DEFAULT_HOST;

  let cookie: string;
  try {
    const resolved = await resolveCookie(host, values["cookies-from"] as string | undefined, values.profile as string | undefined);
    if (!resolved) return 1;
    cookie = resolved;
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  const opts: Options = {
    out: (values.out as string | undefined) ?? process.env.PANOPTO_OUT ?? ".",
    concurrency,
    recursive: values.recursive === true,
    list: values.list === true || values["dry-run"] === true,
    flat: values.flat === true,
    separateStreams: values["separate-streams"] === true || values["all-streams"] === true,
    sharedAudio: values["no-shared-audio"] !== true,
    captions: values["no-captions"] !== true,
    captionsOnly:
      values["captions-only"] === true ||
      values["subs-only"] === true ||
      values["subtitles-only"] === true,
    overwrite: values.overwrite === true,
    host,
  };

  const client = new PanoptoClient(host, cookie);

  let targets: Target[];
  try {
    targets = positionals.map((p) => parseTarget(p));
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 1;
  }

  console.log(`Host: ${client.origin}`);

  let jobs: Job[];
  try {
    jobs = await collectJobs(client, targets, opts);
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  if (jobs.length === 0) {
    console.error("Nothing to download.");
    return 1;
  }

  console.log(`Found ${jobs.length} recording${jobs.length === 1 ? "" : "s"}.`);

  if (opts.list) {
    for (const job of jobs) {
      const where = job.subdir ? `${job.subdir}/` : "";
      const dur = job.session.duration ? ` (${formatDuration(job.session.duration)})` : "";
      console.log(`${where}${baseName(job.session)}${dur}`);
    }
    return 0;
  }

  await ensureDir(opts.out);

  const progress = new ProgressReporter(jobs.length);
  let failures = 0;

  await pool(jobs, opts.concurrency, async (job) => {
    const name = baseName(job.session);
    progress.start(name);
    try {
      const written = await downloadSession(client, job, opts, (p) => progress.update(name, p));
      progress.finish(
        name,
        written.length === 0 ? "skipped (already downloaded)" : `saved ${written.length} file(s)`,
      );
    } catch (err) {
      failures++;
      progress.fail(name, errorMessage(err));
    }
  });

  progress.done();
  const ok = jobs.length - failures;
  console.log(`\nDone: ${ok} succeeded, ${failures} failed. Output: ${resolve(opts.out)}`);
  return failures > 0 ? 1 : 0;
}

/**
 * PANOPTO_COOKIE wins when set; otherwise fall back to reading the cookie out
 * of a local browser profile, which is what most people want day to day since
 * the copied header expires every few days.
 */
async function resolveCookie(
  host: string,
  source: string | undefined,
  profileHint: string | undefined,
): Promise<string | null> {
  const from = (source ?? (process.env.PANOPTO_COOKIE ? "none" : "firefox")).toLowerCase();
  if (from === "none" || from === "env") {
    const cookie = process.env.PANOPTO_COOKIE;
    if (cookie) return cookie;
    console.error(
      "PANOPTO_COOKIE is not set.\n" +
        "Either log in with Firefox and drop --cookies-from none, or copy the\n" +
        "cookie into .env - see README.md.",
    );
    return null;
  }
  if (from !== "firefox") {
    console.error(`Unknown --cookies-from "${source}". Supported: firefox, none.`);
    return null;
  }

  const found = await browserCookieHeader(host, profileHint);
  if (!found) {
    console.error(
      `No ${host} cookies found in any Firefox profile.\n` +
        "Log in at that site in Firefox, or set PANOPTO_COOKIE in .env - see README.md.",
    );
    return null;
  }
  console.log(`Cookie: Firefox profile ${found.profile.name}`);
  return found.header;
}

async function collectJobs(
  client: PanoptoClient,
  targets: Target[],
  opts: Options,
): Promise<Job[]> {
  const jobs: Job[] = [];
  const seen = new Set<string>();

  const push = (session: SessionSummary, subdir: string) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    jobs.push({ session, subdir });
  };

  for (const target of targets) {
    if (target.kind === "session") {
      const delivery = await client.getDelivery(target.id);
      push(
        {
          id: target.id,
          name: delivery.SessionName ?? target.id,
          folderName: null,
          startTime: delivery.SessionStartTime ?? null,
          duration: delivery.Duration ?? null,
        },
        "",
      );
      continue;
    }

    // Folder (optionally recursive), breadth-first.
    const queue: Array<{ id: string; path: string[] }> = [{ id: target.id, path: [] }];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (visited.has(node.id)) continue;
      visited.add(node.id);

      const sessions = await client.listSessions(node.id);
      const folderLabel =
        node.path.length > 0
          ? node.path.join("/")
          : sanitize(sessions.find((s) => s.folderName)?.folderName ?? node.id);

      console.log(`  ${folderLabel}: ${sessions.length} recording(s)`);
      for (const s of sessions) push(s, opts.flat ? "" : folderLabel);

      if (opts.recursive) {
        const children = await client.listSubfolders(node.id);
        for (const child of children) {
          queue.push({ id: child.id, path: [folderLabel, sanitize(child.name)] });
        }
      }
    }
  }

  return jobs;
}

/**
 * Repair mode: walk directories of already-downloaded streams and give the
 * silent ones the audio track of the sibling that has one. Panopto only ever
 * records audio on the primary feed, so a folder's screen captures come out
 * mute unless they borrow it.
 */
async function fixAudio(roots: string[], concurrency: number): Promise<number> {
  if (!(await hasFfmpeg())) {
    console.error("--fix-audio needs ffmpeg on PATH.");
    return 1;
  }

  const groups = new Map<string, string[]>();
  for (const root of roots) {
    const stats = await stat(root).catch(() => null);
    if (!stats) {
      console.error(`No such file or directory: ${root}`);
      return 1;
    }
    if (stats.isDirectory()) {
      for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
        const name = entry.name.toLowerCase();
        // Skip in-progress downloads - they are truncated and have no moov atom.
        if (!entry.isFile() || !name.endsWith(".mp4") || name.endsWith(".part.mp4")) continue;
        const dir = entry.parentPath ?? root;
        groups.set(dir, [...(groups.get(dir) ?? []), join(dir, entry.name)]);
      }
    } else {
      const dir = dirname(root);
      groups.set(dir, [...(groups.get(dir) ?? []), root]);
    }
  }

  let fixed = 0;
  let failures = 0;

  for (const [dir, files] of [...groups].sort()) {
    files.sort();
    const withAudio: string[] = [];
    const silent: string[] = [];
    for (const file of files) {
      ((await fileHasAudio(file)) ? withAudio : silent).push(file);
    }

    if (silent.length === 0) continue;
    const donor = withAudio[0];
    if (!donor) {
      console.error(`${dir}: ${silent.length} silent file(s) but no sibling with an audio track - skipped`);
      failures += silent.length;
      continue;
    }

    console.log(`${dir}: taking audio from ${basename(donor)}`);
    const progress = new ProgressReporter(silent.length);
    await pool(silent, concurrency, async (file) => {
      const name = basename(file);
      progress.start(name);
      try {
        await muxAudioInto(file, donor, await fileDuration(file), (p) => progress.update(name, p));
        fixed++;
        progress.finish(name, "audio added");
      } catch (err) {
        failures++;
        progress.fail(name, errorMessage(err));
      }
    });
    progress.done();
  }

  if (fixed === 0 && failures === 0) {
    console.log("Nothing to fix - every file already has an audio track.");
    return 0;
  }
  console.log(`\nFixed ${fixed} file(s), ${failures} failed.`);
  return failures > 0 ? 1 : 0;
}

/** Returns the files written (empty when everything already existed). */
async function downloadSession(
  client: PanoptoClient,
  job: Job,
  opts: Options,
  onProgress: (p: Progress) => void,
): Promise<string[]> {
  const delivery = await client.getDelivery(job.session.id);
  const dir = job.subdir ? join(opts.out, job.subdir) : opts.out;
  const base = baseName({ ...job.session, name: delivery.SessionName ?? job.session.name });
  const headers = client.headers();
  const duration = delivery.Duration ?? job.session.duration ?? null;
  const written: string[] = [];

  // In separate-streams mode each session gets its own directory, so the stream
  // files can be named after their source. --flat keeps everything in one
  // directory and disambiguates with a filename prefix instead.
  const perSession = opts.separateStreams && !opts.flat && !opts.captionsOnly;
  const sessionDir = perSession ? join(dir, base) : dir;
  const captionDest = perSession ? join(sessionDir, "captions.srt") : join(dir, `${base}.srt`);

  if (opts.captions || opts.captionsOnly) {
    const srt = await saveCaptions(client, delivery, job.session.id, captionDest, opts.overwrite);
    if (srt) written.push(srt);
    if (opts.captionsOnly) {
      // Nothing else to do - but a session without a transcript would otherwise
      // look like a silent skip, so say so.
      if (!srt && !(await fileExists(captionDest))) {
        throw new Error("no captions available for this session");
      }
      return written;
    }
  }

  if (opts.separateStreams) {
    const streams = sourceStreams(delivery);
    if (streams.length === 0) throw new Error("no streams available for this session");

    // Panopto records the microphone once, on the primary feed; the screen and
    // slide captures are video-only. Find the stream that has audio so the
    // silent ones can borrow it.
    const audioFlags = await Promise.all(
      streams.map((s) =>
        opts.sharedAudio && /\.m3u8(\?|$)/i.test(s.StreamUrl)
          ? playlistHasAudio(s.StreamUrl, headers).catch(() => true)
          : Promise.resolve(true),
      ),
    );
    const audioDonor = streams[audioFlags.indexOf(true)]?.StreamUrl ?? null;

    for (const [i, stream] of streams.entries()) {
      // Panopto reuses tags across streams ("object" for every screen source),
      // so number them - that also preserves the primary-first ordering.
      const index = String(i + 1).padStart(2, "0");
      const tag = sanitize(stream.Tag || "stream", 40);
      const dest = perSession
        ? join(sessionDir, `${index}-${tag}.mp4`)
        : join(dir, `${base} [${index}-${tag}].mp4`);
      if (!opts.overwrite && (await fileExists(dest))) continue;
      const borrowAudio = audioFlags[i] === false ? audioDonor : null;
      await fetchStream(stream.StreamUrl, dest, headers, duration, onProgress, borrowAudio);
      written.push(dest);
    }
    return written;
  }

  const dest = join(dir, `${base}.mp4`);
  if (!opts.overwrite && (await fileExists(dest))) return written;

  const url = await bestCombinedUrl(client, delivery, job.session.id);
  if (!url) throw new Error("no downloadable stream found (podcast not rendered and no HLS streams)");
  await fetchStream(url, dest, headers, duration, onProgress);
  written.push(dest);
  return written;
}

/** Write the auto-generated captions as a sidecar .srt. Returns the path, if any. */
async function saveCaptions(
  client: PanoptoClient,
  delivery: Delivery,
  sessionId: string,
  dest: string,
  overwrite: boolean,
): Promise<string | null> {
  if (!overwrite && (await fileExists(dest))) return null;
  // Panopto sometimes leaves the delivery metadata empty even though the
  // transcript endpoint answers; language 0 is the default track.
  const languages = captionLanguages(delivery);
  for (const language of languages.length > 0 ? languages : [0]) {
    const srt = await client.getCaptionsSrt(sessionId, language);
    if (!srt) continue;
    await ensureDir(dirname(dest));
    await Bun.write(dest, srt);
    return dest;
  }
  return null;
}

/** Prefer the pre-rendered podcast MP4; fall back to the primary HLS stream. */
async function bestCombinedUrl(
  client: PanoptoClient,
  delivery: Delivery,
  sessionId: string,
): Promise<string | null> {
  const podcast = podcastStream(delivery);
  if (podcast?.StreamUrl) return podcast.StreamUrl;

  const probed = await client.probePodcastUrl(sessionId);
  if (probed) return probed;

  const primary = sourceStreams(delivery)[0];
  return primary?.StreamUrl ?? null;
}

async function fetchStream(
  url: string,
  dest: string,
  headers: Record<string, string>,
  duration: number | null,
  onProgress: (p: Progress) => void,
  audioUrl: string | null = null,
): Promise<void> {
  if (/\.m3u8(\?|$)/i.test(url)) {
    if (!(await hasFfmpeg())) {
      throw new Error("this recording is only available as HLS, which needs ffmpeg on PATH");
    }
    await downloadHls(url, dest, headers, duration, onProgress, audioUrl);
  } else {
    await downloadFile(url, dest, headers, onProgress);
  }
}

function baseName(session: SessionSummary): string {
  const date = datePrefix(session.startTime);
  const name = sanitize(session.name);
  // Panopto's default session names often already embed the date; don't repeat it.
  return date && !name.includes(date) ? `${date} - ${name}` : name;
}

function errorMessage(err: unknown): string {
  if (err instanceof PanoptoError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Single-line status renderer that stays readable with concurrent downloads. */
class ProgressReporter {
  private active = new Map<string, Progress>();
  private completed = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tty = process.stdout.isTTY === true;

  constructor(private readonly total: number) {
    if (this.tty) this.timer = setInterval(() => this.render(), 250);
  }

  start(name: string): void {
    this.active.set(name, { ratio: 0, done: 0, total: null, label: "starting" });
    if (!this.tty) console.log(`-> ${name}`);
  }

  update(name: string, p: Progress): void {
    this.active.set(name, p);
  }

  finish(name: string, detail: string): void {
    this.active.delete(name);
    this.completed++;
    this.line(`[${this.completed}/${this.total}] ${name} - ${detail}`);
  }

  fail(name: string, reason: string): void {
    this.active.delete(name);
    this.completed++;
    this.line(`[${this.completed}/${this.total}] ${name} - FAILED: ${reason}`);
  }

  done(): void {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }

  private line(text: string): void {
    this.clear();
    console.log(text);
  }

  private clear(): void {
    if (this.tty) process.stdout.write("\r\x1b[2K");
  }

  private render(): void {
    if (!this.tty || this.active.size === 0) return;
    const parts = [...this.active.entries()].map(([name, p]) => {
      const short = name.length > 28 ? `${name.slice(0, 27)}...` : name;
      const pct = p.ratio === null ? p.label : `${Math.floor(p.ratio * 100)}%`;
      const size = p.total === null && p.done > 0 ? ` ${formatBytes(p.done)}` : "";
      return `${short} ${pct}${p.ratio === null ? "" : size}`;
    });
    process.stdout.write(`\r\x1b[2K${this.completed}/${this.total} | ${parts.join("  |  ")}`);
  }
}
