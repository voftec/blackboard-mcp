import { chromium, request, type APIRequestContext, type Browser } from "playwright";
import { existsSync, mkdirSync, chmodSync, rmSync } from "node:fs";
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
