import { describe, expect, it } from "vitest";
import {
  describeIssue,
  issueSeverity,
  reconcileAttachments,
  type DbAttachment
} from "../src/lib/integrity.js";

const ownerSets = (): Record<"BATCH" | "COLOR_CHANGE" | "PROJECT" | "CONSUMPTION", Set<string>> => ({
  BATCH: new Set(["00000000-0000-0000-0000-000000000001"]),
  COLOR_CHANGE: new Set(),
  PROJECT: new Set(),
  CONSUMPTION: new Set()
});

function attachment(overrides: Partial<DbAttachment> = {}): DbAttachment {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    ownerType: "BATCH",
    ownerId: "00000000-0000-0000-0000-000000000001",
    storageKey: "batch/photo.jpg",
    mimeType: "image/jpeg",
    byteSize: 10n,
    sha256: "a".repeat(64),
    ...overrides
  };
}

const presentFile = (sha256 = "a".repeat(64), byteSize = 10n) =>
  new Map([["batch/photo.jpg", { state: "present" as const, sha256, byteSize }]]);

describe("reconcileAttachments", () => {
  it("marks healthy attachments OK", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: presentFile(),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("OK");
    expect(result.findings[0]?.issues).toEqual([]);
    expect(result.orphans).toEqual([]);
    expect(result.summary).toMatchObject({
      totalAttachments: 1,
      okCount: 1,
      orphanCount: 0,
      openIssueCount: 0
    });
  });

  it("reports FILE_MISSING when the disk file is absent", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: new Map(),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("MISSING");
    expect(result.findings[0]?.issues).toEqual(["FILE_MISSING"]);
    expect(result.summary.missingCount).toBe(1);
  });

  it("reports hash mismatch without touching the baseline", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: presentFile("b".repeat(64)),
      existingOwnerIds: ownerSets()
    });
    const finding = result.findings[0];
    expect(finding?.status).toBe("CONFLICT");
    expect(finding?.issues).toEqual(["HASH_MISMATCH"]);
    expect(issueSeverity("HASH_MISMATCH")).toBe("CRITICAL");
    // 基线与实际观测同时保留，任何一方都不会被覆盖
    expect(finding?.attachment.sha256).toBe("a".repeat(64));
    expect(finding?.observed).toMatchObject({ state: "present", sha256: "b".repeat(64) });
    expect(describeIssue("HASH_MISMATCH", finding!)).toContain("未自动替换");
  });

  it("reports size mismatch when only byte size differs", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: presentFile("a".repeat(64), 11n),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("CONFLICT");
    expect(result.findings[0]?.issues).toEqual(["SIZE_MISMATCH"]);
    expect(issueSeverity("SIZE_MISMATCH")).toBe("WARNING");
  });

  it("reports combined size and hash mismatch", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: presentFile("b".repeat(64), 11n),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.issues).toEqual(["SIZE_AND_HASH_MISMATCH"]);
    expect(result.summary.conflictCount).toBe(1);
  });

  it("reports dangling owner references", () => {
    const result = reconcileAttachments({
      attachments: [attachment({ ownerId: "99999999-9999-9999-9999-999999999999" })],
      filesByStorageKey: presentFile(),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("OWNER_DANGLING");
    expect(result.findings[0]?.issues).toEqual(["OWNER_DANGLING"]);
    expect(result.findings[0]?.ownerExists).toBe(false);
    expect(result.summary.ownerDanglingCount).toBe(1);
  });

  it("keeps MISSING status when both file and owner are gone", () => {
    const result = reconcileAttachments({
      attachments: [attachment({ ownerId: "99999999-9999-9999-9999-999999999999" })],
      filesByStorageKey: new Map(),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("MISSING");
    expect(result.findings[0]?.issues).toEqual(["FILE_MISSING"]);
  });

  it("reports unreadable files as a critical issue", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: new Map([
        ["batch/photo.jpg", { state: "unreadable", error: "EACCES" }]
      ]),
      existingOwnerIds: ownerSets()
    });
    expect(result.findings[0]?.status).toBe("UNREADABLE");
    expect(result.findings[0]?.issues).toEqual(["UNREADABLE_FILE"]);
    expect(issueSeverity("UNREADABLE_FILE")).toBe("CRITICAL");
  });

  it("scans orphan files not referenced by any attachment", () => {
    const files = new Map<string, { state: "present"; sha256: string; byteSize: bigint } | { state: "missing" }>([
      ["batch/photo.jpg", { state: "present", sha256: "a".repeat(64), byteSize: 10n }],
      ["project/stray.png", { state: "present", sha256: "c".repeat(64), byteSize: 20n }]
    ]);
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: files,
      existingOwnerIds: ownerSets()
    });
    expect(result.orphans.map((orphan) => orphan.storageKey)).toEqual(["project/stray.png"]);
    expect(result.summary.orphanCount).toBe(1);
  });

  it("ignores missing disk entries that are not referenced (nothing to clean)", () => {
    const result = reconcileAttachments({
      attachments: [attachment()],
      filesByStorageKey: new Map([
        ["batch/photo.jpg", { state: "present", sha256: "a".repeat(64), byteSize: 10n }],
        ["batch/vanished.tmp", { state: "missing" }]
      ]),
      existingOwnerIds: ownerSets()
    });
    expect(result.orphans).toEqual([]);
  });

  it("is idempotent: identical input produces identical output", () => {
    const input = {
      attachments: [
        attachment(),
        attachment({
          id: "22222222-2222-2222-2222-222222222222",
          storageKey: "batch/missing.jpg",
          sha256: "c".repeat(64)
        })
      ],
      filesByStorageKey: presentFile(),
      existingOwnerIds: ownerSets()
    };
    const first = reconcileAttachments(input);
    const second = reconcileAttachments(input);
    expect(second).toEqual(first);
  });
});
