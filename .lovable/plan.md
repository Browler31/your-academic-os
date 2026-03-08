

# WebUntis Timetable Integration

## What we know

The WebUntis public API works without authentication and returns your full weekly timetable as structured JSON:
- **URL pattern**: `https://zhaw-sml-l.webuntis.com/WebUntis/api/public/timetable/weekly/data?elementType=1&elementId=17213&date=YYYY-MM-DD&formatId=1`
- **Data includes**: lesson periods with `date` (e.g. `20260311`), `startTime`/`endTime` (e.g. `1600`/`1645`), and element references (type 1=class, 2=teacher, 3=room, 4=subject) with IDs that map to names in an `elements` array at the end of the response
- **No auth needed** — this is a public timetable endpoint

## What we'll build

### 1. New edge function: `webuntis-sync`

Fetches your timetable from WebUntis and stores it in a new `timetable_entries` table. Accepts a date range and fetches week-by-week. Parses the JSON response to extract:
- Subject name + abbreviation (matched to your existing courses via short_name patterns)
- Day of week, start time, end time
- Room and teacher info
- Links each entry to the matching course in your `courses` table

### 2. New database table: `timetable_entries`

```text
timetable_entries
├── id (uuid, PK)
├── user_id (uuid, NOT NULL)
├── course_id (uuid, nullable FK → courses)
├── subject_name (text)
├── subject_short (text)
├── teacher_name (text, nullable)
├── room_name (text, nullable)
├── day_of_week (int, 1=Mon..5=Fri)
├── start_time (time)
├── end_time (time)
├── date (date, specific occurrence)
├── webuntis_lesson_id (bigint)
├── created_at (timestamptz)
```

RLS: standard per-user policies (select, insert, update, delete).

### 3. Store WebUntis config in profiles

Add two columns to `profiles`:
- `webuntis_school` (text, default `'zhaw-sml-l'`)
- `webuntis_entity_id` (bigint, default `17213`)

This way the edge function knows which class timetable to fetch without hardcoding.

### 4. Course matching logic

The edge function will match WebUntis subjects to your existing Moodle courses by comparing the subject short name (e.g. `"FER"`) against patterns in the course `short_name` field (e.g. `"w.BA.XX.1FER-RE.XX.2026-FS"`). This links timetable entries to courses, which is the missing piece for the AI planner to know *when* each course happens.

### 5. Timetable page in the UI

New `/timetable` page showing a weekly calendar grid:
- Columns = Mon–Fri, rows = time slots (08:00–18:00)
- Colored blocks per course
- Shows room and teacher
- Week navigation (prev/next)
- "Sync from WebUntis" button

Also add a nav item in the sidebar.

### 6. Dashboard integration

Add a "Today's schedule" card to the dashboard showing today's lessons in chronological order — so you immediately see what's coming up.

## Technical details

- The WebUntis API response contains an `elements` array that maps element IDs to names (e.g. `{type: 4, id: 95, name: "FER", longName: "Familienrecht"}`)
- Lesson periods can span multiple 45-min blocks with the same `lessonId` — we'll merge consecutive blocks into single entries
- The edge function fetches one week at a time and can be called with a semester date range to bulk-import the full schedule
- The "Sync Timetable" action will be added to the Moodle Sync page as well, since it's a natural companion

