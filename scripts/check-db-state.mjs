import mysql from 'mysql2/promise';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const conn = await mysql.createConnection(url);
try {
  const [tables] = await conn.query('SHOW TABLES');
  console.log('TABLES');
  console.log(JSON.stringify(tables, null, 2));
  const [drizzleTables] = await conn.query("SHOW TABLES LIKE '__drizzle_migrations'");
  console.log('DRIZZLE_TABLES');
  console.log(JSON.stringify(drizzleTables, null, 2));
  if (Array.isArray(drizzleTables) && drizzleTables.length > 0) {
    const [rows] = await conn.query('SELECT * FROM __drizzle_migrations ORDER BY id');
    console.log('DRIZZLE_ROWS');
    console.log(JSON.stringify(rows, null, 2));
  }
} finally {
  await conn.end();
}
