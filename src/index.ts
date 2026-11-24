import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BASE_URL, BlackboardSession, NotLoggedInError, type Announcement, type ContentItem } from "./blackboard.js";
import { fileToText } from "./files.js";
import { ledgerFile, loadLedger, noteSeen, saveLedger } from "./ledger.js";
import {
  attachAvailability,
  extractLinks,
  flattenContent,
  htmlToText,
  listCourses,
  markTemplate,
  safeFileName,
  semesterLabel,
  sharedTopLevelTitles,
  toContentNode,
  toHomework,
  toMessages,
  toStreamEvents,
  toTodoHomework,
  walkContent,
  type ContentNode,
  type CourseMessage,
  type CourseRef,
  type Homework,
  type StreamEvent,
} from "./model.js";

const DOWNLOAD_DIR = process.env.BLACKBOARD_DOWNLOAD_DIR ?? join(homedir(), "Downloads", "Blackboard");
const bb = new BlackboardSession();

const server = new McpServer({ name: "blackboard-mcp", version: "2.0.0" });

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Wraps a tool so auth failures come back as actionable errors and refreshed cookies get persisted. */
function tool<T>(fn: (args: T) => Promise<unknown>): (args: T) => Promise<ToolResult> {
  return async (args) => {
    try {
      const result = await fn(args);
      await bb.saveState().catch(() => {});
      return json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = err instanceof NotLoggedInError ? { login: bb.login } : {};
      return { ...json({ error: message, ...hint }), isError: true };
    }
  };
}

async function courseRefs(now: Date): Promise<Map<string, CourseRef>> {
  return new Map((await listCourses(bb, now, false)).map((c) => [c.id, { id: c.id, name: c.name, termStart: c.termStart }]));
}

async function courseRef(now: Date, courseId: string): Promise<CourseRef> {
  return (await courseRefs(now)).get(courseId) ?? { id: courseId };
}

/** The courses a request applies to: one explicit course, or every course of the running semester. */
async function targetCourses(now: Date, courseId?: string): Promise<CourseRef[]> {
  if (courseId) return [await courseRef(now, courseId)];
  return (await listCourses(bb, now, true)).map((c) => ({ id: c.id, name: c.name, termStart: c.termStart }));
}

function toAnnouncements(items: Announcement[]) {
  return items
    .map((a) => ({ id: a.id, title: a.title, created: a.createdDate, modified: a.modifiedDate, read: a.readStatus?.isRead, text: htmlToText(a.body?.displayText ?? a.body?.rawText, 3000) }))
    .sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
}

server.registerTool(
  "login",
  {
    title: "Log in to Blackboard",
    description:
      "Opens a visible Chrome window on the institution's single sign-on page (SAML). The user types their own credentials there; the tool never sees them. Returns immediately - poll `session_status` until status is `logged_in`. Pass force=true to re-login even if a session exists.",
    inputSchema: { force: z.boolean().optional().describe("Open the browser even if the saved session still works."), timeoutMinutes: z.number().min(1).max(30).optional() },
  },
  tool(async ({ force, timeoutMinutes }) => {
    if (!force) {
      try {
        const me = await bb.whoami();
        return { status: "logged_in", user: `${me.givenName ?? ""} ${me.familyName ?? ""}`.trim(), message: "Existing session is still valid; no browser opened." };
      } catch (err) {
        if (!(err instanceof NotLoggedInError)) throw err;
      }
    }
    await bb.startLogin((timeoutMinutes ?? 5) * 60_000);
    return {
      status: bb.login.status,
      message: "A Chrome window opened on the MyUP login page. Ask the user to sign in there (username + password + any 2FA). Then call `session_status`; when it reports `logged_in`, the other tools will work.",
    };
  })
);

server.registerTool(
  "session_status",
  { title: "Session status", description: "Reports whether the Blackboard session is valid, whether a login is pending, and who is signed in.", inputSchema: {} },
  tool(async () => {
    try {
      const me = await bb.whoami();
      return { loggedIn: true, login: bb.login, user: { id: me.id, name: `${me.givenName ?? ""} ${me.familyName ?? ""}`.trim(), userName: me.userName, email: me.emailAddress, studentId: me.studentId }, baseUrl: BASE_URL, stateFile: bb.stateFile };
    } catch (err) {
      if (!(err instanceof NotLoggedInError)) throw err;
      return { loggedIn: false, login: bb.login, baseUrl: BASE_URL, hint: bb.login.status === "pending" ? "Login window is open - waiting for the user to sign in." : "Run the `login` tool." };
    }
  })
);

server.registerTool(
  "logout",
  { title: "Log out", description: "Deletes the saved Blackboard session from disk and closes any login window.", inputSchema: {} },
  tool(async () => {
    await bb.logout();
    return { status: "logged_out" };
  })
);

