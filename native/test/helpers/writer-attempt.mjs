import { openSync, closeSync, writeSync } from "node:fs";
const path = process.argv[2];
try {
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.from("W"), 0, 1, 0);
  closeSync(fd);
  process.exit(0);
} catch (error) {
  console.error(JSON.stringify({ code: error?.code, errno: error?.errno, message: error?.message }));
  process.exit(42);
}
