import { checkBinary } from './check-binary';

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--platform' || !['ios', 'android', 'web'].includes(args[1]))) {
    throw new Error('Usage: check-binary-cli [--platform ios|android|web]');
  }
  checkBinary(args[1]);
} catch (error) {
  console.error(`[tellus-audio-sdk] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
