/**
 * Grading at the answer seam (spec #2, ADR-0003): before a production
 * answer (explain / recall) is saved, the independent grader judges it and
 * the verdict is put on the answer — one write, never revised (owner,
 * 2026-10-27: grade first, then save the answer with its verdict).
 *
 * The commitment comes from the PERSISTED question call, never from the
 * client: the answer object is client-authored, so any verdict it carries
 * is dropped and the commitment snapshot is re-taken from the call.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { GRADER_ROLE, gradeProductionAnswer, graderModelOverride } from "../agent/subagents/grader.ts";
import { callUsage } from "../agent/subagents/extraction.ts";
import type { CallUsage } from "../core/contracts.ts";
import { danglingQuestionOf, type LhMessage } from "../core/native-messages.ts";
import { toolQuestionKind } from "../core/pending.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { parseExplainInput } from "../core/tool-parts.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** The grader's spend, for the chat's turn-usage log. */
export interface GraderSpend {
	model: string;
	steps: CallUsage[];
}

/** The settings-resolved grader engine (the extractor's role chain, read
 *  fresh), or the test seam's scripted one. */
function graderEngine(): PiEngine | undefined {
	if (graderModelOverride.current) return graderModelOverride.current;
	const spec = resolveRoleSpec(GRADER_ROLE, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

/**
 * The answer as it will be saved: client-sent verdicts dropped and, for a
 * production answer to a call with key points, the grader's verdict put
 * on it. "I don't know" is never graded; a call that predates key points
 * has nothing to grade against. Never throws — grading failures become
 * an uncertain verdict inside the grader.
 */
export async function withVerdict(
	chatId: string,
	messages: readonly LhMessage[],
	toolCallId: string,
	answer: QuestionAnswerData,
): Promise<{ answer: QuestionAnswerData; spend?: GraderSpend }> {
	const { verdict: _clientVerdict, ...clean } = answer;
	void _clientVerdict;
	const pending = danglingQuestionOf(messages);
	if (!pending || pending.toolCallId !== toolCallId || toolQuestionKind(pending.tool) !== "explain") return { answer: clean };
	const call = parseExplainInput(pending.input);
	if (!call?.keyPoints?.length || clean.dontKnow || clean.dismissed) return { answer: clean };

	const steps: CallUsage[] = [];
	let model = "";
	let engine: PiEngine | undefined;
	try {
		engine = graderEngine();
	} catch (err) {
		console.error(`[chat ${chatId}] grader engine unavailable:`, err);
	}
	const verdict = await gradeProductionAnswer(
		{ question: call.question, correctAnswer: call.correctAnswer, keyPoints: call.keyPoints, answer: clean.text ?? "" },
		{
			engine,
			providerKeyMissing: (provider, tier) =>
				providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
			onUsage: (usage: Usage, stepModel) => {
				steps.push(callUsage(usage));
				model = stepModel;
			},
			chatId,
		},
	);
	return {
		answer: { ...clean, committed: call.correctAnswer, keyPoints: call.keyPoints, verdict },
		spend: steps.length > 0 ? { model, steps } : undefined,
	};
}
