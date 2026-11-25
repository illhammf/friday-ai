#!/usr/bin/env node
import { runInteractiveConversationReset } from '../src/database/conversation-data-reset.js';

try {
  await runInteractiveConversationReset();
} catch (error) {
  console.error(`Reset gagal: ${error?.message || 'kesalahan tidak diketahui'}`);
  process.exitCode = 1;
}
