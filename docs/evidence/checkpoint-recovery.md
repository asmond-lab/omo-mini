# Checkpoint recovery (0.2.2)

An earlier version-1 session checkpoint saved its one observed tool result as a bounded object; the released reader expected an array and rejected continuation. Version 0.2.2 validates that earlier shape against the existing field limits and normalizes it to a one-element array in memory. It does not rewrite the original session or substitute a plan for observed execution.

A truly invalid latest derived checkpoint is warned about and omitted. The native conversation remains available for continuation, with guidance to verify results before claiming completion; an older checkpoint is not substituted. Session-header and runtime project-root checks still block a different-project session.

Independent QA on the fix commit: 41 tests passed, 0 failed; typecheck and build passed. A read-only native continuation of an isolated copy of the affected session used the already-loaded local model: one provider request contained the normalized checkpoint, the assistant returned a nonempty response and stopped normally, and no tools ran. The source session was unchanged during that copy run. This establishes recovery and request shape, not the quality of the model's prose or every possible memory failure. No private transcript or response is published here.
