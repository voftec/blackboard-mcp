import {
  BASE_URL,
  type BlackboardSession,
  type ContentItem,
  type GradeEntry,
  type Membership,
  type Message,
  type StreamResponse,
  type TodoItem,
} from "./blackboard.js";

export interface Course {
  id: string;
  code: string;
  name: string;
  semester?: string;
  termStart?: string;
  termEnd?: string;
  isCurrent: boolean;
  role?: string;
  lastAccess?: string;
  url: string;
}

export type HomeworkState = "open" | "overdue" | "submitted" | "graded";

export interface Homework {
  id: string;
  contentId?: string;
  courseId: string;
  courseName?: string;
  title: string;
  type: string;
  category?: string;
  dueDate?: string;
  pointsPossible?: number;
  state: HomeworkState;
  submissionStatus?: string;
  score?: number;
  autoZero?: boolean;
  /** Due date is earlier than the semester start - almost certainly copied from a previous edition of the course. */
  dueDateLooksStale?: boolean;
  attemptsLeft?: number;
  url: string;
}

export interface CourseRef {
  id: string;
  name?: string;
  termStart?: string;
}

export interface ContentLink {
  text?: string;
  url: string;
  mimeType?: string;
}

export interface ContentNode {
  id: string;
  parentId?: string;
  courseId: string;
  title: string;
  type: string;
  path: string;
  modifiedDate?: string;
  visibility?: string;
  /** Blackboard progress tracking: has the user opened this item? */
  progress?: "unopened" | "opened" | "completed";
  /** For folders/modules: how many trackable items inside were opened / completed. */
  progressSummary?: { completed?: number; started?: number; total?: number };
  /** True when the item lives in a top-level folder that exists in several courses (institutional template material, not course-specific). */
  template?: boolean;
  /** When the professor made it available, according to the activity stream (modifiedDate also moves on bulk edits). */
  availableSince?: string;
  text?: string;
  /** Links and embedded media (videos, images, attachments) found inside the document HTML. */
  links?: ContentLink[];
  file?: { fileName?: string; mimeType?: string; fileSize?: number; downloadUrl?: string };
  launchUrl?: string;
  children?: ContentNode[];
}

export interface StreamEvent {
  timestamp: string;
  kind: string;
  eventType?: string;
  courseId?: string;
  courseName?: string;
  title?: string;
  dueDate?: string;
  /** When the item became available to students. */
  startDate?: string;
  sourceId?: string;
  contentHandler?: string;
  score?: number;
  text?: string;
  seen?: boolean;
}

const CONTAINER_HANDLERS = new Set(["resource/x-bb-folder", "resource/x-bb-lesson"]);

export function htmlToText(html?: string, max = 2000): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<(br|\/p|\/div|\/li|\/h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text || undefined;
}

const decodeEntities = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

/** Last path segment of a URL when it looks like a real file name (has an extension); bbcswebdav ids are ignored. */
function fileNameFromUrl(url: string): string | undefined {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return /\.[a-z0-9]{2,5}$/i.test(last) && !/^xid-/.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}

/** Pulls <a href>, <img|video|source|iframe src> out of Blackboard HTML, resolving relative URLs against the site. */
export function extractLinks(html?: string, max = 30): ContentLink[] | undefined {
  if (!html) return undefined;
  const links: ContentLink[] = [];
  const seen = new Set<string>();
  const tagRe = /<(a|img|video|source|iframe)\b([^>]*)>(?:([\s\S]*?)<\/a>)?/gi;
  for (const m of html.matchAll(tagRe)) {
    const attrs = m[2];
    const raw = /(?:href|src)\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (!raw || raw.startsWith("javascript:") || raw.startsWith("#")) continue;
    const url = decodeEntities(raw.startsWith("/") ? `${BASE_URL}${raw}` : raw);
    if (seen.has(url)) continue;
    seen.add(url);
    const bbfile = /data-bbfile\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    let meta: { mimeType?: string; linkName?: string; alternativeText?: string } = {};
    if (bbfile) {
      try {
        meta = JSON.parse(decodeEntities(bbfile)) as typeof meta;
      } catch {
        meta = {};
      }
    }
    const text = htmlToText(m[3], 120) ?? meta.linkName ?? meta.alternativeText ?? /alt\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? fileNameFromUrl(url);
    links.push({ text, url, mimeType: meta.mimeType });
    if (links.length >= max) break;
  }
  return links.length ? links : undefined;
}

