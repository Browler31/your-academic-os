

## Project Status: Study OS — Where We Are

### What's Built and Working

| Module | Status | What It Does |
|--------|--------|-------------|
| **Moodle Sync** | Working | Pulls courses, files (PDFs), notes (Lernziele, Vorbereitung), and deadlines from ZHAW Moodle via API token. Per-course sequential sync to avoid timeouts. Filters out irrelevant courses. |
| **Dashboard / Autopilot** | Working | "DO THIS NOW" hero card with Pomodoro timer, task queue, today's lectures (WebUntis), upcoming deadlines. "Plan Today" and "Plan Week" buttons call Gemini Flash to generate tasks. |
| **AI Study Planner** | Working | Edge function sends your courses, notes, timetable, and deadlines to Gemini 2.5 Flash. Creates 3-6 daily or 15-25 weekly tasks with priority scores, scheduled dates, and Pomodoro-friendly durations. |
| **PDF Legal Parser** | Working (manual) | Sends PDF bytes to Gemini 2.5 Pro, extracts norms (TBM, Rechtsfolge, Definitionen), key concepts, cases. Stores as JSONB in `files.extracted_content`. |
| **Notes** | Working | Displays Moodle section content grouped by course. AI classifier categorizes notes (Lernziel, Vorbereitung, Pflichtlektüre, etc.). |
| **Files** | Working | Browse synced files by course/type, trigger parsing, view extracted legal content inline. |
| **Tasks** | Working | Priority-ordered task list with "One Thing" card. Tabs for pending/in-progress/done. |
| **Flashcards** | Working | Generate Anki-style cards from notes via Gemini. Export to `.apkg` format. |
| **Analytics** | Working | 14-day study timeline, course coverage (parsed files / flashcards), consistency streaks. |
| **Timetable** | Working | WebUntis sync for ZHAW schedule. |
| **Deadlines** | Working | Pulled from Moodle assignments. |
| **Scheduled Triggers** | DB only | Table exists for 3-tier notifications (24h/1h/5m), but no cron job or push notification logic yet. |

---

### Why You Have to Click "Parse" on Every File

Right now, parsing is **manual and per-file**. You click "Parse" on a PDF, it downloads it, sends it to Gemini 2.5 Pro, and stores the structured legal elements. This was built as a cautious first step because:

1. Gemini Pro calls cost credits and take 20-30 seconds each
2. Not every file is parseable or relevant (some are admin docs, Organisatorisches, etc.)
3. There was no auto-trigger after Moodle sync

This is one of the biggest gaps. The vision was: **Moodle syncs → files auto-parse → norms feed into flashcards and study plans**. Right now the pipeline is broken in the middle because of this manual step.

---

### Login / edu-ID Question

Currently the app uses **anonymous sign-in** — no login screen, no credentials. This means:
- Your data is tied to a browser session. Clear cookies = lose everything.
- There's no real authentication protecting your data.

Regarding **edu-ID (via SWITCH)**: edu-ID uses SAML/Shibboleth federation, which is **not supported** by Lovable Cloud's auth system. The supported OAuth providers are Google and Apple only. However, your ZHAW email is likely a Google Workspace account (`@students.zhaw.ch`), so **Google Sign-In would effectively be your edu-ID login** — same email, same identity.

---

### What's Missing for "Fully Autonomous"

Here's the gap between where we are and the vision of a system that **performs the heavy lifting of law with minimal interaction**:

1. **Auto-parse after sync**: When Moodle sync pulls new PDFs, they should automatically queue for Gemini parsing. No "Parse" button. The pipeline should be: sync → detect new files → parse → extract norms → generate flashcards → feed into planner. One button, full chain.

2. **Parsed content feeding the planner**: The study planner currently reads notes but **ignores extracted legal content from PDFs**. It should use the parsed TBMs and norms to create targeted study tasks like "Review Art. 41 OR TBMs" or "Practice Kausalzusammenhang definition."

3. **Auto-flashcard generation from parsed files**: When a PDF is parsed, Cloze cards should auto-generate from the extracted TBMs and Definitionen. No manual "select notes → generate" step.

4. **3-tier notifications**: The `scheduled_triggers` table exists but nothing populates it or sends push notifications. The cron job and Web Push API integration are missing.

5. **Proper authentication**: Replace anonymous sign-in with Google OAuth so your data persists across devices and is actually secured.

6. **Auto-sync on schedule**: Moodle sync is manual. Should run automatically (daily or before lectures).

### How Close Are We?

The **skeleton is complete** — all the pages, edge functions, database tables, and UI exist. The core AI integrations (Gemini for parsing, planning, flashcard generation) work. What's missing is the **glue** — the automation that connects these pieces into a single autonomous pipeline. I'd estimate we're at **60-65%** of the full vision. The remaining 35% is almost entirely about removing manual steps and making things trigger automatically.

