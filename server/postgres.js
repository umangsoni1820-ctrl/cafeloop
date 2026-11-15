import fs from 'node:fs';
import postgres from 'postgres';

function postgresQuery(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeRows(rows) {
  return rows.map((row) => {
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === 'bigint') row[key] = Number(value);
    }
    return row;
  });
}

function createPostgresAdapter(client, root = false) {
  return {
    kind: 'postgres',
    prepare(statement) {
      const query = postgresQuery(statement);
      return {
        async get(...parameters) {
          const rows = await client.unsafe(query, parameters);
          return normalizeRows(rows)[0] || null;
        },
        async all(...parameters) {
          return normalizeRows(await client.unsafe(query, parameters));
        },
        async run(...parameters) {
          const rows = await client.unsafe(query, parameters);
          return { changes: rows.count ?? rows.length };
        },
      };
    },
    async exec(statement) {
      await client.unsafe(statement);
    },
    transaction(callback) {
      return client.begin((transaction) => callback(createPostgresAdapter(transaction)));
    },
    async close() {
      if (root) await client.end({ timeout: 5 });
    },
  };
}

export async function openPostgresDatabase(connectionString) {
  if (!connectionString) throw new Error('Set DATABASE_URL to the Supabase Postgres session-pooler connection string.');
  const client = postgres(connectionString, { ssl: 'require', max: 5, prepare: false, connect_timeout: 15 });
  const schema = fs.readFileSync(new URL('./postgres-schema.sql', import.meta.url), 'utf8');
  try {
    for (const statement of schema.split(';').map((part) => part.trim()).filter(Boolean)) {
      await client.unsafe(statement);
    }
  } catch (error) {
    await client.end({ timeout: 5 });
    throw new Error(`Could not initialize CafeLoop's Supabase schema: ${error.message}`, { cause: error });
  }
  return createPostgresAdapter(client, true);
}
