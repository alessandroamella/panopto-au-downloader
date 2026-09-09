# panopto-au-downloader

Download Panopto recordings you already have access to (Aarhus University:
`au.cloud.panopto.eu`), plus their auto-generated captions.

It reuses your browser's login cookie - read straight out of your Firefox
profile, or pasted into `.env` - so it works with AU's SSO without ever handling
your password.

## Setup

```bash
bun install
cp .env.example .env
```

### Authentication

If you use Firefox and are logged in at <https://au.cloud.panopto.eu>, there is
nothing to set up: the cookie is read from your Firefox profile automatically
(session cookies included, so keep the tab or the "restore session" setting
around). Pick a specific profile with `--profile <name>`, and turn the whole
thing off with `--cookies-from none`.

`PANOPTO_COOKIE` takes priority whenever it is set, so leave it empty in `.env`
unless you want the manual route.

#### Copying the cookie by hand

1. Open <https://au.cloud.panopto.eu> in your browser and log in through AU SSO.
2. Open devtools (F12) -> **Network** tab, then reload the page.
3. Click the first `List.aspx` (or any) request -> **Headers** -> **Request Headers**
   -> find `Cookie:` and copy the whole value.
4. Paste it into `.env`:

   ```
   PANOPTO_COOKIE=.ASPXAUTH=ABC123...; other=values
   ```

   Pasting only the `.ASPXAUTH` value works too - the tool adds the name for you.

The cookie expires after a while (typically days). When you start seeing
`Unauthorized access`, repeat the steps above - or just let Firefox extraction
handle it.

## Usage

```bash
# One recording
bun run index.ts "https://au.cloud.panopto.eu/Panopto/Pages/Viewer.aspx?id=<guid>"

# A whole course folder, including subfolders, 4 at a time
bun run index.ts -r -c 4 "https://au.cloud.panopto.eu/Panopto/Pages/Sessions/List.aspx?folderID=%22<guid>%22"

# Each camera/screen stream as its own file, in a directory per session
bun run index.ts -s "https://au.cloud.panopto.eu/Panopto/Pages/Viewer.aspx?id=<guid>"

# Just the subtitles for a whole folder, no video
bun run index.ts --captions-only -r "<folder url>"

# See what would be downloaded first
bun run index.ts --list "<folder url>"
```

### Options

| Flag | Meaning |
| --- | --- |
| `-o, --out <dir>` | output directory (default: current directory) |
| `-c, --concurrency <n>` | parallel downloads (default 2) |
| `-r, --recursive` | for folders, descend into subfolders |
| `-s, --separate-streams` | save each source stream separately (see below) |
| `-l, --list` / `--dry-run` | print the recordings and exit |
| `--flat` | no per-folder or per-session subdirectories |
| `--no-captions` | skip the `.srt` sidecar |
| `--captions-only` | only the `.srt` subtitles, no video (aliases `--subs-only`, `--subtitles-only`) |
| `-f, --overwrite` | re-download files that already exist |
| `--host <host>` | different Panopto instance (default `au.cloud.panopto.eu`) |
| `--cookies-from <b>` | where to get the cookie: `firefox` (default) or `none` (use `PANOPTO_COOKIE`) |
| `--profile <name>` | which browser profile to read cookies from (name substring or path) |

Targets can be viewer URLs, folder URLs, or bare session GUIDs, and you can pass
several at once.

### Separate streams

By default you get the combined recording Panopto renders for its own download
button — one MP4 with the camera and slides already composited.

With `-s` / `--separate-streams` you get each source stream instead (`dv` is the
camera/primary feed, `object` the screen and slide captures), one directory per
session:

```
downloads/
  NLP Fall26 2026-08-25/
    01-dv.mp4
    02-object.mp4
    03-object.mp4
    captions.srt
```

Streams keep Panopto's own order, so `01` is the primary feed. They're numbered
because Panopto reuses the same tag for every screen source. Captions are saved
in both modes.

Separate streams are always HLS, so this mode needs `ffmpeg` on your `PATH` and
takes noticeably longer than the combined download — it's a remux, not a
re-encode, but each stream is fetched segment by segment. Expect the individual
streams to be *larger* than the combined MP4 (they're at full source quality),
so `-s` on a whole folder eats disk fast. `--flat` skips the per-session
directory and names files `<session> [01-dv].mp4` instead.

## How it works

For each session the tool calls `DeliveryInfo.aspx` — the same endpoint the web
player uses — and then:

1. **Prefers the pre-rendered podcast MP4** (`PodcastStreams`). This is a plain
   HTTP download: fast, resumable, no ffmpeg needed.
2. Falls back to `/Panopto/Podcast/Download/<id>.mp4` if the delivery info
   doesn't list one.
3. Falls back to the primary **HLS** stream, remuxed to MP4 with `ffmpeg -c copy`
   (no re-encoding, so it's quick — but ffmpeg must be on your `PATH`).

Captions come from `GenerateSRT.ashx` and are written as `<name>.srt` next to the
video, which players like VLC, mpv and Plex pick up automatically. Panopto
numbers caption languages itself (AU's English is language 16, not 0), so the
tool reads the available language ids out of the delivery info rather than
guessing. Sessions without a transcript are simply skipped. Note that the
podcast MP4 usually also carries the captions as an embedded subtitle track.

Files are named `YYYY-MM-DD - Session Name.mp4`. Interrupted HTTP downloads
resume from the `.part` file; finished files are skipped on the next run unless
you pass `--overwrite`.

## Development

```bash
bun test
bun run typecheck
```

## Note

Only download recordings you're entitled to access, and keep them to yourself —
lecture recordings are usually copyrighted by the university and the lecturer.
