/**
 * Grading at the answer seam (spec #2, ADR-0003) — the WIRING only: which
 * answers are graded, and what is saved, is decided in core
 * (core/answer-grading.ts). Here: the grader's engine (the extractor's
 * role chain, read fresh), the provider-key check, the grader run and its
 * spend.
 */

import type { Usage } from "@earendil-works/pi-ai";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { GRADER_ROLE, gradeProductionAnswer, graderModelOverride } from "../agent/subagents/grader.ts";
import { answerGradingOf } from "../core/answer-grading.ts";
import { callUsage, type CallUsage } from "../core/contracts.ts";
import type { LhMessage } from "../core/native-messages.ts";
import type { QuestionAnswerData } from "../core/question-core.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
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
 * The answer as it will be saved (core/answer-grading.ts decides whether
 * it is graded), with the grader's spend. Never throws — grading failures
 * become an uncertain verdict inside the grader.
 */
export async function withVerdict(
	chatId: string,
	messages: readonly LhMessage[],
	toolCallId: string,
	answer: QuestionAnswerData,
): Promise<{ answer: QuestionAnswerData; spend?: GraderSpend }> {
	const grading = answerGradingOf(messages, toolCallId, answer);
	if (!grading.grade) return { answer: grading.answer };

	const steps: CallUsage[] = [];
	let model = "";
	let engine: PiEngine | undefined;
	try {
		engine = graderEngine();
	} catch (err) {
		console.error(`[chat ${chatId}] grader engine unavailable:`, err);
	}
	const verdict = await gradeProductionAnswer(grading.request, {
		engine,
		providerKeyMissing: (provider, tier) => (providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier])),
		onUsage: (usage: Usage, stepModel) => {
			steps.push(callUsage(usage));
			model = stepModel;
		},
		chatId,
	});
	return { answer: grading.withVerdict(verdict), spend: steps.length > 0 ? { model, steps } : undefined };
}
