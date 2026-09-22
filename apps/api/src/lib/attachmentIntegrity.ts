import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { attachmentIntegrityStatuses, type AttachmentIntegrityStatus, type AttachmentOwnerType } from "@handcraft/contracts";
import { pool, withTransaction, type DbClient } from "./db.js";
import { writeAudit } from "./audit.js";
import { config } from "../config.js";

export type IntegrityStatusCounts = Record<AttachmentIntegrityStatus, number>;

export type IntegrityScanSummary = {
  recordsScanned: number;
  filesScanned: number;
  transientFilesSkipped: number;
  invalidKeysSkipped: number;
  entriesWritten: number;
  entriesRemoved: number;
  statusCounts: IntegrityStatusCounts;
  scannedAt: string;
};

type AttachmentRecord = {
  id: string;
  storage_key: string;
  owner_type: AttachmentOwnerType;
  owner_id: string;
  owner_present: boolean;
  sha256: string;
  byte_size: string;
};

type DiskFile = {
  storageKey: string;
  byteSize: number;
  sha256: string;
};

type ObservedEntry = {
  storageKey: string;
  attachmentId: string | null;
  recordPresent: boolean;
  filePresent: boolean;
  ownerType: AttachmentOwnerType | null;
  ownerId: string | null;
  ownerPresent: boolean | null;
  expectedSha256: string | null;
  expectedByteSize: number | null;
  actualSha256: string | null;
  actualByteSize: number | null;
  status: AttachmentIntegrityStatus;
};

export function emptyStatusCounts(): IntegrityStatusCounts {
  return { OK: 0, HASH_MISMATCH: 0, FILE_MISSING: 0, OWNER_MISSING: 0, ORPHAN_FILE: 0 };
}

// 上传暂存（*.tmp）和删除中转（*.deleting-*）是瞬态文件，不计入索引也不视为孤立文件。
export function isTransientUploadArtifact(storageKey: string): boolean {
  const name = storageKey.slice(storageKey.lastIndexOf("/") + 1);
  return name.endsWith(".tmp") || name.includes(".deleting-");
}

export function classifyIntegrityEntry(input: {
  recordPresent: boolean;
  filePresent: boolean;
  ownerPresent: boolean | null;
  hashMatches: boolean | null;
}): AttachmentIntegrityStatus {
  if (input.recordPresent && !input.filePresent) return "FILE_MISSING";
  if (!input.recordPresent && input.filePresent) return "ORPHAN_FILE";
  if (input.recordPresent && input.filePresent) {
    if (input.hashMatches === false) return "HASH_MISMATCH";
    if (input.ownerPresent === false) return "OWNER_MISSING";
    return "OK";
  }
  throw new Error("INTEGRITY_ENTRY_WITHOUT_OBJECT");
}

async function hashFile(filePath: string): Promise<{ byteSize: number; sha256: string }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    byteSize += (chunk as Buffer).length;
  }
  return { byteSize, sha256: hash.digest("hex") };
}

