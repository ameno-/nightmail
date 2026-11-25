-- A fifth focus (src/workspace-focus.ts): personal, an inbox of their own. Constraints only, NOT VALID as in 508: no scan.
SET LOCAL lock_timeout = '2s';
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_focus_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_focus_check CHECK (focus <@ ARRAY['marketing','newsletter','developer','agents','personal']::text[] AND cardinality(focus) <= 5) NOT VALID;
ALTER TABLE operation_settings DROP CONSTRAINT IF EXISTS operation_settings_focus_check;
ALTER TABLE operation_settings ADD CONSTRAINT operation_settings_focus_check CHECK (focus <@ ARRAY['marketing','newsletter','developer','agents','personal']::text[] AND cardinality(focus) <= 5) NOT VALID;
