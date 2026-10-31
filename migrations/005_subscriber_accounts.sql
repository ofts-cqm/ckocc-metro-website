ALTER TABLE metro_profiles DROP CONSTRAINT metro_profiles_role_check;
ALTER TABLE metro_profiles ADD CONSTRAINT metro_profiles_role_check CHECK(role IN ('subscriber','collaborator','admin'));
ALTER TABLE metro_invitations DROP CONSTRAINT metro_invitations_role_check;
ALTER TABLE metro_invitations ADD CONSTRAINT metro_invitations_role_check CHECK(role IN ('subscriber','collaborator','admin'));
ALTER TABLE metro_invitations DROP CONSTRAINT metro_invitations_kind_check;
ALTER TABLE metro_invitations ADD CONSTRAINT metro_invitations_kind_check CHECK(kind IN ('invite','reset','subscribe'));
ALTER TABLE metro_invitations ADD COLUMN locale text NOT NULL DEFAULT 'en-us';
CREATE TABLE metro_subscription_mail (
  invitation_id uuid PRIMARY KEY REFERENCES metro_invitations(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','submitted','skipped','outcome_unknown')),
  provider_message_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
