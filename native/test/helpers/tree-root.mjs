import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const state = process.argv[2];
const here = dirname(fileURLToPath(import.meta.url));
appendFileSync(state, `root:${process.pid}\n`);
spawn(process.execPath, [join(here, "tree-child.mjs"), state], {
  stdio: "ignore",
  windowsHide: true,
});
setInterval(() => {}, 1000);
