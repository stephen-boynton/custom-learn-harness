/**
 * Checks in the extraction view (ADR-0004) — the pure core. The extractor
 * sees each graded check AS THE TEACHER POSED IT, as CONTEXT OUTSIDE
 * COVERAGE: the input attribution needs.
 *
 *   - Production checks (explain/recall): the question and its key points.
 *   - Recognition questions and predictions (quiz/probe): the question, its
 *     options and the correct answer.
 *   - Never the learner's answer, verdict, confidence or thinking (they live
 *     on the toolResult — this module never reads one, except to learn that
 *     a call was refused), never the plan `nodeId`, the quiz `explanation`,
 *     the committed full answer or the `details` line (owner, 2026-10-27).
 *
 * Coverage keeps ONE line builder for hashing (core/coverage.ts
 * messageViewLines — teacher prose only); this module is the prompt's wider
 * builder. Fingerprints, coverage tokens and the trigger never see a check,
 * so asking or answering one never opens a run.
 *
 * WHICH BATCH A CHECK TRAVELS WITH (deterministic from position): the batch
 * holding its own message when that message has prose; otherwise the batch
 * holding the NEXT teacher-prose message. With no later prose yet, it waits.
 * A prose-less message never gets a coverage row, so "has this check
 * travelled?" is exactly "is its host covered?" — no bookkeeping of its own.
 *
 * IDENTITY (owner, 2026-10-27): each check gets a BATCH-LOCAL alias (q1, q2,
 * … in reading order) and keeps its key point ids as authored. The extractor
 * never copies a raw toolCallId; `checks` maps each alias back to its call.
 */

import type { LhMessage } from "./native-messages.ts";
import { failedOutputCallIds, userFacingTextOf } from "./native-messages.ts";
import type { CoverageSlot } from "./coverage.ts";
import { viewTokens } from "./coverage.ts";
import { normalizeOptions, normalizeQuizType, resolveCorrect } from "./question-core.ts";
import { parseExplainInput, parseQuizInput } from "./tool-parts.ts";

/** One posed check, rendered except for its batch-local alias. */
export interface PosedCheck {
	toolCallId: string;
	/** The id of the message whose tool call posed it. */
	messageId: string;
	/** The key point ids as authored (production checks; [] otherwise). */
	keyPointIds: string[];
	/** The check block for a given alias ("q1"). */
	render(alias: string): string;
}

/** A check as it appears in one batch's view: alias → call. */
export interface ViewCheck {
	alias: string;
	toolCallId: string;
	messageId: string;
	keyPointIds: string[];
}

const RECOGNITION_TOOLS = new Set(["quiz", "probe"]);
const PRODUCTION_TOOLS = new Set(["explain", "recall"]);

/** Question calls the boundary REFUSED (an isError result) — never posed. */
function refusedCallIds(messages: ReadonlyArray<LhMessage>): Set<string> {
	const out = new Set<string>();
	for (const m of messages) {
		if (m.role === "toolResult" && m.isError) out.add(m.toolCallId);
	}
	return out;
}

/** The check block of one tool call, or undefined when it is not a posed
 *  graded check (ask_user_question, other tools, unparseable input). */
function posedCheckOf(block: { id: string; name: string; arguments: unknown }, messageId: string): PosedCheck | undefined {
	if (RECOGNITION_TOOLS.has(block.name)) {
		const input = parseQuizInput(block.arguments);
		if (!input) return undefined;
		const options = normalizeOptions(input.options);
		const correct = resolveCorrect(input.correctAnswer, options).indices.map((i) => options[i - 1]!.label);
		const role = normalizeQuizType(input.type) === "predict" ? "multiple choice, prediction" : "multiple choice";
		const body = [
			`Question: ${input.question.trim()}`,
			"Options:",
			...options.map((o) => `  - ${o.label}`),
			`Correct answer: ${correct.join("; ")}`,
		];
		return { toolCallId: block.id, messageId, keyPointIds: [], render: (alias) => [`CHECK ${alias} [${messageId}] — ${role}`, ...body].join("\n") };
	}
	if (PRODUCTION_TOOLS.has(block.name)) {
		const input = parseExplainInput(block.arguments);
		if (!input) return undefined;
		const keyPoints = input.keyPoints ?? [];
		const role = normalizeQuizType(input.type) === "predict" ? "free recall, prediction" : "free recall";
		const body = [`Question: ${input.question.trim()}`];
		if (keyPoints.length > 0) body.push("Key points:", ...keyPoints.map((p) => `  ${p.id}: ${p.text.trim()}`));
		return {
			toolCallId: block.id,
			messageId,
			keyPointIds: keyPoints.map((p) => p.id),
			render: (alias) => [`CHECK ${alias} [${messageId}] — ${role}`, ...body].join("\n"),
		};
	}
	return undefined;
}

