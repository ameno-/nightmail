-- Bound stored contact properties and name length at the database layer (NOT VALID: instant metadata check).
-- 16640 bytes allows 16 KiB of compact JSON plus up to 256 bytes for PostgreSQL jsonb::text whitespace formatting.
SET LOCAL lock_timeout = '2s';
ALTER TABLE audience_contacts
  ADD CONSTRAINT audience_contacts_properties_size
    CHECK (jsonb_typeof(properties) = 'object' AND octet_length(properties::text) <= 16640) NOT VALID,
  ADD CONSTRAINT audience_contacts_name_length
    CHECK (name IS NULL OR char_length(name) <= 200) NOT VALID;
