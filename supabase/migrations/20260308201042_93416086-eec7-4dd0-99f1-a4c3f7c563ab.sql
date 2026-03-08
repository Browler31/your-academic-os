
-- Add WebUntis config to profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS webuntis_school text DEFAULT 'zhaw-sml-l',
  ADD COLUMN IF NOT EXISTS webuntis_entity_id bigint DEFAULT 17213;

-- Create timetable_entries table
CREATE TABLE public.timetable_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  course_id uuid REFERENCES public.courses(id) ON DELETE SET NULL,
  subject_name text NOT NULL,
  subject_short text,
  teacher_name text,
  room_name text,
  day_of_week integer NOT NULL,
  start_time time NOT NULL,
  end_time time NOT NULL,
  date date NOT NULL,
  webuntis_lesson_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.timetable_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own timetable entries"
  ON public.timetable_entries FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own timetable entries"
  ON public.timetable_entries FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own timetable entries"
  ON public.timetable_entries FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own timetable entries"
  ON public.timetable_entries FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Unique constraint to prevent duplicates on re-sync
CREATE UNIQUE INDEX timetable_entries_unique
  ON public.timetable_entries (user_id, date, start_time, subject_short);
