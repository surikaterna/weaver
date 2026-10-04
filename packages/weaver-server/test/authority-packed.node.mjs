import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalSeed } from "./fixtures/authority-host.mjs";
import { artifactProof, run, strictDeclarations, synchronousRequireProof, withPackedServer } from "./fixtures/authority-packed.mjs";

test("external packed server ESM/CJS real TCP/FS and strict Node declarations", { timeout: 120000 }, async (context) => {
  await withPackedServer(async (directory) => {
    for (const [name, member] of [["weaver-server", "startWeaverServer"], ["transport-scomp", "createScompTransport"]])
      await context.test(`independent synchronous CJS ${name}`, () => synchronousRequireProof(directory, name, member));
    await context.test("installed notices and exact generated runtime edges", () => artifactProof(directory));
    await writeFile(join(directory, "seed.json"), JSON.stringify(canonicalSeed("dev").serialized));
    await writeFile(join(directory, "consumer.mjs"), await readFile(new URL("fixtures/authority-http-consumer.mjs", import.meta.url), "utf8"));
    for (const format of ["esm", "cjs"])
      await context.test(`real ${format} listener`, () => console.log(run(process.execPath, ["consumer.mjs", format], directory)));
    await context.test("strict installed declarations", () => strictDeclarations(directory));
    for (const name of ["authority-scomp-consumer.mjs", "authority-scomp-loopback.mjs"])
      await writeFile(join(directory, name), await readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8"));
    await context.test("four real public SCOMP pairs over test TCP", () => console.log(run(process.execPath, ["authority-scomp-consumer.mjs"], directory)));
  });
});
