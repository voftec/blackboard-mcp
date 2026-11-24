# Blackboard MCP (Universidad de Palermo)

An MCP server that gives an AI agent eyes on the user's Blackboard Ultra campus: current-semester courses, open homework, what the professors just uploaded, announcements, file downloads, and course messaging.

Developed by **Diego Aguirre (Voftec)**.

Works with any MCP client that speaks stdio - **Devin, Cursor, Codex, Claude Code**, and others. It is not tied to any specific agent.

It works the way a student does - through a normal browser login - so no institutional API keys are needed:

1. The `login` tool opens **your own Google Chrome** on the MyUP single sign-on page. You type your credentials there; the MCP never sees them.
2. When Blackboard redirects to `/ultra`, the browser cookies are saved to `~/.blackboard-mcp/session.json` (mode 600) and the window closes.
3. Every other tool calls Blackboard's internal JSON API (`/learn/api/v1/...`, the same one the web UI uses) with those cookies. No browser is running for normal queries, so calls take ~200 ms to 2 s.

When the session expires, tools return `Not logged in...` and Devin should call `login` again. The SSO usually remembers you, so the window often closes by itself.

## Tools

| Tool | What it answers |
|---|---|
| `get_briefing` | **Start here.** Per current course: pending homework, new content since N days with opened/unopened status, everything never opened, unread messages, announcements, latest activity. |
| `login` | Opens the Chrome login window (non-blocking). `force: true` to re-login. |
| `session_status` | Is the session valid, is a login pending, who is signed in. |
| `logout` | Deletes the saved session. |
| `find_courses` | Courses of the semester running **today** (term dates from Blackboard). `currentOnly: false` for older ones. |
| `get_course` | Course details, instructors, homework counts by state. |
| `find_homework` | Every gradable item in a course with due date, points, attempts and a computed `state`: `open` / `overdue` / `submitted` / `graded`. |
| `get_upcoming_homework` | Across current courses: `dueSoon` (next N days), `overdue`, `openNoDueDate`, `later`. |
| `get_todo` | Blackboard's own overdue / due today / next 2 weeks feed. |
| `get_course_content` | The outline tree (`/ultra/courses/{id}/outline`): folders, modules, documents (with text), files (with download URLs), assessments, Zoom tools. |
| `get_recent_content` | Newest files/documents/videos/assessments across current courses, each with `progress` (unopened/opened/completed), `availableSince` and `template`. `unopenedOnly: true` = "what haven't I looked at". |
| `read_content` | One item in full: document text, embedded links/videos, attachments, children. |
| `read_file_text` | Downloads a PDF / DOCX / PPTX / XLSX / text file and returns its text - read the professor's slides, apuntes or syllabus without opening them. |
| `download_file` | Downloads one or many files (or everything inside folders/documents: attachments + embedded videos) to `~/Downloads/Blackboard/<course code>/`. |
| `get_messages` | Course messages (Mensajes) with professors/classmates, unread flags, attachments. |
| `list_conversations` | Message conversations of a course: id, participants, unread count, last message preview - the way to get `conversationId` for `send_message`. |
| `list_members` | Students and instructors with their user ids (`recipientIds` for `send_message`). `query` filters by name. |
| `send_message` | Sends a course message as the signed-in user: pass `conversationId` to reply to a thread, or `recipientIds` to start a new conversation. Always confirm recipient + text with the user first. |
| `get_calendar` | Calendar items across all courses between two dates (default: today → +30 days). |
| `get_announcements` | Course announcements as plain text. |
| `get_activity_stream` | The "Actividad" feed: content added, tests/assignments available or due, grades posted, messages. |

### Annotations computed from Blackboard data (nothing hardcoded)

