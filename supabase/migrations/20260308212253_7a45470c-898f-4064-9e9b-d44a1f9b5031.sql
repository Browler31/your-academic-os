-- Add extracted_content to files for parsed PDF data
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS extracted_content jsonb;
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS extracted_at timestamp with time zone;
ALTER TABLE public.files ADD COLUMN IF NOT EXISTS extraction_status text DEFAULT 'pending';

-- Allow updating files (needed for extraction results)
CREATE POLICY "Users can update own files" ON public.files FOR UPDATE USING (auth.uid() = user_id);

-- Scheduled triggers for notifications
CREATE TABLE IF NOT EXISTS public.scheduled_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  trigger_type text NOT NULL, -- 'deadline_24h', 'deadline_1h', 'lecture_prep', 'lecture_5m'
  reference_id uuid, -- task_id, deadline_id, or timetable_entry_id
  title text NOT NULL,
  body text NOT NULL,
  scheduled_for timestamp with time zone NOT NULL,
  sent boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.scheduled_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own triggers" ON public.scheduled_triggers FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own triggers" ON public.scheduled_triggers FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own triggers" ON public.scheduled_triggers FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own triggers" ON public.scheduled_triggers FOR DELETE USING (auth.uid() = user_id);

-- Consistency streaks table
CREATE TABLE IF NOT EXISTS public.study_streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  current_streak integer DEFAULT 0,
  longest_streak integer DEFAULT 0,
  last_study_date date,
  updated_at timestamp with time zone DEFAULT now()
);

ALTER TABLE public.study_streaks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own streaks" ON public.study_streaks FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own streaks" ON public.study_streaks FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own streaks" ON public.study_streaks FOR UPDATE USING (auth.uid() = user_id);