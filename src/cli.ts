import { Command, type CommanderError, InvalidArgumentError, Option } from "commander";
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
  isoTimestamp,
  parseTarget,
  pool,
  sanitize,
  type Target,
} from "./util";

const DEFAULT_HOST = "au.cloud.panopto.eu";

/** Hidden long-form aliases kept for muscle memory; they mirror a visible flag. */
function alias(flag: string): Option {
  return new Option(flag).hideHelp();
}

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new InvalidArgumentError("must be a positive integer.");
  }
  return n;
}

function buildProgram(): Command {
  return new Command()
    .name("panopto-au-downloader")
    .usage("[options] <url-or-guid> [...more]")
    .description("download Panopto recordings you have access to")
    .argument("<target...>", "viewer URLs, folder URLs or session guids (paths, with --fix-audio)")
    .addOption(new Option("-o, --out <dir>", "output directory").env("PANOPTO_OUT").default("."))
    .addOption(
      new Option("-c, --concurrency <n>", "parallel downloads").argParser(positiveInt).default(2),
    )
    .option("-r, --recursive", "for folders, also descend into subfolders")
    .option(
      "-s, --separate-streams",
      "save each source stream (camera, screen, slides) separately instead of the combined " +
        "recording. Each session gets its own directory: <session>/01-dv.mp4, 02-object.mp4, " +
        "captions.srt (alias: --all-streams)",
    )
    .addOption(alias("--all-streams"))
    .option(
      "--no-shared-audio",
      "with -s, don't copy the primary feed's audio into the screen-capture streams (which have " +
        "none of their own)",
    )
    .option(
      "--fix-audio",
      "repair mode: add the missing audio track to already downloaded stream files. Takes paths, " +
        "not URLs: bun run index.ts --fix-audio downloads/",
    )
    .option("-l, --list", "list what would be downloaded, then exit (alias: --dry-run)")
    .addOption(alias("--dry-run"))
    .option(
      "--flat",
      'no per-folder or per-session subdirectories; stream files become "<session> [01-dv].mp4"',
    )
    .option(
      "--no-captions",
      "skip the .srt subtitles (saved by default, in both combined and separate-streams mode)",
    )
    .option(
      "--captions-only",
      "download only the .srt subtitles, no video (aliases: --subs-only, --subtitles-only)",
    )
    .addOption(alias("--subs-only"))
    .addOption(alias("--subtitles-only"))
    .option("-f, --overwrite", "re-download files that already exist")
    .addOption(
      new Option(
        "--cookies-from <browser>",
        'read the login cookie from a local browser profile instead of PANOPTO_COOKIE (default: try Firefox when PANOPTO_COOKIE is unset)',
      ).choices(["firefox", "none", "env"]),
    )
    .option("--profile <name>", "which browser profile to read cookies from (name substring or full path)")
    .addOption(
      new Option("--host <host>", `Panopto host (default: the target's host, else ${DEFAULT_HOST})`)
        .env("PANOPTO_HOST"),
    )
    .addHelpText(
      "after",
      `
Targets may be:
  - a viewer URL      https://<host>/Panopto/Pages/Viewer.aspx?id=<guid>
  - a folder URL      https://<host>/Panopto/Pages/Sessions/List.aspx?folderID=%22<guid>%22
  - a bare session guid

Auth:
  By default the cookie is taken from your Firefox profile - just stay logged in
  at the Panopto site. Otherwise set PANOPTO_COOKIE in .env to the Cookie header
  (or just the .ASPXAUTH value) from a logged-in browser. See README.md.
`,
    )
    .showHelpAfterError("(run with --help to see the available options)")
    .exitOverride();
}

/**
 * What commander hands back. Flags without a declared default are absent rather
 * than false, so the boolean ones are optional; `--no-x` pairs always have one.
 */
