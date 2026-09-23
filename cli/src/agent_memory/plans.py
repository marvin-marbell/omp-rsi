"""Immutable pinned contracts with scoped, evidence-backed work-item updates.

Actor names are audit labels, not authentication. Review is an explicit judgment,
not a proof that an artifact is true; this API never turns a report into a review.
"""
from __future__ import annotations

from copy import deepcopy

from agent_memory.contracts_store import (
    ContractError, check_revision, content_revision, identifier, now, sequence, shape, text,
)
from agent_memory.plan_templates import (
    render_template, requirements, review_template, string_list, validate_template,
)

TASK_FIELDS = ("title", "purpose", "good")
TASK_ADDITIONS = ("achievements", "validation", "steps", "boundaries")
STATUSES = ("pending", "in_progress", "complete")

PHASES = ("planning", "execution", "review", "complete")
PHASE_MOVES = {
    "planning": ("execution",),
    "execution": ("review",),
    "review": ("execution", "complete"),
    "complete": ("review",),
}
STEP_MOVES = {
    "pending": ("in_progress",),
    "in_progress": ("complete",),
    "complete": ("in_progress",),
}
STATUS_MOVES = {
    "pending": ("in_progress", "complete"),
    "in_progress": ("complete",),
    "complete": ("in_progress",),
}
EVENT_KINDS = ("phase_transition", "step_transition", "status_transition", "report",
               "review", "review_feedback", "steering", "retrieval", "contradiction", "external_change", "amendment")
EVENT_SOURCES = ("user", "memory", "pr_review", "external", "agent")
EVENT_CAUSES = ("none", "agent_omission", "external_change", "unknown")
NARRATIVE_SOURCES = {"review_feedback": ("pr_review",), "steering": ("user",),
                     "retrieval": ("memory",), "contradiction": ("memory",),
                     "external_change": ("external", "pr_review")}
MAX_EVENTS = 512


def _bounded(value, label, limit):
    text(value, label)
    if len(value) > limit:
        raise ContractError(f"{label} exceeds {limit} characters")
    return value


def _append_event(plan, event, actor, *, amendment=False):
    shape(event, ("id", "kind", "source", "reference", "summary", "before", "after", "cause"),
          ("step_id",), label="timeline event")
    identifier(event["id"], "timeline event id")
    if event["kind"] not in EVENT_KINDS or type(event["kind"]) is not str:
        raise ContractError("invalid timeline event kind")
    if event["source"] not in EVENT_SOURCES or type(event["source"]) is not str:
        raise ContractError("invalid timeline event source")
    if event["cause"] not in EVENT_CAUSES or type(event["cause"]) is not str:
        raise ContractError("invalid timeline event cause")
    if event["kind"] in NARRATIVE_SOURCES and event["source"] not in NARRATIVE_SOURCES[event["kind"]]:
        raise ContractError("timeline event kind/source mismatch")
    for key, limit in (("reference", 240), ("summary", 500), ("before", 500), ("after", 500)):
        _bounded(event[key], key, limit)
    if event["kind"] == "step_transition":
        identifier(event.get("step_id"), "step_id")
    elif "step_id" in event:
        raise ContractError("step_id only belongs to step_transition")
    if len(plan["timeline"]) >= MAX_EVENTS:
        raise ContractError("timeline is full; create a successor plan")
    if any(previous["id"] == event["id"] for previous in plan["timeline"]):
        raise ContractError("duplicate timeline event ID")
    if event["kind"] == "phase_transition":
        before, after = event["before"], event["after"]
        if plan["phase"] != before or after not in PHASE_MOVES.get(before, ()):
            raise ContractError("invalid phase transition")
        plan["phase"] = after
    elif event["kind"] == "step_transition":
        step = next((s for s in plan["steps"] if s["id"] == event["step_id"]), None)
        if step is None:
            raise ContractError("unknown step identity")
        before, after = event["before"], event["after"]
        if step["status"] != before or after not in STEP_MOVES.get(before, ()):
            raise ContractError("invalid step transition")
        step["status"] = after
    elif event["kind"] in ("report", "review", "status_transition") or (
        event["kind"] == "amendment" and not amendment
    ):
        raise ContractError("reports, reviews, work-item transitions, and amendments have dedicated actions")
    plan["timeline"].append({**deepcopy(event), "actor": actor, "at": now()})


