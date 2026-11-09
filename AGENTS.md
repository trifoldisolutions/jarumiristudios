# Project Overview

> After making any edit or running tests, and before ending a turn or task, check that `npm run dev` and `npm run tw` are still running. If either has stopped, treat it as crashed — don't assume it restarts on its own — and restart it before finishing. This check is silent: don't tell the user the services are still running, and don't mention a restart either. Only bring them up if one won't stay running after a restart.

**Jarumiri Studios**

## Stack
- Node.js (Express)
- Mongoose (MongoDB)
- EJS (Templating)
- Tailwind CSS (Styling)
- Socket.IO (Realtime)
- Stripe (Payments)
- Multer, Sharp and Cloudflare R2 (Uploads and images)
- Resend (Transactional email)
- Nodemon (Development)

## Scripts
- `npm run dev`: Starts the server with nodemon.
- `npm run tw`: Starts Tailwind CSS watch mode.
- `npm run build`: Builds the minified CSS once.
- `npm start`: Starts the server without nodemon.

## File and Folder Structure
**Hard rule:** Whenever you create, move or edit files, follow this layout. Put new code where it says, even if the project doesn't have that folder yet. If something has no place here, ask before adding a new top-level folder. Don't move existing files as a side effect of other work unless the user asks.

```
jarumiri_studios/
├── server.js            App setup, Socket.IO attach, facades list, startup route map, 404 and error handlers
├── AGENTS.md
├── package.json, .env, .gitignore, jarumiri_studios.vbs
├── .vscode/tasks.json   Runs `npm run tw` and `npm run dev` on folder open
├── config/              Constants and settings: limits, pricing
├── models/              Mongoose models, one per file, with the file fields they share in models/shared/
├── routes/
│   ├── public.js        Public pages, mounted at /
│   ├── app.js           The client dashboard and its sign-in pages, mounted at /
│   ├── admin.js         Admin section, mounted at /admin
│   ├── associate.js     Extra section: editors, a separate signed-in role with its own login and URLs, mounted at /associate
│   ├── api.js           JSON API, mounted at /api
│   └── webhooks.js      Calls from outside services (Stripe), mounted at /webhooks, before the body parsers
├── middleware/          Express middleware: sign-in, visitor cookie, submission quotas, uploads
├── services/            Shared logic and outside services (email, payments, R2 and local storage, chat socket, expiry jobs)
├── views/
│   ├── partials/        Shared by more than one section: toast.ejs, confirm-modal.ejs, message-thread-script.ejs
│   ├── public/          Public pages, with their own partials in public/partials/
│   ├── app/             Client dashboard pages, with sign-in pages in app/auth/ and its own partials in app/partials/
│   ├── admin/           Admin pages, with its own partials in admin/partials/
│   └── associate/       Associate pages, with its own partials in associate/partials/
├── src/input.css        Tailwind source, the only CSS file to edit
├── public/
│   ├── output.css       Built by Tailwind: never edit or commit it
│   └── assets/          Images the site shows, served at /assets
├── uploads/             Git-ignored local file storage, used when STORAGE_BACKEND=local; otherwise uploads go to Cloudflare R2
├── scripts/             Scripts run by hand
└── dev_resources/       Git-ignored and internal: journal, tasks, commit message, plans, screenshots, the DNS export
```

- **Routes:** Add each route to its section's file, with a line in that file's `router.routes` list (`{ method, path, label }`). No routes in `server.js`, and no new route file per feature. Logic that several routes share, or that calls an outside service, goes in `services/`. Mount routers through `middleware/skipOptions.js`, so OPTIONS requests keep reaching the 404 handler.
- **Folder names:** No `utils/`, `lib/` or `helpers/`. Helpers go in `services/`, or in `middleware/` if they handle a request.
- **Views:** Every page goes in its section's folder, never directly in `views/`. The folder already says the section, so name files for what they show: `views/admin/users.ejs`, not `views/admin-users.ejs`. A section's own partials go in its `partials/` folder; only what several sections share goes in `views/partials/`.
- **Local-only files:** Notes, screenshots, logs, prompts, one-off scripts and source images go in `dev_resources/`, not the project root.
- **Instruction files:** `AGENTS.md` is the only one. No `CLAUDE.md` or `.claude/` folder.


---

## Agent Instructions for this Project

**Direct File Manipulation via Internal Tools**

When interacting with this project, you are equipped with internal tools (such as `python` and `terminal`) that have direct access to the project directory: `F:\trifoldi\projects\jarumiri_studios`.

**Guidelines:**

1. **Prefer Tools over Manual Copy-Paste:** Do not ask the user to copy, paste, or run long code blocks in their terminal if you can accomplish the task using your internal tools.
2. **File Management:** Use your tools to:
   - **Create** new files (e.g., using `python` to write content).
   - **Update/Edit** existing files by overwriting them with the full updated content.
   - **Read** files to understand the current project state.
   - **Delete** files or directories when requested.
