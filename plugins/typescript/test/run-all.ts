/**
 * Integration test runner for the opto-sync ORM plugins.
 *
 * Requires a reachable Postgres (see OPTO_SYNC_TEST_PG, default
 * postgres://test:test@localhost:55432/plugintest).
 */
import { waitForPostgres, runQueued, report, closeRawPool, exec } from './harness';

type Mod = { register: () => Promise<void>; teardown?: () => Promise<void> };

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const want = (name: string) => only.length === 0 || only.includes(name);

  console.log(`Postgres: ${process.env.OPTO_SYNC_TEST_PG ?? 'postgres://test:test@127.0.0.1:55987/plugintest'}`);
  await waitForPostgres();

  const mods: Array<[string, Mod]> = [];
  if (want('core')) mods.push(['core', await import('./core-contract.test')]);
  if (want('drizzle')) mods.push(['drizzle', await import('./drizzle.test')]);
  if (want('kysely')) mods.push(['kysely', await import('./kysely.test')]);
  if (want('typeorm')) mods.push(['typeorm', await import('./typeorm.test')]);

  try {
    for (const [, m] of mods) {
      await m.register();
      await runQueued();
    }
  } finally {
    for (const [, m] of mods) {
      try {
        await m.teardown?.();
      } catch {
        /* ignore teardown noise */
      }
    }
    // leave the schema clean
    for (const t of ['drizzle_docs', 'kysely_docs', 'typeorm_docs']) {
      await exec(`drop table if exists "${t}"`).catch(() => {});
    }
    await closeRawPool();
  }

  process.exit(report());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