def _automatic_event(plan, kind, actor, reference, summary, before, after):
    number = len(plan["timeline"]) + 1
    existing = {event["id"] for event in plan["timeline"]}
    while f"auto-{number}" in existing:
        number += 1
    event = {"id": f"auto-{number}", "kind": kind, "source": "agent",
             "reference": reference, "summary": _bounded(summary, "summary", 500),
             "before": before, "after": after, "cause": "none", "actor": actor, "at": now()}
    if len(plan["timeline"]) >= MAX_EVENTS:
        raise ContractError("timeline is full; create a successor plan")
    plan["timeline"].append(event)

def _step_texts(plan):
    return [*plan["template"]["content"]["steps"], *plan["task"].get("steps", [])]


def _validate_timeline(plan):
    if plan["phase"] not in PHASES or type(plan["phase"]) is not str:
        raise ContractError("invalid plan phase")
    steps = sequence(plan["steps"], "steps")
    if len(steps) != len(_step_texts(plan)):
        raise ContractError("plan steps do not match pinned template and task steps")
    for index, step in enumerate(steps, 1):
        shape(step, ("id", "status"), label="plan step")
        if step["id"] != f"step-{index}" or step["status"] not in STATUSES:
            raise ContractError("invalid plan step identity or status")
    if "predecessor" in plan:
        predecessor = shape(plan["predecessor"], ("plan_id", "revision"), ("family_plan_id",), label="predecessor")
        identifier(predecessor["plan_id"], "predecessor plan_id")
        _bounded(predecessor["revision"], "predecessor revision", 128)
        if predecessor["plan_id"] == plan["plan_id"]:
            raise ContractError("plan cannot supersede itself")
        if "family_plan_id" in predecessor:
            identifier(predecessor["family_plan_id"], "family_plan_id")
            if predecessor["family_plan_id"] == plan["plan_id"]:
                raise ContractError("plan cannot share a family root with itself")
    events = sequence(plan["timeline"], "timeline")
    if len(events) > MAX_EVENTS:
        raise ContractError("timeline exceeds maximum event count")
    seen = set()
    phase = "planning"
    step_states = {step["id"]: "pending" for step in steps}
    item_states = {item["id"]: "pending" for item in plan["work_items"]}
    for event in events:
        shape(event, ("id", "kind", "source", "reference", "summary", "before", "after",
                      "cause", "actor", "at"), ("step_id",), label="stored timeline event")
        identifier(event["id"], "timeline event id")
        if event["id"] in seen:
            raise ContractError("duplicate timeline event ID")
        seen.add(event["id"])
        if type(event["kind"]) is not str or event["kind"] not in EVENT_KINDS:
            raise ContractError("invalid timeline event kind")
        if type(event["source"]) is not str or event["source"] not in EVENT_SOURCES:
            raise ContractError("invalid timeline event source")
        if type(event["cause"]) is not str or event["cause"] not in EVENT_CAUSES:
            raise ContractError("invalid timeline event cause")
        if event["kind"] in NARRATIVE_SOURCES and event["source"] not in NARRATIVE_SOURCES[event["kind"]]:
            raise ContractError("timeline event kind/source mismatch")
        for key, limit in (("reference", 240), ("summary", 500), ("before", 500), ("after", 500),
                           ("actor", 240), ("at", 80)):
            _bounded(event[key], key, limit)
        if event["kind"] == "phase_transition":
            if "step_id" in event or event["before"] != phase or event["after"] not in PHASE_MOVES[phase]:
                raise ContractError("invalid phase transition history")
            phase = event["after"]
        elif event["kind"] == "step_transition":
            step_id = identifier(event.get("step_id"), "step_id")
            before = step_states.get(step_id)
            if before is None or event["before"] != before or event["after"] not in STEP_MOVES[before]:
                raise ContractError("invalid step transition history")
            step_states[step_id] = event["after"]
        elif event["kind"] == "status_transition":
            parts = event["reference"].split("/")
            if len(parts) != 2 or parts[0] != "work" or parts[1] not in item_states:
                raise ContractError("unknown work-item identity in timeline")
            before = item_states[parts[1]]
            if event["before"] != before or event["after"] not in STATUS_MOVES[before]:
                raise ContractError("invalid work-item transition history")
            item_states[parts[1]] = event["after"]
        elif "step_id" in event:
            raise ContractError("step_id only belongs to step_transition")
        if event["kind"] == "amendment" and ("predecessor" not in plan or len(seen) != 1):
            raise ContractError("amendment must be the successor's first event")
    if "predecessor" in plan and (not events or events[0]["kind"] != "amendment"):
        raise ContractError("successor requires an amendment event")
    if phase != plan["phase"] or any(step_states[s["id"]] != s["status"] for s in steps):
        raise ContractError("timeline transitions do not match current plan state")
    if any(item_states[i["id"]] != i["status"] for i in plan["work_items"]):
        raise ContractError("timeline transitions do not match current work items")
    if plan["phase"] == "complete" and (
        any(s["status"] != "complete" for s in steps) or
        any(i["status"] != "complete" for i in plan["work_items"])
    ):
        raise ContractError("plan phase cannot complete before steps and work items")


