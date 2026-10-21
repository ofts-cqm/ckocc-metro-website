-- Committed before SES submission so uncertain outcomes cannot reopen quota.
CREATE TABLE metro_email_daily_slots (
  job_id uuid NOT NULL REFERENCES metro_email_jobs(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  quota_day date NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(job_id, quota_day),
  UNIQUE(user_id, quota_day, position)
);

-- Include existing submissions when this migration is applied partway through a day.
INSERT INTO metro_email_daily_slots(job_id,user_id,quota_day,position,reserved_at)
SELECT id,user_id,(updated_at AT TIME ZONE 'UTC')::date,
  row_number() OVER (PARTITION BY user_id,(updated_at AT TIME ZONE 'UTC')::date
                    ORDER BY updated_at,id)::integer,updated_at
FROM metro_email_jobs
WHERE kind='notification' AND status IN ('submitted','sending','outcome_unknown');

-- Existing queued emails should gain their original content without replaying sends.
UPDATE metro_email_jobs j SET payload=j.payload || jsonb_build_object('source',o.payload)
FROM metro_operations o WHERE j.operation_id=o.id AND j.kind='notification'
  AND j.status='pending' AND NOT (j.payload ? 'source');
