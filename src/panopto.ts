import { USER_AGENT } from "./util";

export interface PanoptoStream {
  /** Direct .mp4 or HLS .m3u8 playlist URL. */
  StreamUrl: string;
  Tag?: string | null;
  StreamHttpUrl?: string | null;
  RelativeStart?: number;
  RelativeEnd?: number;
  PublicID?: string;
}

export interface Delivery {
  SessionId?: string;
  SessionName?: string;
  Duration?: number;
  /** Pre-rendered combined MP4s. Usually one entry, sometimes empty. */
  PodcastStreams?: PanoptoStream[];
  /** Per-source streams (screen capture, webcam, ...), normally HLS. */
  Streams?: PanoptoStream[];
  /** Seconds since 1601-01-01, not a date string. */
  SessionStartTime?: number;
  HasCaptions?: boolean;
  AvailableCaptions?: Array<{ Language: number }>;
}

export interface SessionSummary {
  id: string;
  name: string;
  folderName: string | null;
  startTime: string | number | null;
  duration: number | null;
}

export interface FolderSummary {
  id: string;
  name: string;
}

export class PanoptoError extends Error {}

export class PanoptoClient {
  readonly host: string;
  readonly cookie: string;

  constructor(host: string, cookie: string) {
    this.host = host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    this.cookie = normalizeCookie(cookie);
  }

  get origin(): string {
    return `https://${this.host}`;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      cookie: this.cookie,
      "user-agent": USER_AGENT,
      referer: `${this.origin}/Panopto/Pages/Sessions/List.aspx`,
      ...extra,
    };
  }

  private async post(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch(`${this.origin}${path}`, {
      method: "POST",
      redirect: "follow",
      ...init,
      headers: this.headers(init.headers as Record<string, string>),
    });
    // Panopto bounces unauthenticated requests to the SSO login page instead of
    // returning 401, so detect that explicitly.
    if (isLoginRedirect(res)) {
      throw new PanoptoError(
        "Not authenticated - Panopto redirected to the login page. Your cookie is missing or expired; grab a fresh one (see README).",
      );
    }
    if (!res.ok) {
      throw new PanoptoError(`${path} failed: HTTP ${res.status} ${res.statusText}`);
    }
    return res;
  }

  /** Session metadata + stream URLs. This is the endpoint the web player uses. */
  async getDelivery(sessionId: string): Promise<Delivery> {
    const body = new URLSearchParams({
      deliveryId: sessionId,
      invocationId: "",
      isLiveNotes: "false",
      refreshAuthCookie: "true",
      isActiveBroadcast: "false",
      isEditing: "false",
      isKollectiveAgentInstalled: "false",
      isEmbed: "false",
      responseType: "json",
    });
    const res = await this.post("/Panopto/Pages/Viewer/DeliveryInfo.aspx", {
      body,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    const json = (await res.json()) as { Delivery?: Delivery; ErrorCode?: number; ErrorMessage?: string };
    if (!json.Delivery) {
      const detail = json.ErrorMessage
        ? stripHtml(json.ErrorMessage)
        : `error code ${json.ErrorCode ?? "unknown"}`;
      const hint = /unauthorized|access|denied|permission/i.test(detail)
        ? " Either your cookie has expired (grab a fresh one) or your account cannot view this recording."
        : "";
      throw new PanoptoError(`${sessionId}: ${detail}.${hint}`);
    }
    return json.Delivery;
  }

  /** All sessions directly inside a folder (paginated internally). */
  async listSessions(folderId: string): Promise<SessionSummary[]> {
    const out: SessionSummary[] = [];
    const pageSize = 100;
    for (let page = 0; ; page++) {
      const res = await this.post("/Panopto/Services/Data.svc/GetSessions", {
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          queryParameters: {
            query: null,
            sortColumn: 1,
            sortAscending: true,
            maxResults: pageSize,
            page,
            startDate: null,
            endDate: null,
            folderID: folderId,
            bookmarked: false,
            getFolderData: true,
            isSharedWithMe: false,
            includePlaylists: false,
          },
        }),
      });
      const json = (await res.json()) as {
        d?: { Results?: any[]; TotalNumber?: number };
      };
      const results = json.d?.Results ?? [];
      for (const r of results) {
        const id: string | undefined = r.DeliveryID ?? r.SessionID ?? r.Id;
        if (!id) continue;
        out.push({
          id: String(id).toLowerCase(),
          name: r.SessionName ?? r.Name ?? id,
          folderName: r.FolderName ?? null,
          startTime: r.StartTime ?? null,
          duration: typeof r.Duration === "number" ? r.Duration : null,
        });
      }
      const total = json.d?.TotalNumber ?? out.length;
      if (results.length < pageSize || out.length >= total) break;
    }
    return out;
  }

  /** Immediate subfolders of a folder. */
  async listSubfolders(folderId: string): Promise<FolderSummary[]> {
    const res = await this.post("/Panopto/Services/Data.svc/GetFolders", {
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        queryParameters: {
          parentID: folderId,
          includeMyFolder: false,
          includePersonalFolders: true,
          page: 0,
          maxResults: 500,
          sortColumn: 1,
          sortAscending: true,
          names: null,
        },
      }),
    });
    const json = (await res.json()) as { d?: any[] };
    return (json.d ?? [])
      .map((f) => ({ id: String(f.Id ?? f.ID ?? "").toLowerCase(), name: f.Name ?? "folder" }))
      .filter((f) => f.id.length > 0);
  }

  /**
   * Auto-generated (or human-edited) captions as SRT text, or null when the
   * session has none in that language.
   */
  async getCaptionsSrt(sessionId: string, language: number): Promise<string | null> {
    const url = `${this.origin}/Panopto/Pages/Transcription/GenerateSRT.ashx?id=${sessionId}&language=${language}`;
    const res = await fetch(url, { headers: this.headers(), redirect: "follow" });
    if (isLoginRedirect(res)) {
      throw new PanoptoError("Not authenticated while fetching captions - cookie expired?");
    }
    if (!res.ok) return null;
    const text = await res.text();
    // Panopto answers with an empty body (or an HTML error page) when no
    // transcript exists; a real SRT always starts with a cue index.
    return /^\s*\d+\s*\r?\n\s*\d\d:\d\d:\d\d/.test(text) ? text : null;
  }

  /**
   * Fallback URL for the pre-rendered podcast MP4 when DeliveryInfo exposes no
   * podcast stream. Returns null if Panopto has not generated one.
   */
  async probePodcastUrl(sessionId: string): Promise<string | null> {
    const url = `${this.origin}/Panopto/Podcast/Download/${sessionId}.mp4?mediaTargetType=videoPodcast`;
    try {
      const res = await fetch(url, { method: "HEAD", headers: this.headers(), redirect: "follow" });
      if (res.ok && !isLoginRedirect(res)) return res.url || url;
    } catch {
      // ignore - caller falls back to HLS
    }
    return null;
  }
}

