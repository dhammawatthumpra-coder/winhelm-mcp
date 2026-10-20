import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import readline from "node:readline";

const require = createRequire(import.meta.url);
const addonPath = process.env.WINHELM_NATIVE_TEST_ADDON;
if (!addonPath) throw new Error("WINHELM_NATIVE_TEST_ADDON is required");
const native = require(addonPath);

const [
  targetPath,
  replacementPath,
  expectedSha256,
  volumeSerialNumber,
  fileIndexHigh,
  fileIndexLow,
  barrierPhase,
  crashPhase,
] = process.argv.slice(2);

try {
  const result = native.guardedMarkerCommitBeginTest(
    targetPath,
    readFileSync(replacementPath),
    expectedSha256,
    Number(volumeSerialNumber),
    Number(fileIndexHigh),
    Number(fileIndexLow),
    barrierPhase,
    crashPhase,
  );
  process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);

  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line === "ack") {
      try {
        const acknowledged = native.guardedMarkerCommitAcknowledge(
          result.transactionId,
        );
        process.stdout.write(`ACK=${JSON.stringify(acknowledged)}\n`);
        input.close();
      } catch (error) {
        process.stdout.write(
          `ACK_ERROR=${JSON.stringify({
            code: error?.code,
            nativeCode: error?.nativeCode,
            phase: error?.phase,
            message: error?.message,
          })}\n`,
        );
        process.exitCode = 3;
        input.close();
      }
    }
  });
  input.on("close", () => process.exit(process.exitCode ?? 0));
} catch (error) {
  process.stdout.write(
    `ERROR=${JSON.stringify({
      code: error?.code,
      nativeCode: error?.nativeCode,
      phase: error?.phase,
      message: error?.message,
      backupPath: error?.backupPath,
      stagePath: error?.stagePath,
    })}\n`,
  );
  process.exit(2);
}
