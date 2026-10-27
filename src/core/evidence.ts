/**
 * HELD STATUS — derived from the evidence ledger on every read, never
 * stored (spec #2, ADR-0002; glossary: held, covered, encountered,
 * attribution, unattached evidence, orphaned evidence). Pure.
 *
 * The ledger's two kinds of entry are JOINED here, on the question's
 * toolCallId (+ key point id): answers are written when graded (chat
 * handler), attributions when the question's batch is merged (the
 * extraction merger) — either may come first.
 *
 *   - An answer with no attribution is UNATTACHED evidence: kept, moves no
 *     status.
 *   - An attribution with no answer (a dismissed or pending question)
 *     contributes nothing.
 *   - An attribution to a node that no longer exists is ORPHANED: ignored.
 *
 * Per proposition, the MOST RECENT production evidence decides (by the
 * answer entry's timestamp, owner 2026-10-27), skipping uncertain
 * verdicts:
 *   held          its key point present, and no contradiction or extra
 *                 error touching it;
 *   misconception its key point contradicted;
 *   not held      its key point absent, an extra error in the answer, or
 *                 "I don't know" (which counts against every proposition
 *                 attributed to the question).
 * A RECOGNITION answer (#10) takes its place in that same order but can
 * only count against: a wrong one, or "I don't know", is not held until a
 * later production pass; a correct one says nothing. A PREDICTION never
 * moves status, right or wrong (owner, 2026-10-27).
 * No production evidence: covered only (some chat provenance) or
 * encountered only (notes provenance alone).
 *
 * Recognition and prediction evidence (#10) and the newest-run rule for
 * re-extracted attributions (#11) extend `outcomeOf` / `attributionsByCall`.
 */

import type { AnswerEntry, AttributionEntry, EvidenceEntry, GraphNode } from "./contracts.ts";
import { hasProbeDone, type LhMessage } from "./native-messages.ts";
import { toolQuestionKind } from "./pending.ts";
import { normalizeOptions, normalizeQuizType, resolveCorrect, type QuestionAnswerData } from "./question-core.ts";
import { parseExplainInput, parseQuizInput } from "./tool-parts.ts";

/**
 * The ANSWER ENTRY for one answered question, read off the SAVED record
 * (the question call and its toolResult) — undefined when the answer is
 * not evidence (see gradedKindOf) or is a dismissal. Free recall is
 * PRODUCTION; multiple choice is RECOGNITION (#10); either with
 * `type: "predict"` is a PREDICTION (owner, 2026-10-27): recorded, never
 * makes held. Phase: probe until the transcript's probe_done, teach after.
 */
export function answerEntryFor(chatId: string, messages: readonly LhMessage[], toolCallId: string, at: string): AnswerEntry | undefined {
	const askingIndex = messages.findIndex(
		(m) => m.role === "assistant" && m.content.some((b) => b.type === "toolCall" && b.id === toolCallId),
	);
	if (askingIndex < 0) return undefined;
	const asking = messages[askingIndex]!;
	if (asking.role !== "assistant") return undefined;
	const call = asking.content.find((b) => b.type === "toolCall" && b.id === toolCallId);
	if (call?.type !== "toolCall") return undefined;
	const graded = gradedKindOf(call.name, call.arguments);
	if (!graded) return undefined;
	const result = messages.find((m) => m.role === "toolResult" && m.toolCallId === toolCallId);
	if (result?.role !== "toolResult" || result.isError) return undefined;
	const answer = result.details as QuestionAnswerData | undefined;
	if (!answer || answer.dismissed) return undefined;
	const dontKnow = answer.dontKnow === true;
	return {
		type: "answer",
		toolCallId,
		chatId,
		questionMessageId: asking.id,
		answerMessageId: result.id,
		kind: graded.kind,
		phase: hasProbeDone(messages.slice(0, askingIndex)) ? "teach" : "probe",
		dontKnow,
		...(answer.verdict ? { verdict: answer.verdict } : {}),
		...(graded.correctValues ? { correct: !dontKnow && choseExactly(answer, graded.correctValues) } : {}),
		...(typeof answer.confidence === "number" ? { confidence: answer.confidence } : {}),
		...(typeof answer.confidenceTouched === "boolean" ? { confidenceTouched: answer.confidenceTouched } : {}),
		...((answer.thinking ?? answer.note) ? { thinking: answer.thinking ?? answer.note } : {}),
		at,
	};
}

/** The evidence kind of a question call, with a multiple-choice call's
 *  committed correct option values — undefined when its answer is not
 *  evidence: an ask, a free-recall call with no key points, or a
 *  multiple-choice call whose correct answer does not resolve (nothing
 *  committed to grade against). */
function gradedKindOf(
	toolName: string,
	args: unknown,
): { kind: AnswerEntry["kind"]; correctValues?: readonly string[] } | undefined {
	const tool = toolQuestionKind(toolName);
	if (tool === "explain") {
		const input = parseExplainInput(args);
		if (!input?.keyPoints?.length) return undefined;
		return { kind: normalizeQuizType(input.type) === "predict" ? "prediction" : "production" };
	}
	if (tool !== "quiz") return undefined;
	const input = parseQuizInput(args);
	if (!input) return undefined;
	const options = normalizeOptions(input.options);
	const resolved = resolveCorrect(input.correctAnswer, options);
	if (resolved.error) return undefined;
	return {
		kind: normalizeQuizType(input.type) === "predict" ? "prediction" : "recognition",
		correctValues: resolved.indices.map((i) => options[i - 1]!.value),
	};
}