interface ParsedFlags {
  out: string;
  concurrency: number;
  sharedAudio: boolean;
  captions: boolean;
  recursive?: boolean;
  separateStreams?: boolean;
  allStreams?: boolean;
  fixAudio?: boolean;
  list?: boolean;
  dryRun?: boolean;
  flat?: boolean;
  captionsOnly?: boolean;
  subsOnly?: boolean;
  subtitlesOnly?: boolean;
  overwrite?: boolean;
  cookiesFrom?: string;
  profile?: string;
  host?: string;
}

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
  const program = buildProgram();
  let flags: ParsedFlags;
  let positionals: string[];
  try {
    program.parse(argv, { from: "user" });
    flags = program.opts<ParsedFlags>();
    positionals = program.args;
  } catch (err) {
    // exitOverride() turns commander's process.exit into a throw; it has already
    // written the help text or the error message itself.
    return isHelpRequest(err) ? 0 : 2;
  }

  const concurrency = flags.concurrency;

  if (flags.fixAudio === true) {
    return await fixAudio(positionals, concurrency);
  }

  const host = flags.host ?? hostFromUrl(positionals[0]!) ?? DEFAULT_HOST;

  let cookie: string;
  try {
    const resolved = await resolveCookie(host, flags.cookiesFrom, flags.profile);
    if (!resolved) return 1;
    cookie = resolved;
  } catch (err) {
    console.error(errorMessage(err));
    return 1;
  }

  const opts: Options = {
    out: flags.out,
    concurrency,
    recursive: flags.recursive === true,
    list: flags.list === true || flags.dryRun === true,
    flat: flags.flat === true,
    separateStreams: flags.separateStreams === true || flags.allStreams === true,
    sharedAudio: flags.sharedAudio,
    captions: flags.captions,
    captionsOnly:
      flags.captionsOnly === true || flags.subsOnly === true || flags.subtitlesOnly === true,
    overwrite: flags.overwrite === true,
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
    // Also for transcripts downloaded before the sidecar existed, hence the
    // fileExists check rather than just `if (srt)`.
    if (srt || (await fileExists(captionDest))) {
      const meta = await saveCaptionsMeta(client, delivery, job.session, captionDest, opts.overwrite);
      if (meta) written.push(meta);
    }
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

/**
 * Write the recording's identity next to its transcript, as `<base>.json`.
 *
 * An .srt has timestamps but no session id, so on its own it is a dead end:
 * quoting "38:12" from it gives you no way back to the moment it came from.
 * The sidecar closes that gap - `viewerUrl` plus `&start=<seconds>` deep-links
 * into Panopto at any point of the transcript.
 *
 * Returns the path, or null when one is already there.
 */
async function saveCaptionsMeta(
  client: PanoptoClient,
  delivery: Delivery,
  session: SessionSummary,
  captionDest: string,
  overwrite: boolean,
): Promise<string | null> {
  const dest = captionDest.replace(/\.srt$/i, ".json");
  if (!overwrite && (await fileExists(dest))) return null;

  const viewerUrl = `${client.origin}/Panopto/Pages/Viewer.aspx?id=${session.id}`;
  const meta = {
    sessionId: session.id,
    title: delivery.SessionName ?? session.name,
    folder: session.folderName,
    recordedAt: isoTimestamp(session.startTime ?? delivery.SessionStartTime),
    durationSeconds: delivery.Duration ?? session.duration ?? null,
    captions: basename(captionDest),
    viewerUrl,
    // Spelled out because the whole point of this file is to be read by
    // something that then has to build a link.
    deepLink: `${viewerUrl}&start=<seconds-from-start-of-recording>`,
  };

  await ensureDir(dirname(dest));
  await Bun.write(dest, `${JSON.stringify(meta, null, 2)}\n`);
  return dest;
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

/** `--help` reaches us as a thrown CommanderError too, and is not a failure. */
function isHelpRequest(err: unknown): boolean {
  const code = (err as CommanderError | undefined)?.code;
  return code === "commander.help" || code === "commander.helpDisplayed";
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
