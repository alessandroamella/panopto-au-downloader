import { createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { once } from "node:events";
import { dirname } from "node:path";
import { USER_AGENT, formatBytes } from "./util";

export interface Progress {
  /** 0..1, or null when the total size is unknown. */
  ratio: number | null;
  done: number;
  total: number | null;
  label: string;
}

export type OnProgress = (p: Progress) => void;

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Download a direct HTTP file to `dest`, buffering through `<dest>.part` so an
 * interrupted run can resume with a Range request.
 */
export async function downloadFile(
  url: string,
  dest: string,
  headers: Record<string, string>,
  onProgress?: OnProgress,
): Promise<void> {
  await ensureDir(dirname(dest));
  const part = `${dest}.part`;
  let offset = await fileSize(part);

  const reqHeaders: Record<string, string> = { "user-agent": USER_AGENT, ...headers };
  if (offset > 0) reqHeaders.range = `bytes=${offset}-`;

  const res = await fetch(url, { headers: reqHeaders, redirect: "follow" });
  if (offset > 0 && res.status !== 206) {
    // Server ignored the Range header - start over.
    offset = 0;
    await unlink(part).catch(() => {});
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  if (!res.body) throw new Error("download failed: empty response body");

  const len = Number(res.headers.get("content-length") ?? "");
  const total = Number.isFinite(len) && len > 0 ? len + offset : null;

  const out = createWriteStream(part, { flags: offset > 0 ? "a" : "w" });
  let done = offset;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await once(out, "drain");
      done += chunk.byteLength;
      onProgress?.({ ratio: total ? done / total : null, done, total, label: formatBytes(done) });
    }
  } finally {
    out.end();
    await once(out, "close");
  }
  await rename(part, dest);
}

/**
 * Remux an HLS playlist into an MP4 with ffmpeg (stream copy - no re-encode).
 */
export async function downloadHls(
  playlistUrl: string,
  dest: string,
  headers: Record<string, string>,
  durationSeconds: number | null,
  onProgress?: OnProgress,
  /** Playlist to take the audio track from, when this stream has none. */
  audioUrl?: string | null,
): Promise<void> {
  const inputHeaders = ffmpegInputArgs(headers);
  await runFfmpeg(
    [
      ...inputHeaders,
      "-i", playlistUrl,
      // Panopto's screen-capture streams carry no audio at all - the microphone
      // is only ever on the primary feed - so optionally take audio from there.
      ...(audioUrl ? [...inputHeaders, "-i", audioUrl, "-map", "0:v:0", "-map", "1:a:0", "-shortest"] : []),
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+faststart",
    ],
    dest,
    durationSeconds,
    onProgress,
  );
}

/**
 * Copy the audio track of `audioSource` into `video` (both local files),
 * rewriting it in place. Stream copy, so it is disk- rather than CPU-bound.
 */
export async function muxAudioInto(
  video: string,
  audioSource: string,
  durationSeconds: number | null,
  onProgress?: OnProgress,
): Promise<void> {
  await runFfmpeg(
    [
      "-i", video,
      "-i", audioSource,
      "-map", "0:v",
      "-map", "1:a:0",
      "-c", "copy",
      "-shortest",
      "-movflags", "+faststart",
    ],
    video,
    durationSeconds,
    onProgress,
  );
}

function ffmpegInputArgs(headers: Record<string, string>): string[] {
  const headerLines = Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\r\n");
  return ["-user_agent", USER_AGENT, ...(headerLines ? ["-headers", `${headerLines}\r\n`] : [])];
}

/**
 * Run ffmpeg into `<dest>.part.mp4` and move it into place on success, so an
 * interrupted or failed run never leaves a half-written file behind. Writing to
 * a temp file also makes it safe for `dest` to be one of the inputs.
 */
async function runFfmpeg(
  args: string[],
  dest: string,
  durationSeconds: number | null,
  onProgress?: OnProgress,
): Promise<void> {
  await ensureDir(dirname(dest));
  const part = `${dest}.part.mp4`;

  const proc = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", "-stats", "-y", ...args, part],
    { stdout: "pipe", stderr: "pipe" },
  );

  const decoder = new TextDecoder();
  let tail = "";
  const readStats = (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk, { stream: true });
      tail = (tail + text).slice(-4000);
      const m = [...text.matchAll(/time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/g)].pop();
      if (m && onProgress) {
        const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        onProgress({
          ratio: durationSeconds ? Math.min(1, secs / durationSeconds) : null,
          done: secs,
          total: durationSeconds,
          label: `${Math.round(secs)}s`,
        });
      }
    }
  })();

  const code = await proc.exited;
  await readStats;
  if (code !== 0) {
    await unlink(part).catch(() => {});
    throw new Error(`ffmpeg exited with code ${code}${tail.trim() ? `:\n${tail.trim()}` : ""}`);
  }
  await rename(part, dest);
}

/**
 * Whether an HLS master playlist offers an audio track. Reading the playlist
 * (a few hundred bytes) avoids probing the media itself.
 */
export async function playlistHasAudio(
  url: string,
  headers: Record<string, string>,
): Promise<boolean> {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT, ...headers } });
  if (!res.ok) throw new Error(`could not read playlist: HTTP ${res.status}`);
  const text = await res.text();
  if (/^#EXT-X-MEDIA:.*TYPE=AUDIO/im.test(text)) return true;
  return [...text.matchAll(/CODECS="([^"]*)"/gi)].some(([, codecs]) =>
    /\b(mp4a|ac-3|ec-3|opus|vorbis|flac)\b/i.test(codecs ?? ""),
  );
}

/** Whether a local media file already has an audio stream. */
export async function fileHasAudio(path: string): Promise<boolean> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 && out.trim().length > 0;
}

/** Duration in seconds of a local media file, or null if ffprobe can't tell. */
export async function fileDuration(path: string): Promise<number | null> {
  const proc = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return null;
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function hasFfmpeg(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
