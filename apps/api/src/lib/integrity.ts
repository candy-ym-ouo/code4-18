import type { AttachmentOwnerType } from "@handcraft/contracts";

export const ownerTables: Record<AttachmentOwnerType, string> = {
  BATCH: "batches",
  COLOR_CHANGE: "color_changes",
  PROJECT: "projects",
  CONSUMPTION: "consumptions"
};

export const integrityIssueKinds = [
  "FILE_MISSING",
  "HASH_MISMATCH",
  "SIZE_MISMATCH",
  "SIZE_AND_HASH_MISMATCH",
  "OWNER_DANGLING",
  "UNREADABLE_FILE"
] as const;
export type IntegrityIssueKind = (typeof integrityIssueKinds)[number];

export type AttachmentIndexStatus =
  | "OK"
  | "MISSING"
  | "CONFLICT"
  | "OWNER_DANGLING"
  | "UNREADABLE";

export type DbAttachment = {
  id: string;
  ownerType: AttachmentOwnerType;
  ownerId: string;
  storageKey: string;
  mimeType: string;
  byteSize: bigint;
  sha256: string;
};

export type ObservedFile =
  | { state: "present"; sha256: string; byteSize: bigint }
  | { state: "missing" }
  | { state: "unreadable"; error: string };

export type ScannedFile = {
  storageKey: string;
  observation:
    | { state: "present"; sha256: string; byteSize: bigint }
    | { state: "unreadable"; error: string };
};

export type AttachmentFinding = {
  attachment: DbAttachment;
  ownerExists: boolean;
  status: AttachmentIndexStatus;
  issues: IntegrityIssueKind[];
  observed?: ObservedFile;
};

export type ReconcileSummary = {
  totalAttachments: number;
  okCount: number;
  missingCount: number;
  conflictCount: number;
  ownerDanglingCount: number;
  unreadableCount: number;
  orphanCount: number;
  openIssueCount: number;
};

export type ReconcileResult = {
  findings: AttachmentFinding[];
  orphans: ScannedFile[];
  summary: ReconcileSummary;
};

/**
 * 协调附件表记录、磁盘实际文件与所有者引用关系。
 *
 * - 文件缺失：记录 FILE_MISSING（基线哈希/大小绝不改写）。
 * - 哈希或大小不一致：记录冲突，但不覆盖任何一方。
 * - owner_type/owner_id 指向不存在的所有者：OWNER_DANGLING。
 * - 磁盘上存在但附件表无引用：孤立文件。
 *
 * 该函数无副作用，同一份输入必然产生同一份输出，是重索引幂等性的基础。
 */
export function reconcileAttachments(input: {
  attachments: DbAttachment[];
  filesByStorageKey: Map<string, ObservedFile>;
  existingOwnerIds: Record<AttachmentOwnerType, ReadonlySet<string>>;
}): ReconcileResult {
  const findings: AttachmentFinding[] = [];
  const referencedKeys = new Set<string>();

  for (const attachment of input.attachments) {
    referencedKeys.add(attachment.storageKey);
    const ownerExists = input.existingOwnerIds[attachment.ownerType]?.has(attachment.ownerId) ?? false;
    const observed = input.filesByStorageKey.get(attachment.storageKey);
    const issues: IntegrityIssueKind[] = [];

    let status: AttachmentIndexStatus;
    if (observed === undefined || observed.state === "missing") {
      status = "MISSING";
      issues.push("FILE_MISSING");
    } else if (observed.state === "unreadable") {
      status = "UNREADABLE";
      issues.push("UNREADABLE_FILE");
    } else {
      const hashMismatch = observed.sha256 !== attachment.sha256;
      const sizeMismatch = observed.byteSize !== attachment.byteSize;
      if (hashMismatch && sizeMismatch) {
        issues.push("SIZE_AND_HASH_MISMATCH");
      } else if (hashMismatch) {
        issues.push("HASH_MISMATCH");
      } else if (sizeMismatch) {
        issues.push("SIZE_MISMATCH");
      }
      status = issues.length > 0 ? "CONFLICT" : ownerExists ? "OK" : "OWNER_DANGLING";
    }

    if (!ownerExists && status !== "MISSING" && status !== "UNREADABLE") {
      issues.push("OWNER_DANGLING");
      if (status === "OK") status = "OWNER_DANGLING";
    }

    findings.push({
      attachment,
      ownerExists,
      status,
      issues,
      observed: observed ?? { state: "missing" }
    });
  }

  const orphans: ScannedFile[] = [];
  for (const [storageKey, observation] of input.filesByStorageKey) {
    if (referencedKeys.has(storageKey) || observation.state === "missing") continue;
    orphans.push({ storageKey, observation });
  }
  orphans.sort((left, right) => left.storageKey.localeCompare(right.storageKey));

  const countBy = (status: AttachmentIndexStatus): number =>
    findings.reduce((total, finding) => total + (finding.status === status ? 1 : 0), 0);

  const summary: ReconcileSummary = {
    totalAttachments: findings.length,
    okCount: countBy("OK"),
    missingCount: countBy("MISSING"),
    conflictCount: countBy("CONFLICT"),
    ownerDanglingCount: countBy("OWNER_DANGLING"),
    unreadableCount: countBy("UNREADABLE"),
    orphanCount: orphans.length,
    openIssueCount: findings.reduce((total, finding) => total + finding.issues.length, 0)
  };

  return { findings, orphans, summary };
}

/**
 * 冲突/不可读问题的严重程度：哈希或内容无法读取意味着内容完整性被破坏，
 * 判定为 CRITICAL；仅大小不一致或引用悬挂判定为 WARNING。
 */
export function issueSeverity(kind: IntegrityIssueKind): "CRITICAL" | "WARNING" {
  return kind === "HASH_MISMATCH" ||
    kind === "SIZE_AND_HASH_MISMATCH" ||
    kind === "UNREADABLE_FILE"
    ? "CRITICAL"
    : "WARNING";
}

export function describeIssue(kind: IntegrityIssueKind, finding: AttachmentFinding): string {
  const { attachment, observed } = finding;
  switch (kind) {
    case "FILE_MISSING":
      return `附件 ${attachment.id} 的存储文件 ${attachment.storageKey} 在磁盘上不存在`;
    case "UNREADABLE_FILE":
      return `附件 ${attachment.id} 的存储文件 ${attachment.storageKey} 无法读取：${
        observed && observed.state === "unreadable" ? observed.error : "未知错误"
      }`;
    case "HASH_MISMATCH":
    case "SIZE_AND_HASH_MISMATCH":
    case "SIZE_MISMATCH": {
      const expectedSize = attachment.byteSize.toString();
      const actualSize = observed && observed.state === "present" ? observed.byteSize.toString() : "未知";
      const expectedHash = attachment.sha256;
      const actualHash = observed && observed.state === "present" ? observed.sha256 : "未知";
      return `附件 ${attachment.id} 内容与索引基线冲突（大小 基线=${expectedSize} 实际=${actualSize}；sha256 基线=${expectedHash} 实际=${actualHash}），未自动替换`;
    }
    case "OWNER_DANGLING":
      return `附件 ${attachment.id} 引用的 ${attachment.ownerType}#${attachment.ownerId} 不存在`;
  }
}
