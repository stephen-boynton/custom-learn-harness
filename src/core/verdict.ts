/**
 * The VERDICT on a production answer (spec #2, ADR-0003): the independent
 * grader's structured judgment of a free-recall answer against the
 * teacher's commitment, and the pure derivations code makes from it — pass
 * and the display label. The grader judges; code derives. Nothing here
 * calls a model (the grader run lives in src/agent/subagents/grader.ts).
 *
 * Shape from docs/research/free-recall-verdicts.md §7.2. The verdict is
 * stored on the answer record (`QuestionAnswerData.verdict`), written once
 * and never revised.
 */

import { Type, type Static } from "typebox";
import type { KeyPoint } from "./question-core.ts";

/** The verdict as the grader submits it. Property order is the order the
 *  grader writes: the rationale comes BEFORE the labels (§7.2). */
export const verdictSchema = Type.Object({
	rationale: Type.String({
		description: "Your reasoning, written FIRST: what the answer says and how it relates to each key point.",
	}),
	attempt: Type.Union([Type.Literal("answered"), Type.Literal("off_target")], {
		description: 'off_target when the answer does not attempt this question at all; otherwise answered.',
	}),
	points: Type.Array(
		Type.Object({
			id: Type.String({ description: "The key point's id, exactly as given." }),
			status: Type.Union([Type.Literal("present"), Type.Literal("absent"), Type.Literal("contradicted")]),
			evidence: Type.String({
				description: 'The shortest quote from the answer supporting the status; "" when absent.',
			}),
		}),
		{ description: "Exactly one entry per key point." },
	),
	extraErrors: Type.Array(Type.Object({ claim: Type.String() }), {
		description: "False claims in the answer that no key point covers. Empty when there are none.",
	}),
	uncertain: Type.Boolean({ description: "true when you could not make this judgment cleanly." }),
});

export type Verdict = Static<typeof verdictSchema>;
export type KeyPointStatus = Verdict["points"][number]["status"];

/** The code check the schema cannot carry: every key point gets exactly
 *  one status, and no status names a point the key doesn't have. null =
 *  the verdict covers the key. */
export function verdictProblem(verdict: Verdict, keyPoints: readonly Pick<KeyPoint, "id">[]): string | null {
	const expected = new Set(keyPoints.map((point) => point.id));
	const seen = new Set<string>();
	for (const point of verdict.points) {
		if (!expected.has(point.id)) return `points names "${point.id}", which is not a key point id.`;
		if (seen.has(point.id)) return `key point "${point.id}" has more than one status — give each exactly one.`;
		seen.add(point.id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	if (missing.length > 0) return `key point(s) ${missing.map((id) => `"${id}"`).join(", ")} have no status — give each exactly one.`;
	return null;
}

/** The UNCERTAIN VERDICT recorded when grading could not produce a clean
 *  verdict (invalid output, a failed call, a timeout, no usable model):
 *  counts neither for nor against the learner. `reason` rides the
 *  rationale for audit. */
export function uncertainVerdict(reason: string): Verdict {
	return { rationale: reason, attempt: "answered", points: [], extraErrors: [], uncertain: true };
}

/** What the derivations read off an answer record. */
export interface GradedAnswer {
	dontKnow?: boolean;
	verdict?: Verdict;
	keyPoints?: readonly Pick<KeyPoint, "id" | "required">[];
}

/** Does the verdict show an error — a contradicted key point or an
 *  extra error? Fails pass; labels the answer a misconception. */
function showsError(v: Verdict): boolean {
	return v.points.some((point) => point.status === "contradicted") || v.extraErrors.length > 0;
}

/** PASS (spec #2): attempt answered, not "I don't know", not uncertain,
 *  every required point present, no point contradicted, no extra errors. */
export function answerPasses(answer: GradedAnswer): boolean {
	const v = answer.verdict;
	if (answer.dontKnow || !v || v.uncertain || v.attempt !== "answered") return false;
	if (showsError(v)) return false;
	const status = new Map(v.points.map((point) => [point.id, point.status]));
	return (answer.keyPoints ?? []).every((point) => !point.required || status.get(point.id) === "present");
}

/** The display label of a production answer. `ungraded` (owner,
 *  2026-10-27) is an uncertain verdict — no claim either way. */
export type DisplayLabel = "dont_know" | "ungraded" | "off_target" | "misconception" | "correct" | "incomplete";

/** The display label (spec #2, research §7.3), first match wins:
 *  dont_know → ungraded (uncertain) → off_target → misconception (any
 *  contradicted point or extra error) → correct (pass) → incomplete.
 *  undefined = nothing to label (no verdict and no "I don't know": a
 *  record from before grading existed). */
export function displayLabel(answer: GradedAnswer): DisplayLabel | undefined {
	if (answer.dontKnow) return "dont_know";
	const v = answer.verdict;
	if (!v) return undefined;
	if (v.uncertain) return "ungraded";
	if (v.attempt === "off_target") return "off_target";
	if (showsError(v)) return "misconception";
	return answerPasses(answer) ? "correct" : "incomplete";
}

/** The verdict as the TEACHER reads it in the answer (owner, 2026-10-27):
 *  the display label, each key point's status, and the extra-error
 *  claims — no evidence quotes, no rationale. An uncertain verdict shows
 *  `ungraded` with no statuses. undefined = nothing to show. */
export function verdictForModel(answer: GradedAnswer): Record<string, unknown> | undefined {
	const label = displayLabel(answer);
	if (!label) return undefined;
	const out: Record<string, unknown> = { label };
	const v = answer.verdict;
	if (label === "dont_know" || label === "ungraded" || !v) return out;
	out.points = v.points.map((point) => ({ id: point.id, status: point.status }));
	if (v.extraErrors.length > 0) out.extraErrors = v.extraErrors.map((error) => error.claim);
	return out;
}