export async function walkUploadFiles(rootDir: string = config.UPLOAD_DIR): Promise<{ files: DiskFile[]; transientSkipped: number; invalidSkipped: number }> {
  const root = path.resolve(rootDir);
  const files: DiskFile[] = [];
  let transientSkipped = 0;
  let invalidSkipped = 0;

  async function walk(directory: string, prefix: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return;
      throw error;
    }
    for (const dirent of dirents) {
      const key = prefix ? `${prefix}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        await walk(path.join(directory, dirent.name), key);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (isTransientUploadArtifact(key)) {
        transientSkipped += 1;
        continue;
      }
      if (key.length > 1024) {
        invalidSkipped += 1;
        continue;
      }
      try {
        const hashed = await hashFile(path.join(directory, dirent.name));
        files.push({ storageKey: key, ...hashed });
      } catch (error) {
        // 扫描与并发上传/删除竞争时文件可能刚好消失，按不存在处理，下次扫描收敛。
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
    }
  }

  await walk(root, "");
  return { files, transientSkipped, invalidSkipped };
}

async function loadAttachmentRecords(): Promise<AttachmentRecord[]> {
  const result = await pool.query<AttachmentRecord>(
    `SELECT a.id, a.storage_key, a.owner_type, a.owner_id, a.sha256, a.byte_size::text,
            CASE a.owner_type
              WHEN 'BATCH' THEN b.id IS NOT NULL
              WHEN 'COLOR_CHANGE' THEN cc.id IS NOT NULL
              WHEN 'PROJECT' THEN p.id IS NOT NULL
              WHEN 'CONSUMPTION' THEN c.id IS NOT NULL
            END AS owner_present
       FROM attachments a
       LEFT JOIN batches b ON a.owner_type = 'BATCH' AND b.id = a.owner_id
       LEFT JOIN color_changes cc ON a.owner_type = 'COLOR_CHANGE' AND cc.id = a.owner_id
       LEFT JOIN projects p ON a.owner_type = 'PROJECT' AND p.id = a.owner_id
       LEFT JOIN consumptions c ON a.owner_type = 'CONSUMPTION' AND c.id = a.owner_id`
  );
  return result.rows;
}

function observeRecords(records: AttachmentRecord[], diskByKey: Map<string, DiskFile>): ObservedEntry[] {
  return records.map((record) => {
    const file = diskByKey.get(record.storage_key) ?? null;
    const expectedByteSize = Number(record.byte_size);
    const hashMatches = file ? file.sha256 === record.sha256 && file.byteSize === expectedByteSize : null;
    return {
      storageKey: record.storage_key,
      attachmentId: record.id,
      recordPresent: true,
      filePresent: file !== null,
      ownerType: record.owner_type,
      ownerId: record.owner_id,
      ownerPresent: record.owner_present,
      expectedSha256: record.sha256,
      expectedByteSize,
      actualSha256: file?.sha256 ?? null,
      actualByteSize: file?.byteSize ?? null,
      status: classifyIntegrityEntry({
        recordPresent: true,
        filePresent: file !== null,
        ownerPresent: record.owner_present,
        hashMatches
      })
    };
  });
}

function observeOrphanFiles(files: DiskFile[], recordKeys: Set<string>): ObservedEntry[] {
  return files
    .filter((file) => !recordKeys.has(file.storageKey))
    .map((file) => ({
      storageKey: file.storageKey,
      attachmentId: null,
      recordPresent: false,
      filePresent: true,
      ownerType: null,
      ownerId: null,
      ownerPresent: null,
      expectedSha256: null,
      expectedByteSize: null,
      actualSha256: file.sha256,
      actualByteSize: file.byteSize,
      status: classifyIntegrityEntry({ recordPresent: false, filePresent: true, ownerPresent: null, hashMatches: null })
    }));
}

// 幂等 upsert：以 storage_key 为唯一键；first_seen_at 与 status_changed_at 只在状态变化时推进；
// 记录消失（record_present = false）时保留最后已知的归属与期望哈希，绝不静默改写或抹除。
async function upsertEntry(client: DbClient, entry: ObservedEntry): Promise<void> {
  await client.query(
    `INSERT INTO attachment_integrity_index AS idx
       (storage_key, attachment_id, record_present, file_present,
        owner_type, owner_id, owner_present,
        expected_sha256, expected_byte_size, actual_sha256, actual_byte_size,
        status, first_seen_at, last_scanned_at, status_changed_at)
     VALUES ($1, $2, $3, $4, $5::attachment_owner_type, $6, $7, $8, $9, $10, $11, $12::attachment_integrity_status, now(), now(), now())
     ON CONFLICT (storage_key) DO UPDATE SET
       attachment_id      = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.attachment_id ELSE idx.attachment_id END,
       record_present     = EXCLUDED.record_present,
       file_present       = EXCLUDED.file_present,
       owner_type         = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.owner_type ELSE idx.owner_type END,
       owner_id           = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.owner_id ELSE idx.owner_id END,
       owner_present      = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.owner_present ELSE idx.owner_present END,
       expected_sha256    = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.expected_sha256 ELSE idx.expected_sha256 END,
       expected_byte_size = CASE WHEN EXCLUDED.record_present THEN EXCLUDED.expected_byte_size ELSE idx.expected_byte_size END,
       actual_sha256      = CASE WHEN EXCLUDED.file_present THEN EXCLUDED.actual_sha256 ELSE NULL END,
       actual_byte_size   = CASE WHEN EXCLUDED.file_present THEN EXCLUDED.actual_byte_size ELSE NULL END,
       status             = EXCLUDED.status,
       last_scanned_at    = now(),
       status_changed_at  = CASE WHEN idx.status IS DISTINCT FROM EXCLUDED.status THEN now() ELSE idx.status_changed_at END`,
    [
      entry.storageKey,
      entry.attachmentId,
      entry.recordPresent,
      entry.filePresent,
      entry.ownerType,
      entry.ownerId,
      entry.ownerPresent,
      entry.expectedSha256,
      entry.expectedByteSize,
      entry.actualSha256,
      entry.actualByteSize,
      entry.status
    ]
  );
}

export async function runAttachmentIntegrityScan(actorUserId: string, requestId?: string): Promise<IntegrityScanSummary> {
  const records = await loadAttachmentRecords();
  const disk = await walkUploadFiles();
  const diskByKey = new Map(disk.files.map((file) => [file.storageKey, file]));
  const observed = [
    ...observeRecords(records, diskByKey),
    ...observeOrphanFiles(disk.files, new Set(records.map((record) => record.storage_key)))
  ];

  return withTransaction(async (client) => {
    for (const entry of observed) {
      await upsertEntry(client, entry);
    }
    // 记录与文件都已消失的对象才从索引移除；仅文件缺失或仅记录缺失的条目必须保留并标记。
    const removed = await client.query(
      "DELETE FROM attachment_integrity_index WHERE NOT (storage_key = ANY($1::text[]))",
      [observed.map((entry) => entry.storageKey)]
    );
    const statusCounts = emptyStatusCounts();
    for (const entry of observed) statusCounts[entry.status] += 1;
    const summary: IntegrityScanSummary = {
      recordsScanned: records.length,
      filesScanned: disk.files.length,
      transientFilesSkipped: disk.transientSkipped,
      invalidKeysSkipped: disk.invalidSkipped,
      entriesWritten: observed.length,
      entriesRemoved: removed.rowCount ?? 0,
      statusCounts,
      scannedAt: new Date().toISOString()
    };
    await writeAudit(client, {
      actorUserId,
      action: "REINDEX",
      entityType: "ATTACHMENT_INTEGRITY",
      afterData: summary,
      requestId
    });
    return summary;
  });
}

export async function attachmentIntegritySummary(): Promise<{
  totalEntries: number;
  statusCounts: IntegrityStatusCounts;
  lastScannedAt: string | null;
}> {
  const result = await pool.query<{ status: AttachmentIntegrityStatus; count: string; last_scanned_at: Date | null }>(
    `SELECT status, count(*)::text, max(last_scanned_at) AS last_scanned_at
       FROM attachment_integrity_index GROUP BY status`
  );
  const statusCounts = emptyStatusCounts();
  let totalEntries = 0;
  let lastScannedAt: string | null = null;
  for (const row of result.rows) {
    statusCounts[row.status] = Number(row.count);
    totalEntries += Number(row.count);
    if (row.last_scanned_at && (!lastScannedAt || row.last_scanned_at.toISOString() > lastScannedAt)) {
      lastScannedAt = row.last_scanned_at.toISOString();
    }
  }
  return { totalEntries, statusCounts, lastScannedAt };
}

export function isIntegrityStatus(value: string): value is AttachmentIntegrityStatus {
  return (attachmentIntegrityStatuses as readonly string[]).includes(value);
}
