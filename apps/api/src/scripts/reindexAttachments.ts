import { pool } from "../lib/db.js";
import { reindexAttachments, type ReindexOutcome } from "../lib/reindex.js";
import type { ReconcileSummary } from "../lib/integrity.js";

// 用法：
//   tsx src/scripts/reindex-attachments.ts            人类可读摘要
//   tsx src/scripts/reindex-attachments.ts --json     输出 JSON
//   tsx src/scripts/reindex-attachments.ts --strict   存在缺失/冲突/孤立时以退出码 2 结束
const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const strict = args.has("--strict");

function hasOpenProblems(summary: ReconcileSummary): boolean {
  return (
    summary.missingCount > 0 ||
    summary.conflictCount > 0 ||
    summary.unreadableCount > 0 ||
    summary.ownerDanglingCount > 0 ||
    summary.orphanCount > 0
  );
}

function printHuman(outcome: ReindexOutcome): void {
  const s = outcome.summary;
  console.info("附件完整性重索引完成");
  console.info(`  附件总数:   ${s?.totalAttachments ?? 0}`);
  console.info(`  正常:       ${s?.okCount ?? 0}`);
  console.info(`  文件缺失:   ${s?.missingCount ?? 0}`);
  console.info(`  内容冲突:   ${s?.conflictCount ?? 0}`);
  console.info(`  引用悬挂:   ${s?.ownerDanglingCount ?? 0}`);
  console.info(`  无法读取:   ${s?.unreadableCount ?? 0}`);
  console.info(`  孤立文件:   ${s?.orphanCount ?? 0}`);
  console.info(`  未解决问题: ${s?.openIssueCount ?? 0}`);
}

try {
  const outcome = await reindexAttachments();
  if (asJson) {
    console.log(JSON.stringify({ runId: outcome.runId, summary: outcome.summary }, null, 2));
  } else {
    printHuman(outcome);
  }
  await pool.end();
  if (strict && hasOpenProblems(outcome.summary)) process.exit(2);
  process.exit(0);
} catch (error) {
  if (asJson) {
    console.error(
      JSON.stringify({
        error: error instanceof Error ? { message: error.message } : { message: String(error) }
      })
    );
  } else {
    console.error("附件完整性重索引失败:", error instanceof Error ? error.message : error);
  }
  await pool.end().catch(() => undefined);
  process.exit(1);
}
