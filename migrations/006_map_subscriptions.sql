ALTER TABLE metro_email_preferences
  ADD COLUMN map_updates boolean NOT NULL DEFAULT false,
  ADD COLUMN map_consent_version integer NOT NULL DEFAULT 0,
  ADD COLUMN map_consent_at timestamptz;

-- Each visible transition has its own identity, including a rollback to old bytes.
CREATE TABLE metro_map_publication_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repository text NOT NULL,
  commit_sha text NOT NULL,
  revision text NOT NULL,
  summary text NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  recipient_cursor text,
  recipients_complete boolean NOT NULL DEFAULT false
);
ALTER TABLE metro_email_jobs ADD COLUMN publication_event_id uuid REFERENCES metro_map_publication_events(id);
CREATE UNIQUE INDEX metro_email_jobs_publication_recipient ON metro_email_jobs(publication_event_id,user_id);
