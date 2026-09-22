import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashFile, resolveStoragePath, scanStorage } from "../src/lib/attachmentFiles.js";

const tempRoots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "attachment-integrity-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("hashFile", () => {
  it("hashes content and reports byte size", async () => {
    const root = await makeRoot();
    const file = path.join(root, "a.jpg");
    const content = Buffer.from([0xff, 0xd8, 0xff, 0, 1, 2]);
    await writeFile(file, content);
    const result = await hashFile(file);
    expect(result.byteSize).toBe(BigInt(content.length));
    expect(result.sha256).toBe(createHash("sha256").update(content).digest("hex"));
  });
});

describe("scanStorage", () => {
  it("indexes nested files by storage key and ignores dotfiles", async () => {
    const root = await makeRoot();
    await mkdir(path.join(root, "batch"), { recursive: true });
    await writeFile(path.join(root, "batch", "x.jpg"), Buffer.from("image"));
    await writeFile(path.join(root, ".health-probe"), "ok");
    const files = await scanStorage(root);
    expect(files.has("batch/x.jpg")).toBe(true);
    expect(files.has(".health-probe")).toBe(false);
    const observed = files.get("batch/x.jpg");
    expect(observed?.state).toBe("present");
    if (observed?.state === "present") {
      expect(observed.byteSize).toBe(BigInt(5));
      expect(observed.sha256).toBe(createHash("sha256").update("image").digest("hex"));
    }
  });

  it("returns an empty map when the root does not exist", async () => {
    const root = path.join(tmpdir(), `missing-${Date.now()}-${process.pid}`);
    const files = await scanStorage(root);
    expect(files.size).toBe(0);
  });
});

describe("resolveStoragePath", () => {
  it("rejects directory traversal", () => {
    const root = path.join(tmpdir(), "storage-root");
    expect(() => resolveStoragePath("../etc/passwd", root)).toThrow(/存储路径无效/);
  });

  it("resolves a valid nested key inside the root", () => {
    const root = path.join(tmpdir(), "storage-root");
    expect(resolveStoragePath("batch/x.jpg", root)).toBe(path.join(root, "batch", "x.jpg"));
  });
});