def task_requirements(task, template):
    combined = []
    for key in ("achievements", "validation"):
        combined += template[key] + task.get(key, [])
    ids = [r["id"] for r in combined]
    if len(ids) != len(set(ids)):
        raise ContractError("task requirements cannot replace pinned requirement IDs")
    return combined


def validate_task(task, template):
    shape(task, TASK_FIELDS, TASK_ADDITIONS, label="task")
    for key in TASK_FIELDS:
        text(task[key], key)
    for key in ("achievements", "validation"):
        if key in task:
            requirements(task[key], key)
    for key in ("steps", "boundaries"):
        if key in task:
            string_list(task[key], key)
    return task_requirements(task, template)


def validate_item_scope(items, requirement_ids, *, stored=False):
    seen, assigned = set(), set()
    for item in sequence(items, "work_items", nonempty=True):
        fields = ("id", "title", "owner", "requirement_ids")
        shape(item, fields + (("status", "evidence", "exceptions") if stored else ()), label="work item")
        item_id = identifier(item["id"], "work item id")
        if item_id in seen:
            raise ContractError("duplicate work item ID")
        seen.add(item_id)
        text(item["title"], "work item title")
        text(item["owner"], "owner")
        ids = sequence(item["requirement_ids"], "requirement_ids", nonempty=True)
        for req in ids:
            identifier(req, "requirement id")
            if req not in requirement_ids:
                raise ContractError(f"unknown requirement: {req}")
        if len(ids) != len(set(ids)):
            raise ContractError("duplicate work item requirement")
        assigned.update(ids)
    if assigned != requirement_ids:
        raise ContractError(f"work items must cover all requirements; missing {sorted(requirement_ids - assigned)}")


def _review(value, target_key):
    shape(value, (target_key, "verdict", "note"), label="review")
    identifier(value[target_key], target_key)
    if not isinstance(value["verdict"], str) or value["verdict"] not in ("accepted", "rejected"):
        raise ContractError("review verdict must be accepted or rejected")
    text(value["note"], "review note")


def _report(value, exception=False):
    fields = ("id", "requirement_id", "reason", "alternative") if exception else ("id", "requirement_id", "summary", "reference")
    shape(value, fields, label="exception" if exception else "evidence")
    identifier(value["id"])
    identifier(value["requirement_id"], "requirement_id")
    for key in fields[2:]:
        text(value[key], key)


def _validate_records(item, exception=False):
    key = "exceptions" if exception else "evidence"
    report_fields = ("id", "requirement_id", "reason", "alternative") if exception else ("id", "requirement_id", "summary", "reference")
    seen = set()
    for record in sequence(item[key], key):
        shape(record, (*report_fields, "reported_by", "reported_at", "reviews"), label=key)
        _report({k: record[k] for k in report_fields}, exception)
        if record["id"] in seen or record["requirement_id"] not in item["requirement_ids"]:
            raise ContractError("duplicate record ID or evidence outside work-item scope")
        seen.add(record["id"])
        text(record["reported_by"], "reported_by")
        text(record["reported_at"], "reported_at")
        for review in sequence(record["reviews"], "reviews"):
            shape(review, ("verdict", "note", "reviewed_by", "reviewed_at"), label="stored review")
            _review({"record_id": record["id"], "verdict": review["verdict"], "note": review["note"]}, "record_id")
            text(review["reviewed_by"], "reviewed_by")
            text(review["reviewed_at"], "reviewed_at")


def _accepted(record):
    return bool(record["reviews"] and record["reviews"][-1]["verdict"] == "accepted")