export function toIso(date?: string | number): string | undefined {
  if (date === undefined || date === null) return undefined;
  const d = new Date(date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function semesterLabel(now: Date): string {
  const month = now.getMonth() + 1;
  return month >= 8 ? `${now.getFullYear()} Segundo Semestre` : `${now.getFullYear()} Primer Semestre`;
}

export function toCourse(m: Membership, now: Date): Course {
  const c = m.course;
  const start = c.term?.startDate ? new Date(c.term.startDate) : undefined;
  const end = c.term?.endDate ? new Date(c.term.endDate) : undefined;
  const inTerm = start && end ? start <= now && now <= end : c.isAvailable !== false && !c.isClosed;
  return {
    id: c.id,
    code: c.courseId,
    name: c.displayName ?? c.name,
    semester: c.term?.name,
    termStart: c.term?.startDate,
    termEnd: c.term?.endDate,
    isCurrent: Boolean(inTerm) && c.isAvailable !== false && !c.isClosed && m.isAvailable !== false,
    role: m.courseRole?.identifier,
    lastAccess: m.lastAccessDate,
    url: `${BASE_URL}/ultra/courses/${c.id}/outline`,
  };
}

export async function listCourses(bb: BlackboardSession, now: Date, currentOnly: boolean): Promise<Course[]> {
  const courses = (await bb.memberships()).map((m) => toCourse(m, now));
  courses.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (b.termStart ?? "").localeCompare(a.termStart ?? "") || a.name.localeCompare(b.name));
  return currentOnly ? courses.filter((c) => c.isCurrent) : courses;
}

function homeworkType(handle?: string): string {
  const suffix = handle?.replace(/^resource\/x-bb-/, "");
  return { assessment: "assessment", assignment: "assignment", forumlink: "discussion", "asmt-test-link": "assessment" }[suffix ?? ""] ?? suffix ?? "other";
}

function categoryLabel(title?: string): string | undefined {
  return title?.replace(/\.name$/, "");
}

export function homeworkUrl(courseId: string, contentId?: string, type?: string): string {
  return contentId && type === "assessment"
    ? `${BASE_URL}/ultra/courses/${courseId}/assessment/${contentId}/overview?courseId=${courseId}`
    : `${BASE_URL}/ultra/courses/${courseId}/outline`;
}

export function toHomework(g: GradeEntry, course: CourseRef, now: Date): Homework {
  const col = g.column;
  const type = homeworkType(col?.scoreProviderHandle);
  const sub = g.submissionStatus?.status;
  const autoZero = Boolean(g.displayGrade?.scoredByAutomaticZero);
  const due = col?.dueDate ? new Date(col.dueDate) : undefined;
  const submitted = Boolean(g.lastAttemptId) || ["SUBMITTED", "NEEDS_GRADING", "GRADED"].includes(sub ?? "");
  let state: HomeworkState = "open";
  if (autoZero) state = "overdue";
  else if (g.status === "GRADED" && g.displayGrade?.score !== undefined) state = "graded";
  else if (submitted) state = "submitted";
  else if (sub === "PAST_DUE_AUTO_ZERO" || sub === "PAST_DUE" || (due && due < now)) state = "overdue";
  const stale = Boolean(due && course.termStart && due < new Date(course.termStart));
  return {
    id: g.columnId ?? col?.id ?? "",
    contentId: col?.contentId,
    courseId: course.id,
    courseName: course.name,
    title: col?.columnName ?? "(sin título)",
    type,
    category: categoryLabel(col?.gradebookCategory?.title),
    dueDate: col?.dueDate,
    pointsPossible: col?.possible,
    state,
    submissionStatus: sub,
    score: g.displayGrade?.score,
    autoZero: autoZero || undefined,
    dueDateLooksStale: stale || undefined,
    attemptsLeft: g.attemptsLeft,
    url: homeworkUrl(course.id, col?.contentId, type),
  };
}

export function toTodoHomework(item: TodoItem, courseNames: Map<string, string>): Omit<Homework, "state" | "url"> & { url: string } {
  const col = item.column;
  const courseId = col?.courseId ?? "";
  const type = homeworkType(col?.scoreProviderHandle);
  return {
    id: col?.id ?? "",
    contentId: col?.contentId,
    courseId,
    courseName: courseNames.get(courseId),
    title: item.title,
    type,
    category: categoryLabel(col?.gradebookCategory?.title),
    dueDate: item.dueDate,
    pointsPossible: col?.possible,
    url: homeworkUrl(courseId, col?.contentId, type),
  };
}

function contentType(item: ContentItem): string {
  const handler = item.contentHandler ?? "";
  const detail = item.contentDetail?.[handler];
  if (handler === "resource/x-bb-folder") return detail?.isBbPage ? "document" : "folder";
  if (handler === "resource/x-bb-lesson") return "learning_module";
  if (handler === "resource/x-bb-document") return "text";
  if (handler === "resource/x-bb-file") return "file";
  if (handler === "resource/x-bb-asmt-test-link") return "assessment";
  if (handler === "resource/x-bb-assignment") return "assignment";
  if (handler === "resource/x-bb-forumlink") return "discussion";
  if (handler === "resource/x-bb-courselink") return "course_link";
  if (handler === "resource/x-bb-externallink") return "external_link";
  if (handler.startsWith("resource/x-bb-bltiplacement-") || handler === "resource/x-bb-blti-link") return "tool";
  return handler.replace(/^resource\/x-bb-/, "") || "other";
}

function progressOf(item: ContentItem): ContentNode["progress"] {
  if (item.contentHandler === "resource/x-bb-document") return undefined;
  switch (item.state) {
    case "None":
      return "unopened";
    case "Started":
      return "opened";
    case "Completed":
      return "completed";
    default:
      return undefined;
  }
}

export function toContentNode(item: ContentItem, courseId: string, path: string): ContentNode {
  const handler = item.contentHandler ?? "";
  const detail = item.contentDetail?.[handler];
  const node: ContentNode = {
    id: item.id,
    parentId: item.parentId,
    courseId,
    title: item.title,
    type: contentType(item),
    path,
    modifiedDate: toIso(item.modifiedDate),
    visibility: item.visibility,
    progress: progressOf(item),
    progressSummary: item.stateCompletion,
    text: htmlToText(item.body?.displayText, 600),
    links: extractLinks(item.body?.displayText),
  };
  if (detail?.file) {
    const f = detail.file;
    node.file = { fileName: f.fileName, mimeType: f.mimeType, fileSize: f.fileSize, downloadUrl: f.permanentUrl ? `${BASE_URL}${f.permanentUrl}` : undefined };
  }
  if (detail?.launchLink) node.launchUrl = `${BASE_URL}${detail.launchLink}`;
  if (node.type === "assessment") node.launchUrl = homeworkUrl(courseId, item.id, "assessment");
  return node;
}

/** Walks the course content tree. Ultra documents fold their `ultraDocumentBody` text into the parent node. */
export async function walkContent(bb: BlackboardSession, courseId: string, parentId: string, depth: number, path = ""): Promise<ContentNode[]> {
  const items = await bb.contentChildren(courseId, parentId);
  const nodes = await Promise.all(
    items.map(async (item) => {
      const node = toContentNode(item, courseId, path);
      const isContainer = CONTAINER_HANDLERS.has(item.contentHandler ?? "");
      if (isContainer && (depth > 0 || node.type === "document")) {
        const children = await walkContent(bb, courseId, item.id, node.type === "document" ? 0 : depth - 1, path ? `${path} / ${node.title}` : node.title);
        const body = children.find((c) => c.type === "text" && c.title === "ultraDocumentBody");
        if (body) {
          node.text = body.text;
          node.links = body.links;
          node.modifiedDate = [node.modifiedDate, body.modifiedDate].filter(Boolean).sort().pop();
        }
        node.children = children.filter((c) => c !== body);
      }
      return node;
    })
  );
  return nodes;
}

export function flattenContent(nodes: ContentNode[]): ContentNode[] {
  return nodes.flatMap((n) => {
    const { children, ...rest } = n;
    return [rest as ContentNode, ...flattenContent(children ?? [])];
  });
}

const STREAM_NOUNS: Record<string, string> = { AN: "announcement", CO: "content", TE: "test", UA: "assignment", CM: "message", CR: "course", DB: "discussion", GB: "grade" };
const STREAM_VERBS: Record<string, string> = { AVAIL: "available", DUE: "due", OVERDUE: "overdue", RCVD: "received", NEW_MSG: "post", GRADED: "graded" };

/** Turns Blackboard event codes like "CO:CO_AVAIL" or "TE:OVERDUE" into "content_added" / "test_overdue". */
function streamKind(providerId: string, eventType?: string): string {
  if (providerId === "bb_mygrades") return "grade_posted";
  if (!eventType) return providerId;
  const [prefix, rest = prefix] = eventType.split(":");
  const noun = STREAM_NOUNS[prefix] ?? prefix.toLowerCase();
  const verb = STREAM_VERBS[rest.replace(new RegExp(`^${prefix}_`), "")] ?? rest.toLowerCase();
  if (noun === "content" && verb === "available") return "content_added";
  if (noun === "announcement" && verb === "available") return "announcement";
  return `${noun}_${verb}`;
}

export function toStreamEvents(res: StreamResponse): StreamEvent[] {
  const courseNames = new Map((res.sv_extras?.sx_courses ?? []).map((c) => [c.id, c.name ?? c.courseId ?? c.id]));
  return (res.sv_streamEntries ?? [])
    .map((e) => {
      const isd = e.itemSpecificData ?? {};
      const nd = isd.notificationDetails ?? {};
      const eventType = e.extraAttribs?.event_type;
      const courseId = e.se_courseId ?? (nd.courseId && nd.courseId !== "_0_1" ? nd.courseId : undefined);
      return {
        timestamp: new Date(e.se_timestamp).toISOString(),
        kind: streamKind(e.providerId, eventType),
        eventType,
        courseId,
        courseName: courseId ? courseNames.get(courseId) : undefined,
        title: isd.title ?? nd.announcementTitle,
        dueDate: nd.dueDate ?? undefined,
        startDate: nd.startDate ?? undefined,
        sourceId: nd.sourceId,
        contentHandler: isd.contentDetails?.contentHandler,
        score: isd.gradeDetails?.displayGradeScore ?? undefined,
        text: htmlToText(nd.announcementBody ?? undefined, 500),
        seen: nd.seen,
      } satisfies StreamEvent;
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function safeFileName(name: string): string {
  return name.replace(/[\/\\:*?"<>|\u0000-\u001f]/g, "_").trim() || "file";
}

const normalizeTitle = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Top-level folder titles that appear in more than one course. Universidad de Palermo copies the same
 * "how to use the campus" folders into every course, so anything under them is template material.
 */
export async function sharedTopLevelTitles(bb: BlackboardSession, courseIds: string[]): Promise<Set<string>> {
  if (courseIds.length < 2) return new Set();
  const roots = await Promise.all(courseIds.map((id) => bb.contentChildren(id, "ROOT")));
  const seenIn = new Map<string, number>();
  for (const items of roots) {
    for (const title of new Set(items.map((i) => normalizeTitle(i.title)))) seenIn.set(title, (seenIn.get(title) ?? 0) + 1);
  }
  return new Set([...seenIn].filter(([, n]) => n > 1).map(([t]) => t));
}

export function markTemplate(nodes: ContentNode[], shared: Set<string>, inherited = false): ContentNode[] {
  for (const n of nodes) {
    const isTemplate = inherited || (n.path === "" && shared.has(normalizeTitle(n.title)));
    if (isTemplate) n.template = true;
    if (n.children) markTemplate(n.children, shared, isTemplate);
  }
  return nodes;
}

/** Adds `availableSince` from the activity stream's content_added / *_available events. */
export function attachAvailability(nodes: ContentNode[], events: StreamEvent[]): void {
  const since = new Map(events.filter((e) => e.sourceId && e.startDate).map((e) => [e.sourceId!, e.startDate!]));
  for (const n of nodes) {
    const date = since.get(n.id);
    if (date) n.availableSince = date;
    if (n.children) attachAvailability(n.children, events);
  }
}

export interface CourseMessage {
  id: string;
  conversationId: string;
  courseId: string;
  courseName?: string;
  from: string;
  fromMe: boolean;
  postDate?: string;
  isRead?: boolean;
  text?: string;
  attachments?: ContentLink[];
}

export function toMessages(conversationId: string, course: CourseRef, messages: Message[], myUserId: string): CourseMessage[] {
  return messages.map((m) => ({
    id: m.id,
    conversationId,
    courseId: course.id,
    courseName: course.name,
    from: [m.sender?.givenName, m.sender?.familyName].filter(Boolean).join(" ") || m.sender?.userName || "?",
    fromMe: m.sender?.id === myUserId,
    postDate: m.postDate,
    isRead: m.isRead,
    text: htmlToText(m.body?.displayText ?? m.body?.rawText, 3000),
    attachments: extractLinks(m.body?.displayText ?? m.body?.rawText),
  }));
}
