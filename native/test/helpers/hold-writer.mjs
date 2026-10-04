import { openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
const path = process.argv[2];
const ready = process.argv[3];
const fd = openSync(path, "r+");
writeFileSync(ready, String(process.pid), "utf8");
const cleanup = () => {
  try { closeSync(fd); } catch {}
  try { unlinkSync(ready); } catch {}
  process.exit(0);
};
process.on("SIGTERM", cleanup);
process.on("SIGINT", cleanup);
setInterval(() => {}, 1000);
