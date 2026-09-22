-- 附件完整性索引：哈希/所有者/引用校验、孤立文件扫描与幂等重索引。
-- 设计原则：索引行只记录“观测到的”状态；附件表中的基线（sha256/byte_size/storage_key）
-- 永远不会被重索引覆盖，冲突只报告、不静默替换。

CREATE TYPE attachment_index_status AS ENUM ('OK', 'MISSING', 'CONFLICT', 'OWNER_DANGLING', 'UNREADABLE');
CREATE TYPE integrity_issue_severity AS ENUM ('CRITICAL', 'WARNING');
CREATE TYPE integrity_issue_status AS ENUM ('OPEN', 'RESOLVED');
CREATE TYPE orphan_file_status AS ENUM ('OPEN', 'RESOLVED');

CREATE TABLE attachment_index (
  attachment_id uuid PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
  status attachment_index_status NOT NULL,
  observed_sha256 char(64),
  observed_byte_size bigint CHECK (observed_byte_size IS NULL OR observed_byte_size >= 0),
  read_error varchar(300),
  indexed_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_index_status_idx ON attachment_index(status);

CREATE TABLE attachment_index_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz NOT NULL DEFAULT now(),
  triggered_by_user_id uuid REFERENCES users(id),
  total_attachments integer NOT NULL DEFAULT 0 CHECK (total_attachments >= 0),
  ok_count integer NOT NULL DEFAULT 0 CHECK (ok_count >= 0),
  missing_count integer NOT NULL DEFAULT 0 CHECK (missing_count >= 0),
  conflict_count integer NOT NULL DEFAULT 0 CHECK (conflict_count >= 0),
  owner_dangling_count integer NOT NULL DEFAULT 0 CHECK (owner_dangling_count >= 0),
  unreadable_count integer NOT NULL DEFAULT 0 CHECK (unreadable_count >= 0),
  orphan_count integer NOT NULL DEFAULT 0 CHECK (orphan_count >= 0),
  open_issue_count integer NOT NULL DEFAULT 0 CHECK (open_issue_count >= 0)
);
CREATE INDEX attachment_index_runs_started_idx ON attachment_index_runs(started_at DESC);

CREATE TABLE attachment_integrity_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attachment_id uuid REFERENCES attachments(id) ON DELETE CASCADE,
  storage_key varchar(255),
  kind varchar(40) NOT NULL,
  severity integrity_issue_severity NOT NULL,
  status integrity_issue_status NOT NULL DEFAULT 'OPEN',
  detail varchar(500) NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolve_reason varchar(40),
  CHECK (
    (status = 'OPEN' AND resolved_at IS NULL AND resolve_reason IS NULL)
    OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolve_reason IS NOT NULL)
  )
);
CREATE INDEX integrity_issues_open_idx
  ON attachment_integrity_issues(status, severity, last_seen_at DESC)
  WHERE status = 'OPEN';
CREATE INDEX integrity_issues_attachment_idx
  ON attachment_integrity_issues(attachment_id, kind, status);
-- 同一附件、同一问题类型在任意时刻只允许一条 OPEN 记录，使重索引可以幂等 upsert；
-- 问题消失后转为 RESOLVED，再次出现则写入新的 OPEN 行，历史完整保留。
CREATE UNIQUE INDEX integrity_issues_open_kind_uq
  ON attachment_integrity_issues(attachment_id, kind)
  WHERE status = 'OPEN';

CREATE TABLE orphan_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  storage_key varchar(255) NOT NULL UNIQUE,
  observed_sha256 char(64),
  observed_byte_size bigint CHECK (observed_byte_size IS NULL OR observed_byte_size >= 0),
  read_error varchar(300),
  status orphan_file_status NOT NULL DEFAULT 'OPEN',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (
    (status = 'OPEN' AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND resolved_at IS NOT NULL)
  )
);
CREATE INDEX orphan_files_open_idx
  ON orphan_files(status, last_seen_at DESC)
  WHERE status = 'OPEN';
