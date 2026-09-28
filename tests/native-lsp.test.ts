import { expect, test } from "bun:test";
import { join } from "node:path";

test.each(["1", "0"])("native extension loading honors the LSP policy for local profile %s", async profile => {
  const script = `
    import { createExtensionRuntime, loadExtensionFromFactory } from "./node_modules/@code-yeongyu/senpi/dist/core/extensions/loader.js";
    import { createEventBus } from "./node_modules/@code-yeongyu/senpi/dist/core/event-bus.js";
    const values = {};
    await loadExtensionFromFactory(pi => {
      pi.registerFlag("omo-senpi-lsp-disabled", { type: "boolean", default: false });
      pi.registerFlag("unrelated-disabled", { type: "boolean", default: false });
      values.disabled = pi.getFlag("omo-senpi-lsp-disabled");
      values.unrelated = pi.getFlag("unrelated-disabled");
    }, process.cwd(), createEventBus(), createExtensionRuntime());
    console.log(JSON.stringify(values));
  `;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, OMO_MINI_LOCAL_PROFILE: profile },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, output, errors] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(errors).toBe("");
  expect(code).toBe(0);
  expect(JSON.parse(output)).toEqual({ disabled: false, unrelated: false });
}, 15000);
