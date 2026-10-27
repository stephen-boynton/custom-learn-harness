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

async function mountDock(toolName: "explain" | "recall" | "quiz", input: unknown, initialDraft?: QuestionFormDraft) {
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

// ─── confidence + thinking on explain/recall; the "untouched" flag ─────────
// Owner, 2026-10-27: explain and recall gain the quiz's confidence slider
// and thinking field, and every confidence carries whether the learner
// moved the slider (reversing "50 must mean 50, never untouched").

async function submitForm(host: HTMLElement) {
	const form = host.querySelector("form");
	assert.ok(form, "the dock's form is rendered");
	await act(async () => {
		form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
	});
}

async function pressKey(key: string) {
	await act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true }) as Event & { key: string };
		Object.defineProperty(event, "key", { value: key });
		document.body.dispatchEvent(event);
	});
}

const answeredDraft: QuestionFormDraft = {
	selection: { selected: new Set(), otherSelected: false, dontKnow: false },
	thinking: "I remember the interferometer.",
	other: "",
	text: "No fringe shift, so no aether wind.",
	confidenceIndex: 2,
};

describe("explain and recall: confidence and thinking ride the answer", () => {
	it("the explain dock shows the confidence slider and a thinking field", async () => {
		const { host } = await mountDock("explain", EXPLAIN_INPUT);
		assert.ok(host.querySelector('[data-testid="confidence-slider"]'), "the confidence slider is rendered");
		assert.ok(host.querySelector('[data-testid="thinking-field"]'), "the thinking field is rendered");
		assert.ok(host.querySelector('[data-testid="answer-field"]'), "the answer field stays");
	});

	it("an untouched slider submits 50 marked untouched, with the thinking", async () => {
		const { host, submitted } = await mountDock("recall", RECALL_INPUT, answeredDraft);
		await submitForm(host);
		assert.equal(submitted.length, 1);
		const answer = submitted[0]!;
		assert.equal(answer.text, "No fringe shift, so no aether wind.");
		assert.equal(answer.confidence, 50);
		assert.equal(answer.confidenceTouched, false, "the resting 50 is recorded as untouched");
		assert.equal(answer.thinking, "I remember the interferometer.");
	});

	it("a moved slider submits its value marked touched", async () => {
		const { host, submitted } = await mountDock("explain", EXPLAIN_INPUT, answeredDraft);
		await pressKey("ArrowRight");
		await submitForm(host);
		assert.equal(submitted[0]!.confidence, 70);
		assert.equal(submitted[0]!.confidenceTouched, true);
	});

	it("\"I don't know\" sends no confidence", async () => {
		const { host, submitted } = await mountDock("explain", EXPLAIN_INPUT, answeredDraft);
		await act(async () => button(host, "I don't know").click());
		assert.equal(submitted[0]!.confidence, undefined);
		assert.equal(submitted[0]!.confidenceTouched, undefined);
	});
});

describe("quiz: the confidence carries the untouched flag too", () => {
	const QUIZ_INPUT = {
		type: "check",
		nodeId: "planets",
		question: "Which planet is closest to the sun?",
		options: [{ label: "Venus" }, { label: "Mercury" }],
		correctAnswer: "Mercury",
		explanation: "Mercury is the innermost planet.",
	};
	const picked: QuestionFormDraft = { ...answeredDraft, selection: { selected: new Set([0]), otherSelected: false, dontKnow: false } };

	it("untouched → false; moved → true", async () => {
		const untouched = await mountDock("quiz", QUIZ_INPUT, picked);
		await submitForm(untouched.host);
		assert.equal(untouched.submitted[0]!.confidence, 50);
		assert.equal(untouched.submitted[0]!.confidenceTouched, false);
		await act(async () => mounted!.root.unmount());
		mounted!.host.remove();
		mounted = null;

		const moved = await mountDock("quiz", QUIZ_INPUT, picked);
		await pressKey("ArrowLeft");
		await submitForm(moved.host);
		assert.equal(moved.submitted[0]!.confidence, 30);
		assert.equal(moved.submitted[0]!.confidenceTouched, true);
	});
});
