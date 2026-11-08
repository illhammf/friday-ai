import { pathToFileURL } from 'node:url';

export async function startFriday() {
  const { startFriday: startRuntime } = await import('./friday-runtime.js');
  return startRuntime();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startFriday().catch((error) => {
    console.error('Gagal menjalankan WhatsApp:', error);
    process.exitCode = 1;
  });
}
