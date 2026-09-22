CREATE TYPE attachment_integrity_status AS ENUM ('OK', 'HASH_MISMATCH', 'FILE_MISSING', 'OWNER_MISSING', 'ORPHAN_FILE');

-- 附件完整性索引是只读观察层：扫描器只写入本表，绝不修改 attachments 或磁盘文件。
-- 因此本表不建外键；record_present / file_present 记录最近一次扫描时的真实状态，
-- 归属与期望哈希在记录消失后仍保留最后已知值，避免缺失对象被静默抹除。
CREATE TABLE attachment_integrity_index (
  storage_key text PRIMARY KEY CHECK (char_length(storage_key) BETWEEN 1 AND 1024),
  attachment_id uuid,
  record_present boolean NOT NULL,
  file_present boolean NOT NULL,
  owner_type attachment_owner_type,
  owner_id uuid,
  owner_present boolean,
  expected_sha256 char(64),
  expected_byte_size bigint CHECK (expected_byte_size IS NULL OR expected_byte_size > 0),
  actual_sha256 char(64),
  actual_byte_size bigint CHECK (actual_byte_size IS NULL OR actual_byte_size >= 0),
  status attachment_integrity_status NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_scanned_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_integrity_status_idx ON attachment_integrity_index(status);
CREATE INDEX attachment_integrity_attachment_idx ON attachment_integrity_index(attachment_id) WHERE attachment_id IS NOT NULL;
