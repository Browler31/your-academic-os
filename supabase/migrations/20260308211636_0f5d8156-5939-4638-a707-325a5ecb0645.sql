ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS moodle_token text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS moodle_verified_at timestamp with time zone;