def item_progress(item):
    evidenced = {e["requirement_id"] for e in item["evidence"] if _accepted(e)}
    excepted = {e["requirement_id"] for e in item["exceptions"] if _accepted(e)}
    pending_exceptions = [e["id"] for e in item["exceptions"] if not e["reviews"]]
    missing = sorted(set(item["requirement_ids"]) - evidenced - excepted)
    return {"work_item_id": item["id"], "reported_evidence": len(item["evidence"]),
            "reviewed_requirements": sorted(evidenced), "accepted_exceptions": sorted(excepted),
            "missing_requirements": missing, "pending_exceptions": pending_exceptions,
            "ready": not missing and not pending_exceptions}


def validate_plan(plan):
    schema = plan.get("schema")
    fields = ("kind", "schema", "plan_id", "title", "created_by", "template", "task", "work_items")
    shape(plan, fields + (("phase", "steps", "timeline") if schema == 2 else ()),
          ("predecessor",) if schema == 2 else (), label="plan contract")
    if plan["kind"] != "plan" or type(schema) is not int or schema not in (1, 2):
        raise ContractError("unsupported plan contract")
    identifier(plan["plan_id"], "plan_id")
    text(plan["title"], "title")
    text(plan["created_by"], "created_by")
    pin = shape(plan["template"], ("template_id", "revision", "content", "content_sha256"), label="template pin")
    identifier(pin["template_id"], "template_id")
    text(pin["revision"], "template revision")
    template = validate_template(pin["content"])
    if content_revision(template) != pin["content_sha256"]:
        raise ContractError("pinned template snapshot hash mismatch")
    reqs = validate_task(plan["task"], template)
    validate_item_scope(plan["work_items"], {r["id"] for r in reqs}, stored=True)
    progress = []
    for item in plan["work_items"]:
        if not isinstance(item["status"], str) or item["status"] not in STATUSES:
            raise ContractError("invalid work item status")
        _validate_records(item)
        _validate_records(item, exception=True)
        detail = item_progress(item)
        if item["status"] == "complete" and not detail["ready"]:
            raise ContractError(f"work item {item['id']} cannot complete without reviewed evidence or accepted exceptions")
        progress.append(detail)
    if schema == 2:
        _validate_timeline(plan)
    complete = all(i["status"] == "complete" for i in plan["work_items"]) and (schema == 1 or plan["phase"] == "complete")
    return {"valid": True, "complete": complete, "work_items": progress}


def render_plan(plan):
    task = plan["task"]
    pin = plan["template"]
    sections = [f"# {task['title']}", "Rewards > gates: reward useful outcomes with evidence, not tool-call counts.",
                "## Purpose", task["purpose"], "## What good looks like", task["good"],
                "## Governing template snapshot",
                f"Template `{pin['template_id']}` at content revision `{pin['revision']}`. Requirements remain pinned.",
                render_template(pin["content"]).replace("\n## ", "\n### ").replace("# ", "### ", 1)]
    if plan["schema"] == 2:
        sections += ["## Trajectory", f"Phase: {plan['phase']}."]
        if "predecessor" in plan:
            previous = plan["predecessor"]
            sections.append(f"Supersedes `{previous['plan_id']}` at revision `{previous['revision']}`; the predecessor remains unchanged.")
        step_texts = _step_texts(plan)
        for index, step in enumerate(plan["steps"]):
            sections.append(f"- {step['id']} ({step['status']}): {step_texts[index]}")
        for event in plan["timeline"]:
            sections.append(f"- {event['kind']} `{event['id']}` by {event['actor']} at {event['at']}: "
                            f"{event['summary']} ({event['before']} → {event['after']}; "
                            f"source {event['source']} {event['reference']}; cause {event['cause']})")
    for key in TASK_ADDITIONS:
        if key in task:
            sections.append(f"## Task {key}")
            sections.append(f"This section lists task-specific {key} alongside the pinned template.")
            sections.extend(f"- {v['id']}: {v['description']} Evidence: {v['evidence']}" if isinstance(v, dict) else f"- {v}" for v in task[key])
    sections += ["## Work items and evidence", "Scoped work tracks reported evidence and explicit review separately."]
    for item in plan["work_items"]:
        sections += [f"### {item['id']}: {item['title']}",
                     f"Owner: {item['owner']}. Status: {item['status']}. Requirements: {', '.join(item['requirement_ids'])}."]
        for key in ("evidence", "exceptions"):
            for record in item[key]:
                content = (f"{record['summary']} — {record['reference']}" if key == "evidence" else
                           f"{record['reason']} — alternative: {record['alternative']}")
                sections.append(f"- {key} `{record['id']}` for `{record['requirement_id']}`, reported by {record['reported_by']}: {content}")
                for review in record["reviews"]:
                    sections.append(f"  - Review {review['verdict']} by {review['reviewed_by']}: {review['note']}")
    sections += ["## Completion", "Complete with reviewed evidence/accepted exceptions." if validate_plan(plan)["complete"] else
                 "Not complete. Status alone never establishes achievement; reported evidence needs explicit review."]
    return "\n\n".join(sections)