3. **Path Management:** Always ensure you are targeting the correct directory (`F:\trifoldi\projects\jarumiri_studios`) when executing commands to avoid creating files in the wrong workspace.
4. **Directory Restriction (hard rule):** You may not create, edit, or delete files at any path outside `F:\trifoldi\projects\jarumiri_studios`. This holds even if the harness/tool defaults to a different working directory — redirect every file operation back to this project's directory rather than letting it fall through to the default. If a requested change would require touching a path outside this directory, stop and ask instead of proceeding.

**Goal:** Minimize friction for the user by performing file-system operations directly through your interface rather than requesting manual input.

5. **Screenshot Restriction (hard rule):** For the following projects — ozsdiaries, storiesbyshews, jarumiristudios, wapdooz, whimish, allthingsaprons — you are not allowed, under any circumstances, to take screenshots of the UI while working. If a screenshot seems necessary to verify or debug something, stop and explicitly request permission from the user before taking it.

6. **Journal Entries (hard rule):** When adding a new entry to this project's journal (`dev_resources/journal.md`, via the Dispatch dashboard's Journal tab), each individual entry must not exceed 150 characters. Write one entry per feature or change, not one per part of it: a feature with its settings, prompts and tests is a single entry. If it doesn't fit in 150 characters, describe it at a higher level instead of splitting it up; the details belong in the commit message. Only log what will be useful to someone reading the journal later: what changed, why, and any decision or gotcha that isn't obvious from the code. Leave out word lists, examples, test counts, lists of files (the file report covers those) and steps that were undone or redone in the same session. Before adding an entry, read today's entries and skip anything one of them already covers.

7. **Journal Upkeep (hard rule):** After any significant update to the project, add entries to this project's journal before ending the turn. Significant means things like a new feature or page, a model, route or data change, a recorded client decision or requirement, or a convention, tooling or config change. Trivial edits (typos, small copy or style tweaks) don't need an entry. Add entries through the Dispatch dashboard: its Journal tab, or `POST http://localhost:3000/api/project-folders/jarumiri_studios/journal` with JSON `{ "content": "..." }`. It files each entry under today's date with the time. If the dashboard isn't running, write them by hand in the same format: a `## YYYY-MM-DD` heading, then `- **HH:MM** — text` bullets. Follow rule 6 for what goes in an entry and its 150-character limit, and say what changed and why in plain words.

8. **Task Completion Reporting (hard rule):** Only the user marks tasks in `dev_resources/tasks.json` as done. Never mark a task done or archive it yourself (don't change its `done` or `archived` fields, through the project hub or by editing the file). Instead, whenever you believe you've completed a task, report it to the user in your reply, so they can mark it done and finished tasks don't stay open. Give the task's ID and title, what you did, and how you checked it works. If you finished only part of a task, say what's still left.

9. **Push Commit Message (hard rule):** Every time you add an entry to this project's journal, also create or update `dev_resources/commit_message.txt` before ending the turn. The Dispatch dashboard's Push button commits with this file's text, so it must cover everything done since the last push, not just your latest change. If the file doesn't exist, create it. If it does, keep what's already in it and add the new work. Write it as a git commit message: a summary line of 72 characters or fewer that covers all of the work in the file, then a blank line, then one `- ` bullet per change saying what changed and why in plain words. Rewrite the summary line whenever it no longer covers everything. Never stage, commit or push this file yourself: the dashboard leaves it out of every commit and deletes it once a push has used it, so the next journal entry starts a fresh one.

10. **Journal File Reports (hard rule):** Every journal entry you add must also report the files its work created, modified or deleted, as paths relative to this project's folder with forward slashes. The Dispatch dashboard lists each day's files under that day's entries, so this is what keeps a day's changes traceable. With the dashboard running, send them with the entry: `POST http://localhost:3000/api/project-folders/jarumiri_studios/journal` with JSON `{ "content": "...", "files": { "created": ["..."], "modified": ["..."], "deleted": ["..."] } }`, leaving out any list that would be empty. When the `CLAUDE_CODE_SESSION_ID` environment variable is set, also send it as the `X-Agent-Session` header, so the entry's record keeps which Claude Code session wrote it. When writing the journal by hand, put them under the entry as sub-bullets indented two spaces, one line per kind: ``- Created: `path/one.js`, `path/two.js` ``, then ``- Modified: ...`` and ``- Deleted: ...``. List each file under the entry for the change that touched it. The 150-character limit is for the entry's text, not its file list.

11. **Tasks (hard rule):** This project's to-do list is `dev_resources/tasks.json`, shown in the Dispatch dashboard's Tasks tab. Whenever something needs doing later (a follow-up, a known bug, something left out of the current work), add it there as a task, not as a TODO comment, a Markdown note or anywhere else. With the dashboard running, use its API: `POST http://localhost:3000/api/project-folders/jarumiri_studios/tasks` with JSON `{ "title": "...", "description": "...", "dueDate": "YYYY-MM-DD", "tags": ["..."] }`. Only the title is required (80 characters at most); the description is limited to 500 characters and each tag to 30. When the `CLAUDE_CODE_SESSION_ID` environment variable is set, also send it as the `X-Agent-Session` header, as for journal entries. Never edit `tasks.json` by hand: the dashboard gives each task its ID and records who created it. If the dashboard isn't running, say so and ask instead of writing the file. Marking tasks done or archiving them is the user's alone (rule 8, Task Completion Reporting).
