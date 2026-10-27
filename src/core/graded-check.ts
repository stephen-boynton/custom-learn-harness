/**
 * GRADED CHECK — which posed question calls are evidence, and of what kind
 * (spec #2, ADR-0004). One reading of a question call's RAW arguments,
 * shared by the extractor's check view (core/check-view.ts) and the answer
 * entry (core/evidence.ts), so the two never disagree on what a check is.
 * Pure.
 *
 *   - Free recall (explain / recall) with key points: PRODUCTION, or a
 *     PREDICTION with `type: "predict"`. A call from before key points
 *     existed has nothing to grade against: not a check.
 *   - Multiple choice (quiz / probe) whose correct answer resolves to its
 *     options: RECOGNITION, or a PREDICTION with `type: "predict"`.
 *   - ask_user_question, any other tool, unparseable input: not a check.
 */

import type { EvidenceKind } from "./contracts.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { normalizeOptions, normalizeQuizType, resolveCorrect, type KeyPoint, type QuizOption } from "./question-core.ts";
import { parseExplainInput, parseQuizInput } from "./tool-parts.ts";

export type GradedCheck =
	| {
			mechanic: "free_recall";
			kind: Extract<EvidenceKind, "production" | "prediction">;
			question: string;
			keyPoints: KeyPoint[];
	  }
	| {
			mechanic: "multiple_choice";
			kind: Extract<EvidenceKind, "recognition" | "prediction">;
			question: string;
			options: QuizOption[];
			/** 1-based indices into `options` of the committed correct answer. */
			correctIndices: number[];
	  };

const isQuestionTool = (name: string): boolean => (QUESTION_TOOLS as readonly string[]).includes(name);

/** The graded check a question call poses, or undefined when its answer
 *  is not evidence (see the header). */
export function gradedCheckOf(toolName: string, args: unknown): GradedCheck | undefined {
	if (!isQuestionTool(toolName)) return undefined;
	const tool = toolQuestionKind(toolName);
	if (tool === "explain") {
		const input = parseExplainInput(args);
		if (!input?.keyPoints?.length) return undefined;
		return {
			mechanic: "free_recall",
			kind: normalizeQuizType(input.type) === "predict" ? "prediction" : "production",
			question: input.question,
			keyPoints: input.keyPoints,
		};
	}
	if (tool !== "quiz") return undefined;
	const input = parseQuizInput(args);
	if (!input) return undefined;
	let options: QuizOption[];
	try {
		options = normalizeOptions(input.options);
	} catch {
		return undefined; // duplicate option values — never a gradeable check
	}
	const resolved = resolveCorrect(input.correctAnswer, options);
	if (resolved.error) return undefined;
	return {
		mechanic: "multiple_choice",
		kind: normalizeQuizType(input.type) === "predict" ? "prediction" : "recognition",
		question: input.question,
		options,
		correctIndices: resolved.indices,
	};
}
