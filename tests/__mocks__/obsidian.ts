// Minimal stub for obsidian package — used only in test environment.
// Vitest aliases obsidian to this file so that source modules importing
// from "obsidian" (e.g. settings.ts, dashboard.ts, main.ts) can be loaded in tests.

// ─── DOM Helpers (work in both Node and browser) ──────────────

interface MockHTMLElement {
  tagName: string;
  children: unknown[];
  childNodes: unknown[];
  innerHTML: string;
  textContent: string;
  style: Record<string, string>;
  classList: { add: () => void; remove: () => void; contains: () => boolean };
  appendChild(child: unknown): unknown;
  removeChild(_child: unknown): null;
  createEl(tag: string, opts?: { text?: string; cls?: string }): unknown;
  querySelector(_sel: string): null;
  querySelectorAll(_sel: string): never[];
  addEventListener(_ev: string, _cb: unknown): void;
  removeEventListener(_ev: string, _cb: unknown): void;
  empty(): void;
}

function createMockHtmlElement(tagName: string): MockHTMLElement {
  const children: unknown[] = [];
  return {
    tagName: tagName.toUpperCase(),
    children,
    childNodes: [],
    innerHTML: "",
    textContent: "",
    style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(child: unknown) { children.push(child); return child; },
    removeChild(_child: unknown) { return null; },
    createEl(tag: string, opts?: { text?: string; cls?: string }) {
      const child = createMockHtmlElement(tag);
      if (opts?.text) child.textContent = opts.text;
      if (opts?.cls) child.innerHTML = `<div class="${opts.cls}"></div>`;
      children.push(child);
      return child;
    },
    querySelector(_sel: string) { return null; },
    querySelectorAll(_sel: string) { return []; },
    addEventListener() {},
    removeEventListener() {},
    empty() { children.length = 0; },
  };
}

function createDivElement(): HTMLElement {
  if (typeof document !== "undefined") {
    return document.createElement("div");
  }
  return createMockHtmlElement("div") as unknown as HTMLElement;
}

function createInputElement(): HTMLInputElement {
  if (typeof document !== "undefined") {
    return document.createElement("input");
  }
  const el = createMockHtmlElement("input");
  return {
    ...el,
    type: "text",
    value: "",
    placeholder: "",
    min: "",
    max: "",
    step: "",
    checked: false,
    disabled: false,
  } as unknown as HTMLInputElement;
}

// ─── Stub Classes ─────────────────────────────────────────────

export class App {
  vault: Vault = new Vault();
}

export class MockDataAdapter {
  getName(): string {
    return "mock-adapter";
  }
  async read(_normalizedPath: string): Promise<string> {
    return "";
  }
  async write(_normalizedPath: string, _data: string): Promise<void> {}
  async exists(_normalizedPath: string, _resource?: boolean): Promise<boolean> {
    return false;
  }
  async list(_normalizedPath: string): Promise<ListedFiles> {
    return { files: [], folders: [] };
  }
  async remove(_normalizedPath: string): Promise<void> {}
  async copy(_normalizedPath: string, _normalizedNewPath: string): Promise<void> {}
}

export interface ListedFiles {
  files: string[];
  folders: string[];
}

export class Vault {
  adapter: MockDataAdapter = new MockDataAdapter();
  getFiles(): TFile[] {
    return [];
  }
  readRaw(_path: string): Promise<string> {
    return Promise.resolve("");
  }
  create(_path: string, _data: string): Promise<TFile> {
    return Promise.resolve(new TFile());
  }
  modify(_file: TFile, _data: string): Promise<void> {
    return Promise.resolve();
  }
  delete(_file: TFile): Promise<void> {
    return Promise.resolve();
  }
  getAbstractFileByPath(_path: string): TAbstractFile | null {
    return null;
  }
  exists(_path: string): Promise<boolean> {
    return Promise.resolve(false);
  }
  getMarkdownFiles(): TFile[] {
    return [];
  }
}

export class TFile {
  path: string = "";
  name: string = "";
  basename: string = "";
  extension: string = "md";
}