server.registerTool(
  "find_courses",
  {
    title: "Find courses",
    description:
      "Lists the signed-in user's Blackboard courses. By default only the courses whose academic term (semester) contains today's date are returned - e.g. '2026 Segundo Semestre'. Set currentOnly=false to see past courses too.",
    inputSchema: { currentOnly: z.boolean().optional().describe("Default true: only courses from the semester that is running right now.") },
  },
  tool(async ({ currentOnly }) => {
    const now = new Date();
    const courses = await listCourses(bb, now, currentOnly ?? true);
    return { today: now.toISOString(), expectedSemester: semesterLabel(now), count: courses.length, courses };
  })
);

server.registerTool(
  "get_course",
  {
    title: "Get course",
    description: "Course details plus instructors and a homework summary (open / overdue / submitted / graded counts).",
    inputSchema: { courseId: z.string().describe("Blackboard course id such as _95767_1") },
  },
  tool(async ({ courseId }) => {
    const now = new Date();
    const [course, instructors, grades, courses] = await Promise.all([bb.course(courseId), bb.instructors(courseId), bb.grades(courseId), listCourses(bb, now, false)]);
    const meta = courses.find((c) => c.id === courseId);
    const homework = grades.map((g) => toHomework(g, { id: courseId, name: meta?.name, termStart: meta?.termStart }, now));
    const summary = homework.reduce<Record<string, number>>((acc, h) => ({ ...acc, [h.state]: (acc[h.state] ?? 0) + 1 }), {});
    return {
      id: course.id,
      code: course.courseId,
      name: course.displayName ?? course.name,
      description: htmlToText(course.description, 1000),
      semester: course.term?.name,
      termStart: course.term?.startDate,
      termEnd: course.term?.endDate,
      isCurrent: meta?.isCurrent,
      instructors,
      homeworkSummary: summary,
      urls: { outline: `${BASE_URL}/ultra/courses/${courseId}/outline`, grades: `${BASE_URL}/ultra/courses/${courseId}/grades`, announcements: `${BASE_URL}/ultra/courses/${courseId}/announcements` },
    };
  })
);

