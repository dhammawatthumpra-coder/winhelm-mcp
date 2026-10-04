import { appendFileSync } from "node:fs";
const state = process.argv[2];
appendFileSync(state, `grandchild:${process.pid}\n`);
setInterval(() => {}, 1000);
