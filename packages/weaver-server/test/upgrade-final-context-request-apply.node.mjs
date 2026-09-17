import { test } from "node:test";
import {
  assertPreactivationRefusal,
  authoritySnapshot,
  mutateFinalContextRequest,
  observeNoAdmission,
  regionUs,
  tenantOne,
  withFinalMatrixRuntime,
} from "./upgrade-final-matrix-fixture.mjs";

const rows = [
  ["omitted inventory context", (contexts) => contexts.splice(1, 1)],
  ["extra inventory context", (contexts) => contexts.push([
    { scopeId: "region", value: "unrecorded" },
  ])],
  ["duplicate context", (contexts) => contexts.push(regionUs)],
  ["canonical alias context", (contexts) => contexts.push(
    tenantOne.map((scope) => ({ ...scope })),
  )],
];

for (const [name, mutate] of rows)
  test(`real apply rejects ${name}`, async (t) => {
    await withFinalMatrixRuntime(t, async ({ fixture, runtime, request, reopen }) => {
      const initial = await authoritySnapshot(runtime);
      mutateFinalContextRequest(t, runtime, mutate);
      const effects = observeNoAdmission(t, runtime);
      await assertPreactivationRefusal(
        runtime,
        runtime.applyUpgrade({ version: 1, request }),
        effects,
        initial,
        reopen,
        fixture,
      );
    });
  });