def create_plan(store, request, actor):
    shape(request, ("action", "plan_id", "template_id", "template_revision", "task"), label="create request")
    plan_id = identifier(request["plan_id"], "plan_id")
    review = review_template(store, request["template_id"])
    check_revision(request["template_revision"], review["revision"])
    shape(request["task"], (*TASK_FIELDS, "work_items"), TASK_ADDITIONS, label="task")
    task = deepcopy(request["task"])
    items = task.pop("work_items")
    reqs = validate_task(task, review["template"])
    validate_item_scope(items, {r["id"] for r in reqs})
    for item in items:
        item.update(status="pending", evidence=[], exceptions=[])
    plan = {"kind": "plan", "schema": 2, "plan_id": plan_id, "title": task["title"], "created_by": actor,
            "template": {"template_id": review["template_id"], "revision": review["revision"],
                         "content": deepcopy(review["template"]), "content_sha256": content_revision(review["template"])},
            "task": task, "work_items": items, "phase": "planning",
            "steps": [{"id": f"step-{index}", "status": "pending"}
                      for index, _ in enumerate([*review["template"]["steps"], *task.get("steps", [])], 1)], "timeline": []}
    validation = validate_plan(plan)
    result = store.save("plans", plan_id, plan, render_plan(plan), actor=actor, expected=None)
    return {**result, "plan": plan, "validation": validation}


def read_plan(store, plan_id):
    entry = store.read("plans", plan_id)
    if entry["contract"].get("plan_id") != plan_id:
        raise ContractError("plan identity does not match file")
    validation = validate_plan(entry["contract"])
    return {"path": entry["path"], "revision": entry["revision"], "plan": entry["contract"],
            "validation": validation, "markdown": entry["markdown"]}


def append_plan_event(store, request, actor):
    shape(request, ("action", "plan_id", "revision", "event"), label="append_event request")
    current = read_plan(store, request["plan_id"])
    check_revision(request["revision"], current["revision"])
    plan = deepcopy(current["plan"])
    if plan["schema"] != 2:
        raise ContractError("schema 1 plans have no timeline; create a successor plan")
    _append_event(plan, request["event"], actor)
    validation = validate_plan(plan)
    result = store.save("plans", plan["plan_id"], plan, render_plan(plan), actor=actor,
                        expected=request["revision"])
    return {**result, "plan": plan, "validation": validation}


def amend_plan(store, request, actor):
    shape(request, ("action", "plan_id", "revision", "successor_plan_id", "task", "event"),
          label="amend request")
    current = read_plan(store, request["plan_id"])
    check_revision(request["revision"], current["revision"])
    parent = current["plan"]
    successor_id = identifier(request["successor_plan_id"], "successor_plan_id")
    if successor_id == parent["plan_id"]:
        raise ContractError("successor plan ID must differ from predecessor")
    # The parent and its pinned requirements remain untouched. A successor starts
    # with fresh review/evidence and must cover every requirement of the same pin.
    shape(request["task"], (*TASK_FIELDS, "work_items"), TASK_ADDITIONS, label="task")
    task = deepcopy(request["task"])
    items = task.pop("work_items")
    template = parent["template"]["content"]
    reqs = validate_task(task, template)
    validate_item_scope(items, {r["id"] for r in reqs})
    for item in items:
        item.update(status="pending", evidence=[], exceptions=[])
    plan = {"kind": "plan", "schema": 2, "plan_id": successor_id, "title": task["title"],
            "created_by": actor, "template": deepcopy(parent["template"]), "task": task,
            "work_items": items, "phase": "planning",
            "steps": [{"id": f"step-{index}", "status": "pending"}
                      for index, _ in enumerate([*template["steps"], *task.get("steps", [])], 1)],
            "predecessor": {"plan_id": parent["plan_id"], "revision": current["revision"],
                            "family_plan_id": parent.get("predecessor", {}).get("family_plan_id",
                                            parent.get("predecessor", {}).get("plan_id", parent["plan_id"]))},
            "timeline": []}
    event = request["event"]
    if not isinstance(event, dict) or event.get("kind") != "amendment":
        raise ContractError("amend requires an amendment event")
    # The amendment is an explicit provenance event, not a change to the parent.
    shape(event, ("id", "kind", "source", "reference", "summary", "before", "after", "cause"),
          label="amendment event")
    _append_event(plan, event, actor, amendment=True)
    validation = validate_plan(plan)
    result = store.save("plans", successor_id, plan, render_plan(plan), actor=actor, expected=None)
    return {**result, "plan": plan, "validation": validation}


