import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  classifyIntegrityEntry,
  emptyStatusCounts,
  isIntegrityStatus,
  isTransientUploadArtifact,
  walkUploadFiles
} from "../src/lib/attachmentIntegrity.js";

describe("classifyIntegrityEntry", () => {
  it("marks a fully consistent entry as OK", () => {
    expect(classifyIntegrityEntry({ recordPresent: true, filePresent: true, ownerPresent: true, hashMatches: true })).toBe("OK");
  });

  it("flags content conflicts instead of adopting the new hash", () => {
    expect(classifyIntegrityEntry({ recordPresent: true, filePresent: true, ownerPresent: true, hashMatches: false })).toBe("HASH_MISMATCH");
  });

  it("prioritizes hash conflicts over missing owners", () => {
    expect(classifyIntegrityEntry({ recordPresent: true, filePresent: true, ownerPresent: false, hashMatches: false })).toBe("HASH_MISMATCH");
  });

  it("flags a missing owner only when content still matches", () => {
    expect(classifyIntegrityEntry({ recordPresent: true, filePresent: true, ownerPresent: false, hashMatches: true })).toBe("OWNER_MISSING");
  });

  it("flags a record whose file is gone", () => {
    expect(classifyIntegrityEntry({ recordPresent: true, filePresent: false, ownerPresent: true, hashMatches: null })).toBe("FILE_MISSING");
  });

  it("flags a file without a record as orphan", () => {
    expect(classifyIntegrityEntry({ recordPresent: false, filePresent: true, ownerPresent: null, hashMatches: null })).toBe("ORPHAN_FILE");
  });

  it("refuses to classify an entry with neither record nor file", () => {
    expect(() => classifyIntegrityEntry({ recordPresent: false, filePresent: false, ownerPresent: null, hashMatches: null })).toThrow();
  });
});

describe("isTransientUploadArtifact", () => {
  it("detects upload staging and delete trash files", () => {
    expect(isTransientUploadArtifact("batch/abc.png.tmp")).toBe(true);
    expect(isTransientUploadArtifact("batch/abc.png.deleting-1726900000000")).toBe(true);
    expect(isTransientUploadArtifact("orphan.tmp")).toBe(true);
  });

  it("keeps regular storage keys", () => {
    expect(isTransientUploadArtifact("batch/9f0b1c.png")).toBe(false);
    expect(isTransientUploadArtifact("project/tmp-photo.jpg")).toBe(false);
  });
});

describe("status helpers", () => {
  it("starts every status counter at zero", () => {
    expect(emptyStatusCounts()).toEqual({ OK: 0, HASH_MISMATCH: 0, FILE_MISSING: 0, OWNER_MISSING: 0, ORPHAN_FILE: 0 });
  });

  it("validates known statuses only", () => {
    expect(isIntegrityStatus("OK")).toBe(true);
    expect(isIntegrityStatus("ORPHAN_FILE")).toBe(true);
    expect(isIntegrityStatus("BROKEN")).toBe(false);
  });
});

describe("walkUploadFiles", () => {
  let uploadDir: string;

  beforeAll(async () => {
    uploadDir = await mkdtemp(path.join(tmpdir(), "integrity-scan-"));
    await mkdir(path.join(uploadDir, "batch"), { recursive: true });
    await mkdir(path.join(uploadDir, "project"), { recursive: true });
    await writeFile(path.join(uploadDir, "batch", "keep.png"), "png-bytes");
    await writeFile(path.join(uploadDir, "batch", "keep.png.tmp"), "partial");
    await writeFile(path.join(uploadDir, "project", "gone.jpg.deleting-123"), "trash");
  });

  afterAll(async () => {
    await rm(uploadDir, { recursive: true, force: true });
  });

  it("hashes real files and skips transient artifacts", async () => {
    const { files, transientSkipped, invalidSkipped } = await walkUploadFiles(uploadDir);
    expect(invalidSkipped).toBe(0);
    expect(transientSkipped).toBe(2);
    expect(files).toHaveLength(1);
    expect(files[0]?.storageKey).toBe("batch/keep.png");
    expect(files[0]?.byteSize).toBe("png-bytes".length);
    expect(files[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
