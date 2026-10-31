-- Remove account credentials without erasing shared work or delivery evidence.
ALTER TABLE metro_operations DROP CONSTRAINT metro_operations_actor_id_fkey;
ALTER TABLE metro_operations ADD CONSTRAINT metro_operations_actor_id_fkey
  FOREIGN KEY (actor_id) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE metro_edit_sessions ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE metro_edit_sessions DROP CONSTRAINT metro_edit_sessions_owner_id_fkey;
ALTER TABLE metro_edit_sessions ADD CONSTRAINT metro_edit_sessions_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE metro_uploads ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE metro_uploads DROP CONSTRAINT metro_uploads_owner_id_fkey;
ALTER TABLE metro_uploads ADD CONSTRAINT metro_uploads_owner_id_fkey
  FOREIGN KEY (owner_id) REFERENCES "user"(id) ON DELETE SET NULL;

ALTER TABLE metro_email_jobs ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE metro_email_jobs DROP CONSTRAINT metro_email_jobs_user_id_fkey;
ALTER TABLE metro_email_jobs ADD CONSTRAINT metro_email_jobs_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE SET NULL;
ALTER TABLE metro_email_jobs DROP CONSTRAINT metro_email_jobs_token_id_fkey;
ALTER TABLE metro_email_jobs ADD CONSTRAINT metro_email_jobs_token_id_fkey
  FOREIGN KEY (token_id) REFERENCES metro_email_tokens(id) ON DELETE SET NULL;
ALTER TABLE metro_email_daily_slots ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE metro_email_daily_slots DROP CONSTRAINT metro_email_daily_slots_user_id_fkey;
ALTER TABLE metro_email_daily_slots ADD CONSTRAINT metro_email_daily_slots_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE SET NULL;
