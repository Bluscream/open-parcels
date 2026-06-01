import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data.db");
const client = createClient({ url: `file:${dbPath}` });

export const db = drizzle(client, { schema });
