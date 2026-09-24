const MAX_INLINE_CHARS = 90000;
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const reason = "Saved contract details exceed the inline budget. Open the exact plan path for omitted content; omission is not evidence of completeness.";

/** Keep a large durable save addressable without slicing structured JSON. */
export function contractCreateOutput(saved) {
	const full = JSON.stringify(saved);
	if (full.length <= MAX_INLINE_CHARS) return full;
	const result = {
		...pick(saved, ["path", "revision", "persistence", "validation", "session_binding"]),
		plan: { plan_id: saved.plan.plan_id, ...(saved.plan.template ? { template: pick(saved.plan.template, ["template_id", "revision"]) } : {}) },
		details_omitted: true, reason,
		omitted_fields: ["plan.task", "plan.work_items", "plan.template.content", "markdown"],
	};
	if (JSON.stringify(result).length <= MAX_INLINE_CHARS) return JSON.stringify(result);
	if (result.validation?.work_items) {
		result.validation = { ...pick(result.validation, ["valid", "complete"]), work_item_count: result.validation.work_items.length, details_omitted: true };
		result.omitted_fields.push("validation.work_items");
	}
	return JSON.stringify(result);
}