/** MC correctness recomputed SERVER side (owner, 2026-10-27): the saved
 *  selection, by option value, against the call's committed correct
 *  answer — the client's own `correct` is never trusted. */
function choseExactly(answer: QuestionAnswerData, correctValues: readonly string[]): boolean {
	const chosen = new Set((Array.isArray(answer.answers) ? answer.answers : []).map((a) => a.value));
	return chosen.size === correctValues.length && correctValues.every((v) => chosen.has(v));
}

export type HeldStatus = "held" | "misconception" | "not_held" | "covered_only" | "encountered_only";

export interface PropositionEvidence {
	status: HeldStatus;
	/** ISO timestamp of the answer that decided the status; absent when no
	 *  evidence decides it (covered only / encountered only). */
	latestAt?: string;
}

export interface EvidenceView {
	/** The status of a proposition node. */
	statusOf(node: GraphNode): PropositionEvidence;
	/** Answers no attribution points at (glossary: unattached evidence) —
	 *  the extractor-health signal. */
	unattached: AnswerEntry[];
}

/** Imported-notes source ids are "src_" + a path hash (the notes front
 *  door, agent/subagents/extraction.ts) — everything else is a chat. */
const isNotesSourceId = (id: string): boolean => id.startsWith("src_");

/** What one answer says about one proposition, or undefined when it says
 *  nothing (an uncertain verdict, a correct recognition answer, any
 *  prediction). */
function outcomeOf(answer: AnswerEntry, keyPointIds: ReadonlyArray<string | undefined>): HeldStatus | undefined {
	// Recognition can count against held, never make it (#10).
	if (answer.kind === "recognition") return answer.dontKnow || answer.correct === false ? "not_held" : undefined;
	if (answer.kind !== "production") return undefined;
	if (answer.dontKnow) return "not_held";
	const v = answer.verdict;
	if (!v || v.uncertain) return undefined;
	const status = new Map(v.points.map((p) => [p.id, p.status]));
	// One proposition may be tested by more than one key point of the
	// same answer: it is held only when every one of them is present.
	const statuses = keyPointIds.map((id) => (id === undefined ? undefined : status.get(id)));
	if (statuses.includes("contradicted")) return "misconception";
	if (v.extraErrors.length > 0) return "not_held";
	return statuses.length > 0 && statuses.every((s) => s === "present") ? "held" : "not_held";
}

/** Order answers oldest → newest by timestamp; append order breaks ties. */
const byAt = (a: { at: string; seq: number }, b: { at: string; seq: number }): number =>
	a.at < b.at ? -1 : a.at > b.at ? 1 : a.seq - b.seq;

export function evidenceView(entries: ReadonlyArray<EvidenceEntry>): EvidenceView {
	const answers = new Map<string, { entry: AnswerEntry; seq: number }>();
	const attributionsByCall = new Map<string, AttributionEntry[]>();
	entries.forEach((entry, seq) => {
		if (entry.type === "answer") {
			// One answer per question; a duplicate line never replaces the first.
			if (!answers.has(entry.toolCallId)) answers.set(entry.toolCallId, { entry, seq });
		} else {
			const list = attributionsByCall.get(entry.toolCallId) ?? [];
			list.push(entry);
			attributionsByCall.set(entry.toolCallId, list);
		}
	});

	// proposition id → its evidence, oldest first: (answer, key points).
	const evidenceOf = new Map<string, Array<{ at: string; seq: number; answer: AnswerEntry; keyPointIds: Array<string | undefined> }>>();
	const unattached: AnswerEntry[] = [];
	for (const { entry: answer, seq } of answers.values()) {
		const attributions = attributionsByCall.get(answer.toolCallId) ?? [];
		if (attributions.length === 0) {
			unattached.push(answer);
			continue;
		}
		const pointsByProposition = new Map<string, Array<string | undefined>>();
		for (const a of attributions) {
			const points = pointsByProposition.get(a.propositionId) ?? [];
			if (!points.includes(a.keyPointId)) points.push(a.keyPointId);
			pointsByProposition.set(a.propositionId, points);
		}
		for (const [propositionId, keyPointIds] of pointsByProposition) {
			const list = evidenceOf.get(propositionId) ?? [];
			list.push({ at: answer.at, seq, answer, keyPointIds });
			evidenceOf.set(propositionId, list);
		}
	}
	for (const list of evidenceOf.values()) list.sort(byAt);

	return {
		unattached,
		statusOf(node: GraphNode): PropositionEvidence {
			const list = evidenceOf.get(node.id) ?? [];
			for (let i = list.length - 1; i >= 0; i--) {
				const { answer, keyPointIds } = list[i]!;
				const status = outcomeOf(answer, keyPointIds);
				if (status) return { status, latestAt: answer.at };
			}
			const covered = node.provenance.some((pt) => !isNotesSourceId(pt.chatId));
			return { status: covered ? "covered_only" : "encountered_only" };
		},
	};
}
