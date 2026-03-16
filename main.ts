import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  getAllTags,
  requestUrl,
} from "obsidian";

// ─── Types ────────────────────────────────────────────────────────────────────

interface BookData {
  isbn: string;
  title: string;
  authors: string[];
  editors: string[];
  publisher: string;
  publishedYear: string;
  coverUrl: string;
  pages: string;
  subjects: string[];
}

interface CustomField {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "boolean";
}

interface BookCatalogSettings {
  baseFolder: string;
  notesSubfolder: string;
  googleBooksApiKey: string;
  saveAndAddFirst: boolean;
  customFields: CustomField[];
}

// ─── Open Library API types ───────────────────────────────────────────────────

interface OLAuthor { name: string; }
interface OLContribution { name: string; role?: string; }
interface OLPublisher { name: string; }
interface OLCover { large?: string; medium?: string; }
interface OLSubject { name?: string; }

interface OLBookData {
  title?: string;
  authors?: OLAuthor[];
  contributions?: OLContribution[];
  publishers?: OLPublisher[];
  publish_date?: string;
  cover?: OLCover;
  number_of_pages?: number;
  subjects?: (string | OLSubject)[];
}

interface OLSearchDoc {
  isbn?: string[];
  title?: string;
  author_name?: string[];
  publisher?: string[];
  first_publish_year?: number;
  cover_i?: number;
  subject?: string[];
}

// ─── Google Books API types ───────────────────────────────────────────────────

interface GBImageLinks {
  extraLarge?: string;
  large?: string;
  thumbnail?: string;
  smallThumbnail?: string;
}

interface GBIdentifier { type: string; identifier: string; }

interface GBVolumeInfo {
  title?: string;
  authors?: string[];
  publisher?: string;
  publishedDate?: string;
  pageCount?: number;
  categories?: string[];
  imageLinks?: GBImageLinks;
  industryIdentifiers?: GBIdentifier[];
}

interface GBVolume { volumeInfo: GBVolumeInfo; }

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: BookCatalogSettings = {
  baseFolder: "Books",
  notesSubfolder: "Notes",
  googleBooksApiKey: "",
  saveAndAddFirst: true,
  customFields: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toYamlInline(items: string[]): string {
  if (!items || items.length === 0) return "[]";
  const escaped = items.map((i) => `"${i.replace(/"/g, '\\"')}"`);
  return `[${escaped.join(", ")}]`;
}

function toYamlKey(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "").replace(/^-+|-+$/g, "") || "custom-field";
}

const LOWERCASE_WORDS = new Set([
  "a", "an", "the",
  "and", "but", "or", "nor", "for", "so", "yet",
  "at", "by", "for", "in", "of", "on", "to", "up",
  "as", "is", "it",
]);

function toTitleCase(str: string): string {
  if (!str) return str;
  const words = str.trim().split(/\s+/);
  return words
    .map((word, index) => {
      if (index === 0 || index === words.length - 1) return capitalizeWord(word);
      const clean = word.toLowerCase().replace(/[^a-z]/g, "");
      if (LOWERCASE_WORDS.has(clean)) return word.toLowerCase();
      return capitalizeWord(word);
    })
    .join(" ");
}