const stateFilter = z.enum(["open", "overdue", "submitted", "graded", "pending", "all"]).optional();
function filterByState(items: Homework[], state?: z.infer<typeof stateFilter>): Homework[] {
  if (!state || state === "all") return items;
  if (state === "pending") return items.filter((h) => h.state === "open" || h.state === "overdue");
  return items.filter((h) => h.state === state);
}
function byDueDate(a: Homework, b: Homework): number {
  return (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
}

server.registerTool(
  "find_homework",
  {
    title: "Find homework in a course",
    description:
      "All gradable work in one course (tests, prácticas, autoevaluaciones, foros) with due date, points, attempts left and a computed state: open, overdue, submitted or graded. Use state='pending' for open+overdue.",
    inputSchema: { courseId: z.string(), state: stateFilter.describe("Filter by state. Default all.") },
  },
  tool(async ({ courseId, state }) => {
    const now = new Date();
    const [grades, course] = await Promise.all([bb.grades(courseId), courseRef(now, courseId)]);
    const homework = filterByState(grades.map((g) => toHomework(g, course, now)), state).sort(byDueDate);
    return { courseId, courseName: course.name, count: homework.length, homework };
  })
);

server.registerTool(
  "get_upcoming_homework",
  {
    title: "Upcoming homework",
    description:
      "Homework across all current-semester courses (or one course) that still needs action: items due within the next N days, overdue items not yet submitted, and open items with no due date. Sorted by due date.",
    inputSchema: { days: z.number().min(1).max(365).optional().describe("Look-ahead window in days. Default 14."), courseId: z.string().optional() },
  },
  tool(async ({ days, courseId }) => {
    const now = new Date();
    const horizon = new Date(now.getTime() + (days ?? 14) * 86_400_000);
    const courses = await targetCourses(now, courseId);
    const perCourse = await Promise.all(courses.map(async (c) => (await bb.grades(c.id)).map((g) => toHomework(g, c, now))));
    const all = perCourse.flat();
    const dueSoon = all.filter((h) => h.state === "open" && h.dueDate && new Date(h.dueDate) <= horizon).sort(byDueDate);
    const overdue = all.filter((h) => h.state === "overdue").sort(byDueDate);
    const openNoDueDate = all.filter((h) => h.state === "open" && !h.dueDate);
    const later = all.filter((h) => h.state === "open" && h.dueDate && new Date(h.dueDate) > horizon).sort(byDueDate);
    return { today: now.toISOString(), windowDays: days ?? 14, courses: courses.map((c) => c.name), dueSoon, overdue, openNoDueDate, later };
  })
);

server.registerTool(
  "get_todo",
  {
    title: "Blackboard to-do (overdue / today / next 2 weeks)",
    description: "Blackboard's own due-date feed for the student: overdue items, items due today and items due in the next ~15 days (server-side limit).",
    inputSchema: {},
  },
  tool(async () => {
    const now = new Date();
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    const until = new Date(since.getTime() + 15 * 86_400_000 - 1);
    const [todo, refs] = await Promise.all([bb.todo(since, until), courseRefs(now)]);
    const names = new Map([...refs].map(([id, c]) => [id, c.name ?? id]));
    const map = (items: typeof todo.overdueItems) => items.map((i) => toTodoHomework(i, names));
    return { since: since.toISOString(), until: until.toISOString(), overdue: map(todo.overdueItems ?? []), dueToday: map(todo.dueTodayItems ?? []), upcoming: map(todo.futureDueItems ?? []) };
  })
);

server.registerTool(
  "get_course_content",
  {
    title: "Browse course content",
    description:
      "The course outline (what you see at /ultra/courses/{id}/outline): folders, learning modules, documents (with their text), files (with download URLs), assessments and tools. Start at ROOT and go deeper with parentId or a larger depth.",
    inputSchema: {
      courseId: z.string(),
      parentId: z.string().optional().describe("Folder/module id to list. Default ROOT."),
      depth: z.number().min(0).max(6).optional().describe("How many nested folder levels to expand. Default 1."),
    },
  },
  tool(async ({ courseId, parentId, depth }) => {
    const items = await walkContent(bb, courseId, parentId ?? "ROOT", depth ?? 1);
    return { courseId, parentId: parentId ?? "ROOT", count: items.length, items };
  })
);

/** Every non-container item of the given courses, flattened, newest first, with template + availability annotations. */
async function scanContent(courses: CourseRef[], events?: StreamEvent[]): Promise<ContentNode[]> {
  const [trees, shared] = await Promise.all([
    Promise.all(courses.map((c) => walkContent(bb, c.id, "ROOT", 6))),
    sharedTopLevelTitles(bb, (await listCourses(bb, new Date(), true)).map((c) => c.id)),
  ]);
  trees.forEach((tree) => markTemplate(tree, shared));
  if (events) trees.forEach((tree) => attachAvailability(tree, events));
  const names = new Map(courses.map((c) => [c.id, c.name]));
  return flattenContent(trees.flat())
    .filter((n) => !["folder", "learning_module"].includes(n.type))
    .sort((a, b) => (b.modifiedDate ?? "").localeCompare(a.modifiedDate ?? ""))
    .map((n) => ({ courseName: names.get(n.courseId), ...n }));
}

server.registerTool(
  "get_recent_content",
  {
    title: "Recently added content",
    description:
      "What the professors added or changed recently across the current-semester courses (or one course), newest first: files, documents, videos, assessments. Each item says whether the user has opened it (`progress`), when it became available (`availableSince`) and whether it is institutional template material shared by all courses (`template`). unopenedOnly=true answers 'what haven't I looked at yet'.",
    inputSchema: {
      courseId: z.string().optional(),
      days: z.number().min(1).max(365).optional().describe("Only items modified within the last N days. Default 14 (use 365 with unopenedOnly for everything pending)."),
      limit: z.number().min(1).max(200).optional().describe("Max items. Default 40."),
      unopenedOnly: z.boolean().optional().describe("Only items the user has never opened in Blackboard."),
      includeTemplate: z.boolean().optional().describe("Include institutional template folders (Zoom instructions, library info...). Default false."),
    },
  },
  tool(async ({ courseId, days, limit, unopenedOnly, includeTemplate }) => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - (days ?? 14) * 86_400_000).toISOString();
    const courses = await targetCourses(now, courseId);
    const events = toStreamEvents(await bb.stream().catch(() => ({ sv_streamEntries: [] })));
    const ledger = loadLedger();
    const recent = (await scanContent(courses, events))
      .filter((n) => (n.modifiedDate ?? "") >= cutoff && (includeTemplate || !n.template))
      .map((n) => ({ ...n, newToYou: !ledger.seen[n.id] }));
    const items = recent.filter((n) => !unopenedOnly || n.progress === "unopened").slice(0, limit ?? 40);
    return {
      since: cutoff,
      lastBriefingAt: ledger.lastBriefingAt,
      courses: courses.map((c) => c.name),
      totalRecent: recent.length,
      unopenedRecent: recent.filter((n) => n.progress === "unopened").length,
      neverReported: recent.filter((n) => n.newToYou).length,
      count: items.length,
      items,
    };
  })
);

const markOpenedInput = z.boolean().optional().describe("Also tell Blackboard that the user opened this item (progress tracking -> 'Iniciado'). Default false.");

async function markOpened(courseId: string, contentIds: string[]): Promise<Array<{ contentId: string; state: string }>> {
  return Promise.all(contentIds.map((id) => bb.setContentState(courseId, id, "Started").catch((err) => ({ contentId: id, state: `error: ${err instanceof Error ? err.message : String(err)}` }))));
}

server.registerTool(
  "mark_content",
  {
    title: "Mark content as opened / completed",
    description:
      "Updates Blackboard's progress tracking for content items - the same thing as opening an item or ticking 'Marcar como completado'. Use it after the user reviews material through the agent so the 'unopened' list stays truthful. state: opened (Iniciado) or completed (Completado).",
    inputSchema: {
      courseId: z.string(),
      contentIds: z.array(z.string()).min(1),
      state: z.enum(["opened", "completed"]),
    },
  },
  tool(async ({ courseId, contentIds, state }) => {
    const target = state === "completed" ? "Completed" : "Started";
    const results = await Promise.all(contentIds.map((id) => bb.setContentState(courseId, id, target)));
    return { courseId, updated: results };
  })
);