export class TAbstractFile {
  path: string = "";
  name: string = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export class Notice {
  constructor(_message: string | DocumentFragment, _timeout?: number) {}
}

export interface Command {
  id: string;
  name: string;
  callback?: () => void;
  checkCallback?: (checking: boolean) => boolean | void;
  hotkeys?: { modifiers: string[]; key: string }[];
}

export class Plugin {
  app: App = new App();
  private _loaded: boolean = false;
  private _commands: Command[] = [];
  private _views: Map<string, unknown> = new Map();
  private _ribbonIcons: Array<{ icon: string; title: string; cb: () => void }> = [];
  private _settingTabs: unknown[] = [];
  private _savedData: unknown = null;

  /** Exposed for test inspection */
  get _test_commands(): readonly Command[] {
    return this._commands;
  }

  /** Exposed for test inspection */
  get _test_views(): ReadonlyMap<string, unknown> {
    return this._views;
  }

  /** Exposed for test inspection */
  get _test_ribbonIcons(): readonly { icon: string; title: string; cb: () => void }[] {
    return this._ribbonIcons;
  }

  /** Exposed for test inspection */
  get _test_settingTabs(): readonly unknown[] {
    return this._settingTabs;
  }

  async loadData(): Promise<unknown> {
    return this._savedData;
  }

  async saveData(data: unknown): Promise<void> {
    this._savedData = data;
  }

  /** Exposed for tests: pre-seed data before onload() is called */
  _test_setData(data: unknown): void {
    this._savedData = data;
  }

  addCommand(command: Command): Command {
    this._commands.push(command);
    return command;
  }

  addRibbonIcon(icon: string, title: string, callback: () => void): HTMLElement {
    this._ribbonIcons.push({ icon, title, cb: callback });
    return createDivElement();
  }

  addSettingTab(tab: unknown): void {
    this._settingTabs.push(tab);
  }

  registerView(type: string, viewCreator: (leaf: WorkspaceLeaf) => unknown): void {
    this._views.set(type, viewCreator);
  }

  async onload(): Promise<void> {
    this._loaded = true;
  }

  onunload(): void {
    this._loaded = false;
  }

  /** Exposed for test inspection */
  get _test_loaded(): boolean {
    return this._loaded;
  }
}

export class WorkspaceLeaf {
  view: unknown = null;
}

export class ItemView {
  app: App;
  leaf: WorkspaceLeaf;
  containerEl: HTMLElement;
  contentEl: HTMLElement;

  constructor(leaf: WorkspaceLeaf) {
    this.app = new App();
    this.leaf = leaf;
    this.containerEl = createDivElement();
    this.contentEl = createDivElement();
    this.containerEl.appendChild(this.contentEl);
  }

  getViewType(): string {
    return "";
  }

  getDisplayText(): string {
    return "";
  }

  getIcon(): string {
    return "";
  }

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class Setting {
  constructor(_containerEl: HTMLElement) {}
  setName(_name: string): this {
    return this;
  }
  setDesc(_desc: string): this {
    return this;
  }
  addText(
    _cb: (component: TextComponent) => unknown
  ): this {
    return this;
  }
  addButton(
    _cb: (button: unknown) => unknown
  ): this {
    return this;
  }
  addToggle(
    _cb: (toggle: unknown) => unknown
  ): this {
    return this;
  }
  addExtraButton(
    _cb: (button: unknown) => unknown
  ): this {
    return this;
  }
}

export class TextComponent {
  inputEl: HTMLInputElement;
  constructor() {
    this.inputEl = createInputElement();
  }
  setValue(_value: string): this {
    return this;
  }
  setPlaceholder(_placeholder: string): this {
    return this;
  }
  onChange(_callback: (value: string) => unknown): this {
    return this;
  }
}

export class Modal {
  app: App;
  titleEl: HTMLElement;
  contentEl: HTMLElement;

  constructor(app: App) {
    this.app = app;
    this.titleEl = createDivElement();
    this.contentEl = createDivElement();
  }

  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export class SuggestModal<T> extends Modal {
  private _placeholder: string = "";

  setPlaceholder(text: string): void {
    this._placeholder = text;
  }

  getSuggestions(_query: string): T[] {
    return [];
  }

  renderSuggestion(_item: T, _el: HTMLElement): void {}

  onChooseSuggestion(_item: T, _evt: MouseEvent | KeyboardEvent): void {}
}

export class TextInputModal extends Modal {
  constructor(
    app: App,
    _title: string,
    _placeholder: string,
    _onSubmit: (value: string) => void,
  ) {
    super(app);
  }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = createDivElement();
  }
  display(): void {}
  hide(): void {}
}
