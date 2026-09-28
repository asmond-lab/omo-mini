import { z } from "zod";

const trigger = z.object({ step_count: z.number().int().nonnegative().optional(), on_compaction: z.boolean().optional() }).strict();
const enabled = z.object({ enabled: z.boolean().optional() }).strict();
const positive = z.number().int().positive();
const nonnegative = z.number().int().nonnegative();

export function isolatedMemoryOverride(writable: boolean, nativeMemorySync = false) {
  const writer = z.object({ enabled: (writable ? z.boolean() : z.literal(false)).optional() });
  return z.object({
    enabled: z.boolean().optional(),
    agent: z.literal("auto").optional(),
    agents: z.object({}).strict().optional(),
    reflection: writer.extend({
      trigger: trigger.optional(), merge: z.enum(["auto", "integration"]).optional(),
      category: z.literal("quick").optional(), timeout_minutes: positive.optional(),
      sandbox: z.enum(["auto", "required", "off"]).optional(),
    }).strict().optional(),
    nudge: enabled.extend({ every_user_turns: positive.optional() }).strict().optional(),
    facts: writer.extend({ debounce_settles: positive.optional() }).strict().optional(),
    dream: writer.extend({
      idle_minutes: nonnegative.optional(), min_hours_between: positive.optional(),
      shutdown_launch: z.boolean().optional(), auto_select_max: z.number().int().min(1).max(10).optional(),
      auto_select_max_chars: z.number().int().min(10_000).optional(),
    }).strict().optional(),
    people: enabled.extend({ max_entries: z.number().int().min(1).max(100).optional(),
      max_entry_chars: z.number().int().min(50).max(500).optional() }).strict().optional(),
    soul: z.object({ edit_notice: z.boolean().optional() }).strict().optional(),
    write_notice: enabled.optional(),
    sync: z.object({ enabled: z.literal(nativeMemorySync).optional() }).strict().optional(),
    search: enabled.optional(),
    recall: enabled.extend({
      max_items: z.number().int().min(1).max(5).optional(), category: z.literal("quick").optional(),
      event_caps: z.object({ tool_args: nonnegative.optional(), result_head: nonnegative.optional(),
        assistant: nonnegative.optional(), prompt: nonnegative.optional() }).strict().optional(),
      sidecar_max_tokens: positive.optional(), max_concurrent_wakes: positive.optional(),
      tool_budget: positive.optional(),
    }).strict().optional(),
    compile_warn_tokens: positive.optional(),
  }).strict();
}