def append_reports(item, reports, actor, *, exception=False):
    key = "exceptions" if exception else "evidence"
    existing = {e["id"] for e in item[key]}
    for report in sequence(reports, key):
        _report(report, exception)
        if report["id"] in existing:
            raise ContractError(f"duplicate {key} ID; reports are append-only")
        if report["requirement_id"] not in item["requirement_ids"]:
            raise ContractError("evidence/exception is outside selected work-item scope")
        existing.add(report["id"])
        item[key].append({**deepcopy(report), "reported_by": actor, "reported_at": now(), "reviews": []})


def append_reviews(item, reviews, actor, *, exception=False):
    key = "exceptions" if exception else "evidence"
    target = "exception_id" if exception else "evidence_id"
    records = {e["id"]: e for e in item[key]}
    for review in sequence(reviews, "reviews"):
        _review(review, target)
        record = records.get(review[target])
        if record is None:
            raise ContractError(f"review target not in this work item: {review[target]}")
        record["reviews"].append({"verdict": review["verdict"], "note": review["note"],
                                  "reviewed_by": actor, "reviewed_at": now()})


def update_plan(store, request, actor):
    changes = ("status", "evidence", "reviews", "exceptions", "exception_reviews")
    shape(request, ("action", "plan_id", "revision", "work_item_id"), changes, label="update request")
    if not any(k in request for k in changes):
        raise ContractError("update requires a scoped change")
    current = read_plan(store, request["plan_id"])
    check_revision(request["revision"], current["revision"])
    work_item_id = identifier(request["work_item_id"], "work_item_id")
    plan = deepcopy(current["plan"])
    item = next((i for i in plan["work_items"] if i["id"] == work_item_id), None)
    if item is None:
        raise ContractError("work item not found")
    # Reviews deliberately precede new reports: a single operation cannot both
    # report a new achievement/exception and silently mark it accepted.
    v2 = plan["schema"] == 2
    for key in ("reviews", "exception_reviews", "evidence", "exceptions"):
        if key in request:
            sequence(request[key], key)
    for key, exception in (("reviews", False), ("exception_reviews", True)):
        target = "exception_id" if exception else "evidence_id"
        records = {record["id"]: record for record in item["exceptions" if exception else "evidence"]}
        for review in request.get(key, []):
            _review(review, target)
            previous = records.get(review[target])
            if previous is None:
                raise ContractError(f"review target not in this work item: {review[target]}")
            before = previous["reviews"][-1]["verdict"] if previous["reviews"] else "unreviewed"
            append_reviews(item, [review], actor, exception=exception)
            if v2:
                ref = f"work/{work_item_id}/{'exception' if exception else 'evidence'}/{review[target]}"
                _automatic_event(plan, "review", actor, ref, review["note"][:500],
                                 before, review["verdict"])
    for key, exception in (("evidence", False), ("exceptions", True)):
        for report in request.get(key, []):
            append_reports(item, [report], actor, exception=exception)
            if v2:
                ref = f"work/{work_item_id}/{'exception' if exception else 'evidence'}/{report['id']}"
                _automatic_event(plan, "report", actor, ref,
                                 report["reason" if exception else "summary"][:500],
                                 "unreported", "reported")
    if "status" in request:
        before, after = item["status"], request["status"]
        if v2 and after not in STATUS_MOVES.get(before, ()):
            raise ContractError("invalid work-item status transition")
        item["status"] = after
        if v2:
            _automatic_event(plan, "status_transition", actor, f"work/{work_item_id}",
                             "Work-item status changed", before, after)
    validation = validate_plan(plan)
    result = store.save("plans", request["plan_id"], plan, render_plan(plan), actor=actor,
                        expected=request["revision"])
    return {**result, "plan": plan, "validation": validation}
