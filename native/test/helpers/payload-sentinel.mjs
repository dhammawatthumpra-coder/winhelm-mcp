import { writeFileSync } from "node:fs";
const marker = process.argv[2];
writeFileSync(marker, JSON.stringify({ pid: process.pid }), "utf8");
setInterval(() => {}, 1000);