function capitalizeWord(word: string): string {
  if (!word) return word;
  if (word === word.toUpperCase() && /^[A-Z]/.test(word) && word.length <= 3) return word;
  if (word.includes("-")) return word.split("-").map((p) => capitalizeWord(p)).join("-");
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function toTitleCaseNames(names: string[]): string[] {
  return names.map((name) =>
    name.split(/(\s+|,\s*)/).map((p) => capitalizeWord(p)).join("")
  );
}

// ─── Path Helpers ─────────────────────────────────────────────────────────────

function getNotesFolder(settings: Pick<BookCatalogSettings, "baseFolder" | "notesSubfolder">): string {
  if (settings.notesSubfolder.trim()) {
    return `${settings.baseFolder}/${settings.notesSubfolder}`.replace(/\/+/g, "/");
  }
  return settings.baseFolder;
}

function getBasePath(baseFolder: string): string {
  return `${baseFolder}/Book Catalog.base`;
}

// ─── Base File Generator ──────────────────────────────────────────────────────

function generateBaseContent(settings: BookCatalogSettings): string {
  const notesFolder = getNotesFolder(settings);
  return `filters:
  and:
    - file.hasTag("book")
    - file.inFolder("${notesFolder}")
properties:
  file.name:
    displayName: Title
views:
  - type: table
    name: All Books
    order:
      - file.name
      - authors
      - editors
      - publisher
      - published
      - condition
      - copies
      - valuation
      - isbn
    sort:
      - property: file.name
        direction: ASC
  - type: table
    name: By Year
    order:
      - file.name
      - authors
      - publisher
      - published
      - condition
      - copies
      - valuation
    sort:
      - property: published
        direction: ASC
  - type: table
    name: Needs Condition
    filters:
      and:
        - condition == ""
    order:
      - file.name
      - authors
      - publisher
      - copies
      - valuation
      - isbn
    sort:
      - property: file.name
        direction: ASC
`;
}

// ─── Main Plugin ──────────────────────────────────────────────────────────────

export default class BookCatalogPlugin extends Plugin {
  settings: BookCatalogSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("library", "Open Book Catalog", () => {
      const baseFile = this.findExistingBaseFile();
      if (baseFile) {
        void this.app.workspace.getLeaf(false).openFile(baseFile);
      } else {
        new Notice("Book Catalog.base not found. Create it in Settings → Book Catalog.");
      }
    });

    this.addRibbonIcon("book-plus", "Add book", () => new ISBNModal(this.app, this).open());

    this.addCommand({
      id: "add-by-isbn",
      name: "Add by ISBN",
      callback: () => new ISBNModal(this.app, this).open(),
    });

    this.addCommand({
      id: "open-catalog",
      name: "Open catalog",
      callback: () => {
        const baseFile = this.findExistingBaseFile();
        if (baseFile) void this.app.workspace.getLeaf(false).openFile(baseFile);
        else new Notice("Book Catalog.base not found. Create it in Settings → Book Catalog.");
      },
    });

    this.addSettingTab(new BookCatalogSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.customFields) this.settings.customFields = [];
  }

  async saveSettings() { await this.saveData(this.settings); }

  async ensureFolder(path: string): Promise<void> {
    if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
  }

  collectFiles(folder: TFolder, results: TFile[] = []): TFile[] {
    for (const child of folder.children) {
      if (child instanceof TFile) results.push(child);
      else if (child instanceof TFolder) this.collectFiles(child, results);
    }
    return results;
  }

  scanVaultForBookNotes(): TFile[] {
    return this.collectFiles(this.app.vault.getRoot()).filter((f) => {
      if (f.extension !== "md") return false;
      const cache = this.app.metadataCache.getFileCache(f);
      return cache ? (getAllTags(cache)?.includes("#book") ?? false) : false;
    });
  }

  findExistingBaseFile(): TFile | null {
    return this.collectFiles(this.app.vault.getRoot())
      .find((f) => f.extension === "base" && f.name === "Book Catalog.base") ?? null;
  }

  async createBaseFile(): Promise<void> {
    await this.ensureFolder(this.settings.baseFolder);
    const basePath = getBasePath(this.settings.baseFolder);
    const content = generateBaseContent(this.settings);
    const existing = this.app.vault.getAbstractFileByPath(basePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      new Notice("✅ Book Catalog.base updated.");
    } else {
      await this.app.vault.create(basePath, content);
      new Notice("✅ Book Catalog.base created.");
    }
  }

  async reorganizeFiles(bookNotes: TFile[]): Promise<void> {
    const newNotesFolder = getNotesFolder(this.settings);
    const newBasePath = getBasePath(this.settings.baseFolder);
    await this.ensureFolder(this.settings.baseFolder);
    if (this.settings.notesSubfolder.trim()) await this.ensureFolder(newNotesFolder);
    let moved = 0;
    for (const file of bookNotes) {
      const newPath = `${newNotesFolder}/${file.name}`;
      if (file.path !== newPath) { await this.app.vault.rename(file, newPath); moved++; }
    }
    const existingBase = this.findExistingBaseFile();
    if (existingBase && existingBase.path !== newBasePath) await this.app.vault.rename(existingBase, newBasePath);
    await this.createBaseFile();
    await this.saveSettings();
    new Notice(`✅ Reorganization complete. ${moved} note${moved !== 1 ? "s" : ""} moved.`);
  }

  // ─── ISBN Barcode Lookup ──────────────────────────────────────────────────

  async lookupISBN(isbn: string): Promise<BookData | null> {
    const cleanISBN = isbn.replace(/[^0-9X]/gi, "");
    try { const b = await this.fetchOpenLibraryByISBN(cleanISBN); if (b) return b; } catch (e) { console.warn("Open Library ISBN lookup failed:", e); }
    try { const b = await this.fetchGoogleBooksByISBN(cleanISBN); if (b) return b; } catch (e) { console.warn("Google Books ISBN lookup failed:", e); }
    return null;
  }

  async fetchOpenLibraryByISBN(isbn: string): Promise<BookData | null> {
    const url = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
    const response = await requestUrl({ url });
    const data = response.json as Record<string, OLBookData>;
    const key = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const book = data[key];
    return {
      isbn,
      title: toTitleCase(book.title ?? "Unknown Title"),
      authors: toTitleCaseNames((book.authors ?? []).map((a) => a.name)),
      editors: toTitleCaseNames(
        (book.contributions ?? [])
          .filter((c) => c.role?.toLowerCase().includes("editor"))
          .map((c) => c.name)
      ),
      publisher: book.publishers?.[0]?.name ?? "",
      publishedYear: book.publish_date ? book.publish_date.split(" ").pop() ?? "" : "",
      coverUrl: book.cover?.large ?? book.cover?.medium ?? "",
      pages: book.number_of_pages?.toString() ?? "",
      subjects: (book.subjects ?? []).slice(0, 8).map((s) =>
        typeof s === "string" ? s : (s.name ?? "")
      ),
    };
  }

  async fetchGoogleBooksByISBN(isbn: string): Promise<BookData | null> {
    let url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
    if (this.settings.googleBooksApiKey) url += `&key=${this.settings.googleBooksApiKey}`;
    const response = await requestUrl({ url });
    const data = response.json as { items?: GBVolume[] };
    if (!data.items?.length) return null;
    const info = data.items[0].volumeInfo;
    return {
      isbn,
      title: toTitleCase(info.title ?? "Unknown Title"),
      authors: toTitleCaseNames(info.authors ?? []),
      editors: [],
      publisher: info.publisher ?? "",
      publishedYear: info.publishedDate ? info.publishedDate.substring(0, 4) : "",
      coverUrl: info.imageLinks?.extraLarge ?? info.imageLinks?.large ?? info.imageLinks?.thumbnail ?? "",
      pages: info.pageCount?.toString() ?? "",
      subjects: (info.categories ?? []).slice(0, 8),
    };
  }

  // ─── Manual Title/Author Search ───────────────────────────────────────────

  async searchBooks(title: string, author: string): Promise<BookData[]> {
    const results: BookData[] = [];
    const seen = new Set<string>();
    const dedupeKey = (b: BookData) => `${b.title.toLowerCase().trim()}|${(b.authors[0] ?? "").toLowerCase().trim()}`;
    const addResult = (b: BookData) => { const key = dedupeKey(b); if (!seen.has(key)) { seen.add(key); results.push(b); } };
    try { (await this.searchOpenLibrary(title, author)).forEach(addResult); } catch (e) { console.warn("Open Library search failed:", e); }
    try { (await this.searchGoogleBooks(title, author)).forEach(addResult); } catch (e) { console.warn("Google Books search failed:", e); }
    return results.slice(0, 10);
  }

  async searchOpenLibrary(title: string, author: string): Promise<BookData[]> {
    let url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}`;
    if (author) url += `&author=${encodeURIComponent(author)}`;
    url += `&limit=8&fields=title,author_name,publisher,first_publish_year,isbn,cover_i,subject`;
    const response = await requestUrl({ url });
    const data = response.json as { docs?: OLSearchDoc[] };
    return (data.docs ?? []).map((doc): BookData => ({
      isbn: doc.isbn?.[0] ?? "",
      title: toTitleCase(doc.title ?? "Unknown Title"),
      authors: toTitleCaseNames(doc.author_name ?? []),
      editors: [],
      publisher: doc.publisher?.[0] ?? "",
      publishedYear: doc.first_publish_year?.toString() ?? "",
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
      pages: "",
      subjects: (doc.subject ?? []).slice(0, 8),
    }));
  }

  async searchGoogleBooks(title: string, author: string): Promise<BookData[]> {
    let q = `intitle:${encodeURIComponent(title)}`;
    if (author) q += `+inauthor:${encodeURIComponent(author)}`;
    let url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8`;
    if (this.settings.googleBooksApiKey) url += `&key=${this.settings.googleBooksApiKey}`;
    const response = await requestUrl({ url });
    const data = response.json as { items?: GBVolume[] };
    return (data.items ?? []).map((item): BookData => {
      const info = item.volumeInfo;
      const isbn =
        info.industryIdentifiers?.find((id) => id.type === "ISBN_13")?.identifier ??
        info.industryIdentifiers?.find((id) => id.type === "ISBN_10")?.identifier ?? "";
      return {
        isbn,
        title: toTitleCase(info.title ?? "Unknown Title"),
        authors: toTitleCaseNames(info.authors ?? []),
        editors: [],
        publisher: info.publisher ?? "",
        publishedYear: info.publishedDate ? info.publishedDate.substring(0, 4) : "",
        coverUrl: info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail ?? "",
        pages: info.pageCount?.toString() ?? "",
        subjects: (info.categories ?? []).slice(0, 8),
      };
    });
  }

  // ─── Note Utilities ───────────────────────────────────────────────────────

  findExistingNote(book: BookData): TFile | null {
    const folder = getNotesFolder(this.settings);
    const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, "").trim();
    const file = this.app.vault.getAbstractFileByPath(`${folder}/${safeTitle}.md`);
    return file instanceof TFile ? file : null;
  }

  async createBookNote(book: BookData, condition: string, acquired: string, valuation: string, copies: string, customValues: Record<string, string> = {}): Promise<void> {
    const notesFolder = getNotesFolder(this.settings);
    await this.ensureFolder(this.settings.baseFolder);
    if (this.settings.notesSubfolder.trim()) await this.ensureFolder(notesFolder);
    const safeTitle = book.title.replace(/[\\/:*?"<>|]/g, "").trim();
    await this.app.vault.create(`${notesFolder}/${safeTitle}.md`, this.generateNoteContent(book, condition, acquired, valuation, copies, customValues));
    new Notice(`✅ Book added: ${book.title}`);
  }

  async updateCopies(file: TFile, newCount: number): Promise<void> {
    const content = await this.app.vault.read(file);
    const updated = /^copies:\s*\d+/m.test(content)
      ? content.replace(/^copies:\s*\d+/m, `copies: ${newCount}`)
      : content.replace(/^(---[\s\S]*?)\n---/m, `$1\ncopies: ${newCount}\n---`);
    await this.app.vault.modify(file, updated);
    new Notice(`✅ Copies updated to ${newCount}.`);
  }

  openNote(file: TFile): void { void this.app.workspace.getLeaf(false).openFile(file); }

  generateNoteContent(book: BookData, condition: string, acquired: string, valuation: string, copies: string, customValues: Record<string, string> = {}): string {
    const coverLine = book.coverUrl ? `\n<img src="${book.coverUrl}" alt="cover" width="150"/>\n` : "";
    const valuationYaml = valuation ? parseFloat(valuation) || `"${valuation}"` : '""';
    const copiesYaml = copies ? parseInt(copies) || 1 : 1;
    const customLines = this.settings.customFields.map((field) => {
      const raw = customValues[field.id] ?? "";
      const key = toYamlKey(field.name);
      if (field.type === "boolean") return `${key}: ${raw === "true"}`;
      if (field.type === "number") return `${key}: ${parseFloat(raw) || ""}`;
      return `${key}: "${raw.replace(/"/g, '\\"')}"`;
    }).join("\n");
    return `---
title: "${book.title.replace(/"/g, '\\"')}"
authors: ${toYamlInline(book.authors)}
editors: ${toYamlInline(book.editors)}
publisher: "${book.publisher}"
published: ${book.publishedYear || '""'}
pages: ${book.pages || '""'}
isbn: "${book.isbn}"
cover: "${book.coverUrl}"
condition: "${condition}"
acquired: "${acquired}"
valuation: ${valuationYaml}
copies: ${copiesYaml}
subjects: ${toYamlInline(book.subjects)}${customLines ? "\n" + customLines : ""}
tags: ["book"]
---
${coverLine}
## Notes

`;
  }
}

// ─── Reorganize Modal ─────────────────────────────────────────────────────────

class ReorganizeModal extends Modal {
  plugin: BookCatalogPlugin;
  constructor(app: App, plugin: BookCatalogPlugin) { super(app); this.plugin = plugin; }
  onOpen() { this.showScanStep(); }

  showScanStep() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Reorganize catalog files" });
    contentEl.createEl("p", { cls: "bc-reorg-hint", text: "Scan your vault to find all book notes regardless of where they currently live." });

    const targetEl = contentEl.createDiv({ cls: "bc-target-box" });
    targetEl.createEl("p", { cls: "bc-target-heading", text: "Target location (from your settings):" });
    targetEl.createEl("p", { cls: "bc-target-path", text: `📄 ${getBasePath(this.plugin.settings.baseFolder)}` });
    targetEl.createEl("p", { cls: "bc-target-path-last", text: `📚 ${getNotesFolder(this.plugin.settings)}/` });

    const resultsEl = contentEl.createDiv({ cls: "bc-results-area" });
    const btnRow = contentEl.createDiv({ cls: "bc-reorg-btn-row" });
    const cancelBtn = btnRow.createEl("button", { cls: "bc-reorg-cancel-btn", text: "Cancel" });
    const scanBtn = btnRow.createEl("button", { cls: "bc-reorg-scan-btn", text: "🔍  Scan vault" });

    cancelBtn.addEventListener("click", () => this.close());
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true;
      scanBtn.setText("Scanning...");
      resultsEl.empty();

      const bookNotes = this.plugin.scanVaultForBookNotes();
      const newNotesFolder = getNotesFolder(this.plugin.settings);
      const notesToMove = bookNotes.filter((f) => f.path !== `${newNotesFolder}/${f.name}`);
      const existingBase = this.plugin.findExistingBaseFile();
      const newBasePath = getBasePath(this.plugin.settings.baseFolder);
      const baseNeedsMove = !!(existingBase && existingBase.path !== newBasePath);

      const resultBox = resultsEl.createDiv({ cls: "bc-result-box" });
      resultBox.createEl("p", { cls: "bc-result-box-heading", text: `✅ Scan complete — found ${bookNotes.length} book note${bookNotes.length !== 1 ? "s" : ""} in your vault.` });

      if (bookNotes.length === 0) {
        resultBox.createEl("p", { cls: "bc-folder-name", text: 'No book notes found. Make sure your notes have tags: ["book"] in their frontmatter.' });
        scanBtn.disabled = false;
        scanBtn.setText("🔍  Scan vault");
        return;
      }

      const byFolder = new Map<string, TFile[]>();
      for (const f of bookNotes) {
        const folder = f.parent?.path ?? "(root)";
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      }

      byFolder.forEach((files, folder) => {
        const alreadyInPlace = folder === newNotesFolder;
        const folderEl = resultBox.createDiv({ cls: "bc-folder-row" });
        const nameEl = folderEl.createEl("span", { text: `📁 ${folder}/ — ${files.length} note${files.length !== 1 ? "s" : ""}` });
        nameEl.addClass(alreadyInPlace ? "bc-folder-name is-ok" : "bc-folder-name");
        if (alreadyInPlace) folderEl.createEl("span", { cls: "bc-folder-ok-badge", text: " ✓ already in target" });
      });

      if (existingBase) resultBox.createEl("p", { cls: "bc-base-path", text: `📄 Book Catalog.base: ${existingBase.path}` });

      if (notesToMove.length === 0 && !baseNeedsMove) {
        resultBox.createEl("p", { cls: "bc-all-ok", text: "✅ Everything is already in the correct location." });
        scanBtn.disabled = false;
        scanBtn.setText("🔍  Scan again");
        return;
      }

      const proceedRow = resultsEl.createDiv({ cls: "bc-proceed-row" });
      const proceedBtn = proceedRow.createEl("button", { cls: "bc-proceed-btn", text: `Review ${notesToMove.length} move${notesToMove.length !== 1 ? "s" : ""} →` });
      proceedBtn.addEventListener("click", () => this.showConfirmStep(bookNotes, notesToMove, existingBase, baseNeedsMove));
      scanBtn.disabled = false;
      scanBtn.setText("🔍  Scan again");
    });
  }

  showConfirmStep(allNotes: TFile[], notesToMove: TFile[], existingBase: TFile | null, baseNeedsMove: boolean) {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    const newNotesFolder = getNotesFolder(s);
    const newBasePath = getBasePath(s.baseFolder);

    contentEl.createEl("h2", { text: "Confirm reorganization" });
    contentEl.createEl("p", { cls: "bc-reorg-confirm-hint", text: "Review the changes below before confirming." });

    if (notesToMove.length > 0) {
      contentEl.createEl("p", { cls: "bc-section-label", text: "Book notes to move:" });
      const notesBox = contentEl.createDiv({ cls: "bc-tree-box" });
      const byFolder = new Map<string, TFile[]>();
      for (const f of notesToMove) {
        const folder = f.parent?.path ?? "(root)";
        if (!byFolder.has(folder)) byFolder.set(folder, []);
        byFolder.get(folder)!.push(f);
      }
      byFolder.forEach((files, folder) => {
        notesBox.createEl("div", { text: `📁 ${folder}/` });
        const indent = notesBox.createDiv({ cls: "bc-tree-indent" });
        files.slice(0, 4).forEach((f) => indent.createEl("div", { cls: "bc-tree-item", text: `📝 ${f.name}` }));
        if (files.length > 4) indent.createEl("div", { cls: "bc-tree-item", text: `… and ${files.length - 4} more` });
        notesBox.createEl("div", { cls: "bc-tree-dest", text: `↳ → ${newNotesFolder}/` });
      });
    }

    if (baseNeedsMove && existingBase) {
      contentEl.createEl("p", { cls: "bc-section-label", text: "Base file to move:" });
      const baseBox = contentEl.createDiv({ cls: "bc-tree-box" });
      baseBox.createEl("div", { cls: "bc-tree-item", text: `📄 ${existingBase.path}` });
      baseBox.createEl("div", { cls: "bc-tree-dest", text: `↳ → ${newBasePath}` });
    }

    const summaryEl = contentEl.createDiv({ cls: "bc-summary-box" });
    summaryEl.createEl("p", { cls: "bc-summary-line", text: `📚 ${notesToMove.length} note${notesToMove.length !== 1 ? "s" : ""} → ${newNotesFolder}/` });
    if (baseNeedsMove) summaryEl.createEl("p", { cls: "bc-summary-line", text: `📄 Base → ${newBasePath}` });
    summaryEl.createEl("p", { cls: "bc-summary-line-last", text: "📄 Book Catalog.base will be regenerated with updated paths." });

    const btnRow = contentEl.createDiv({ cls: "bc-confirm-btn-row" });
    const backBtn = btnRow.createEl("button", { cls: "bc-btn-secondary", text: "← Back" });
    const confirmBtn = btnRow.createEl("button", { cls: "bc-btn-primary", text: "Confirm & move files" });

    backBtn.addEventListener("click", () => this.showScanStep());
    confirmBtn.addEventListener("click", () => {
      confirmBtn.disabled = true;
      confirmBtn.setText("Moving files...");
      void this.plugin.reorganizeFiles(allNotes).then(() => this.close());
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── ISBN Input Modal ─────────────────────────────────────────────────────────

class ISBNModal extends Modal {
  plugin: BookCatalogPlugin;
  constructor(app: App, plugin: BookCatalogPlugin) { super(app); this.plugin = plugin; }
  onOpen() { this.showScanStep(); }

  showScanStep() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add book" });

    const tabBar = contentEl.createDiv({ cls: "bc-tab-bar" });
    const barcodeBtn = tabBar.createEl("button", { cls: "bc-tab-btn is-active", text: "📷  Scan / ISBN" });
    const searchBtn  = tabBar.createEl("button", { cls: "bc-tab-btn", text: "🔍  Search by title" });
    const tabContent = contentEl.createDiv();

    const renderBarcodeTab = () => {
      barcodeBtn.addClass("is-active"); barcodeBtn.removeClass("bc-tab-btn");
      searchBtn.removeClass("is-active");
      barcodeBtn.className = "bc-tab-btn is-active";
      searchBtn.className = "bc-tab-btn";
      tabContent.empty();

      tabContent.createEl("p", { cls: "bc-hint", text: "Scan the barcode with a USB scanner, or type the ISBN manually." });

      const inputEl = tabContent.createEl("input", { type: "text", placeholder: "ISBN / barcode..." });
      inputEl.addClass("bc-isbn-input");
      setTimeout(() => inputEl.focus(), 50);

      const statusEl = tabContent.createEl("p", { cls: "bc-status", text: "" });
      const lookupBtn = tabContent.createEl("button", { cls: "bc-lookup-btn", text: "Look up book" });

      const doLookup = async (isbn: string) => {
        if (!isbn) { statusEl.setText("Please enter an ISBN."); return; }
        lookupBtn.disabled = true;
        inputEl.disabled = true;
        statusEl.setText("Looking up book...");
        const book = await this.plugin.lookupISBN(isbn);
        if (!book) {
          statusEl.setText("❌ No book found. Check the number and try again.");
          lookupBtn.disabled = false;
          inputEl.disabled = false;
          inputEl.focus();
          return;
        }
        const existing = this.plugin.findExistingNote(book);
        if (existing) { this.showDuplicateStep(book, existing); return; }
        this.showConfirmStep(book);
      };

      inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") void doLookup(inputEl.value.trim()); });
      lookupBtn.addEventListener("click", () => void doLookup(inputEl.value.trim()));
    };

    const renderSearchTab = () => {
      barcodeBtn.className = "bc-tab-btn";
      searchBtn.className = "bc-tab-btn is-active";
      tabContent.empty();

      tabContent.createEl("p", { cls: "bc-hint", text: "Search by title and optionally author. Title is required." });

      const titleRow = tabContent.createDiv({ cls: "bc-form-row" });
      titleRow.createEl("label", { cls: "bc-form-label", text: "Title *" });
      const titleEl = titleRow.createEl("input", { type: "text", placeholder: "Required" });
      titleEl.addClass("bc-form-input");
      setTimeout(() => titleEl.focus(), 50);

      const authorRow = tabContent.createDiv({ cls: "bc-form-row-last" });
      authorRow.createEl("label", { cls: "bc-form-label", text: "Author" });
      const authorEl = authorRow.createEl("input", { type: "text", placeholder: "Optional" });
      authorEl.addClass("bc-form-input");

      const statusEl = tabContent.createEl("p", { cls: "bc-status-search", text: "" });
      const searchActionBtn = tabContent.createEl("button", { cls: "bc-search-btn", text: "Search books" });
      const resultsEl = tabContent.createDiv();

      const renderResults = (books: BookData[]) => {
        resultsEl.empty();
        if (books.length === 0) {
          resultsEl.createEl("p", { cls: "bc-hint", text: "No results found. Try different search terms." });
          return;
        }
        resultsEl.createEl("p", { cls: "bc-result-count", text: `${books.length} result${books.length !== 1 ? "s" : ""} — click to select` });
        books.forEach((book) => {
          const card = resultsEl.createDiv({ cls: "bc-result-card" });
          if (book.coverUrl) {
            const img = card.createEl("img");
            img.src = book.coverUrl;
            img.alt = "cover";
            img.addClass("bc-result-thumb");
          } else {
            const ph = card.createDiv({ cls: "bc-result-thumb-placeholder" });
            ph.createEl("span", { text: "📖" });
          }
          const info = card.createDiv({ cls: "bc-result-info" });
          info.createEl("div", { cls: "bc-result-title", text: book.title });
          if (book.authors.length > 0) info.createEl("div", { cls: "bc-result-meta", text: book.authors.join(", ") });
          const meta = [book.publisher, book.publishedYear].filter(Boolean).join(", ");
          if (meta) info.createEl("div", { cls: "bc-result-meta", text: meta });
          card.addEventListener("click", () => {
            const existing = this.plugin.findExistingNote(book);
            if (existing) { this.showDuplicateStep(book, existing); return; }
            this.showConfirmStep(book);
          });
        });
      };

      const doSearch = async () => {
        const title = titleEl.value.trim();
        if (!title) {
          statusEl.setText("Please enter a title.");
          statusEl.addClass("is-error");
          titleEl.focus();
          return;
        }
        statusEl.removeClass("is-error");
        searchActionBtn.disabled = true;
        searchActionBtn.setText("Searching...");
        statusEl.setText("Searching…");
        resultsEl.empty();
        const books = await this.plugin.searchBooks(title, authorEl.value.trim());
        statusEl.setText("");
        searchActionBtn.disabled = false;
        searchActionBtn.setText("Search books");
        renderResults(books);
      };

      const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") void doSearch(); };
      titleEl.addEventListener("keydown", onEnter);
      authorEl.addEventListener("keydown", onEnter);
      searchActionBtn.addEventListener("click", () => void doSearch());
    };

    barcodeBtn.addEventListener("click", renderBarcodeTab);
    searchBtn.addEventListener("click", renderSearchTab);
    renderBarcodeTab();
  }

  showDuplicateStep(book: BookData, existing: TFile) {
    const { contentEl } = this;
    contentEl.empty();

    const headerEl = contentEl.createDiv({ cls: "bc-dup-header" });
    headerEl.createEl("span", { cls: "bc-dup-emoji", text: "📚" });
    headerEl.createEl("h2", { text: "Already in your catalog" });

    const previewEl = contentEl.createDiv({ cls: "bc-preview" });
    if (book.coverUrl) {
      const imgEl = previewEl.createEl("img");
      imgEl.src = book.coverUrl;
      imgEl.alt = "cover";
      imgEl.addClass("bc-preview-img");
    }
    const metaEl = previewEl.createDiv({ cls: "bc-preview-meta" });
    metaEl.createEl("strong", { text: book.title });
    if (book.authors.length > 0) metaEl.createEl("span", { cls: "bc-preview-detail", text: book.authors.join(", ") });
    if (book.publisher || book.publishedYear) metaEl.createEl("span", { cls: "bc-preview-detail", text: [book.publisher, book.publishedYear].filter(Boolean).join(", ") });

    const cache = this.plugin.app.metadataCache.getFileCache(existing);
    const currentCopies: number = cache?.frontmatter?.copies ?? 1;
    const copiesInfoEl = contentEl.createDiv({ cls: "bc-copies-info" });
    copiesInfoEl.createEl("span", { text: "Currently in catalog: " });
    copiesInfoEl.createEl("strong", { text: `${currentCopies} cop${currentCopies === 1 ? "y" : "ies"}` });

    contentEl.createEl("hr");

    const copiesWrap = contentEl.createDiv({ cls: "bc-copies-row" });
    copiesWrap.createEl("label", { cls: "bc-copies-label", text: "Update copies to" });
    const copiesEl = copiesWrap.createEl("input", { type: "number" });
    copiesEl.value = String(currentCopies + 1);
    copiesEl.min = "1";
    copiesEl.step = "1";
    copiesEl.addClass("bc-copies-input");

    const btnCol = contentEl.createDiv({ cls: "bc-btn-col" });
    const updateBtn = btnCol.createEl("button", { cls: "bc-btn-full-primary", text: "✅  Update copies" });
    const openBtn   = btnCol.createEl("button", { cls: "bc-btn-full", text: "📖  Open existing note" });
    const scanBtn   = btnCol.createEl("button", { cls: "bc-btn-full", text: "↩  Search again" });

    updateBtn.addEventListener("click", () => {
      const newCount = parseInt(copiesEl.value) || currentCopies + 1;
      updateBtn.disabled = true;
      updateBtn.setText("Saving...");
      void this.plugin.updateCopies(existing, newCount).then(() => this.close());
    });
    openBtn.addEventListener("click", () => { this.plugin.openNote(existing); this.close(); });
    scanBtn.addEventListener("click", () => this.showScanStep());
  }

  showConfirmStep(book: BookData) {
    const { contentEl } = this;
    contentEl.empty();

    const previewEl = contentEl.createDiv({ cls: "bc-preview" });
    if (book.coverUrl) {
      const imgEl = previewEl.createEl("img");
      imgEl.src = book.coverUrl;
      imgEl.alt = "cover";
      imgEl.addClass("bc-preview-img");
    }
    const metaEl = previewEl.createDiv({ cls: "bc-preview-meta" });
    metaEl.createEl("strong", { text: book.title });
    if (book.authors.length > 0) metaEl.createEl("span", { cls: "bc-preview-detail", text: book.authors.join(", ") });
    if (book.publisher || book.publishedYear) metaEl.createEl("span", { cls: "bc-preview-detail", text: [book.publisher, book.publishedYear].filter(Boolean).join(", ") });
    if (book.pages) metaEl.createEl("span", { cls: "bc-preview-detail", text: `${book.pages} pages` });

    contentEl.createEl("hr");

    // ── Standard fields ───────────────────────────────────────────────────
    const conditionRow = contentEl.createDiv({ cls: "bc-field-row" });
    conditionRow.createEl("label", { cls: "bc-field-label", text: "Condition" });
    const conditionEl = conditionRow.createEl("select");
    conditionEl.addClass("bc-field-select");
    ["", "New", "Fine", "Very Good", "Good", "Fair", "Poor"].forEach((c) => {
      const opt = conditionEl.createEl("option", { text: c || "— select —" });
      opt.value = c;
    });

    const acquiredRow = contentEl.createDiv({ cls: "bc-field-row" });
    acquiredRow.createEl("label", { cls: "bc-field-label", text: "Acquired" });
    const acquiredEl = acquiredRow.createEl("input", { type: "date" });
    acquiredEl.addClass("bc-field-input");
    acquiredEl.value = new Date().toISOString().split("T")[0];

    const copiesRow = contentEl.createDiv({ cls: "bc-field-row" });
    copiesRow.createEl("label", { cls: "bc-field-label", text: "Copies" });
    const copiesEl = copiesRow.createEl("input", { type: "number" });
    copiesEl.addClass("bc-field-input");
    copiesEl.value = "1";
    copiesEl.min = "1";
    copiesEl.step = "1";

    const valuationRow = contentEl.createDiv({ cls: "bc-field-row" });
    valuationRow.createEl("label", { cls: "bc-field-label", text: "Value (USD)" });
    const valuationWrap = valuationRow.createDiv({ cls: "bc-valuation-wrap" });
    valuationWrap.createEl("span", { cls: "bc-valuation-prefix", text: "$" });
    const valuationEl = valuationWrap.createEl("input", { type: "number" });
    valuationEl.addClass("bc-valuation-input");
    valuationEl.placeholder = "0.00";
    valuationEl.min = "0";
    valuationEl.step = "0.01";

    // ── Custom fields ─────────────────────────────────────────────────────
    const customGetters: Record<string, () => string> = {};
    if (this.plugin.settings.customFields.length > 0) {
      contentEl.createEl("hr", { cls: "bc-custom-divider" });
      this.plugin.settings.customFields.forEach((field) => {
        const wrap = contentEl.createDiv({ cls: "bc-field-row" });
        wrap.createEl("label", { cls: "bc-field-label", text: field.name });

        if (field.type === "boolean") {
          const toggleOuter = wrap.createDiv({ cls: "bc-toggle-outer" });
          const toggleInput = toggleOuter.createEl("input", { type: "checkbox" });
          toggleInput.addClass("bc-toggle-input");
          const slider = toggleOuter.createDiv({ cls: "bc-toggle-slider" });
          slider.createDiv({ cls: "bc-toggle-knob" });
          const sync = () => { slider.toggleClass("is-on", toggleInput.checked); };
          toggleInput.addEventListener("change", sync);
          slider.addEventListener("click", () => { toggleInput.checked = !toggleInput.checked; sync(); });
          customGetters[field.id] = () => toggleInput.checked ? "true" : "false";
        } else if (field.type === "date") {
          const el = wrap.createEl("input", { type: "date" });
          el.addClass("bc-field-input");
          customGetters[field.id] = () => el.value;
        } else if (field.type === "number") {
          const el = wrap.createEl("input", { type: "number" });
          el.addClass("bc-field-input");
          el.step = "any";
          customGetters[field.id] = () => el.value;
        } else {
          const el = wrap.createEl("input", { type: "text" });
          el.addClass("bc-field-input");
          customGetters[field.id] = () => el.value;
        }
      });
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    const saveFirst = this.plugin.settings.saveAndAddFirst;
    const btnRow = contentEl.createDiv({ cls: "bc-btn-row" });
    const backBtn        = btnRow.createEl("button", { cls: "bc-btn-secondary", text: "← Back" });
    const saveAnotherBtn = btnRow.createEl("button", { text: "Save & add another" });
    const saveBtn        = btnRow.createEl("button", { text: "Save book" });
    saveAnotherBtn.addClass(saveFirst ? "bc-btn-primary" : "bc-btn-secondary");
    saveBtn.addClass(saveFirst ? "bc-btn-secondary" : "bc-btn-primary");

    const collectCustomValues = (): Record<string, string> => {
      const vals: Record<string, string> = {};
      for (const id in customGetters) vals[id] = customGetters[id]();
      return vals;
    };

    backBtn.addEventListener("click", () => this.showScanStep());
    saveBtn.addEventListener("click", () => {
      saveBtn.disabled = true;
      saveBtn.setText("Saving...");
      void this.plugin.createBookNote(book, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues())
        .then(() => this.close());
    });
    saveAnotherBtn.addEventListener("click", () => {
      saveAnotherBtn.disabled = true;
      saveAnotherBtn.setText("Saving...");
      void this.plugin.createBookNote(book, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues())
        .then(() => this.showScanStep());
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class BookCatalogSettingTab extends PluginSettingTab {
  plugin: BookCatalogPlugin;
  constructor(app: App, plugin: BookCatalogPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── File organization ─────────────────────────────────────────────────
    new Setting(containerEl).setName("File organization").setHeading();
    containerEl.createEl("p", { cls: "bc-hint", text: "Set where the catalog base file and book notes should live. After changing these, use Reorganize files below to move existing files." });

    new Setting(containerEl)
      .setName("Catalog folder")
      .setDesc("Folder where Book Catalog.base is created. Can be nested, e.g. '03 Resources/Books'.")
      .addText((text) => text.setPlaceholder("Books").setValue(this.plugin.settings.baseFolder).onChange(async (value) => {
        this.plugin.settings.baseFolder = value.trim();
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName("Notes subfolder")
      .setDesc("Subfolder inside the catalog folder for book notes. Leave blank to store notes directly in the catalog folder.")
      .addText((text) => text.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async (value) => {
        this.plugin.settings.notesSubfolder = value.trim();
        await this.plugin.saveSettings();
      }));

    const previewEl = containerEl.createDiv({ cls: "bc-path-preview" });
    const updatePreview = () => {
      previewEl.empty();
      previewEl.createEl("p", { cls: "bc-path-line", text: `📄 Base file: ${getBasePath(this.plugin.settings.baseFolder)}` });
      previewEl.createEl("p", { cls: "bc-path-line-last", text: `📚 Book notes: ${getNotesFolder(this.plugin.settings)}/` });
    };
    updatePreview();
    const origSave = this.plugin.saveSettings.bind(this.plugin);
    this.plugin.saveSettings = async () => { await origSave(); updatePreview(); };

    new Setting(containerEl)
      .setName("Create or update base file")
      .setDesc("Creates Book Catalog.base at the path shown above with the correct filters and column layout.")
      .addButton((btn) => btn.setButtonText("Create base file").setCta().onClick(async () => { await this.plugin.createBaseFile(); }));

    containerEl.createEl("hr");

    // ── Reorganize files ──────────────────────────────────────────────────
    new Setting(containerEl).setName("Reorganize files").setHeading();
    containerEl.createEl("p", { cls: "bc-hint", text: "Move existing book notes and the base file to match your current folder settings. Scans your entire vault first so manually-moved files are always found." });

    new Setting(containerEl)
      .setName("Scan & reorganize")
      .setDesc("Scans the entire vault, shows what was found and where, then lets you confirm before moving anything.")
      .addButton((btn) => btn.setButtonText("Scan vault & reorganize").setWarning().onClick(() => { new ReorganizeModal(this.app, this.plugin).open(); }));

    containerEl.createEl("hr");

    // ── Modal preferences ─────────────────────────────────────────────────
    new Setting(containerEl).setName("Modal preferences").setHeading();

    new Setting(containerEl)
      .setName("Default to save & add another")
      .setDesc("When on, 'Save & add another' is the primary (highlighted) button in the confirm step. Turn off to make 'Save book' the primary button instead.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.saveAndAddFirst).onChange(async (value) => {
        this.plugin.settings.saveAndAddFirst = value;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl("hr");

    // ── Custom fields ─────────────────────────────────────────────────────
    new Setting(containerEl).setName("Custom fields").setHeading();
    containerEl.createEl("p", { cls: "bc-hint", text: "Add your own fields to the capture modal. Each field is saved to the note's frontmatter using the field name as the YAML key." });

    const fieldListEl = containerEl.createDiv({ cls: "bc-field-list" });
    const renderFieldList = () => {
      fieldListEl.empty();
      if (this.plugin.settings.customFields.length === 0) {
        fieldListEl.createEl("p", { cls: "bc-field-empty", text: "No custom fields yet." });
        return;
      }
      this.plugin.settings.customFields.forEach((field, index) => {
        const row = fieldListEl.createDiv({ cls: "bc-field-item" });
        const nameEl = row.createDiv({ cls: "bc-field-name-wrap" });
        nameEl.createEl("span", { cls: "bc-field-name", text: field.name });
        nameEl.createEl("span", { cls: "bc-type-badge", text: field.type });
        const deleteBtn = row.createEl("button", { cls: "bc-field-delete", text: "✕" });
        deleteBtn.addEventListener("click", () => {
          this.plugin.settings.customFields.splice(index, 1);
          void this.plugin.saveSettings().then(() => renderFieldList());
        });
      });
    };
    renderFieldList();

    const addRow = containerEl.createDiv({ cls: "bc-add-row" });
    const nameInput = addRow.createEl("input", { type: "text", placeholder: "Field name" });
    nameInput.addClass("bc-add-name-input");
    const typeSelect = addRow.createEl("select");
    typeSelect.addClass("bc-add-type-select");
    (["text", "number", "date", "boolean"] as const).forEach((t) => {
      const opt = typeSelect.createEl("option", { text: t });
      opt.value = t;
    });
    const addBtn = addRow.createEl("button", { cls: "bc-add-btn", text: "Add field" });
    addBtn.addEventListener("click", () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const key = toYamlKey(name);
      if (this.plugin.settings.customFields.some((f) => toYamlKey(f.name) === key)) {
        new Notice("A field with that name already exists.");
        return;
      }
      this.plugin.settings.customFields.push({ id: `cf-${Date.now()}`, name, type: typeSelect.value as CustomField["type"] });
      nameInput.value = "";
      void this.plugin.saveSettings().then(() => renderFieldList());
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

    containerEl.createEl("hr");

    // ── API ───────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("API").setHeading();

    new Setting(containerEl)
      .setName("Google Books API key")
      .setDesc("Optional. Used as a fallback if Open Library returns no results. Get a free key at console.cloud.google.com.")
      .addText((text) => text.setPlaceholder("AIza...").setValue(this.plugin.settings.googleBooksApiKey).onChange(async (value) => {
        this.plugin.settings.googleBooksApiKey = value;
        await this.plugin.saveSettings();
      }));
  }
}
