CREATE TABLE metro_edit_sessions (
  id uuid PRIMARY KEY, owner_id text NOT NULL REFERENCES "user"(id),
  base_commit text NOT NULL, base_revision text NOT NULL,
  expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_uploads (
  id uuid PRIMARY KEY, edit_session_id uuid NOT NULL REFERENCES metro_edit_sessions(id),
  owner_id text NOT NULL REFERENCES "user"(id), kind text NOT NULL CHECK (kind IN ('json','png')),
  pathname text NOT NULL UNIQUE, url text, size bigint, reserved_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'reserved', expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metro_uploads_owner ON metro_uploads(owner_id, status);
CREATE TABLE metro_operations (
  id uuid PRIMARY KEY, kind text NOT NULL, scope text NOT NULL, idempotency_key text NOT NULL,
  request_digest text NOT NULL, actor_id text REFERENCES "user"(id), receipt_digest text,
  status text NOT NULL DEFAULT 'accepted', payload jsonb NOT NULL,
  checkpoint jsonb NOT NULL DEFAULT '{}', result jsonb NOT NULL DEFAULT '{}',
  lease_until timestamptz, lease_token uuid, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(scope, idempotency_key)
);
CREATE INDEX metro_operations_actor ON metro_operations(actor_id, created_at DESC);
CREATE UNIQUE INDEX metro_operations_edit_session ON metro_operations((payload->>'editSessionId')) WHERE kind='update';
CREATE TABLE metro_outbox (
  operation_id uuid PRIMARY KEY REFERENCES metro_operations(id), state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
  run_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_publications (
  repository text PRIMARY KEY, commit_sha text NOT NULL, revision text NOT NULL,
  manifest jsonb NOT NULL, json_sha text NOT NULL, png_sha text NOT NULL,
  image_url text NOT NULL, overview_url text NOT NULL, width integer NOT NULL, height integer NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_webhook_deliveries (
  id text PRIMARY KEY, event text NOT NULL, payload_digest text NOT NULL,
  state text NOT NULL DEFAULT 'pending', operation_id uuid REFERENCES metro_operations(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_github_cache (
  cache_key text PRIMARY KEY, payload jsonb NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE metro_pipeline_audit (
  id bigserial PRIMARY KEY, actor_id text, action text NOT NULL,
  operation_id uuid REFERENCES metro_operations(id), created_at timestamptz NOT NULL DEFAULT now()
);