server.registerTool(
  "read_content",
  {
    title: "Read a content item",
    description: "Full detail of one content item: the document text (HTML stripped), embedded links/videos, attached files with download URLs, and direct children for folders/modules. To read the inside of an attached PDF/DOCX/PPTX use read_file_text.",
    inputSchema: { courseId: z.string(), contentId: z.string(), markAsOpened: markOpenedInput },
  },
  tool(async ({ courseId, contentId, markAsOpened }) => {
    if (markAsOpened) await markOpened(courseId, [contentId]);
    const item = await bb.content(courseId, contentId);
    const node = toContentNode(item, courseId, "");
    let html = item.body?.displayText;
    if (["folder", "learning_module", "document"].includes(node.type)) {
      const children = await walkContent(bb, courseId, contentId, 1);
      const body = children.find((c) => c.type === "text" && c.title === "ultraDocumentBody");
      if (body) html = (await bb.contentChildren(courseId, contentId)).find((c) => c.id === body.id)?.body?.displayText ?? html;
      node.children = children.filter((c) => c !== body);
    }
    node.text = htmlToText(html, 8000);
    node.links = extractLinks(html);
    return node;
  })
);

// ---------- files ----------

type FileTarget = { url: string; fileName?: string; title?: string; contentId?: string; mimeType?: string };
const fileOf = (i: ContentItem) => i.contentDetail?.[i.contentHandler ?? ""]?.file;
const isBlackboardFile = (url: string) => url.startsWith(`${BASE_URL}/bbcswebdav/`);

function fileTargetsOf(item: ContentItem): FileTarget[] {
  const f = fileOf(item);
  if (f?.permanentUrl) return [{ url: `${BASE_URL}${f.permanentUrl}`, fileName: f.fileName, title: item.title, contentId: item.id, mimeType: f.mimeType }];
  return (extractLinks(item.body?.displayText) ?? [])
    .filter((l) => isBlackboardFile(l.url))
    .map((l) => ({ url: l.url, fileName: l.text, title: item.title, contentId: item.id, mimeType: l.mimeType }));
}

/** Resolves content ids (files, or folders/documents containing files + embedded media) and raw URLs into download targets. */
async function resolveTargets(args: { courseId?: string; contentIds: string[]; urls: string[]; fileName?: string }): Promise<FileTarget[]> {
  const targets: FileTarget[] = args.urls.map((url) => ({ url, fileName: args.urls.length === 1 ? args.fileName : undefined }));
  if (args.contentIds.length && !args.courseId) throw new Error("`courseId` is required together with contentId(s).");
  for (const id of args.contentIds) {
    const item = await bb.content(args.courseId!, id);
    targets.push(...fileTargetsOf(item));
    if (!fileOf(item)) for (const child of await bb.contentChildren(args.courseId!, id)) targets.push(...fileTargetsOf(child));
  }
  if (!targets.length) throw new Error("Provide `url`/`urls`, or `courseId` + `contentId`/`contentIds`.");
  return [...new Map(targets.map((t) => [t.url, t])).values()];
}

async function downloadDir(courseId: string | undefined, destDir?: string): Promise<string> {
  const dir = destDir ?? join(DOWNLOAD_DIR, courseId ? safeFileName((await bb.course(courseId)).courseId ?? courseId) : "misc");
  mkdirSync(dir, { recursive: true });
  return dir;
}

type Saved = { contentId?: string; title?: string; path: string; fileName: string; bytes: number; mimeType?: string; skipped?: boolean };

/** Downloads one target into `dir`, reusing an existing file unless `overwrite`. Always returns the bytes. */
async function saveTarget(t: FileTarget, dir: string, overwrite?: boolean): Promise<Saved & { buffer: Buffer }> {
  let name = t.fileName ? safeFileName(t.fileName) : undefined;
  if (name && existsSync(join(dir, name)) && !overwrite) {
    const buffer = readFileSync(join(dir, name));
    return { contentId: t.contentId, title: t.title, path: join(dir, name), fileName: name, bytes: buffer.length, mimeType: t.mimeType, skipped: true, buffer };
  }
  const { buffer, contentType, fileName: served } = await bb.download(t.url);
  name ??= safeFileName(served ?? decodeURIComponent(new URL(t.url).pathname.split("/").pop() ?? "") ?? t.contentId ?? "file");
  const path = join(dir, name);
  const skipped = existsSync(path) && !overwrite;
  if (!skipped) writeFileSync(path, buffer);
  return { contentId: t.contentId, title: t.title, path, fileName: name, bytes: buffer.length, mimeType: t.mimeType ?? contentType, skipped: skipped || undefined, buffer };
}

