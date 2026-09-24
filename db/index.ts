import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Local D1 binding `DB` is unavailable. Start the app with the configured Cloudflare Vite runtime."
    );
  }

  return drizzle(env.DB, { schema });
}
