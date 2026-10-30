// Development-only oracle bridge. The production runtime never invokes Python.
import * as fs from "node:fs";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { imageFile, videoFile } from "../skills/qiushui-fast-publish/scripts/lib/core";
import { configuredPlans, preflight, textSkips } from "../skills/qiushui-fast-publish/scripts/lib/preflight";
import * as publication from "../skills/qiushui-fast-publish/scripts/lib/publication";
import { startServer } from "../skills/qiushui-fast-publish/scripts/lib/server";
import { TaskStore } from "../skills/qiushui-fast-publish/scripts/lib/task-store";
if (process.argv[2] === "serve") {
  const { server } = startServer({
    state: process.argv[3],
    port: 0,
    hostPort: 2663,
    adminToken: "admin-test",
    validate: (...args) => {
      const mock = path.join(process.argv[3], "preflight-override.json");
      return fs.existsSync(mock) ? JSON.parse(fs.readFileSync(mock, "utf8")) : preflight(...args);
    },
  });
  console.log(JSON.stringify({ port: server.port }));
} else {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })) {
    try {
      const r = JSON.parse(line);
      let result;
      if (r.op === "preflight") result = preflight(...(r.args as [string, string, string, string, boolean]));
      else if (r.op === "plans") result = configuredPlans(...(r.args as [string, string, string, boolean]));
      else if (r.op === "skips") result = textSkips(...(r.args as [string, string, string]));
      else if (r.op === "image") result = imageFile(...(r.args as [string, string]));
      else if (r.op === "video") result = videoFile(...(r.args as [string, string]));
      else if (r.op === "generate") result = publication.generate(...(r.args as [string, any, string]));
      else if (r.op === "claim") result = new TaskStore(r.state).claim(r.args[0]);
      else throw new Error("Unknown test operation");
      console.log(JSON.stringify({ result }));
    } catch (error) {
      console.log(JSON.stringify({ error: (error as Error).message }));
    }
  }
}
