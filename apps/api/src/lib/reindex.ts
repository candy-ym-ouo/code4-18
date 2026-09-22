import { pool, type DbClient } from "./db.js";
import { AppError } from "./errors.js";
import { scanStorage } from "./attachmentFiles.js";
import {
  attachmentOwnerTypes,
  type AttachmentOwnerType
} from "@handcraft/contracts";
import {
  describeIssue,
  issueSeverity,
  ownerTables,
  reconcileAttachments,
  type AttachmentFinding,
  type DbAttachment,
  type IntegrityIssueKind,
  type ReconcileSummary
} from "./integrity.js";

const REINDEX_LOCK_KEY = "handcraft_attachment_reindex";

export type ReindexOutcome = {
  runId: string;
  summary: ReconcileSummary;
};

/**
 * 执行一次全量附件完整性重索引：
 *
 * 1. 使用会话级 advisory lock 阻止并发重索引；
 * 2. REPEATABLE READ 单事务读取附件/所有者快照并写入索引，保证引用校验
 *    基于同一数据库快照，不受扫描期间并发提交影响；
 * 3. 以“只记录观测值、绝不回写基线”的方式刷新索引；
 * 4. 问题与孤立文件采用 upsert + 批量解析，重复执行结果一致（幂等）。
 */
export async function reindexAttachments(options: { triggeredByUserId?: string } = {}): Promise<ReindexOutcome> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked",
      [REINDEX_LOCK_KEY]
    );
    if (!locked.rows[0]?.locked) {
      throw new AppError(409, "REINDEX_ALREADY_RUNNING", "附件重索引正在执行中，请稍后再试");
    }

    try {
      // 磁盘哈希可能较慢，但这是运维批处理；持有事务快照可避免“所有者刚删除”类竞态误报。
      await client.query("BEGIN");
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const attachments = await fetchAttachments(client);
      const existingOwnerIds = await fetchExistingOwnerIds(client);
      const observedFiles = await scanStorage();
      const result = reconcileAttachments({ attachments, filesByStorageKey: observedFiles, existingOwnerIds });
      await persistIndex(client, result.findings, result.orphans);
      const runResult = await client.query<{ id: string }>(
        `INSERT INTO attachment_index_runs
           (triggered_by_user_id, total_attachments, ok_count, missing_count, conflict_count,
            owner_dangling_count, unreadable_count, orphan_count, open_issue_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          options.triggeredByUserId ?? null,
          result.summary.totalAttachments,
          result.summary.okCount,
          result.summary.missingCount,
          result.summary.conflictCount,
          result.summary.ownerDanglingCount,
          result.summary.unreadableCount,
          result.summary.orphanCount,
          result.summary.openIssueCount
        ]
      );
      await client.query("COMMIT");
      return { runId: runResult.rows[0]?.id ?? "", summary: result.summary };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [REINDEX_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

async function fetchAttachments(client: DbClient): Promise<DbAttachment[]> {
  const result = await client.query<{
    id: string;
    owner_type: AttachmentOwnerType;
    owner_id: string;
    storage_key: string;
    mime_type: string;
    byte_size: string;
    sha256: string;
  }>(
    `SELECT id, owner_type, owner_id, storage_key, mime_type, byte_size::text AS byte_size, sha256
     FROM attachments`
  );
  return result.rows.map((row) => ({
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: BigInt(row.byte_size),
    sha256: row.sha256
  }));
}

async function fetchExistingOwnerIds(
  client: DbClient
): Promise<Record<AttachmentOwnerType, Set<string>>> {
  const result = {} as Record<AttachmentOwnerType, Set<string>>;
  for (const ownerType of attachmentOwnerTypes) {
    const table = ownerTables[ownerType];
    const rows = await client.query<{ id: string }>(`SELECT id FROM ${table}`);
    result[ownerType] = new Set(rows.rows.map((row) => row.id));
  }
  return result;
}

async function persistIndex(
  client: DbClient,
  findings: AttachmentFinding[],
  orphans: {
    storageKey: string;
    observation:
      | { state: "present"; sha256: string; byteSize: bigint }
      | { state: "unreadable"; error: string };
  }[]
): Promise<void> {
  for (const finding of findings) {
    const observed = finding.observed;
    const present = observed?.state === "present" ? observed : undefined;
    const readError = observed?.state === "unreadable" ? observed.error.slice(0, 300) : null;
    await client.query(
      `INSERT INTO attachment_index
         (attachment_id, status, observed_sha256, observed_byte_size, read_error, indexed_at, verified_at)
       VALUES ($1, $2::attachment_index_status, $3, $4, $5, now(), now())
       ON CONFLICT (attachment_id) DO UPDATE SET
         status = EXCLUDED.status,
         observed_sha256 = EXCLUDED.observed_sha256,
         observed_byte_size = EXCLUDED.observed_byte_size,
         read_error = EXCLUDED.read_error,
         verified_at = now()`,
      [
        finding.attachment.id,
        finding.status,
        present?.sha256 ?? null,
        present ? present.byteSize.toString() : null,
        readError
      ]
    );

    for (const kind of finding.issues) {
      await client.query(
        `INSERT INTO attachment_integrity_issues
           (attachment_id, storage_key, kind, severity, status, detail, first_seen_at, last_seen_at)
         VALUES ($1, $2, $3, $4::integrity_issue_severity, 'OPEN', $5, now(), now())
         ON CONFLICT (attachment_id, kind) WHERE status = 'OPEN' DO UPDATE SET
           storage_key = EXCLUDED.storage_key,
           detail = EXCLUDED.detail,
           last_seen_at = now()`,
        [
          finding.attachment.id,
          finding.attachment.storageKey,
          kind,
          issueSeverity(kind),
          describeIssue(kind, finding)
        ]
      );
    }
  }

  const issueAttachmentIds = findings
    .filter((finding) => finding.issues.length > 0)
    .map((finding) => finding.attachment.id);
  const currentIssueKeys = new Set(
    findings.flatMap((finding) =>
      finding.issues.map((kind) => `${finding.attachment.id}:${kind}` as const)
    )
  );
  // 当前扫描未复现的 OPEN 问题全部解析；无附件的孤儿问题不受影响（attachment_id IS NULL）。
  if (issueAttachmentIds.length > 0) {
    const openIssues = await client.query<{ id: string; attachment_id: string; kind: IntegrityIssueKind }>(
      `SELECT id, attachment_id, kind FROM attachment_integrity_issues
       WHERE status = 'OPEN' AND attachment_id = ANY($1::uuid[])`,
      [issueAttachmentIds]
    );
    for (const issue of openIssues.rows) {
      if (!currentIssueKeys.has(`${issue.attachment_id}:${issue.kind}`)) {
        await client.query(
          `UPDATE attachment_integrity_issues
           SET status = 'RESOLVED', resolved_at = now(), resolve_reason = 'NOT_REPRODUCED'
           WHERE id = $1`,
          [issue.id]
        );
      }
    }
  }

  for (const orphan of orphans) {
    const present = orphan.observation.state === "present" ? orphan.observation : undefined;
    const readError = orphan.observation.state === "unreadable" ? orphan.observation.error.slice(0, 300) : null;
    await client.query(
      `INSERT INTO orphan_files
         (storage_key, observed_sha256, observed_byte_size, read_error, status, first_seen_at, last_seen_at, resolved_at)
       VALUES ($1, $2, $3, $4, 'OPEN', now(), now(), null)
       ON CONFLICT (storage_key) DO UPDATE SET
         observed_sha256 = EXCLUDED.observed_sha256,
         observed_byte_size = EXCLUDED.observed_byte_size,
         read_error = EXCLUDED.read_error,
         status = 'OPEN',
         last_seen_at = now(),
         resolved_at = null`,
      [
        orphan.storageKey,
        present?.sha256 ?? null,
        present ? present.byteSize.toString() : null,
        readError
      ]
    );
  }

  const orphanKeys = orphans.map((orphan) => orphan.storageKey);
  if (orphanKeys.length > 0) {
    await client.query(
      `UPDATE orphan_files
       SET status = 'RESOLVED', resolved_at = now()
       WHERE status = 'OPEN' AND NOT (storage_key = ANY($1::varchar[]))`,
      [orphanKeys]
    );
  } else {
    await client.query(
      `UPDATE orphan_files SET status = 'RESOLVED', resolved_at = now() WHERE status = 'OPEN'`
    );
  }
}
