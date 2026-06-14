import { installBinary } from './install-binary';

function fail(message: string): void {
  console.error(`[tellus-audio-sdk] ${message}`);
  process.exit(1);
}

installBinary().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