- `progress` - Blackboard's progress tracking (`state`: None / Started / Completed) tells whether the user ever opened an item.
- `availableSince` - taken from the activity stream; `modifiedDate` also moves when a professor bulk-edits a module, so this is the truthful "added on" date.
- `template` - items under top-level folders whose title exists in **more than one** current course (The university copies the same "Antes de comenzar" / Zoom guides into every course). Hidden by default in `get_recent_content` and `get_briefing`; pass `includeTemplate: true` to see them.
- `dueDateLooksStale` - due date earlier than the semester start (copied from a previous edition of the course).
- Current semester - a course is current when today falls inside its term's `startDate`..`endDate`.

## Setup

```bash
npm install
npm run build
```

### Register it in your MCP client

Any client that supports stdio MCP servers can run it. Point the client at `node /path/to/BLACKBOARD-mcp/dist/index.js`:

- **Devin**: `devin mcp add -s user blackboard -- node "/path/to/BLACKBOARD-mcp/dist/index.js"` (or add it under Customize > MCPs).
- **Claude Code**: `claude mcp add blackboard -- node /path/to/BLACKBOARD-mcp/dist/index.js`
- **Cursor / Codex**: add a stdio server with command `node` and arg `/path/to/BLACKBOARD-mcp/dist/index.js` in the MCP settings.

Then: "log me in to Blackboard" -> sign in in the Chrome window -> "what homework do I have this week?".

### Smoke test

```bash
node scripts/smoke.mjs                 # runs every read tool against the saved session
node scripts/smoke.mjs login '{"force":true}'
node scripts/smoke.mjs find_homework '{"courseId":"_95767_1","state":"pending"}'
```

### Configuration

Everything is optional; see `.env.example`. Defaults point at `https://palermo.blackboard.com`, use installed Google Chrome for the login window, store the session in `~/.blackboard-mcp/session.json` and download to `~/Downloads/Blackboard`.

## How the endpoints were found

The internal API was mapped by watching the network calls of a logged-in Blackboard Ultra session with the Playwright MCP:

| Data | Endpoint |
|---|---|
| Current user | `GET /learn/api/v1/users/me` |
| Courses + terms | `GET /learn/api/v1/users/{userId}/memberships?expand=course.effectiveAvailability,course.permissions,courseRole` |
| Homework (student gradebook) | `GET /learn/api/v1/courses/{courseId}/gradebook/grades?userId=...&includeNoGradeItems=true&expand=column,submissionStatus,attemptsLeft,...` |
| Overdue / due soon | `GET /learn/api/v1/calendars/todo/studentItems?since&until` (window <= ~16 days) |
| Content tree | `GET /learn/api/v1/courses/{courseId}/contents/{ROOT\|id}/children?@view=Summary` |
| File download | `contentDetail["resource/x-bb-file"].file.permanentUrl` -> `/bbcswebdav/pid-...` (redirects to a signed CDN URL) |
| Announcements | `GET /learn/api/v1/courses/{courseId}/announcements` |
| Messages | `GET /learn/api/v1/courses/{courseId}/conversations` -> `/conversations/{id}/messages` |
| Opened / not opened | `state` + `stateCompletion` on every content item (progress tracking) |
| Activity stream | `POST /learn/api/v1/streams/ultra` with header `X-Blackboard-XSRF` from `GET /learn/api/v1/utilities/xsrfToken` |

Ultra "documents" are folders with `isBbPage: true` whose child `ultraDocumentBody` holds the HTML; attachments are sibling `x-bb-file` items and embedded videos are `bbcswebdav` links inside the HTML.

## Privacy

- Credentials are typed only into Blackboard's own login page inside Chrome.
- The session file lives in your home directory with `600` permissions and is never written inside this repo.
- `captures/` (raw API samples used while mapping the API) and `.playwright-mcp/` are gitignored because they contain personal course data.

## Disclaimer

Personal project, not affiliated with or endorsed by Anthology/Blackboard or Universidad de Palermo. It uses the institution's own web API with the signed-in user's session; users are responsible for complying with their institution's terms of use.
