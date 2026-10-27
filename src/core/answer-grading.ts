/**
 * WHAT GRADING AN ANSWER MEANS (spec #2, ADR-0003) — the decisions at the
 * answer seam, pure. The server wires the grader run (engine, key check,
 * spend) around them (server/grading.ts); nothing here calls a model.
 *
 *   - The answer object is client-authored, so any verdict it carries is
 *     dropped.
 *   - Only a production answer (explain / recall) to the PENDING question,
 *     whose PERSISTED call commits key points, is graded — never "I don't
 *     know", never a dismissal, never a call from before key points.
 *   - The commitment snapshot (full answer + key points) is re-taken from
 *     the persisted call, never from the client, and saved with the verdict
 *     in one write (owner, 2026-10-27).
 */

import { danglingQuestionOf, type LhMessage } from "./native-messages.ts";
import { toolQuestionKind } from "./pending.ts";
import type { KeyPoint, QuestionAnswerData } from "./question-core.ts";
import { parseExplainInput } from "./tool-parts.ts";
import type { Verdict } from "./verdict.ts";

/** Exactly what the grader is shown: the question, the commitment and the
 *  learner's answer — no conversation, confidence or thinking. */
export interface GradingRequest {
	question: string;
	/** The committed full answer. */
	correctAnswer: string;
	keyPoints: readonly KeyPoint[];
	/** The learner's answer, verbatim. */
	answer: string;
}

export type AnswerGrading =
	/** Nothing to grade: save `answer` as is. */
	| { grade: false; answer: QuestionAnswerData }
	/** Grade `request`, then save `withVerdict(verdict)`. */
	| { grade: true; request: GradingRequest; withVerdict: (verdict: Verdict) => QuestionAnswerData };

/** How an incoming answer is graded before it is saved. */
export function answerGradingOf(messages: readonly LhMessage[], toolCallId: string, answer: QuestionAnswerData): AnswerGrading {
	const { verdict: _clientVerdict, ...clean } = answer;
	void _clientVerdict;
	const pending = danglingQuestionOf(messages);
	if (!pending || pending.toolCallId !== toolCallId || toolQuestionKind(pending.tool) !== "explain") return { grade: false, answer: clean };
	const call = parseExplainInput(pending.input);
	if (!call?.keyPoints?.length || clean.dontKnow || clean.dismissed) return { grade: false, answer: clean };
	const keyPoints = call.keyPoints;
	return {
		grade: true,
		request: { question: call.question, correctAnswer: call.correctAnswer, keyPoints, answer: clean.text ?? "" },
		withVerdict: (verdict) => ({ ...clean, committed: call.correctAnswer, keyPoints, verdict }),
	};
}