const fileInputs = {
  courseId: z.string().optional(),
  contentId: z.string().optional().describe("A file item, or a folder/document (takes every attached file and embedded video/image inside it)."),
  contentIds: z.array(z.string()).optional().describe("Several content ids from the same course."),
  url: z.string().url().optional().describe("Direct Blackboard file URL (bbcswebdav) from another tool's output."),
  urls: z.array(z.string().url()).optional(),
  fileName: z.string().optional().describe("File name to save as when passing a single url."),
  destDir: z.string().optional().describe(`Absolute directory to save into. Default ${DOWNLOAD_DIR}/<course code>/`),
  overwrite: z.boolean().optional().describe("Re-download even if the file already exists locally. Default false."),
  markAsOpened: markOpenedInput,
};

const collect = (args: { contentId?: string; contentIds?: string[]; url?: string; urls?: string[] }) => ({
  contentIds: [...(args.contentId ? [args.contentId] : []), ...(args.contentIds ?? [])],
  urls: [...(args.url ? [args.url] : []), ...(args.urls ?? [])],
});

server.registerTool(
  "download_file",
  {
    title: "Download file(s)",
    description: "Downloads files through the logged-in session and returns the local paths. Accepts one or many content ids (files, or folders/documents whose attachments and embedded videos are all fetched) and/or direct Blackboard URLs.",
    inputSchema: fileInputs,
  },
  tool(async (args) => {
    const { contentIds, urls } = collect(args);
    const targets = await resolveTargets({ courseId: args.courseId, fileName: args.fileName, contentIds, urls });
    const dir = await downloadDir(args.courseId, args.destDir);
    const downloaded: Saved[] = [];
    for (const t of targets) {
      const { buffer: _buffer, ...saved } = await saveTarget(t, dir, args.overwrite);
      downloaded.push(saved);
    }
    const marked = args.markAsOpened && args.courseId ? await markOpened(args.courseId, contentIds) : undefined;
    return { dir, count: downloaded.length, downloaded, marked };
  })
);

