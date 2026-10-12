import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../src/components/ui/button";
import { Field, FieldLabel } from "../src/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../src/components/ui/select";
import { Textarea } from "../src/components/ui/textarea";
import { Alert, AlertDescription } from "../src/components/ui/alert";
import { cn } from "../src/lib/utils";

const options = [
	{ value: "", label: "选择模型…" },
	{ value: "model-a", label: "Model A" },
];

test("shadcn select keeps empty and selected labels with explicit field association", () => {
	for (const option of options) {
		const html = renderToStaticMarkup(
			<Field>
				<FieldLabel htmlFor="model">模型</FieldLabel>
				<Select id="model" value={option.value} items={options} onValueChange={() => {}}>
					<SelectTrigger><SelectValue /></SelectTrigger>
					<SelectContent>
						{options.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
					</SelectContent>
				</Select>
			</Field>,
		);
		expect(html).toContain('for="model"');
		expect(html).toContain('id="model"');
		expect(html).toContain(option.label);
		expect(html).toContain('role="combobox"');
		expect(html).toContain('data-slot="select-trigger"');
		expect(html).not.toContain("<select");
	}
});

test("provider labels are text, not executable markup", () => {
	const html = renderToStaticMarkup(
		<Select id="provider" value="custom" items={[{ value: "custom", label: "<img src=x onerror=alert(1)>" }]}>
			<SelectTrigger><SelectValue /></SelectTrigger>
		</Select>,
	);
	expect(html).toContain("&lt;img");
	expect(html).not.toContain("<img");
});

test("shadcn controls retain disabled, input labeling and button semantics", () => {
	const html = renderToStaticMarkup(
		<><Button disabled>发送</Button><Textarea className="composer-input" aria-label="主题或任务" rows={2} /></>,
	);
	expect(html).toContain('type="button"');
	expect(html).toContain('disabled=""');
	expect(html).toContain('data-slot="button"');
	expect(html).toContain('data-slot="textarea"');
	expect(html).toContain('aria-label="主题或任务"');
	expect(html).toContain("composer-input");
});

test("alerts announce errors and utility overrides remove conflicting classes", () => {
	const html = renderToStaticMarkup(<Alert variant="destructive"><AlertDescription>保存失败，请重试</AlertDescription></Alert>);
	expect(html).toContain('role="alert"');
	expect(html).toContain("保存失败，请重试");
	expect(cn("h-8 px-2", "h-10")).toBe("px-2 h-10");
});
