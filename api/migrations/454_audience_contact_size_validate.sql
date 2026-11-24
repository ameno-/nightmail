-- Validate audience_contacts size constraints under SHARE UPDATE EXCLUSIVE (does not block reads or writes).
SET LOCAL lock_timeout = '1min';
ALTER TABLE audience_contacts VALIDATE CONSTRAINT audience_contacts_properties_size;
ALTER TABLE audience_contacts VALIDATE CONSTRAINT audience_contacts_name_length;