server.registerTool(
  "read_file_text",
  {
    title: "Read the text inside a file",
    description:
      "Downloads a PDF / DOCX / PPTX / XLSX / text file from Blackboard (same targets as download_file) and returns its extracted text so you can summarize or answer questions about it - class presentations, apuntes, guías de ejercicios, syllabus. The file is also kept locally.",
    inputSchema: { ...fileInputs, maxChars: z.number().min(500).max(200_000).optional().describe("Truncate each file's text to this many characters. Default 20000.") },
  },
  tool(async (args) => {
    const { contentIds, urls } = collect(args);
    const targets = await resolveTargets({ courseId: args.courseId, fileName: args.fileName, contentIds, urls });
    const dir = await downloadDir(args.courseId, args.destDir);
    const max = args.maxChars ?? 20_000;
    const files = [];
    for (const t of targets) {
      const { buffer, ...saved } = await saveTarget(t, dir, args.overwrite);
      try {
        const extracted = await fileToText(buffer, saved.fileName, saved.mimeType ?? "");
        files.push({ ...saved, kind: extracted.kind, pages: extracted.pages, chars: extracted.text.length, truncated: extracted.text.length > max, text: extracted.text.slice(0, max) });
      } catch (err) {
        files.push({ ...saved, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const marked = args.markAsOpened && args.courseId ? await markOpened(args.courseId, contentIds) : undefined;
    return { dir, count: files.length, files, marked };
  })
);

// ---------- communication ----------

server.registerTool(
  "get_announcements",
  { title: "Course announcements", description: "Announcements posted in a course, newest first, with plain-text bodies.", inputSchema: { courseId: z.string(), limit: z.number().min(1).max(100).optional() } },
  tool(async ({ courseId, limit }) => {
    const items = await bb.announcements(courseId, limit ?? 25);
    return { courseId, count: items.length, announcements: toAnnouncements(items) };
  })
);

async function courseMessages(course: CourseRef, myId: string): Promise<CourseMessage[]> {
  const conversations = await bb.conversations(course.id);
  const perConversation = await Promise.all(conversations.map(async (c) => toMessages(c.id, course, await bb.conversationMessages(course.id, c.id), myId)));
  return perConversation.flat().sort((a, b) => (b.postDate ?? "").localeCompare(a.postDate ?? ""));
}

server.registerTool(
  "get_messages",
  {
    title: "Course messages",
    description: "Blackboard course messages (Mensajes) exchanged with professors and classmates in the current courses or one course, newest first, with read/unread flags and attachments.",
    inputSchema: {
      courseId: z.string().optional(),
      unreadOnly: z.boolean().optional(),
      limit: z.number().min(1).max(200).optional().describe("Default 30."),
    },
  },
  tool(async ({ courseId, unreadOnly, limit }) => {
    const now = new Date();
    const [courses, myId] = await Promise.all([targetCourses(now, courseId), bb.getUserId()]);
    const messages = (await Promise.all(courses.map((c) => courseMessages(c, myId))))
      .flat()
      .filter((m) => !unreadOnly || m.isRead === false)
      .sort((a, b) => (b.postDate ?? "").localeCompare(a.postDate ?? ""));
    return { courses: courses.map((c) => c.name), unread: messages.filter((m) => m.isRead === false && !m.fromMe).length, count: Math.min(messages.length, limit ?? 30), messages: messages.slice(0, limit ?? 30) };
  })
);

server.registerTool(
  "list_conversations",
  {
    title: "List conversations",
    description:
      "The course's message conversations (id, participants, unread count, latest message preview). Use this to find the `conversationId` that `send_message` replies to.",
    inputSchema: { courseId: z.string() },
  },
  tool(async ({ courseId }) => {
    const [conversations, me] = await Promise.all([bb.conversations(courseId), bb.whoami()]);
    const myId = me.id;
    const items = await Promise.all(
      conversations.map(async (c) => {
        const msgs = await bb.conversationMessages(courseId, c.id);
        const last = msgs.sort((a, b) => (b.postDate ?? "").localeCompare(a.postDate ?? ""))[0];
        const others = msgs.flatMap((m) => (m.sender && m.sender.id !== myId ? [`${m.sender.givenName ?? ""} ${m.sender.familyName ?? ""}`.trim()] : []));
        return {
          conversationId: c.id,
          totalCount: c.totalCount,
          unreadCount: c.unreadCount,
          participants: [...new Set(others)],
          lastMessage: last ? { from: `${last.sender?.givenName ?? ""} ${last.sender?.familyName ?? ""}`.trim(), fromMe: last.sender?.id === myId, postDate: last.postDate, preview: htmlToText(last.body?.rawText ?? last.body?.displayText, 200) } : undefined,
        };
      })
    );
    return { courseId, count: items.length, conversations: items };
  })
);

server.registerTool(
  "list_members",
  {
    title: "List course members",
    description: "Students and instructors of a course with their Blackboard user ids - needed as `recipientIds` for send_message.",
    inputSchema: { courseId: z.string(), query: z.string().optional().describe("Filter by name substring (case-insensitive).") },
  },
  tool(async ({ courseId, query }) => {
    const members = await bb.courseMembers(courseId);
    const q = query?.toLowerCase();
    const filtered = q ? members.filter((m) => m.name.toLowerCase().includes(q) || (m.userName ?? "").toLowerCase().includes(q)) : members;
    return { courseId, count: filtered.length, members: filtered };
  })
);

server.registerTool(
  "send_message",
  {
    title:
      "Send a course message",
    description:
      "Sends a Blackboard course message as the signed-in user. Two modes: reply - pass `conversationId` (from list_conversations or get_messages) and the text goes to everyone in that thread; or new conversation - pass `recipientIds` (user ids from list_members). ALWAYS confirm the recipient(s) and the exact text with the user before calling, unless they already approved them.",
    inputSchema: {
      courseId: z.string(),
      text: z.string().describe("Message body (plain text)."),
      conversationId: z.string().optional().describe("Existing conversation to reply to (from list_conversations)."),
      recipientIds: z.array(z.string()).optional().describe("User ids for a NEW conversation (from list_members); ignored when conversationId is set."),
    },
  },
  tool(async ({ courseId, text, conversationId, recipientIds }) => {
    if (conversationId) {
      const msg = await bb.postConversationMessage(courseId, conversationId, text);
      return { sent: true, mode: "reply", conversationId, messageId: msg.id, postDate: msg.postDate };
    }
    if (!recipientIds?.length) throw new Error("Pass either `conversationId` (reply) or `recipientIds` (new conversation). Use list_members to find user ids.");
    const conv = await bb.createConversation(courseId, recipientIds, text);
    return { sent: true, mode: "new_conversation", conversationId: conv.id, participantIds: recipientIds };
  })
);

server.registerTool(
  "get_calendar",
  {
    title: "Calendar events",
    description: "Blackboard calendar items between two dates across all courses (classes, due dates, office hours). Default window: today through the next 30 days.",
    inputSchema: {
      since: z.string().optional().describe("ISO date lower bound. Default today."),
      until: z.string().optional().describe("ISO date upper bound. Default today + 30 days."),
    },
  },
  tool(async ({ since, until }) => {
    const start = since ? new Date(since) : new Date();
    const end = until ? new Date(until) : new Date(start.getTime() + 30 * 86_400_000);
    const items = await bb.calendarItems(start, end);
    const mapped = items.map((e: any) => ({
      id: e.id,
      title: e.title,
      courseId: e.calendarId,
      start: e.start,
      end: e.end,
      location: e.location,
      description: htmlToText(e.description?.rawText ?? e.description, 500),
    }));
    return { since: start.toISOString(), until: end.toISOString(), count: mapped.length, events: mapped };
  })
);

/** Every current course (or just `courseId`) that has a Zoom LTI tool, with its launch URL. */
async function zoomTargets(courseId?: string): Promise<Array<{ courseId: string; courseName?: string; title: string; launchUrl: string }>> {
  const courses = await listCourses(bb, new Date(), true);
  const ids = courseId ? [courseId] : courses.map((c) => c.id);
  const out: Array<{ courseId: string; courseName?: string; title: string; launchUrl: string }> = [];
  for (const id of ids) {
    const found = await bb.findZoomLaunchUrl(id).catch(() => undefined);
    if (found) out.push({ courseId: id, courseName: courses.find((c) => c.id === id)?.name, ...found });
  }
  return out;
}

server.registerTool(
  "list_zoom_recordings",
  {
    title: "List Zoom class recordings",
    description:
      "Finds each course's 'Zoom - Clases sincrónicas' LTI tool, opens it, and lists the Cloud Recordings (recorded synchronous classes). Pass `courseId` for one course; omit it to search every current course.",
    inputSchema: { courseId: z.string().optional() },
  },
  tool(async ({ courseId }) => {
    const targets = await zoomTargets(courseId);
    if (!targets.length) return { count: 0, note: "No Zoom LTI tool found in the selected courses.", recordings: [] };
    const recordings: Array<Record<string, unknown>> = [];
    for (const t of targets) {
      const recs = await bb.zoomRecordings(t.launchUrl).catch((e) => [{ error: String(e) }]);
      for (const r of recs as any[]) recordings.push({ courseId: t.courseId, course: t.courseName, tool: t.title, ...r });
    }
    return { count: recordings.length, coursesSearched: targets.length, recordings };
  })
);

server.registerTool(
  "download_zoom_recordings",
  {
    title: "Download Zoom class recordings",
    description:
      "Opens each course's Zoom LTI 'Clases sincrónicas', goes to Cloud Recordings and downloads the recordings one at a time into ~/Downloads/Blackboard/<course>/Zoom/ as '<YYYY-MM-DD> <topic>.mp4'. Works even when the host disabled the download button (it fetches the stream the Zoom web player plays). Pass `courseId` for one course; omit it to download from every current course. Narrow it to a single recording with `meetingId`, `topic` and/or `date` (all given filters must match; see list_zoom_recordings). Recordings already downloaded with the same size are skipped. Full class videos are large (around 1 GB per 2 hours); use fileType 'm4a' for the much smaller audio-only file.",
    inputSchema: {
      courseId: z.string().optional(),
      meetingId: z.string().optional().describe("Zoom meeting ID, as list_zoom_recordings shows it; spaces are ignored (e.g. '813 0790 0208')."),
      topic: z.string().optional().describe("Case-insensitive substring of the recording topic."),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Local start date of the recording, YYYY-MM-DD."),
      fileType: z.enum(["mp4", "m4a"]).optional().describe("'mp4' video (default) or 'm4a' audio only."),
      destDir: z.string().optional().describe("Override the download folder."),
    },
  },
  tool(async ({ courseId, meetingId, topic, date, fileType, destDir }) => {
    const targets = await zoomTargets(courseId);
    if (!targets.length) return { downloaded: 0, note: "No Zoom LTI tool found in the selected courses.", results: [] };
    const filter = meetingId || topic || date ? { meetingId, topic, date } : undefined;
    const results: Array<Record<string, unknown>> = [];
    for (const t of targets) {
      const dir = destDir ?? join(DOWNLOAD_DIR, t.courseId, "Zoom");
      const recs = await bb.downloadZoomRecordings(t.launchUrl, dir, { filter, fileType }).catch((e) => [{ error: String(e) }]);
      for (const r of recs as any[]) results.push({ courseId: t.courseId, course: t.courseName, ...r });
    }
    const out: Record<string, unknown> = {
      downloaded: results.filter((r) => r.file && !r.skipped).length,
      skipped: results.filter((r) => r.skipped || r.error).length,
      results,
    };
    if (filter && !results.length) out.note = "No recording matched the given meetingId/topic/date.";
    return out;
  })
);

server.registerTool(
  "get_activity_stream",
  {
    title: "Activity stream (what's new)",
    description:
      "Blackboard's activity feed - the same 'Actividad' page: content added, tests/assignments made available or due, grades posted, announcements and messages across all courses. Newest first.",
    inputSchema: { courseId: z.string().optional(), limit: z.number().min(1).max(200).optional().describe("Default 40.") },
  },
  tool(async ({ courseId, limit }) => {
    const events = toStreamEvents(await bb.stream()).filter((e) => !courseId || e.courseId === courseId);
    return { count: Math.min(events.length, limit ?? 40), events: events.slice(0, limit ?? 40) };
  })
);

// ---------- one-shot briefing ----------

server.registerTool(
  "get_briefing",
  {
    title: "Briefing: what's new, what's pending, what I haven't opened",
    description:
      "One call that answers 'what happened in my courses and what do I need to do?'. For every current-semester course (or one course): pending homework (due soon / overdue), content that is new to the user (never shown in a previous briefing - `newSinceLastBriefing`), everything the user has never opened in Blackboard (`unopened`), unread messages, recent announcements and the latest activity. Each item carries `progress` (Blackboard opened/unopened) and `newToYou` (never reported by Devin before). Start here, then drill down with the other tools; after the user reviews something, call mark_content.",
    inputSchema: {
      courseId: z.string().optional(),
      days: z.number().min(1).max(120).optional().describe("How far back the 'recent' lists reach. Default 14."),
      includeTemplate: z.boolean().optional().describe("Also list institutional template material (Zoom guides etc.) among unopened items. Default false."),
      remember: z.boolean().optional().describe("Record this briefing so next time only newer things count as new. Default true."),
    },
  },
  tool(async ({ courseId, days, includeTemplate, remember }) => {
    const now = new Date();
    const since = new Date(now.getTime() - (days ?? 14) * 86_400_000).toISOString();
    const horizon = new Date(now.getTime() + (days ?? 14) * 86_400_000);
    const ledger = loadLedger();
    const isNew = (id: string) => !ledger.seen[id];
    const [courses, myId, events] = await Promise.all([targetCourses(now, courseId), bb.getUserId(), bb.stream().then(toStreamEvents).catch(() => [] as StreamEvent[])]);
    const content = await scanContent(courses, events);
    const reported: string[] = [];
    const perCourse = await Promise.all(
      courses.map(async (c) => {
        const [grades, messages, announcements] = await Promise.all([bb.grades(c.id), courseMessages(c, myId).catch(() => [] as CourseMessage[]), bb.announcements(c.id, 10).catch(() => [])]);
        const homework = grades.map((g) => toHomework(g, c, now)).map((h) => ({ ...h, newToYou: isNew(h.id) }));
        const mine = content.filter((n) => n.courseId === c.id && (includeTemplate || !n.template));
        const strip = (n: ContentNode) => ({ id: n.id, title: n.title, type: n.type, path: n.path, modifiedDate: n.modifiedDate, availableSince: n.availableSince, progress: n.progress, newToYou: isNew(n.id), template: n.template, fileName: n.file?.fileName, downloadUrl: n.file?.downloadUrl, video: n.links?.find((l) => l.mimeType?.startsWith("video"))?.url });
        const recent = mine.filter((n) => (n.modifiedDate ?? "") >= since || (n.availableSince ?? "") >= since);
        const unopened = mine.filter((n) => n.progress === "unopened");
        const newSince = mine.filter((n) => isNew(n.id)).slice(0, 40);
        const unread = messages.filter((m) => m.isRead === false && !m.fromMe);
        const recentAnnouncements = toAnnouncements(announcements).filter((a) => (a.created ?? "") >= since).map((a) => ({ ...a, newToYou: isNew(a.id) }));
        reported.push(...homework.map((h) => h.id), ...newSince.map((n) => n.id), ...recent.map((n) => n.id), ...unopened.map((n) => n.id), ...unread.map((m) => m.id), ...recentAnnouncements.map((a) => a.id));
        return {
          courseId: c.id,
          course: c.name,
          url: `${BASE_URL}/ultra/courses/${c.id}/outline`,
          homework: {
            overdue: homework.filter((h) => h.state === "overdue").sort(byDueDate),
            dueSoon: homework.filter((h) => h.state === "open" && h.dueDate && new Date(h.dueDate) <= horizon).sort(byDueDate),
            openNoDueDate: homework.filter((h) => h.state === "open" && !h.dueDate),
            counts: homework.reduce<Record<string, number>>((acc, h) => ({ ...acc, [h.state]: (acc[h.state] ?? 0) + 1 }), {}),
          },
          newSinceLastBriefing: mine.filter((n) => isNew(n.id)).slice(0, 40).map(strip),
          recentContent: recent.slice(0, 40).map(strip),
          unopened: { count: unopened.length, items: unopened.slice(0, 40).map(strip) },
          unreadMessages: unread.slice(0, 10).map((m) => ({ ...m, newToYou: isNew(m.id) })),
          latestMessages: messages.slice(0, 5).map((m) => ({ from: m.from, fromMe: m.fromMe, postDate: m.postDate, text: m.text?.slice(0, 300) })),
          announcements: recentAnnouncements.slice(0, 5),
          activity: events.filter((e) => e.courseId === c.id && e.timestamp >= since).slice(0, 15),
        };
      })
    );
    const summary = {
      newSinceLastBriefing: perCourse.reduce((n, c) => n + c.newSinceLastBriefing.length, 0),
      unopened: perCourse.reduce((n, c) => n + c.unopened.count, 0),
      pendingHomework: perCourse.reduce((n, c) => n + c.homework.overdue.length + c.homework.dueSoon.length + c.homework.openNoDueDate.length, 0),
      unreadMessages: perCourse.reduce((n, c) => n + c.unreadMessages.length, 0),
    };
    const lastBriefingAt = ledger.lastBriefingAt;
    if (remember ?? true) {
      noteSeen(ledger, reported, now.toISOString());
      ledger.lastBriefingAt = now.toISOString();
      saveLedger(ledger);
    }
    return { today: now.toISOString(), semester: semesterLabel(now), since, lastBriefingAt, ledgerFile, summary, courses: perCourse };
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    bb.dispose().finally(() => process.exit(0));
  });
}
