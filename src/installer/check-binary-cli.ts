import { checkBinary } from './check-binary';

try {
  checkBinary();
} catch (error) {
  console.error(`[tellus-audio-sdk] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
