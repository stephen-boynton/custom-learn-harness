/**
 * The question dock, mounted and clicked (linkedom + react-dom/client):
 * what a learner's press actually submits. Spec #2 / ticket #6 — explain
 * and recall gain "I don't know" (a secondary button beside Submit that
 * submits at once and discards typed text, owner 2026-10-27).
 */
import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { QuestionDock } from "../components/question-dock.tsx";
import type { QuestionAnswerData, QuestionFormDraft } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const KEY_POINTS = [{ id: "p1", text: "A stationary aether predicts a fringe shift.", kind: "fact", required: true }];
const EXPLAIN_INPUT = {
	type: "check",
	nodeId: "aether",
	question: "Explain why the null result matters.",
	correctAnswer: "It ruled out a stationary aether — one predicts a fringe shift, and none was seen.",
	keyPoints: KEY_POINTS,
};
const RECALL_INPUT = {
	question: "Explain why the null result matters.",
	correctAnswer: "It ruled out a stationary aether — one predicts a fringe shift, and none was seen.",
	keyPoints: KEY_POINTS,
};

const typedDraft: QuestionFormDraft = {
	selection: { selected: new Set(), otherSelected: false, dontKnow: false },
	thinking: "",
	other: "",
	text: "something half-typed",
	confidenceIndex: 2,
};

let mounted: { root: Root; host: HTMLElement } | null = null;
afterEach(async () => {
	if (!mounted) return;
	const { root, host } = mounted;
	await act(async () => root.unmount());
	host.remove();
	mounted = null;
});

async function mountDock(toolName: "explain" | "recall", input: unknown, initialDraft?: QuestionFormDraft) {
	const submitted: QuestionAnswerData[] = [];
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	mounted = { root, host };
	await act(async () =>
		root.render(
			<QuestionDock
				toolName={toolName}
				toolCallId={`${toolName}-1`}
				input={input as never}
				expanded
				onExpand={() => {}}
				onSubmit={(answer) => submitted.push(answer)}
				initialDraft={initialDraft}
			/>,
		),
	);
	return { host, submitted };
}

function button(host: HTMLElement, label: string): HTMLElement {
	const found = [...host.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
	assert.ok(found, `a "${label}" button is rendered`);
	return found as HTMLElement;
}

describe("explain and recall: the \"I don't know\" action", () => {
	for (const [toolName, input] of [
		["explain", EXPLAIN_INPUT],
		["recall", RECALL_INPUT],
	] as const) {
		it(`${toolName}: pressing "I don't know" submits at once with dontKnow and discards the typed text`, async () => {
			const { host, submitted } = await mountDock(toolName, input, typedDraft);
			await act(async () => button(host, "I don't know").click());
			assert.equal(submitted.length, 1, "one press, one submission");
			const answer = submitted[0]!;
			assert.equal(answer.kind, "explain");
			assert.equal(answer.tool, toolName);
			assert.equal(answer.dontKnow, true);
			assert.equal(answer.text, undefined, "the half-typed text is discarded");
		});
	}
});
