import { WorkingStatusIndicator, CompactionStatusIndicator, StatusIndicator, CountdownTimer } from "./pi-display.mjs";
import { activeTheme } from "./theme.mjs";

/** @typedef {{ kind: "working" } | { kind: "compaction"; reason: "manual" | "threshold" | "overflow"; taskId?: import("@earendil-works/pi-durable").TaskId } | { kind: "retry"; attempt: number; at: number } | { kind: "deferred"; at: number }} Activity */

/** Pi's animated status, embedded in the editor or visible above a selector. */
export class RunStatus {
	/** @param {import("@earendil-works/pi-tui").TUI} tui @param {import("@earendil-works/pi-coding-agent").CustomEditor} editor @param {import("@earendil-works/pi-tui").Container} fallback */
	constructor(tui, editor, fallback) {
		this.tui = tui;
		this.editor = editor;
		this.fallback = fallback;
		this.embedded = true;
		/** @type {InstanceType<typeof StatusIndicator> | undefined} */
		this.indicator = undefined;
		/** @type {InstanceType<typeof CountdownTimer> | undefined} */
		this.countdown = undefined;
		/** @type {string | undefined} */
		this.key = undefined;
		this.closed = false;
	}
	/** @param {Activity | undefined} activity */
	set(activity) {
		if (this.closed) return;
		const key = JSON.stringify(activity);
		if (key === this.key) return;
		this.key = key;
		this.countdown?.dispose();
		this.countdown = undefined;
		this.indicator?.dispose();
		this.indicator = undefined;
		const color = (/** @type {string} */ text) => this.editor.borderColor(text);
		if (activity?.kind === "compaction") this.indicator = new CompactionStatusIndicator(this.tui, activity.reason, color);
		else if (activity?.kind === "working") this.indicator = new WorkingStatusIndicator(this.tui, "Working (esc to interrupt)", undefined, color);
		else if (activity?.kind === "deferred") this.indicator = new WorkingStatusIndicator(this.tui, "Waiting for provider (esc to interrupt)", undefined, color);
		else if (activity?.kind === "retry") {
			// Durable exposes the attempt and deadline, not a maximum retry count.
			this.indicator = new StatusIndicator("retry", this.tui, (/** @type {string} */ text) => activeTheme().fg("warning", text), (/** @type {string} */ text) => activeTheme().fg("muted", text), "Retrying");
			this.countdown = new CountdownTimer(Math.max(0, activity.at - Date.now()), this.tui, (/** @type {number} */ seconds) => {
				this.indicator?.setMessage(`Retrying (${activity.attempt}) in ${seconds}s... (esc to interrupt)`);
			});
		}
		this.mount();
	}
	/** @param {boolean} embedded */
	setEmbedded(embedded) { if (this.closed) return; this.embedded = embedded; this.mount(); }
	mount() {
		this.editor.setWorkingStatusIndicator(this.embedded ? this.indicator : undefined);
		this.fallback.clear();
		if (!this.embedded && this.indicator) this.fallback.addChild(this.indicator);
		this.tui.requestRender();
	}
	invalidate() { this.indicator?.invalidate(); }
	dispose() {
		this.set(undefined);
		this.closed = true;
	}
}
