import {
  Pool,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from "pg";

let pool: Pool | undefined;

/** Lazy initialization allows builds without connecting to a deployment database.
 * Every server query and transaction uses it.
 */
export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString)
    throw new Error(
      "DATABASE_URL is required for persistent application state.",
    );
  pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    // Configure verified TLS in DATABASE_URL or PGSSLROOTCERT; never disable certificate checks.
  });
  pool.on("error", () => console.error("Database pool connection failed."));
  return pool;
}

/** Runs a parameterized statement through the shared pool.
 * Server data access uses it for individual database operations.
 */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params);
}

/** Runs a callback inside a committed or rolled-back transaction.
 * Multi-step account, email, and operation workflows use it.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
