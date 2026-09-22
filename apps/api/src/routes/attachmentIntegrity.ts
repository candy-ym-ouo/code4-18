import type { FastifyInstance } from "fastify";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { attachmentIntegritySummary, isIntegrityStatus, runAttachmentIntegrityScan } from "../lib/attachmentIntegrity.js";

type Query = Record<string, string | undefined>;

export async function attachmentIntegrityRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/attachment-integrity/reindex",
    {
      config: {
        rateLimit: {
          max: 30,
          timeWindow: "1 minute"
        }
      }
    },
    async (request) => {
      const user = (request as AuthenticatedRequest).authUser;
      const summary = await runAttachmentIntegrityScan(user.id, request.id);
      return { data: summary };
    }
  );

  app.get("/attachment-integrity/summary", async () => {
    return { data: await attachmentIntegritySummary() };
  });

  app.get<{ Querystring: Query }>("/attachment-integrity/entries", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["1 = 1"];
    if (request.query.status) {
      if (!isIntegrityStatus(request.query.status)) {
        throw new AppError(422, "INVALID_STATUS", "完整性状态无效");
      }
      values.push(request.query.status);
      conditions.push(`status = $${values.length}`);
    }
    const where = conditions.join(" AND ");
    const total = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM attachment_integrity_index WHERE ${where}`,
      values
    );
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT storage_key AS "storageKey", attachment_id AS "attachmentId",
              record_present AS "recordPresent", file_present AS "filePresent",
              owner_type AS "ownerType", owner_id AS "ownerId", owner_present AS "ownerPresent",
              expected_sha256 AS "expectedSha256", expected_byte_size::text AS "expectedByteSize",
              actual_sha256 AS "actualSha256", actual_byte_size::text AS "actualByteSize",
              status, first_seen_at AS "firstSeenAt", last_scanned_at AS "lastScannedAt",
              status_changed_at AS "statusChangedAt"
         FROM attachment_integrity_index
        WHERE ${where}
        ORDER BY (status = 'OK'), storage_key
        LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });
}
