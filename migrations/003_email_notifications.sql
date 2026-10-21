CREATE TABLE metro_email_preferences (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  consent_version integer NOT NULL DEFAULT 0,
  consent_at timestamptz,
  locale text NOT NULL DEFAULT 'en-us',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_email_tokens (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verification','change','unsubscribe')),
  address text NOT NULL CHECK (address=lower(address)),
  source_email text,
  auth_version integer,
  token_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metro_email_tokens_user ON metro_email_tokens(user_id,purpose,created_at DESC);
CREATE TABLE metro_email_jobs (
  id uuid PRIMARY KEY,
  operation_id uuid REFERENCES metro_operations(id),
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('notification','verification')),
  address text NOT NULL CHECK (address=lower(address)),
  consent_version integer,
  token_id uuid REFERENCES metro_email_tokens(id),
  locale text NOT NULL DEFAULT 'en-us',
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','submitted','skipped','failed','outcome_unknown')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  ses_message_id text,
  error_code text,
  delivery_status text,
  feedback_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,user_id)
);
CREATE INDEX metro_email_jobs_due ON metro_email_jobs(status,next_attempt_at);
CREATE UNIQUE INDEX metro_email_jobs_ses ON metro_email_jobs(ses_message_id) WHERE ses_message_id IS NOT NULL;
CREATE TABLE metro_email_outbox (
  job_id uuid PRIMARY KEY REFERENCES metro_email_jobs(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  run_id text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_email_feedback (
  topic_arn text NOT NULL,
  message_id text NOT NULL,
  ses_message_id text,
  event_kind text NOT NULL,
  affected_addresses jsonb NOT NULL DEFAULT '[]',
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(topic_arn,message_id)
);
CREATE INDEX metro_email_feedback_ses ON metro_email_feedback(ses_message_id);
CREATE TABLE metro_email_suppressions (
  address text PRIMARY KEY CHECK (address=lower(address)),
  reason text NOT NULL,
  feedback_message_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_email_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  launch_cutoff timestamptz NOT NULL DEFAULT now()
);
INSERT INTO metro_email_state(singleton) VALUES(true);
