import type { Db } from './index.js';
import { SCHEMA_SQL } from './schema.js';

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