function isLoginRedirect(res: Response): boolean {
  return /\/Panopto\/Pages\/Auth|login\.aspx|wayf|adfs|microsoftonline/i.test(res.url);
}

/**
 * Accepts either a full `Cookie:` header value copied from devtools, or a bare
 * .ASPXAUTH token.
 */
function normalizeCookie(raw: string): string {
  const value = raw.trim().replace(/^Cookie:\s*/i, "").replace(/^["']|["']$/g, "");
  if (!value) throw new PanoptoError("Empty cookie - set PANOPTO_COOKIE in .env");
  return value.includes("=") ? value : `.ASPXAUTH=${value}`;
}

/** Pick the combined MP4 if Panopto rendered one. */
export function podcastStream(delivery: Delivery): PanoptoStream | null {
  const streams = delivery.PodcastStreams ?? [];
  const mp4 = streams.find((s) => s.StreamUrl && /\.mp4(\?|$)/i.test(s.StreamUrl));
  return mp4 ?? streams.find((s) => !!s.StreamUrl) ?? null;
}

/**
 * Per-source streams in Panopto's own order, which puts the primary stream
 * first. (Sorting by length would not: the screen captures often run a second
 * or two longer than the primary camera feed.)
 */
export function sourceStreams(delivery: Delivery): PanoptoStream[] {
  return (delivery.Streams ?? []).filter((s) => !!s.StreamUrl);
}

/**
 * Caption language ids to try, most likely first. Panopto numbers languages
 * itself (English (UK) is 16 at AU, not 0), so trust the delivery when it says
 * which ones exist and only guess as a fallback.
 */
export function captionLanguages(delivery: Delivery): number[] {
  const listed = (delivery.AvailableCaptions ?? [])
    .map((c) => c.Language)
    .filter((n) => Number.isInteger(n));
  return listed.length > 0 ? listed : delivery.HasCaptions ? [0] : [];
}

function stripHtml(text: string): string {
  return text
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/, "")
    .trim();
}
