import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { config } from "../config.js";
import { AppError } from "./errors.js";
import type { ObservedFile } from "./integrity.js";

/** 将存储键解析为 UPLOAD_DIR 内的绝对路径，拒绝任何目录穿越尝试。 */
export function resolveStoragePath(storageKey: string, rootDirectory = path.resolve(config.UPLOAD_DIR)): string {
  const root = path.resolve(rootDirectory);
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new AppError(400, "INVALID_STORAGE_KEY", "附件存储路径无效");
  }
  return resolved;
}

/** 流式计算文件 sha256 与字节数，避免把大文件整体读入内存。 */
export async function hashFile(filePath: string): Promise<{ sha256: string; byteSize: bigint }> {
  const hash = createHash("sha256");
  let byteSize = 0n;
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    byteSize += BigInt(buffer.length);
    hash.update(buffer);
  }
  return { sha256: hash.digest("hex"), byteSize };
}

/**
 * 递归扫描附件根目录，返回 storageKey -> 观测结果。
 * 顶层以 “.” 开头的条目（如健康检查探针）不视为附件；
 * 扫描期间消失的文件记为 missing，无法读取记为 unreadable。
 */
export async function scanStorage(
  rootDirectory = path.resolve(config.UPLOAD_DIR)
): Promise<Map<string, ObservedFile>> {
  const files = new Map<string, ObservedFile>();
  let entries: Dirent[];
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.name.startsWith(".")) return;
      await walk(path.join(rootDirectory, entry.name), rootDirectory, files);
    })
  );
  return files;
}

async function walk(absolutePath: string, rootDirectory: string, files: Map<string, ObservedFile>): Promise<void> {
  const storageKey = toStorageKey(absolutePath, rootDirectory);
  let children: Dirent[];
  try {
    children = await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      files.set(storageKey, { state: "missing" });
    } else if (code === "ENOTDIR") {
      await inspectFile(absolutePath, rootDirectory, files);
    } else {
      files.set(storageKey, { state: "unreadable", error: errorMessage(error) });
    }
    return;
  }

  await Promise.all(
    children.map((child) => walk(path.join(absolutePath, child.name), rootDirectory, files))
  );
}

async function inspectFile(absolutePath: string, rootDirectory: string, files: Map<string, ObservedFile>): Promise<void> {
  const storageKey = toStorageKey(absolutePath, rootDirectory);
  try {
    const { sha256, byteSize } = await hashFile(absolutePath);
    files.set(storageKey, { state: "present", sha256, byteSize });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      files.set(storageKey, { state: "missing" });
    } else {
      files.set(storageKey, { state: "unreadable", error: errorMessage(error) });
    }
  }
}

function toStorageKey(absolutePath: string, rootDirectory: string): string {
  const relative = path.relative(rootDirectory, absolutePath);
  return relative.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 280);
  return String(error).slice(0, 280);
}
