/**
 * One inline input owner, matching Pi's regular-mode selectors. Component identity
 * prevents a late callback from replacing a newer interaction.
 * @param {import("@earendil-works/pi-tui").TUI} tui
 * @param {import("@earendil-works/pi-tui").Container} container
 * @param {import("@earendil-works/pi-tui").Component} editor
 * @param {(active: import("@earendil-works/pi-tui").Component) => void} [onChange]
 */
export function createEditorSlot(tui, container, editor, onChange) {
	let active = editor;
	let closed = false;
	/** @param {import("@earendil-works/pi-tui").Component} component */
	const dispose = (component) => /** @type {{ dispose?: () => void }} */ (component).dispose?.();
	/** @param {import("@earendil-works/pi-tui").Component} component @param {import("@earendil-works/pi-tui").Component} [expected] */
	function show(component, expected) {
		if (closed || (expected && active !== expected)) return;
		const previous = active;
		active = component;
		if (previous !== editor && previous !== component) dispose(previous);
		container.clear();
		container.addChild(component);
		tui.setFocus(component);
		onChange?.(component);
		tui.requestRender();
	}
	return {
		show,
		/** @param {import("@earendil-works/pi-tui").Component} [expected] */
		restore: (expected) => show(editor, expected),
		cancel: () => { if (!closed && active !== editor) active.handleInput?.("\x1b"); },
		dispose: () => {
			if (closed) return;
			closed = true;
			if (active !== editor) dispose(active);
		},
	};
}
