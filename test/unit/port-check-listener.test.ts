import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  checkPort,
  selectPreferredPortConnection,
} from "../../src/engine/system.js";
import { ConfigManager } from "../../src/config/config-manager.js";

describe("Port check listener selection", () => {
  before(async () => {
    await ConfigManager.getInstance().updateConfig(
      { allowedDirectories: ["*"] },
      false
    );
  });
  it("prefers Listen over earlier TIME_WAIT records", () => {
    const selected = selectPreferredPortConnection([
      { pid: 0, processName: "Unknown", state: "TimeWait" },
      { pid: 4242, processName: "node", state: "Listen" },
      { pid: 0, processName: "Unknown", state: "CloseWait" },
    ]);

    assert.deepStrictEqual(selected, {
      pid: 4242,
      processName: "node",
      state: "Listen",
    });
  });

  it("falls back to the first record when no listener exists", () => {
    const selected = selectPreferredPortConnection([
      { pid: 0, processName: "Unknown", state: "TimeWait" },
      { pid: 8181, processName: "client", state: "Established" },
    ]);

    assert.deepStrictEqual(selected, {
      pid: 0,
      processName: "Unknown",
      state: "TimeWait",
    });
  });

  it("returns undefined for an empty record set", () => {
    assert.strictEqual(selectPreferredPortConnection([]), undefined);
  });

  it(
    "reports the active Windows listener owner",
    { skip: process.platform !== "win32" },
    async () => {
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });

      try {
        const address = server.address();
        assert.ok(address && typeof address === "object");

        const result = await checkPort(address.port);

        assert.strictEqual(result.inUse, true);
        assert.strictEqual(result.state?.toLowerCase(), "listen");
        assert.strictEqual(result.pid, process.pid);
        assert.ok(result.processName);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  );
});
