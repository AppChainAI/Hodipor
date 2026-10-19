import { Container, Input, SelectList, Spacer, fuzzyFilter, getKeybindings } from "@earendil-works/pi-tui";
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { ThemedText } from "./pi-display.mjs";
import { activeTheme } from "./theme.mjs";

/** Bounded, searchable choices without advertising unimplemented Pi host actions. */
export class ChoiceSelector extends Container {
	/** @param {string} title @param {import("@earendil-works/pi-tui").SelectItem[]} items @param {(value: string) => void} select @param {() => void} cancel @param {string} [current] */
	constructor(title, items, select, cancel, current) {
		super();
		this.items = items;
		this.select = select;
		this.cancel = cancel;
		this.input = new Input();
		this.listContainer = new Container();
		this.addChild(new DynamicBorder());
		this.addChild(new ThemedText(() => activeTheme().fg("accent", title), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new ThemedText(() => activeTheme().fg("dim", "↑/↓ select · Enter confirm · Esc cancel · Ctrl+C exit"), 1, 1));
		this.addChild(new DynamicBorder());
		this.list = this.updateList(current);
	}
	get focused() { return this.input.focused; }
	set focused(value) { this.input.focused = value; }
	/** @param {string} [current] */
	updateList(current) {
		const query = this.input.getValue();
		const items = query ? fuzzyFilter(this.items, query, item => `${item.label} ${item.description ?? ""}`) : this.items;
		const list = new SelectList(items, 8, getSelectListTheme());
		const index = items.findIndex(item => item.value === current);
		if (index >= 0) list.setSelectedIndex(index);
		list.onSelect = item => this.select(item.value);
		list.onCancel = this.cancel;
		this.listContainer.clear();
		this.listContainer.addChild(list);
		return list;
	}
	/** @param {string} data */
	handleInput(data) {
		const kb = getKeybindings();
		if ((/** @type {const} */ (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"])).some(action => kb.matches(data, action))) {
			this.list.handleInput(data);
		} else {
			const selected = this.list.getSelectedItem()?.value;
			this.input.handleInput(data);
			this.list = this.updateList(selected);
		}
	}
}
