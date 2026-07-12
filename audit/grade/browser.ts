/** Load an unpacked extension in headless Chromium and wait for its SW. */
import { chromium, type BrowserContext, type Worker } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LoadedExtension {
  context: BrowserContext;
  serviceWorker: Worker | null;
  extensionId: string;
  close(): Promise<void>;
}

export async function loadExtension(extPath: string): Promise<LoadedExtension> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'standdown-grade-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      '--headless=new',
      `--disable-extensions-except=${extPath}`,
      `--load-extension=${extPath}`,
      '--no-first-run',
    ],
  });

  let sw = context.serviceWorkers()[0] ?? null;
  if (!sw) {
    // Content-script-only extensions have no SW; don't block long on it.
    sw = await context.waitForEvent('serviceworker', { timeout: 3000 }).catch(() => null);
  }
  const extensionId = sw ? new URL(sw.url()).host : '';

  return {
    context,
    serviceWorker: sw,
    extensionId,
    close: async () => {
      // context.close() can itself wedge under the headless-MV3 failure mode;
      // don't let teardown hang the process after the audit already finished.
      await Promise.race([
        context.close(),
        new Promise((r) => setTimeout(r, 5000).unref()),
      ]);
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}
