-- What a workspace is here for (src/workspace-focus.ts), first one leading: NULL until it was asked, empty when skipped.
-- A nullable column: metadata only, no table rewrite.
SET LOCAL lock_timeout = '2s';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS focus text[];
ALTER TABLE operation_settings ADD COLUMN IF NOT EXISTS focus text[];
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_focus_check;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_focus_check CHECK (focus <@ ARRAY['marketing','newsletter','developer','agents']::text[] AND cardinality(focus) <= 4) NOT VALID;
ALTER TABLE operation_settings DROP CONSTRAINT IF EXISTS operation_settings_focus_check;
ALTER TABLE operation_settings ADD CONSTRAINT operation_settings_focus_check CHECK (focus <@ ARRAY['marketing','newsletter','developer','agents']::text[] AND cardinality(focus) <= 4) NOT VALID;
