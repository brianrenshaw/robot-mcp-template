// kv.ts
// The OAuth library wants a Workers KV namespace to keep its sign-in records in. This gives it
// the oauth_kv table of the D1 database instead, so the whole server has one place for data.
// (A real KV namespace bound as OAUTH_KV works too: delete the `withStore` line in index.ts.)

interface PutOptions {
  expirationTtl?: number; // seconds from now
  expiration?: number; // Unix seconds
  metadata?: unknown;
}

interface ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string | null;
}

interface Row {
  key: string;
  value: string;
  metadata: string | null;
  expires_at: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function dbKv(db: D1Database) {
  return {
    async get(key: string, options?: string | { type?: string }): Promise<any> {
      const row = await db
        .prepare(`SELECT * FROM oauth_kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)`)
        .bind(key, nowSeconds())
        .first<Row>();
      if (!row) return null;
      const type = typeof options === "string" ? options : options?.type;
      return type === "json" ? JSON.parse(row.value) : row.value;
    },

    async put(key: string, value: string, options: PutOptions = {}): Promise<void> {
      const now = nowSeconds();
      const expires = options.expiration ?? (options.expirationTtl ? now + options.expirationTtl : null);
      await db
        .prepare(
          `INSERT INTO oauth_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at`,
        )
        .bind(key, String(value), options.metadata === undefined ? null : JSON.stringify(options.metadata), expires)
        .run();
      // Housekeeping: drop records that have expired.
      await db.prepare(`DELETE FROM oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?`).bind(now).run();
    },

    async delete(key: string): Promise<void> {
      await db.prepare(`DELETE FROM oauth_kv WHERE key = ?`).bind(key).run();
    },

    async list(options: ListOptions = {}) {
      const prefix = options.prefix ?? "";
      const limit = Math.min(Math.max(options.limit ?? 1000, 1), 1000);
      const { results } = await db
        .prepare(
          `SELECT * FROM oauth_kv
           WHERE key >= ? AND key < ? AND key > ? AND (expires_at IS NULL OR expires_at > ?)
           ORDER BY key LIMIT ${limit + 1}`,
        )
        .bind(prefix, prefix + "￿", options.cursor ?? "", nowSeconds())
        .all<Row>();
      const page = results.slice(0, limit);
      const complete = results.length <= limit;
      return {
        keys: page.map((r) => ({
          name: r.key,
          ...(r.expires_at ? { expiration: r.expires_at } : {}),
          ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
        })),
        list_complete: complete,
        ...(complete ? {} : { cursor: page[page.length - 1]!.key }),
        cacheStatus: null,
      };
    },
  };
}
