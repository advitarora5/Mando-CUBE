import { createClient } from '@supabase/supabase-js';
import { assertAllowedTarget } from '../../src/pipeline/store/supabase.ts';

export async function integrationDatabase(env = process.env, connect = createClient) {
  const required = ['true', '1'].includes(env.CI) || env.PIPELINE_REQUIRE_DATABASE_TESTS === '1';
  const unavailable = reason => {
    const message = `Database integration preflight: ${reason}`;
    if (required) throw new Error(`${message} Database tests are required and cannot be skipped.`);
    return { db: null, skip: message };
  };
  const url = env.PIPELINE_SUPABASE_URL, key = env.PIPELINE_SUPABASE_KEY;
  if (!url || !key) return unavailable('set both PIPELINE_SUPABASE_URL and PIPELINE_SUPABASE_KEY for local Supabase.');
  try {
    assertAllowedTarget(url, undefined);
  } catch {
    return unavailable('the database target must be a valid local Supabase URL; remote targets are refused.');
  }
  let db;
  try {
    db = connect(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await db.from('companies').select('id').limit(1).abortSignal(AbortSignal.timeout(5000));
    if (error || !Array.isArray(data)) throw new Error('Database read failed');
  } catch {
    return unavailable('could not read companies; check local Supabase availability, credentials and applied migrations (5-second timeout).');
  }
  return { db, skip: false };
}