/** The posed checks of ONE message, in content order. */
function checksOf(message: LhMessage, refused: ReadonlySet<string>): PosedCheck[] {
	if (message.role !== "assistant") return [];
	const out: PosedCheck[] = [];
	for (const block of message.content) {
		if (block.type !== "toolCall" || refused.has(block.id)) continue;
		const check = posedCheckOf(block, message.id);
		if (check) out.push(check);
	}
	return out;
}

/**
 * Where every posed check of a transcript travels: host message id → the
 * checks of the PROSE-LESS messages before it that ride with it (its own
 * checks render inline with its prose, so they are not listed here).
 * Checks with no later prose host are absent — they wait.
 */
function carriedChecks(slots: ReadonlyArray<CoverageSlot>, refused: ReadonlySet<string>): Map<string, PosedCheck[]> {
	const out = new Map<string, PosedCheck[]>();
	let waiting: PosedCheck[] = [];
	for (const slot of slots) {
		if (slot.tokens > 0) {
			if (waiting.length > 0) out.set(slot.message.id, waiting);
			waiting = [];
		} else {
			waiting.push(...checksOf(slot.message, refused));
		}
	}
	return out;
}

/**
 * The extraction view over a whole transcript: the pieces a batching run
 * needs. `extraTokens(slot)` is the size of the checks travelling with a
 * prose slot (the fill-budget weight beyond its coverage tokens);
 * `viewOf(batch)` renders a batch's passages and checks in reading order.
 */
export function extractionViewOf(
	messages: ReadonlyArray<LhMessage>,
	slots: ReadonlyArray<CoverageSlot>,
	failedOutputCalls: ReadonlySet<string> = failedOutputCallIds(messages),
): {
	extraTokens: (slot: CoverageSlot) => number;
	viewOf: (batch: ReadonlyArray<CoverageSlot>) => { lines: string[]; checks: ViewCheck[] };
} {
	const refused = refusedCallIds(messages);
	const carried = carriedChecks(slots, refused);
	const checksTravellingWith = (slot: CoverageSlot): PosedCheck[] => [
		...(carried.get(slot.message.id) ?? []),
		...checksOf(slot.message, refused),
	];
	// The weight is measured with a stand-in alias: q-numbers differ by a
	// character or two between batches — noise at chars/4.
	const extraTokens = (slot: CoverageSlot): number => {
		const blocks = checksTravellingWith(slot).map((c) => c.render("q1"));
		return blocks.length > 0 ? viewTokens(blocks) : 0;
	};
	const viewOf = (batch: ReadonlyArray<CoverageSlot>) => {
		const lines: string[] = [];
		const checks: ViewCheck[] = [];
		const emit = (check: PosedCheck) => {
			const alias = `q${checks.length + 1}`;
			checks.push({ alias, toolCallId: check.toolCallId, messageId: check.messageId, keyPointIds: check.keyPointIds });
			lines.push(check.render(alias));
		};
		for (const slot of batch) {
			for (const check of carried.get(slot.message.id) ?? []) emit(check);
			const message = slot.message;
			if (message.role !== "assistant") continue;
			// Content order. Each prose block yields EXACTLY the line
			// messageViewLines hashes for it (same text selection, same
			// "TEACHER [id] text" shape) — the prompt widens the coverage
			// view, it never rewrites it.
			for (const block of message.content) {
				for (const text of userFacingTextOf([block], failedOutputCalls)) lines.push(`TEACHER [${message.id}] ${text.trim()}`);
				if (block.type !== "toolCall" || refused.has(block.id)) continue;
				const check = posedCheckOf(block, message.id);
				if (check) emit(check);
			}
		}
		return { lines, checks };
	};
	return { extraTokens, viewOf };
}
