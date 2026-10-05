import { test } from "node:test";
import { run, root } from "./packed-consumer-helper.mjs";

test("actual packed test callbacks clean owned parents when sentinel mkdir/write reject", () => {
  const helper = new URL("./packed-parent-cleanup.mjs", import.meta.url).href;
  console.log(run(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e",
    `import { verifyParentCleanup } from ${JSON.stringify(helper)}; await verifyParentCleanup();`], root));
});
