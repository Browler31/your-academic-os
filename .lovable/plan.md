

## Moodle Integration for Your Study OS

### The Problem

All your study materials — Lernziele, Prüfungsfragen, lecture slides, preparation instructions, Abgabetermine — live in ZHAW Moodle. Right now you'd have to manually download and upload everything. That defeats the purpose of an autonomous system.

### How Moodle Works (Technically)

Moodle exposes a **Web Services REST API** that returns JSON. You authenticate with a personal API token (generated in your Moodle profile settings). With that token, you can programmatically:

- List all your enrolled courses
- Get all resources/files per course (PDFs, PPTX, URLs)
- Download file contents
- Get assignment deadlines (Abgabetermine)
- Get course sections with descriptions (where Lernziele and prep instructions often live)
- Get forum posts, quizzes, and announcements

ZHAW Moodle base URL is likely `https://moodle.zhaw.ch`.

### What to Build

**Phase 1 — Supabase Edge Function: Moodle Proxy**

A Supabase edge function that takes your Moodle token, calls the Moodle API, and returns structured data. This handles CORS and keeps your token server-side.

Key Moodle API endpoints to use:
- `core_enrol_get_users_courses` — list your courses
- `core_course_get_contents` — get all sections, modules, files per course
- `mod_assign_get_assignments` — get all assignments with due dates
- `core_calendar_get_calendar_events` — get calendar/deadline events
- `core_webservice_get_site_info` — verify connection

**Phase 2 — Web UI: Moodle Sync Page**

A page in the app where you:
1. Enter your Moodle token once (stored as a Supabase secret)
2. See all your enrolled courses auto-imported
3. Toggle which courses to sync
4. Hit "Sync Now" to pull all materials, deadlines, and Lernziele
5. See sync status and last-sync timestamp

**Phase 3 — Auto-Processing Pipeline**

When files are pulled from Moodle:
- Course sections with text content (Lernziele, prep instructions) are stored as structured notes
- PDF/PPTX files are downloaded and stored (in Supabase Storage or referenced for your iCloud pipeline)
- Assignment due dates become deadlines in your task system
- Calendar events become reminders

### Architecture

```text
Browser (Web UI)
    │
    ▼
Supabase Edge Function (/moodle-sync)
    │
    ├── Moodle REST API (moodle.zhaw.ch/webservice/rest/server.php)
    │     ├── Get courses
    │     ├── Get course contents (sections, files, Lernziele)
    │     ├── Get assignments (Abgabetermine)
    │     └── Download files
    │
    └── Supabase DB
          ├── courses table (auto-populated from Moodle)
          ├── deadlines table (from assignments + calendar)
          ├── notes table (Lernziele, prep instructions)
          └── files table (metadata + storage refs)
```

### Prerequisites

1. **Supabase connection** — needed for edge functions and database
2. **Your Moodle API token** — you generate this at `moodle.zhaw.ch → Preferences → Security Keys → Manage Tokens` (or similar path in ZHAW's Moodle)

### What This Gives You

Instead of manually checking Moodle, downloading files, and entering deadlines — you hit one button and everything flows into your Study OS. The system knows your courses, your deadlines, your Lernziele, and your Prüfungsvorbereitung materials. Combined with the flashcard and task system, this closes the loop: Moodle → auto-import → auto-process → autonomous study plan.

### Implementation Steps

1. Connect Supabase (or enable Lovable Cloud)
2. Create database tables for courses, deadlines, notes, files
3. Build Moodle proxy edge function
4. Build Moodle sync UI page
5. Build auto-processing logic (extract Lernziele from section descriptions, create deadline entries from assignments)
6. Add periodic re-sync capability

