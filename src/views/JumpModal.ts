import { App, Modal } from "obsidian";
import { startOfToday, toDateString } from "../util/dates";

const MONTHS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Jump to any month of any year: a year stepper over a grid of twelve
 * months. Opened by clicking the calendar's title, so crossing several years
 * is a couple of clicks rather than a dozen presses of "next".
 */
export class JumpModal extends Modal {
	private year: number;
	private gridEl!: HTMLElement;
	private yearEl!: HTMLInputElement;

	constructor(
		app: App,
		private current: string,
		private onPick: (date: string) => void
	) {
		super(app);
		this.year = Number(current.slice(0, 4));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("tc-jump");
		this.setTitle("Go to");

		const stepper = contentEl.createDiv({ cls: "tc-jump-stepper" });
		const back = stepper.createEl("button", { text: "‹", attr: { "aria-label": "Previous year" } });
		this.yearEl = stepper.createEl("input", {
			cls: "tc-jump-year",
			attr: { type: "number", "aria-label": "Year" },
		});
		const forward = stepper.createEl("button", { text: "›", attr: { "aria-label": "Next year" } });

		back.addEventListener("click", () => this.setYear(this.year - 1));
		forward.addEventListener("click", () => this.setYear(this.year + 1));
		// Typing a year is the fast way across a long distance; the grid
		// follows once it looks like a whole year.
		this.yearEl.addEventListener("input", () => {
			const typed = Number(this.yearEl.value);
			if (Number.isInteger(typed) && typed >= 1000 && typed <= 9999) {
				this.year = typed;
				this.renderMonths();
			}
		});

		this.gridEl = contentEl.createDiv({ cls: "tc-jump-months" });
		this.setYear(this.year);

		const footer = contentEl.createDiv({ cls: "tc-jump-footer" });
		const today = footer.createEl("button", { text: "Today" });
		today.addEventListener("click", () => this.pick(toDateString(startOfToday())));
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private setYear(year: number): void {
		this.year = year;
		this.yearEl.value = String(year);
		this.renderMonths();
	}

	private renderMonths(): void {
		this.gridEl.empty();
		const currentMonth = this.current.slice(0, 7);
		const thisMonth = toDateString(startOfToday()).slice(0, 7);
		MONTHS.forEach((label, index) => {
			const month = `${this.year}-${String(index + 1).padStart(2, "0")}`;
			const button = this.gridEl.createEl("button", { cls: "tc-jump-month", text: label });
			if (month === currentMonth) button.addClass("is-current");
			if (month === thisMonth) button.addClass("is-today");
			button.addEventListener("click", () => this.pick(`${month}-01`));
		});
	}

	private pick(date: string): void {
		this.onPick(date);
		this.close();
	}
}
