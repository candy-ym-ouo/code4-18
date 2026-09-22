import type { FastifyInstance } from "fastify";
import { pool } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { reindexAttachments } from "../lib/reindex.js";
import type { AuthenticatedRequest } from "../lib/auth.js";

const indexStatuses = ["OK", "MISSING", "CONFLICT", "OWNER_DANGLING", "UNREADABLE"] as const;
type IndexStatus = (typeof indexStatuses)[number];
const issueStatuses = ["OPEN", "RESOLVED"] as const;
const orphanStatuses = ["OPEN", "RESOLVED"] as const;

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new AppError(422, "INVALID_LIMIT", "limit 必须是 1 到 500 之间的整数");
  }
  return value;
}

function parseEnum<T extends readonly string[]>(
  raw: unknown,
  allowed: T,
  code: string,
  message: string
): T[number] | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    throw new AppError(422, code, message);
  }
  return raw;
}

export async function integrityRoutes(app: FastifyInstance): Promise<void> {
  app.post("/attachment-integrity/reindex", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    const outcome = await reindexAttachments({ triggeredByUserId: user.id });
    return reply.status(201).send({
      data: {
        runId: outcome.runId,
        summary: outcome.summary
      }
    });
  });

  app.get("/attachment-integrity/status", async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const statusFilter = parseEnum(
      query.status,
      indexStatuses,
      "INVALID_INDEX_STATUS",
      "附件索引状态无效"
    ) as IndexStatus | undefined;    const limit = parseLimit(query.limit);

    const totals = await pool.query<{ status: IndexStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM attachment_index GROUP BY status`
    );
    const issues = await pool.query<{
      status: string;
      severity: string;
      count: string;
    }>(
      `SELECT status, severity, count(*)::text AS count
       FROM attachment_integrity_issues GROUP BY status, severity`
    );
    const orphans = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM orphan_files GROUP BY status`
    );
    const latestRun = await pool.query(
      `SELECT id, started_at AS "startedAt", finished_at AS "finishedAt",
              total_attachments::text AS "totalAttachments",
              ok_count::text AS "okCount",
              missing_count::text AS "missingCount",
              conflict_count::text AS "conflictCount",
              owner_dangling_count::text AS "ownerDanglingCount",
              unreadable_count::text AS "unreadableCount",
              orphan_count::text AS "orphanCount",
              open_issue_count::text AS "openIssueCount"
       FROM attachment_index_runs ORDER BY started_at DESC LIMIT 1`
    );

    const itemsParams: unknown[] = [];
    let where = "";
    if (statusFilter) {
      itemsParams.push(statusFilter);
      where = "WHERE i.status = $1::attachment_index_status";
    }
    itemsParams.push(limit);
    const items = await pool.query(
      `SELECT i.attachment_id AS "attachmentId",
              i.status,
              i.observed_sha256 AS "observedSha256",
              i.observed_byte_size::text AS "observedByteSize",
              i.read_error AS "readError",
              i.verified_at AS "verifiedAt",
              a.owner_type AS "ownerType",
              a.owner_id AS "ownerId",
              a.storage_key AS "storageKey",
              a.sha256 AS "expectedSha256",
              a.byte_size::text AS "expectedByteSize"
       FROM attachment_index i
       JOIN attachments a ON a.id = i.attachment_id
       ${where}
       ORDER BY i.verified_at DESC
       LIMIT $${itemsParams.length}`,
      itemsParams
    );

    return {
      data: {
        indexedByStatus: Object.fromEntries(
          totals.rows.map((row) => [row.status, Number(row.count)])
        ),
        issuesByStatusAndSeverity: Object.fromEntries(
          issues.rows.map((row) => [`${row.status}:${row.severity}`, Number(row.count)])
        ),
        orphansByStatus: Object.fromEntries(
          orphans.rows.map((row) => [row.status, Number(row.count)])
        ),
        latestRun: latestRun.rows[0] ?? null,
        items: items.rows
      }
    };
  });

  app.get("/attachment-integrity/issues", async (request) => {
    const query = request.query as { status?: string; severity?: string; limit?: string };
    const statusFilter = parseEnum(
      query.status,
      issueStatuses,
      "INVALID_ISSUE_STATUS",
      "问题状态无效"
    );
    const limit = parseLimit(query.limit);
    const params: unknown[] = [];
    const clauses: string[] = [];
    if (statusFilter) {
      params.push(statusFilter);
      clauses.push(`status = $${params.length}::integrity_issue_status`);
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT id, attachment_id AS "attachmentId", storage_key AS "storageKey",
              kind, severity, status, detail,
              first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt",
              resolved_at AS "resolvedAt", resolve_reason AS "resolveReason"
       FROM attachment_integrity_issues
       ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY (status = 'OPEN') DESC,
                (severity = 'CRITICAL') DESC,
                last_seen_at DESC
       LIMIT $${params.length}`,
      params
    );
    return { data: result.rows };
  });

  app.get("/attachment-integrity/orphans", async (request) => {
    const query = request.query as { status?: string; limit?: string };
    const statusFilter = parseEnum(
      query.status,
      orphanStatuses,
      "INVALID_ORPHAN_STATUS",
      "孤立文件状态无效"
    );
    const limit = parseLimit(query.limit);
    const params: unknown[] = [];
    let where = "";
    if (statusFilter) {
      params.push(statusFilter);
      where = `WHERE status = $1::orphan_file_status`;
    }
    params.push(limit);
    const result = await pool.query(
      `SELECT id, storage_key AS "storageKey",
              observed_sha256 AS "observedSha256",
              observed_byte_size::text AS "observedByteSize",
              read_error AS "readError",
              status, first_seen_at AS "firstSeenAt",
              last_seen_at AS "lastSeenAt", resolved_at AS "resolvedAt"
       FROM orphan_files
       ${where}
       ORDER BY (status = 'OPEN') DESC, last_seen_at DESC
       LIMIT $${params.length}`,
      params
    );
    return { data: result.rows };
  });
}
