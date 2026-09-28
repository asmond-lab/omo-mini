import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { InteractiveMode } from "../node_modules/@code-yeongyu/senpi/dist/modes/interactive/interactive-mode.js";
import { FooterDataProvider } from "../node_modules/@code-yeongyu/senpi/dist/core/footer-data-provider.js";

const native = InteractiveMode.prototype as unknown as {
  selectModelFromUi(model: unknown, done: () => void): Promise<void>;
  setExtensionStatus(key: string, text: string | undefined): void;
};
const candidate = { provider: "omo-mini-local", id: "downloaded-local", contextWindow: 1 };
const active = { provider: "omo-mini-local", id: "loaded-instance", contextWindow: 65536 };

test("Native picker uses its own footer status while fake local load is pending and restores it on every outcome", async () => {
  const original = { profile: process.env["OMO_MINI_LOCAL_PROFILE"], root: process.env["OMO_MINI_ROOT"] };
  process.env["OMO_MINI_LOCAL_PROFILE"] = "1";
  process.env["OMO_MINI_ROOT"] = "C:\\fake-workspace";
  try {
    for (const outcome of ["success", "failure", "cancel"] as const) {
      const footerDataProvider = new FooterDataProvider(tmpdir());
      const before = "PRIOR-UNLOADED-STATUS-SENTINEL";
      footerDataProvider.setExtensionStatus("omo-mini", before);
      const started = Promise.withResolvers<void>();
      const release = Promise.withResolvers<{ model: typeof active }>();
      const statuses: (string | undefined)[] = [];
      const errors: string[] = [];
      let closed = 0, renders = 0;
      const session = { model: undefined as typeof active | undefined,
        setModel: (_model: unknown) => { started.resolve(); return release.promise; } };
      const ui = {
        footerDataProvider, session, ui: { requestRender() { renders++; } },
        setExtensionStatus(key: string, text: string | undefined) {
          native.setExtensionStatus.call(this, key, text);
          statuses.push(footerDataProvider.getExtensionStatuses().get(key));
        },
        footer: { invalidate() {}, setCompactionDelegated() {} },
        updateEditorBorderColor() {}, showStatus(_text: string) {},
        showError(text: string) { errors.push(text); },
        showRiskyMainModelWarning() {}, maybeWarnAboutAnthropicSubscriptionAuth() {}, checkDaxnutsEasterEgg() {},
      };
      try {
        // Subscribe to the exact fake-load entry before selecting; no polling or sleep.
        const selection = native.selectModelFromUi.call(ui, candidate, () => { closed++; });
        await started.promise;
        expect(closed).toBe(1);
        const pending = footerDataProvider.getExtensionStatuses().get("omo-mini");
        expect(pending).toContain(candidate.id);
        expect(pending).toContain(process.env["OMO_MINI_ROOT"]!);
        expect(pending).not.toContain(active.id);
        expect(pending).not.toBe(before);
        expect(renders).toBe(2);
        expect(statuses).toHaveLength(1);
        if (outcome === "success") {
          session.model = active;
          release.resolve({ model: active });
          await selection;
          const ready = footerDataProvider.getExtensionStatuses().get("omo-mini");
          expect(ready).toContain(active.id);
          expect(ready).toContain(String(active.contextWindow));
          expect(ready).toContain(process.env["OMO_MINI_ROOT"]!);
          expect(ready).not.toContain(candidate.id);
          expect(ready).not.toBe(before);
          expect(errors).toEqual([]);
        } else {
          release.reject(Error(outcome === "cancel" ? "Local load cancelled" : "Local load failed"));
          await selection;
          expect(footerDataProvider.getExtensionStatuses().get("omo-mini")).toBe(before);
          expect(errors).toHaveLength(1);
        }
        expect(statuses).toHaveLength(2);
        expect(renders).toBe(3);
      } finally { footerDataProvider.dispose(); }
    }
  } finally {
    if (original.profile === undefined) delete process.env["OMO_MINI_LOCAL_PROFILE"];
    else process.env["OMO_MINI_LOCAL_PROFILE"] = original.profile;
    if (original.root === undefined) delete process.env["OMO_MINI_ROOT"];
    else process.env["OMO_MINI_ROOT"] = original.root;
  }
});
