import 'dotenv/config';
import {
  getRuntimeSummary,
  inspectRuntime,
} from '../src/config/runtime-diagnostics.js';

const results = await inspectRuntime();
const summary = getRuntimeSummary(results);

console.log('Friday AI — pemeriksaan runtime\n');

for (const result of results) {
  const marker = result.ok ? 'OK' : result.required ? 'ERROR' : 'WARN';
  console.log(`[${marker}] ${result.label}: ${result.detail}`);

  if (!result.ok && result.guidance) {
    console.log(`      ${result.guidance}`);
  }
}

if (summary.ok) {
  console.log('\nSemua runtime dan dependency yang diperiksa tersedia.');
} else if (summary.requiredFailed.length > 0) {
  console.error('\nAda kebutuhan wajib yang belum siap; perbaiki sebelum menjalankan Friday.');
  process.exitCode = 1;
} else {
  console.warn('\nFriday dapat berjalan, tetapi sebagian fitur media belum siap.');
}
