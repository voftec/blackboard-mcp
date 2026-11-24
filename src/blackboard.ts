import { chromium, request, type APIRequestContext, type Browser, type BrowserContext, type Page } from "playwright";
import { existsSync, mkdirSync, chmodSync, rmSync, createWriteStream, renameSync, statSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BASE_URL = (process.env.BLACKBOARD_BASE_URL ?? "https://palermo.blackboard.com").replace(/\/$/, "");
const SSO_LOGIN_URL =
  process.env.BLACKBOARD_LOGIN_URL ??
  `${BASE_URL}/auth-saml/saml/login?apId=_2352_1&redirectUrl=${encodeURIComponent(`${BASE_URL}/ultra`)}`;
const STATE_FILE = process.env.BLACKBOARD_STATE_FILE ?? join(homedir(), ".blackboard-mcp", "session.json");
const BROWSER_CHANNEL = process.env.BLACKBOARD_BROWSER_CHANNEL ?? "chrome";
const API = "/learn/api/v1";

export class NotLoggedInError extends Error {
  constructor() {
    super("Not logged in to Blackboard. Run the `login` tool, sign in with MyUP in the browser window, then retry.");
  }
}

interface Paged<T> {
  results: T[];
  paging?: { nextPage?: string };
}

export interface Term {
  id: string;
  name: string;
  startDate?: string;
  endDate?: string;
}

export interface RawCourse {
  id: string;
  courseId: string;
  name: string;
  displayName?: string;
  description?: string;
  isAvailable?: boolean;
  isClosed?: boolean;
  term?: Term;
  ultraStatus?: string;
}

export interface Membership {
  course: RawCourse;
  courseRole?: { identifier?: string; roleBucket?: string };
  enrollmentDate?: string;
  lastAccessDate?: string;
  isAvailable?: boolean;
}

export interface GradeColumn {
  id: string;
  columnName: string;
  courseId?: string;
  dueDate?: string;
  possible?: number;
  contentId?: string;
  scoreProviderHandle?: string;
  gradebookCategory?: { title?: string };
  visible?: boolean;
  multipleAttempts?: number;
  isLateAttemptCreationDisallowed?: boolean;
}

export interface GradeEntry {
  columnId: string;
  status?: string;
  attemptsLeft?: number;
  displayGrade?: { score?: number; scoredByAutomaticZero?: boolean };
  submissionStatus?: { status?: string };
  hasBeenViewedByStudent?: boolean;
  lastAttemptId?: string;
  column?: GradeColumn;
}

export interface TodoItem {
  title: string;
  dueDate: string;
  column?: GradeColumn;
  contentVisibility?: string;
  isLateAttemptCreationDisallowed?: boolean;
}

export interface TodoResponse {
  overdueItems: TodoItem[];
  dueTodayItems: TodoItem[];
  futureDueItems: TodoItem[];
}

export interface FileDetail {
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  permanentUrl?: string;
  viewerUrl?: string;
}

export interface ContentItem {
  id: string;
  parentId?: string;
  courseId?: string;
  title: string;
  contentHandler?: string;
  description?: string;
  body?: { rawText?: string; displayText?: string; webLocation?: string };
  contentDetail?: Record<string, { isBbPage?: boolean; isFolder?: boolean; file?: FileDetail; launchLink?: string; test?: { deploymentSettings?: { attemptCount?: number } } }>;
  visibility?: string;
  position?: number;
  modifiedDate?: string | number;
  /** Progress tracking: "None" = never opened, "Started" = opened, "Completed" = marked as done. */
  state?: string;
  stateCompletion?: { completed?: number; started?: number; total?: number };
  isReviewable?: boolean;
}

export interface Announcement {
  id: string;
  title: string;
  body?: { rawText?: string; displayText?: string };
  createdDate?: string;
  modifiedDate?: string;
  readStatus?: { isRead?: boolean };
}

export interface User {
  id: string;
  userName?: string;
  givenName?: string;
  familyName?: string;
  emailAddress?: string;
  studentId?: string;
}

export interface Message {
  id: string;
  conversationId?: string;
  body?: { rawText?: string; displayText?: string };
  sender?: { id?: string; givenName?: string; familyName?: string; userName?: string };
  isRead?: boolean;
  postDate?: string;
  type?: string;
}

export interface Conversation {
  id: string;
  courseId?: string;
  createdDate?: string;
  updatedDate?: string;
  totalCount?: number;
  unreadCount?: number;
  messages?: Message[];
  participantIds?: string[];
}

export interface StreamEntry {
  providerId: string;
  se_courseId?: string;
  se_timestamp: number;
  extraAttribs?: { event_type?: string; grd_grade?: string };
  itemSpecificData?: {
    title?: string;
    contentDetails?: { contentHandler?: string };
    gradeDetails?: { displayGradeScore?: number; displayGradeGrade?: string };
    notificationDetails?: {
      courseId?: string;
      dueDate?: string;
      startDate?: string;
      sourceType?: string;
      sourceId?: string;
      announcementTitle?: string;
      announcementBody?: string;
      gradebookCategoryName?: string;
      seen?: boolean;
    };
  };
}

export interface StreamResponse {
  sv_streamEntries: StreamEntry[];
  sv_extras?: { sx_courses?: Array<{ id: string; name?: string; courseId?: string }> };
}

type LoginState = { status: "idle" | "pending" | "logged_in" | "failed"; message?: string; startedAt?: string };

export class BlackboardSession {
  private api: APIRequestContext | null = null;
  private loginBrowser: Browser | null = null;
  private loginState: LoginState = { status: existsSync(STATE_FILE) ? "logged_in" : "idle" };
  private userId: string | null = null;

  get stateFile(): string {
    return STATE_FILE;
  }

  get login(): LoginState {
    return this.loginState;
  }

  private async getApi(): Promise<APIRequestContext> {
    if (!this.api) {
      this.api = await request.newContext({
        baseURL: BASE_URL,
        storageState: existsSync(STATE_FILE) ? STATE_FILE : undefined,
      });
    }
    return this.api;
  }

  private async resetApi(): Promise<void> {
    await this.api?.dispose().catch(() => {});
    this.api = null;
    this.userId = null;
  }

  private assertAuthenticated(status: number, contentType: string, path: string): void {
    if (status === 401 || status === 403 || (status >= 300 && status < 400) || (status < 300 && !contentType.includes("json"))) {
      throw new NotLoggedInError();
    }
    if (status >= 400) throw new Error(`Blackboard API ${status} for ${path}`);
  }

  async get<T>(path: string): Promise<T> {
    const api = await this.getApi();
    const res = await api.get(path, { maxRedirects: 0, headers: { Accept: "application/json" } });
    this.assertAuthenticated(res.status(), res.headers()["content-type"] ?? "", path);
    return (await res.json()) as T;
  }

  /** Writes need Blackboard's XSRF token on top of the session cookies. */
  async send<T>(method: "post" | "patch" | "put", path: string, data: unknown): Promise<T> {
    const api = await this.getApi();
    const { xsrfToken } = await this.get<{ xsrfToken: string }>(`${API}/utilities/xsrfToken`);
    const res = await api[method](path, {
      maxRedirects: 0,
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Blackboard-XSRF": xsrfToken },
      data,
    });
    this.assertAuthenticated(res.status(), res.headers()["content-type"] ?? "", path);
    return (await res.json()) as T;
  }

  post<T>(path: string, data: unknown): Promise<T> {
    return this.send<T>("post", path, data);
  }

  async getAll<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let i = 0; next && i < 50; i++) {
      const page: Paged<T> = await this.get<Paged<T>>(next);
      out.push(...(page.results ?? []));
      next = page.paging?.nextPage || undefined;
    }
    return out;
  }

  /** Downloads a file through the authenticated session (bbcswebdav URLs redirect to a signed CDN link). */
  async download(url: string): Promise<{ buffer: Buffer; contentType?: string; fileName?: string }> {
    const api = await this.getApi();
    const res = await api.get(url, { maxRedirects: 10, headers: { Accept: "*/*" } });
    const contentType = res.headers()["content-type"] ?? "";
    if (res.status() === 401 || res.status() === 403 || contentType.includes("text/html")) throw new NotLoggedInError();
    if (!res.ok()) throw new Error(`Download failed with ${res.status()} for ${url}`);
    const disposition = res.headers()["content-disposition"] ?? new URL(res.url()).searchParams.get("response-content-disposition") ?? "";
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
    const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1];
    const fileName = encoded ? decodeURIComponent(encoded) : plain;
    return { buffer: await res.body(), contentType, fileName };
  }

  async saveState(): Promise<void> {
    if (!this.api) return;
    mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
    await this.api.storageState({ path: STATE_FILE });
    chmodSync(STATE_FILE, 0o600);
  }

  /** Opens a visible browser at the MyUP SSO page. Resolves in the background once the user lands on /ultra. */
  async startLogin(timeoutMs: number): Promise<void> {
    if (this.loginState.status === "pending") return;
    await this.cancelLogin();
    this.loginState = { status: "pending", startedAt: new Date().toISOString(), message: "Waiting for you to sign in with MyUP in the browser window." };

    const run = async () => {
      const browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: false });
      this.loginBrowser = browser;
      const context = await browser.newContext({
        storageState: existsSync(STATE_FILE) ? STATE_FILE : undefined,
        viewport: null,
      });
      const page = await context.newPage();
      await page.goto(SSO_LOGIN_URL);
      await page.waitForURL((url) => url.href.startsWith(`${BASE_URL}/ultra`), { timeout: timeoutMs });
      mkdirSync(dirname(STATE_FILE), { recursive: true, mode: 0o700 });
      await context.storageState({ path: STATE_FILE });
      chmodSync(STATE_FILE, 0o600);
      await browser.close();
      this.loginBrowser = null;
      await this.resetApi();
      const me = await this.whoami();
      this.loginState = { status: "logged_in", message: `Signed in as ${[me.givenName, me.familyName].filter(Boolean).join(" ")}` };
    };

    run().catch(async (err) => {
      this.loginState = { status: "failed", message: err instanceof Error ? err.message : String(err) };
      await this.cancelLogin();
    });
  }

  async cancelLogin(): Promise<void> {
    await this.loginBrowser?.close().catch(() => {});
    this.loginBrowser = null;
  }

  async logout(): Promise<void> {
    await this.cancelLogin();
    await this.resetApi();
    rmSync(STATE_FILE, { force: true });
    this.loginState = { status: "idle" };
  }

  async whoami(): Promise<User> {
    const me = await this.get<User>(`${API}/users/me`);
    this.userId = me.id;
    return me;
  }

  async getUserId(): Promise<string> {
    return this.userId ?? (await this.whoami()).id;
  }

  async memberships(): Promise<Membership[]> {
    const uid = await this.getUserId();
    return this.getAll<Membership>(
      `${API}/users/${uid}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole&includeCount=true&limit=10000`
    );
  }

  async course(courseId: string): Promise<RawCourse> {
    return this.get<RawCourse>(`${API}/courses/${encodeURIComponent(courseId)}`);
  }

  async instructors(courseId: string): Promise<Array<{ name: string; role?: string }>> {
    const rows = await this.getAll<{ user?: { givenName?: string; familyName?: string }; courseRole?: { identifier?: string } }>(
      `${API}/courses/${encodeURIComponent(courseId)}/memberships?expand=user,courseRole&limit=50&roleBucket=TEACHING&membershipAvailable=true`
    );
    return rows.map((r) => ({ name: [r.user?.givenName, r.user?.familyName].filter(Boolean).join(" "), role: r.courseRole?.identifier }));
  }

  async grades(courseId: string): Promise<GradeEntry[]> {
    const uid = await this.getUserId();
    const expand = "lastAttempt,attemptsLeft,submissionStatus,hasAttemptOrGradeFeedback,column,column.restricted,canStudentViewGradeResults,column.isLateAttemptCreationDisallowed";
    return this.getAll<GradeEntry>(
      `${API}/courses/${encodeURIComponent(courseId)}/gradebook/grades?userId=${uid}&limit=100&offset=0&sort=column.position(asc)&expand=${expand}&includeNoGradeItems=true&skipExternalGrade=true&skipKnowledgeCheck=true`
    );
  }

  /** Blackboard rejects windows wider than ~16 days. */
  async todo(since: Date, until: Date): Promise<TodoResponse> {
    return this.get<TodoResponse>(
      `${API}/calendars/todo/studentItems?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}`
    );
  }

  async content(courseId: string, contentId: string): Promise<ContentItem> {
    return this.get<ContentItem>(`${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}`);
  }

  async contentChildren(courseId: string, parentId = "ROOT"): Promise<ContentItem[]> {
    return this.getAll<ContentItem>(
      `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(parentId)}/children?@view=Summary&expand=gradebookCategory&limit=100`
    );
  }

  /** Progress-tracking state of one item for the current user: "Started" | "Completed" | undefined (never opened). */
  async contentState(courseId: string, contentId: string): Promise<string | undefined> {
    const res = await this.get<Paged<{ contentId: string; state: string }>>(
      `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/states/me`
    );
    return res.results?.[0]?.state;
  }

  /** Same call the "Marcar como completado" checkbox makes. */
  async setContentState(courseId: string, contentId: string, state: "Started" | "Completed"): Promise<{ contentId: string; state: string }> {
    return this.send("patch", `${API}/courses/${encodeURIComponent(courseId)}/contents/${encodeURIComponent(contentId)}/states/me`, { state });
  }

  async conversations(courseId: string): Promise<Conversation[]> {
    return this.getAll<Conversation>(`${API}/courses/${encodeURIComponent(courseId)}/conversations?limit=25&offset=0`);
  }

  async conversationMessages(courseId: string, conversationId: string): Promise<Message[]> {
    return this.getAll<Message>(
      `${API}/courses/${encodeURIComponent(courseId)}/conversations/${encodeURIComponent(conversationId)}/messages?limit=25&offset=0`
    );
  }

  /** Posts a reply inside an existing conversation. */
  async postConversationMessage(courseId: string, conversationId: string, rawText: string): Promise<Message> {
    return this.post<Message>(
      `${API}/courses/${encodeURIComponent(courseId)}/conversations/${encodeURIComponent(conversationId)}/messages`,
      { body: { rawText } }
    );
  }

  /** Creates a new conversation with one or more recipients and a first message. */
  async createConversation(courseId: string, participantIds: string[], rawText: string): Promise<Conversation> {
    return this.post<Conversation>(`${API}/courses/${encodeURIComponent(courseId)}/conversations`, {
      participantIds,
      messages: [{ body: { rawText } }],
    });
  }

  async courseMembers(courseId: string): Promise<Array<{ id: string; name: string; userName?: string; role?: string }>> {
    const rows = await this.getAll<{ user?: { id?: string; givenName?: string; familyName?: string; userName?: string }; courseRole?: { identifier?: string } }>(
      `${API}/courses/${encodeURIComponent(courseId)}/memberships?expand=user,courseRole&limit=200&membershipAvailable=true`
    );
    return rows
      .filter((r) => r.user?.id)
      .map((r) => ({ id: r.user!.id!, name: [r.user?.givenName, r.user?.familyName].filter(Boolean).join(" "), userName: r.user?.userName, role: r.courseRole?.identifier }));
  }

  async calendarItems(since: Date, until: Date): Promise<Array<Record<string, unknown>>> {
    return this.getAll<Record<string, unknown>>(
      `${API}/calendars/calendarItems?since=${encodeURIComponent(since.toISOString())}&until=${encodeURIComponent(until.toISOString())}&limit=200`
    );
  }

  /** Finds the Zoom LTI launch link in a course ("Zoom - Clases sincrónicas" or any BLTI tool whose title/URL mentions zoom). */
  async findZoomLaunchUrl(courseId: string): Promise<{ contentId: string; title: string; launchUrl: string } | undefined> {
    const items = await this.getAll<ContentItem>(
      `${API}/courses/${encodeURIComponent(courseId)}/contents?@view=Summary&expand=gradebookCategory&limit=200`
    );
    const candidates: ContentItem[] = [...items];
    // One level of folders is enough for the standard "Clases sincrónicas (videoconferencias)" layout.
    for (const item of items) {
      const handler = item.contentHandler ?? "";
      if (handler === "resource/x-bb-folder" || handler === "resource/x-bb-lesson") {
        candidates.push(...(await this.contentChildren(courseId, item.id)));
      }
    }
    for (const item of candidates) {
      const handler = item.contentHandler ?? "";
      const detail = item.contentDetail?.[handler];
      const launchLink: string | undefined = detail?.launchLink;
      const isZoomTool =
        (handler.startsWith("resource/x-bb-bltiplacement-") || handler === "resource/x-bb-blti-link") &&
        (/zoom/i.test(item.title ?? "") || /zoom/i.test(launchLink ?? "") || /zoom/i.test(item.description ?? ""));
      if (isZoomTool && launchLink) {
        return { contentId: item.id, title: item.title ?? "Zoom", launchUrl: `${BASE_URL}${launchLink}` };
      }
    }
    return undefined;
  }

  /** Opens the course's Zoom LTI in a headless browser and returns the Cloud Recordings list. */
  async zoomRecordings(launchUrl: string): Promise<Array<{ topic: string; meetingId?: string; startTime?: string; detailUrl?: string }>> {
    const { page, browser } = await this.zoomRecordingsPage(launchUrl);
    try {
      const rows = await page.$$eval("table tbody tr, tr[class*='record'], [class*='recording'] tr", (trs) =>
        trs
          .map((tr) => {
            const cells = Array.from(tr.querySelectorAll("td")).map((td) => (td as any).innerText.trim());
            const a = tr.querySelector("a[href]") as any;
            if (!cells.length && !a) return null;
            return { topic: cells[0] ?? a?.innerText?.trim() ?? "", meetingId: cells[1], startTime: cells[2], detailUrl: a?.href };
          })
          .filter(Boolean)
      );
      return rows as Array<{ topic: string; meetingId?: string; startTime?: string; detailUrl?: string }>;
    } finally {
      await browser.close();
    }
  }

  /**
   * Downloads the course's Zoom Cloud Recordings into `destDir`, one at a time.
   *
   * The Zoom LTI does not expose a download button when the host disabled downloads, so each recording is
   * resolved through the LTI's own JSON API: the list response gives the recordings, opening a recording's detail
   * view gives its files and their `playUrl`, and the player page requests a signed media URL that is fetched
   * with the session cookies. No element handle is kept across navigations: the list is reloaded and every
   * element is re-located for each recording.
   */
  async downloadZoomRecordings(
    launchUrl: string,
    destDir: string,
    opts: { filter?: ZoomRecordingFilter; fileType?: ZoomFileType } = {}
  ): Promise<ZoomDownloadResult[]> {
    const fileType = opts.fileType ?? "mp4";
    const { page, context, browser } = await this.zoomRecordingsPage(launchUrl, { requireList: true });
    const results: ZoomDownloadResult[] = [];
    try {
      const all = this.lastZoomList ?? [];
      const selected = all.map((rec, index) => ({ rec, index })).filter(({ rec }) => matchesZoomFilter(rec, opts.filter));
      if (selected.length) mkdirSync(destDir, { recursive: true });
      for (let n = 0; n < selected.length; n++) {
        const { rec, index } = selected[n];
        const base = zoomResultBase(rec);
        try {
          // The first recording uses the list already open; every later one starts from a fresh list.
          if (n > 0) await this.openZoomRecordingList(page, launchUrl);
          const files = await this.openZoomRecordingDetail(page, rec, index);
          const wanted = files.find((f) => f.fileType?.toUpperCase() === fileType.toUpperCase() && f.playUrl);
          if (!wanted) {
            results.push({ ...base, skipped: `no playable ${fileType} file for this recording` });
            continue;
          }
          const name = `${base.date ?? "recording"} ${rec.topic ?? rec.meetingNumber ?? index}`.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 140);
          const file = join(destDir, `${name}.${fileType}`);
          if (existsSync(file) && wanted.fileSize && statSync(file).size === wanted.fileSize) {
            results.push({ ...base, file, bytes: wanted.fileSize, skipped: "already downloaded" });
            continue;
          }
          const mediaUrl = await this.resolveZoomMediaUrl(context, wanted.playUrl!, fileType);
          const bytes = await this.streamWithCookies(context, mediaUrl, file);
          results.push({ ...base, file, bytes });
        } catch (e) {
          results.push({ ...base, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return results;
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  /** The recordings list from the last Cloud Recordings page load (the LTI's own JSON response). */
  private lastZoomList: ZoomApiRecording[] | undefined;

  /** Launches the Zoom LTI inside the saved session and lands on the Cloud Recordings tab. */
  private async zoomRecordingsPage(launchUrl: string, opts: { requireList?: boolean } = {}) {
    if (!existsSync(STATE_FILE)) throw new NotLoggedInError();
    const browser = await chromium.launch({ channel: BROWSER_CHANNEL, headless: true });
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    try {
      await this.openZoomRecordingList(page, launchUrl, opts.requireList ?? false);
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
    return { page, context, browser };
  }

  /** (Re)launches the LTI on `page`, opens Cloud Recordings and waits until the list has loaded. */
  private async openZoomRecordingList(page: Page, launchUrl: string, requireList = true): Promise<void> {
    const listResponse = page
      .waitForResponse((r) => /\/lti\/rich\/recording\/COURSE\?/.test(r.url()) && r.ok(), { timeout: 90000 })
      .catch(() => null);
    await page.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    // LTI redirects through applications.zoom.us; give it time, then click the Cloud Recordings tab.
    await page.waitForURL(/zoom\.us|zoom\.com/, { timeout: 60000 }).catch(() => {});
    const tab = page.locator("text=/cloud recordings/i").first();
    await tab.waitFor({ timeout: 30000 }).catch(() => {});
    await tab.click().catch(() => {});
    const resp = await listResponse;
    const body = resp ? await resp.json().catch(() => null) : null;
    this.lastZoomList = body?.result?.list;
    if (requireList && !Array.isArray(this.lastZoomList)) throw new Error("Zoom Cloud Recordings list did not load.");
    // Let the table render the rows the response describes.
    await page.locator("table tbody tr").first().waitFor({ timeout: 15000 }).catch(() => {});
  }

  /** Opens a recording's detail view from the list and returns its files (from the LTI's JSON response). */
  private async openZoomRecordingDetail(page: Page, rec: ZoomApiRecording, index: number): Promise<ZoomApiFile[]> {
    // Rows are keyed by their position in the list response; check the topic too in case the table re-sorted.
    let row = page.locator(`table tbody tr[data-row-key="${index}"]`);
    if (rec.topic && !(await row.filter({ hasText: rec.topic }).count())) {
      row = page.locator("table tbody tr", { hasText: rec.topic }).first();
    }
    const fileResponse = page.waitForResponse((r) => /\/lti\/rich\/recording\/file\?/.test(r.url()) && r.ok(), { timeout: 60000 });
    await row.locator("[role=button], a").first().click({ timeout: 30000 });
    const body = await (await fileResponse).json();
    return (body?.result?.recordingFiles ?? []) as ZoomApiFile[];
  }

  /** Opens the Zoom web player for `playUrl` and returns the signed media URL it streams. */
  private async resolveZoomMediaUrl(context: BrowserContext, playUrl: string, fileType: ZoomFileType): Promise<string> {
    const player = await context.newPage();
    try {
      const media = player.waitForRequest((r) => /ssrweb\.zoom\.us\//.test(r.url()) && new RegExp(`\\.${fileType}(\\?|$)`, "i").test(r.url()), {
        timeout: 60000,
      });
      await player.goto(playUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      return (await media).url();
    } finally {
      await player.close().catch(() => {});
    }
  }

  /** Streams `url` to `file` using the browser context's cookies; writes to a temp file and renames on success. */
  private async streamWithCookies(context: BrowserContext, url: string, file: string): Promise<number> {
    const cookie = (await context.cookies(url)).map((c) => `${c.name}=${c.value}`).join("; ");
    const res = await fetch(url, { headers: { Cookie: cookie, Referer: "https://zoom.us/" } });
    if (!res.ok || !res.body) throw new Error(`Media download failed: HTTP ${res.status}`);
    const tmp = `${file}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
      renameSync(tmp, file);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    return statSync(file).size;
  }

  async announcements(courseId: string, limit = 25): Promise<Announcement[]> {
    const page = await this.get<Paged<Announcement>>(`${API}/courses/${encodeURIComponent(courseId)}/announcements?limit=${limit}`);
    return page.results ?? [];
  }

  async stream(): Promise<StreamResponse> {
    const body = { providers: {}, forOverview: false, retrieveOnly: false, flushCache: false };
    let res = await this.post<StreamResponse>(`${API}/streams/ultra`, body);
    if (!res.sv_streamEntries?.length) {
      await new Promise((r) => setTimeout(r, 1500));
      res = await this.post<StreamResponse>(`${API}/streams/ultra`, { ...body, retrieveOnly: true });
    }
    return res;
  }

  async dispose(): Promise<void> {
    await this.cancelLogin();
    await this.resetApi();
  }
}

export type ZoomFileType = "mp4" | "m4a";

/** Narrows `download_zoom_recordings` to some recordings. Every field given must match. */
export interface ZoomRecordingFilter {
  /** Zoom meeting ID; spaces and dashes are ignored ("813 0790 0208" = "81307900208"). */
  meetingId?: string;
  /** Case-insensitive substring of the recording topic. */
  topic?: string;
  /** Local start date of the recording, YYYY-MM-DD. */
  date?: string;
}

export interface ZoomDownloadResult {
  topic?: string;
  meetingId?: string;
  date?: string;
  startTime?: string;
  file?: string;
  bytes?: number;
  skipped?: string;
  error?: string;
}

/** One entry of the Zoom LTI `recording/COURSE` JSON list. */
interface ZoomApiRecording {
  meetingId: string;
  meetingNumber?: string;
  topic?: string;
  /** UTC, "YYYY-MM-DD HH:mm:ss". */
  startTime?: string;
  listStartTime?: string;
  timezone?: string;
}

/** One entry of the Zoom LTI `recording/file` JSON `recordingFiles`. */
interface ZoomApiFile {
  fileType?: string;
  fileSize?: number;
  playUrl?: string;
}

/** Local start date (YYYY-MM-DD) of a recording, in its own timezone. */
export function zoomLocalDate(rec: { startTime?: string; timezone?: string }): string | undefined {
  if (!rec.startTime) return undefined;
  const utc = new Date(`${rec.startTime.replace(" ", "T")}Z`);
  if (Number.isNaN(utc.getTime())) return rec.startTime.slice(0, 10);
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: rec.timezone || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(utc);
  } catch {
    return utc.toISOString().slice(0, 10);
  }
}

export function matchesZoomFilter(rec: { meetingNumber?: string; topic?: string; startTime?: string; timezone?: string }, filter?: ZoomRecordingFilter): boolean {
  if (!filter) return true;
  if (filter.meetingId && (rec.meetingNumber ?? "").replace(/\D/g, "") !== filter.meetingId.replace(/\D/g, "")) return false;
  if (filter.topic && !(rec.topic ?? "").toLowerCase().includes(filter.topic.toLowerCase())) return false;
  if (filter.date && zoomLocalDate(rec) !== filter.date) return false;
  return true;
}

function zoomResultBase(rec: ZoomApiRecording): ZoomDownloadResult {
  const n = (rec.meetingNumber ?? "").replace(/\D/g, "");
  const meetingId = n.length === 11 ? `${n.slice(0, 3)} ${n.slice(3, 7)} ${n.slice(7)}` : rec.meetingNumber;
  return { topic: rec.topic, meetingId, date: zoomLocalDate(rec), startTime: rec.listStartTime ?? rec.startTime };
}
