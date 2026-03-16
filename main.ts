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
        this.app.workspace.getLeaf(false).openFile(baseFile);
      } else {
        new Notice("Book Catalog.base not found. Create it in Settings → Book Catalog.");
      }
    });

    this.addRibbonIcon("book-plus", "Add Book", () => new ISBNModal(this.app, this).open());

    this.addCommand({ id: "add-book-by-isbn", name: "Add book by ISBN", callback: () => new ISBNModal(this.app, this).open() });
    this.addCommand({ id: "open-book-catalog", name: "Open Book Catalog", callback: () => {
      const baseFile = this.findExistingBaseFile();
      if (baseFile) this.app.workspace.getLeaf(false).openFile(baseFile);
      else new Notice("Book Catalog.base not found. Create it in Settings → Book Catalog.");
    }});

    this.addSettingTab(new BookCatalogSettingTab(this.app, this));
  }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); if (!this.settings.customFields) this.settings.customFields = []; }
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
    if (existing instanceof TFile) { await this.app.vault.modify(existing, content); new Notice("✅ Book Catalog.base updated."); }
    else { await this.app.vault.create(basePath, content); new Notice("✅ Book Catalog.base created."); }
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
    const data = response.json;
    const key = `ISBN:${isbn}`;
    if (!data[key]) return null;
    const book = data[key];
    return {
      isbn,
      title: toTitleCase(book.title || "Unknown Title"),
      authors: toTitleCaseNames((book.authors || []).map((a: any) => a.name)),
      editors: toTitleCaseNames((book.contributions || []).filter((c: any) => c.role?.toLowerCase().includes("editor")).map((c: any) => c.name)),
      publisher: book.publishers?.[0]?.name || "",
      publishedYear: book.publish_date ? book.publish_date.split(" ").pop() : "",
      coverUrl: book.cover?.large || book.cover?.medium || "",
      pages: book.number_of_pages?.toString() || "",
      subjects: (book.subjects || []).slice(0, 8).map((s: any) => s.name || s),
    };
  }

  async fetchGoogleBooksByISBN(isbn: string): Promise<BookData | null> {
    let url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
    if (this.settings.googleBooksApiKey) url += `&key=${this.settings.googleBooksApiKey}`;
    const response = await requestUrl({ url });
    const data = response.json;
    if (!data.items?.length) return null;
    const info = data.items[0].volumeInfo;
    return {
      isbn,
      title: toTitleCase(info.title || "Unknown Title"),
      authors: toTitleCaseNames(info.authors || []),
      editors: [],
      publisher: info.publisher || "",
      publishedYear: info.publishedDate ? info.publishedDate.substring(0, 4) : "",
      coverUrl: info.imageLinks?.extraLarge || info.imageLinks?.large || info.imageLinks?.thumbnail || "",
      pages: info.pageCount?.toString() || "",
      subjects: (info.categories || []).slice(0, 8),
    };
  }

  // ─── Manual Title/Author Search ───────────────────────────────────────────

  async searchBooks(title: string, author: string): Promise<BookData[]> {
    const results: BookData[] = [];
    const seen = new Set<string>();
    const dedupeKey = (b: BookData) => `${b.title.toLowerCase().trim()}|${(b.authors[0] || "").toLowerCase().trim()}`;
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
    const data = response.json;
    return (data.docs || []).map((doc: any): BookData => ({
      isbn: doc.isbn?.[0] || "",
      title: toTitleCase(doc.title || "Unknown Title"),
      authors: toTitleCaseNames(doc.author_name || []),
      editors: [],
      publisher: doc.publisher?.[0] || "",
      publishedYear: doc.first_publish_year?.toString() || "",
      coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "",
      pages: "",
      subjects: (doc.subject || []).slice(0, 8),
    }));
  }

  async searchGoogleBooks(title: string, author: string): Promise<BookData[]> {
    let q = `intitle:${encodeURIComponent(title)}`;
    if (author) q += `+inauthor:${encodeURIComponent(author)}`;
    let url = `https://www.googleapis.com/books/v1/volumes?q=${q}&maxResults=8`;
    if (this.settings.googleBooksApiKey) url += `&key=${this.settings.googleBooksApiKey}`;
    const response = await requestUrl({ url });
    const data = response.json;
    return (data.items || []).map((item: any): BookData => {
      const info = item.volumeInfo;
      const isbn = info.industryIdentifiers?.find((id: any) => id.type === "ISBN_13")?.identifier
        || info.industryIdentifiers?.find((id: any) => id.type === "ISBN_10")?.identifier || "";
      return {
        isbn, title: toTitleCase(info.title || "Unknown Title"),
        authors: toTitleCaseNames(info.authors || []), editors: [],
        publisher: info.publisher || "",
        publishedYear: info.publishedDate ? info.publishedDate.substring(0, 4) : "",
        coverUrl: info.imageLinks?.thumbnail || info.imageLinks?.smallThumbnail || "",
        pages: info.pageCount?.toString() || "",
        subjects: (info.categories || []).slice(0, 8),
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

  openNote(file: TFile): void { this.app.workspace.getLeaf(false).openFile(file); }

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
    contentEl.createEl("h2", { text: "Reorganize Catalog Files" });
    contentEl.createEl("p", { text: "Scan your vault to find all book notes regardless of where they currently live." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin-bottom:1.25rem;";
    const targetEl = contentEl.createDiv();
    targetEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; margin-bottom:1.25rem; font-size:0.85rem;";
    targetEl.createEl("p", { text: "Target location (from your settings):" }).style.cssText = "font-weight:600; margin:0 0 0.4rem;";
    targetEl.createEl("p", { text: `📄 ${getBasePath(this.plugin.settings.baseFolder)}` }).style.cssText = "margin:0 0 0.2rem; color:var(--text-muted);";
    targetEl.createEl("p", { text: `📚 ${getNotesFolder(this.plugin.settings)}/` }).style.cssText = "margin:0; color:var(--text-muted);";
    const resultsEl = contentEl.createDiv(); resultsEl.style.cssText = "min-height:2rem; margin-bottom:1rem;";
    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem;";
    const cancelBtn = btnRow.createEl("button", { text: "Cancel" }); cancelBtn.style.cssText = "flex:1; padding:0.5rem;";
    const scanBtn = btnRow.createEl("button", { text: "🔍  Scan Vault" }); scanBtn.style.cssText = "flex:1; padding:0.5rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    cancelBtn.addEventListener("click", () => this.close());
    scanBtn.addEventListener("click", () => {
      scanBtn.disabled = true; scanBtn.setText("Scanning..."); resultsEl.empty();
      const bookNotes = this.plugin.scanVaultForBookNotes();
      const newNotesFolder = getNotesFolder(this.plugin.settings);
      const notesToMove = bookNotes.filter((f) => f.path !== `${newNotesFolder}/${f.name}`);
      const existingBase = this.plugin.findExistingBaseFile();
      const newBasePath = getBasePath(this.plugin.settings.baseFolder);
      const baseNeedsMove = !!(existingBase && existingBase.path !== newBasePath);
      const resultBox = resultsEl.createDiv(); resultBox.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; font-size:0.85rem;";
      resultBox.createEl("p", { text: `✅ Scan complete — found ${bookNotes.length} book note${bookNotes.length !== 1 ? "s" : ""} in your vault.` }).style.cssText = "font-weight:600; margin:0 0 0.5rem;";
      if (bookNotes.length === 0) { resultBox.createEl("p", { text: 'No book notes found. Make sure your notes have tags: ["book"] in their frontmatter.' }).style.cssText = "color:var(--text-muted); margin:0;"; scanBtn.disabled = false; scanBtn.setText("🔍  Scan Vault"); return; }
      const byFolder = new Map<string, TFile[]>();
      for (const f of bookNotes) { const folder = f.parent?.path ?? "(root)"; if (!byFolder.has(folder)) byFolder.set(folder, []); byFolder.get(folder)!.push(f); }
      byFolder.forEach((files, folder) => {
        const alreadyInPlace = folder === newNotesFolder;
        const folderEl = resultBox.createDiv(); folderEl.style.cssText = "margin-bottom:0.3rem;";
        folderEl.createEl("span", { text: `📁 ${folder}/ — ${files.length} note${files.length !== 1 ? "s" : ""}` }).style.cssText = alreadyInPlace ? "color:var(--color-green); font-weight:500;" : "color:var(--text-muted);";
        if (alreadyInPlace) folderEl.createEl("span", { text: " ✓ already in target" }).style.cssText = "color:var(--color-green); font-size:0.8rem;";
      });
      if (existingBase) resultBox.createEl("p", { text: `📄 Book Catalog.base: ${existingBase.path}` }).style.cssText = "margin:0.5rem 0 0; color:var(--text-muted);";
      if (notesToMove.length === 0 && !baseNeedsMove) { resultBox.createEl("p", { text: "✅ Everything is already in the correct location." }).style.cssText = "margin:0.75rem 0 0; font-weight:600; color:var(--color-green);"; scanBtn.disabled = false; scanBtn.setText("🔍  Scan Again"); return; }
      const proceedRow = resultsEl.createDiv(); proceedRow.style.cssText = "display:flex; justify-content:flex-end; margin-top:0.75rem;";
      const proceedBtn = proceedRow.createEl("button", { text: `Review ${notesToMove.length} move${notesToMove.length !== 1 ? "s" : ""} →` });
      proceedBtn.style.cssText = "padding:0.4rem 1rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
      proceedBtn.addEventListener("click", () => this.showConfirmStep(bookNotes, notesToMove, existingBase, baseNeedsMove));
      scanBtn.disabled = false; scanBtn.setText("🔍  Scan Again");
    });
  }

  showConfirmStep(allNotes: TFile[], notesToMove: TFile[], existingBase: TFile | null, baseNeedsMove: boolean) {
    const { contentEl } = this; contentEl.empty();
    const s = this.plugin.settings; const newNotesFolder = getNotesFolder(s); const newBasePath = getBasePath(s.baseFolder);
    contentEl.createEl("h2", { text: "Confirm Reorganization" });
    contentEl.createEl("p", { text: "Review the changes below before confirming." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin-bottom:1rem;";
    const treeStyle = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; font-family:monospace; font-size:0.82rem; margin-bottom:0.75rem; line-height:1.8;";
    if (notesToMove.length > 0) {
      contentEl.createEl("p", { text: "Book notes to move:" }).style.cssText = "font-weight:600; margin-bottom:0.25rem;";
      const notesBox = contentEl.createDiv(); notesBox.style.cssText = treeStyle;
      const byFolder = new Map<string, TFile[]>();
      for (const f of notesToMove) { const folder = f.parent?.path ?? "(root)"; if (!byFolder.has(folder)) byFolder.set(folder, []); byFolder.get(folder)!.push(f); }
      byFolder.forEach((files, folder) => {
        notesBox.createEl("div", { text: `📁 ${folder}/` });
        const indent = notesBox.createDiv(); indent.style.cssText = "padding-left:1.2rem;";
        files.slice(0, 4).forEach((f) => indent.createEl("div", { text: `📝 ${f.name}` }).style.cssText = "color:var(--text-muted);");
        if (files.length > 4) indent.createEl("div", { text: `… and ${files.length - 4} more` }).style.cssText = "color:var(--text-muted);";
        notesBox.createEl("div", { text: `↳ → ${newNotesFolder}/` }).style.cssText = "padding-left:1.2rem; color:var(--color-green);";
      });
    }
    if (baseNeedsMove && existingBase) {
      contentEl.createEl("p", { text: "Base file to move:" }).style.cssText = "font-weight:600; margin-bottom:0.25rem;";
      const baseBox = contentEl.createDiv(); baseBox.style.cssText = treeStyle;
      baseBox.createEl("div", { text: `📄 ${existingBase.path}` }).style.cssText = "color:var(--text-muted);";
      baseBox.createEl("div", { text: `↳ → ${newBasePath}` }).style.cssText = "color:var(--color-green);";
    }
    const summaryEl = contentEl.createDiv(); summaryEl.style.cssText = "background:var(--background-modifier-border); border-radius:6px; padding:0.6rem 0.9rem; margin-bottom:1.25rem; font-size:0.85rem;";
    summaryEl.createEl("p", { text: `📚 ${notesToMove.length} note${notesToMove.length !== 1 ? "s" : ""} → ${newNotesFolder}/` }).style.cssText = "margin:0 0 0.2rem;";
    if (baseNeedsMove) summaryEl.createEl("p", { text: `📄 Base → ${newBasePath}` }).style.cssText = "margin:0 0 0.2rem;";
    summaryEl.createEl("p", { text: "📄 Book Catalog.base will be regenerated with updated paths." }).style.cssText = "margin:0;";
    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem; justify-content:flex-end;";
    const backBtn = btnRow.createEl("button", { text: "← Back" }); backBtn.style.cssText = "padding:0.4rem 1rem;";
    const confirmBtn = btnRow.createEl("button", { text: "Confirm & Move Files" }); confirmBtn.style.cssText = "background:var(--interactive-accent); color:var(--text-on-accent); padding:0.4rem 1rem; border-radius:4px;";
    backBtn.addEventListener("click", () => this.showScanStep());
    confirmBtn.addEventListener("click", async () => { confirmBtn.disabled = true; confirmBtn.setText("Moving files..."); await this.plugin.reorganizeFiles(allNotes); this.close(); });
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

    contentEl.createEl("h2", { text: "Add Book" });

    const tabBar = contentEl.createDiv();
    tabBar.style.cssText = "display:flex; gap:0.5rem; margin-bottom:1.25rem;";
    const barcodeBtn = tabBar.createEl("button", { text: "📷  Scan / ISBN" });
    const searchBtn  = tabBar.createEl("button", { text: "🔍  Search by Title" });
    const activeStyle   = "flex:1; padding:0.4rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px; font-weight:500; cursor:pointer;";
    const inactiveStyle = "flex:1; padding:0.4rem; background:var(--background-secondary); border-radius:4px; cursor:pointer;";
    const tabContent = contentEl.createDiv();

    const renderBarcodeTab = () => {
      barcodeBtn.style.cssText = activeStyle; searchBtn.style.cssText = inactiveStyle;
      tabContent.empty();
      tabContent.createEl("p", { text: "Scan the barcode with a USB scanner, or type the ISBN manually." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin:0 0 0.75rem;";
      const inputEl = tabContent.createEl("input", { type: "text", placeholder: "ISBN / barcode..." });
      inputEl.style.cssText = "width:100%; margin-bottom:0.75rem; font-size:1.1rem; padding:0.5rem;";
      setTimeout(() => inputEl.focus(), 50);
      const statusEl = tabContent.createEl("p", { text: "" });
      statusEl.style.cssText = "color:var(--text-muted); min-height:1.5rem; margin:0 0 0.75rem;";
      const lookupBtn = tabContent.createEl("button", { text: "Look Up Book" });
      lookupBtn.style.cssText = "width:100%; padding:0.5rem;";
      const doLookup = async (isbn: string) => {
        if (!isbn) { statusEl.setText("Please enter an ISBN."); return; }
        lookupBtn.disabled = true; inputEl.disabled = true; statusEl.setText("Looking up book...");
        const book = await this.plugin.lookupISBN(isbn);
        if (!book) {
          statusEl.setText("❌ No book found. Check the number and try again.");
          lookupBtn.disabled = false; inputEl.disabled = false; inputEl.focus(); return;
        }
        const existing = this.plugin.findExistingNote(book);
        if (existing) { this.showDuplicateStep(book, existing); return; }
        this.showConfirmStep(book);
      };
      inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doLookup(inputEl.value.trim()); });
      lookupBtn.addEventListener("click", () => doLookup(inputEl.value.trim()));
    };

    const renderSearchTab = () => {
      barcodeBtn.style.cssText = inactiveStyle; searchBtn.style.cssText = activeStyle;
      tabContent.empty();
      tabContent.createEl("p", { text: "Search by title and optionally author. Title is required." }).style.cssText = "color:var(--text-muted); font-size:0.9rem; margin:0 0 0.75rem;";
      const rowStyle   = "display:flex; align-items:center; gap:0.75rem; margin-bottom:0.6rem;";
      const labelStyle = "min-width:60px; font-weight:500; font-size:0.9rem;";
      const titleWrap = tabContent.createDiv(); titleWrap.style.cssText = rowStyle;
      titleWrap.createEl("label", { text: "Title *" }).style.cssText = labelStyle;
      const titleEl = titleWrap.createEl("input", { type: "text", placeholder: "Required" });
      titleEl.style.cssText = "flex:1; padding:0.35rem;";
      setTimeout(() => titleEl.focus(), 50);
      const authorWrap = tabContent.createDiv(); authorWrap.style.cssText = rowStyle + " margin-bottom:0.9rem;";
      authorWrap.createEl("label", { text: "Author" }).style.cssText = labelStyle;
      const authorEl = authorWrap.createEl("input", { type: "text", placeholder: "Optional" });
      authorEl.style.cssText = "flex:1; padding:0.35rem;";
      const statusEl = tabContent.createEl("p", { text: "" });
      statusEl.style.cssText = "color:var(--text-muted); min-height:1.2rem; margin:0 0 0.5rem; font-size:0.85rem;";
      const searchActionBtn = tabContent.createEl("button", { text: "Search Books" });
      searchActionBtn.style.cssText = "width:100%; padding:0.5rem; margin-bottom:0.75rem;";
      const resultsEl = tabContent.createDiv();
      const renderResults = (books: BookData[]) => {
        resultsEl.empty();
        if (books.length === 0) { resultsEl.createEl("p", { text: "No results found. Try different search terms." }).style.cssText = "color:var(--text-muted); font-size:0.9rem;"; return; }
        resultsEl.createEl("p", { text: `${books.length} result${books.length !== 1 ? "s" : ""} — click to select` }).style.cssText = "font-size:0.8rem; color:var(--text-muted); margin-bottom:0.5rem;";
        books.forEach((book) => {
          const card = resultsEl.createDiv();
          card.style.cssText = "display:flex; gap:0.65rem; padding:0.6rem; border-radius:6px; border:1px solid var(--background-modifier-border); margin-bottom:0.4rem; cursor:pointer; align-items:flex-start;";
          if (book.coverUrl) { const img = card.createEl("img"); img.src = book.coverUrl; img.alt = "cover"; img.style.cssText = "width:40px; height:auto; border-radius:3px; flex-shrink:0;"; }
          else { const ph = card.createDiv(); ph.style.cssText = "width:40px; height:54px; background:var(--background-secondary); border-radius:3px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:1.2rem;"; ph.createEl("span", { text: "📖" }); }
          const info = card.createDiv(); info.style.cssText = "flex:1; min-width:0;";
          info.createEl("div", { text: book.title }).style.cssText = "font-weight:600; font-size:0.9rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
          if (book.authors.length > 0) info.createEl("div", { text: book.authors.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.82rem;";
          const meta = [book.publisher, book.publishedYear].filter(Boolean).join(", ");
          if (meta) info.createEl("div", { text: meta }).style.cssText = "color:var(--text-muted); font-size:0.82rem;";
          card.addEventListener("mouseenter", () => { card.style.background = "var(--background-secondary)"; });
          card.addEventListener("mouseleave", () => { card.style.background = ""; });
          card.addEventListener("click", () => {
            const existing = this.plugin.findExistingNote(book);
            if (existing) { this.showDuplicateStep(book, existing); return; }
            this.showConfirmStep(book);
          });
        });
      };
      const doSearch = async () => {
        const title = titleEl.value.trim();
        if (!title) { statusEl.setText("Please enter a title."); statusEl.style.color = "var(--color-red)"; titleEl.focus(); return; }
        statusEl.style.color = "var(--text-muted)"; searchActionBtn.disabled = true; searchActionBtn.setText("Searching..."); statusEl.setText("Searching…"); resultsEl.empty();
        const books = await this.plugin.searchBooks(title, authorEl.value.trim());
        statusEl.setText(""); searchActionBtn.disabled = false; searchActionBtn.setText("Search Books");
        renderResults(books);
      };
      const onEnter = (e: KeyboardEvent) => { if (e.key === "Enter") doSearch(); };
      titleEl.addEventListener("keydown", onEnter); authorEl.addEventListener("keydown", onEnter);
      searchActionBtn.addEventListener("click", doSearch);
    };

    barcodeBtn.addEventListener("click", renderBarcodeTab);
    searchBtn.addEventListener("click", renderSearchTab);
    renderBarcodeTab();
  }

  showDuplicateStep(book: BookData, existing: TFile) {
    const { contentEl } = this; contentEl.empty();
    const headerEl = contentEl.createDiv(); headerEl.style.cssText = "display:flex; align-items:center; gap:0.5rem; margin-bottom:1rem;";
    headerEl.createEl("span", { text: "📚" }).style.fontSize = "1.5rem";
    headerEl.createEl("h2", { text: "Already in your catalog" }).style.margin = "0";
    const previewEl = contentEl.createDiv(); previewEl.style.cssText = "display:flex; gap:1rem; margin-bottom:1.25rem; align-items:flex-start;";
    if (book.coverUrl) { const imgEl = previewEl.createEl("img"); imgEl.src = book.coverUrl; imgEl.alt = "cover"; imgEl.style.cssText = "width:80px; height:auto; border-radius:4px; flex-shrink:0;"; }
    const metaEl = previewEl.createDiv(); metaEl.style.cssText = "display:flex; flex-direction:column; gap:0.2rem;";
    metaEl.createEl("strong", { text: book.title });
    if (book.authors.length > 0) metaEl.createEl("span", { text: book.authors.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (book.publisher || book.publishedYear) metaEl.createEl("span", { text: [book.publisher, book.publishedYear].filter(Boolean).join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    const cache = this.plugin.app.metadataCache.getFileCache(existing);
    const currentCopies: number = cache?.frontmatter?.copies ?? 1;
    const copiesInfoEl = contentEl.createDiv();
    copiesInfoEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.65rem 0.9rem; margin-bottom:1.25rem; font-size:0.9rem;";
    copiesInfoEl.createEl("span", { text: "Currently in catalog: " });
    copiesInfoEl.createEl("strong", { text: `${currentCopies} cop${currentCopies === 1 ? "y" : "ies"}` });
    contentEl.createEl("hr").style.marginBottom = "1rem";
    const copiesWrap = contentEl.createDiv(); copiesWrap.style.cssText = "display:flex; align-items:center; gap:0.75rem; margin-bottom:1.25rem;";
    copiesWrap.createEl("label", { text: "Update copies to" }).style.cssText = "min-width:110px; font-weight:500; font-size:0.9rem;";
    const copiesEl = copiesWrap.createEl("input", { type: "number" }); copiesEl.value = String(currentCopies + 1); copiesEl.min = "1"; copiesEl.step = "1"; copiesEl.style.cssText = "flex:1; padding:0.35rem;";
    const btnCol = contentEl.createDiv(); btnCol.style.cssText = "display:flex; flex-direction:column; gap:0.6rem;";
    const updateBtn = btnCol.createEl("button", { text: "✅  Update Copies" }); updateBtn.style.cssText = "width:100%; padding:0.5rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    const openBtn  = btnCol.createEl("button", { text: "📖  Open Existing Note" }); openBtn.style.cssText = "width:100%; padding:0.5rem;";
    const scanBtn  = btnCol.createEl("button", { text: "↩  Search Again" }); scanBtn.style.cssText = "width:100%; padding:0.5rem;";
    updateBtn.addEventListener("click", async () => { const newCount = parseInt(copiesEl.value) || currentCopies + 1; updateBtn.disabled = true; updateBtn.setText("Saving..."); await this.plugin.updateCopies(existing, newCount); this.close(); });
    openBtn.addEventListener("click", () => { this.plugin.openNote(existing); this.close(); });
    scanBtn.addEventListener("click", () => this.showScanStep());
  }

  showConfirmStep(book: BookData) {
    const { contentEl } = this; contentEl.empty();

    const previewEl = contentEl.createDiv(); previewEl.style.cssText = "display:flex; gap:1rem; margin-bottom:1.25rem; align-items:flex-start;";
    if (book.coverUrl) { const imgEl = previewEl.createEl("img"); imgEl.src = book.coverUrl; imgEl.alt = "cover"; imgEl.style.cssText = "width:80px; height:auto; border-radius:4px; flex-shrink:0;"; }
    const metaEl = previewEl.createDiv(); metaEl.style.cssText = "display:flex; flex-direction:column; gap:0.2rem;";
    metaEl.createEl("strong", { text: book.title });
    if (book.authors.length > 0) metaEl.createEl("span", { text: book.authors.join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (book.publisher || book.publishedYear) metaEl.createEl("span", { text: [book.publisher, book.publishedYear].filter(Boolean).join(", ") }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";
    if (book.pages) metaEl.createEl("span", { text: `${book.pages} pages` }).style.cssText = "color:var(--text-muted); font-size:0.9rem;";

    contentEl.createEl("hr").style.marginBottom = "1rem";

    const rowStyle   = "display:flex; align-items:center; gap:0.75rem; margin-bottom:0.75rem;";
    const labelStyle = "min-width:80px; font-weight:500;";

    // ── Standard fields ───────────────────────────────────────────────────
    const conditionWrap = contentEl.createDiv(); conditionWrap.style.cssText = rowStyle;
    conditionWrap.createEl("label", { text: "Condition" }).style.cssText = labelStyle;
    const conditionEl = conditionWrap.createEl("select"); conditionEl.style.cssText = "flex:1; padding:0.35rem;";
    ["", "New", "Fine", "Very Good", "Good", "Fair", "Poor"].forEach((c) => { const opt = conditionEl.createEl("option", { text: c || "— select —" }); opt.value = c; });

    const acquiredWrap = contentEl.createDiv(); acquiredWrap.style.cssText = rowStyle;
    acquiredWrap.createEl("label", { text: "Acquired" }).style.cssText = labelStyle;
    const acquiredEl = acquiredWrap.createEl("input", { type: "date" }); acquiredEl.style.cssText = "flex:1; padding:0.35rem;"; acquiredEl.value = new Date().toISOString().split("T")[0];

    const copiesWrap = contentEl.createDiv(); copiesWrap.style.cssText = rowStyle;
    copiesWrap.createEl("label", { text: "Copies" }).style.cssText = labelStyle;
    const copiesEl = copiesWrap.createEl("input", { type: "number" }); copiesEl.value = "1"; copiesEl.min = "1"; copiesEl.step = "1"; copiesEl.style.cssText = "flex:1; padding:0.35rem;";

    const valuationWrap = contentEl.createDiv(); valuationWrap.style.cssText = rowStyle;
    valuationWrap.createEl("label", { text: "Value (USD)" }).style.cssText = labelStyle;
    const valuationPrefix = valuationWrap.createDiv(); valuationPrefix.style.cssText = "display:flex; align-items:center; flex:1; border:1px solid var(--background-modifier-border); border-radius:4px; overflow:hidden;";
    valuationPrefix.createEl("span", { text: "$" }).style.cssText = "padding:0.35rem 0.5rem; background:var(--background-secondary); color:var(--text-muted); font-weight:500; border-right:1px solid var(--background-modifier-border);";
    const valuationEl = valuationPrefix.createEl("input", { type: "number" }); valuationEl.placeholder = "0.00"; valuationEl.min = "0"; valuationEl.step = "0.01"; valuationEl.style.cssText = "flex:1; padding:0.35rem 0.5rem; border:none; background:transparent; outline:none;";

    // ── Custom fields ─────────────────────────────────────────────────────
    const customGetters: Record<string, () => string> = {};
    if (this.plugin.settings.customFields.length > 0) {
      contentEl.createEl("hr").style.cssText = "margin:0.75rem 0;";
      this.plugin.settings.customFields.forEach((field) => {
        const wrap = contentEl.createDiv(); wrap.style.cssText = rowStyle;
        wrap.createEl("label", { text: field.name }).style.cssText = labelStyle + " font-size:0.9rem;";
        if (field.type === "boolean") {
          // Toggle switch
          const toggleOuter = wrap.createDiv(); toggleOuter.style.cssText = "position:relative; width:40px; height:22px; flex-shrink:0;";
          const toggleInput = toggleOuter.createEl("input", { type: "checkbox" }); toggleInput.style.cssText = "opacity:0; width:0; height:0; position:absolute;";
          const slider = toggleOuter.createDiv(); slider.style.cssText = "position:absolute; cursor:pointer; top:0; left:0; right:0; bottom:0; background:var(--background-modifier-border); border-radius:22px; transition:background 0.2s;";
          const knob = slider.createDiv(); knob.style.cssText = "position:absolute; height:16px; width:16px; left:3px; bottom:3px; background:white; border-radius:50%; transition:transform 0.2s;";
          const sync = () => { slider.style.background = toggleInput.checked ? "var(--interactive-accent)" : "var(--background-modifier-border)"; knob.style.transform = toggleInput.checked ? "translateX(18px)" : "translateX(0)"; };
          toggleInput.addEventListener("change", sync);
          slider.addEventListener("click", () => { toggleInput.checked = !toggleInput.checked; sync(); });
          customGetters[field.id] = () => toggleInput.checked ? "true" : "false";
        } else if (field.type === "date") {
          const el = wrap.createEl("input", { type: "date" }); el.style.cssText = "flex:1; padding:0.35rem;";
          customGetters[field.id] = () => el.value;
        } else if (field.type === "number") {
          const el = wrap.createEl("input", { type: "number" }); el.style.cssText = "flex:1; padding:0.35rem;"; el.step = "any";
          customGetters[field.id] = () => el.value;
        } else {
          const el = wrap.createEl("input", { type: "text" }); el.style.cssText = "flex:1; padding:0.35rem;";
          customGetters[field.id] = () => el.value;
        }
      });
    }

    // ── Buttons ───────────────────────────────────────────────────────────
    const saveFirst = this.plugin.settings.saveAndAddFirst;
    const accentStyle  = "background:var(--interactive-accent); color:var(--text-on-accent); padding:0.4rem 1rem; border-radius:4px;";
    const normalStyle  = "padding:0.4rem 1rem;";

    const btnRow = contentEl.createDiv(); btnRow.style.cssText = "display:flex; gap:0.75rem; justify-content:flex-end; margin-top:1.25rem;";
    const backBtn        = btnRow.createEl("button", { text: "← Back" }); backBtn.style.cssText = normalStyle;
    const saveAnotherBtn = btnRow.createEl("button", { text: "Save & Add Another" }); saveAnotherBtn.style.cssText = saveFirst ? accentStyle : normalStyle;
    const saveBtn        = btnRow.createEl("button", { text: "Save Book" }); saveBtn.style.cssText = saveFirst ? normalStyle : accentStyle;

    const collectCustomValues = (): Record<string, string> => {
      const vals: Record<string, string> = {};
      for (const id in customGetters) vals[id] = customGetters[id]();
      return vals;
    };

    backBtn.addEventListener("click", () => this.showScanStep());
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; saveBtn.setText("Saving...");
      await this.plugin.createBookNote(book, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues());
      this.close();
    });
    saveAnotherBtn.addEventListener("click", async () => {
      saveAnotherBtn.disabled = true; saveAnotherBtn.setText("Saving...");
      await this.plugin.createBookNote(book, conditionEl.value, acquiredEl.value, valuationEl.value, copiesEl.value, collectCustomValues());
      this.showScanStep();
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

class BookCatalogSettingTab extends PluginSettingTab {
  plugin: BookCatalogPlugin;
  constructor(app: App, plugin: BookCatalogPlugin) { super(app, plugin); this.plugin = plugin; }

  display(): void {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl("h2", { text: "Book Catalog Settings" });

    // ── File Organization ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "File Organization" });
    containerEl.createEl("p", { text: "Set where the catalog base file and book notes should live. After changing these, use Reorganize Files below to move existing files." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";
    new Setting(containerEl).setName("Catalog folder").setDesc("Folder where Book Catalog.base is created. Can be nested, e.g. '03 Resources/Books'.").addText((text) => text.setPlaceholder("Books").setValue(this.plugin.settings.baseFolder).onChange(async (value) => { this.plugin.settings.baseFolder = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Notes subfolder").setDesc("Subfolder inside the catalog folder for book notes. Leave blank to store notes directly in the catalog folder.").addText((text) => text.setPlaceholder("Notes").setValue(this.plugin.settings.notesSubfolder).onChange(async (value) => { this.plugin.settings.notesSubfolder = value.trim(); await this.plugin.saveSettings(); }));
    const previewEl = containerEl.createDiv(); previewEl.style.cssText = "background:var(--background-secondary); border-radius:6px; padding:0.75rem 1rem; margin-bottom:1rem; font-size:0.85rem;";
    const updatePreview = () => { previewEl.empty(); previewEl.createEl("p", { text: `📄 Base file: ${getBasePath(this.plugin.settings.baseFolder)}` }).style.cssText = "margin:0 0 0.25rem; color:var(--text-muted);"; previewEl.createEl("p", { text: `📚 Book notes: ${getNotesFolder(this.plugin.settings)}/` }).style.cssText = "margin:0; color:var(--text-muted);"; };
    updatePreview();
    const origSave = this.plugin.saveSettings.bind(this.plugin);
    this.plugin.saveSettings = async () => { await origSave(); updatePreview(); };
    new Setting(containerEl).setName("Create or update base file").setDesc("Creates Book Catalog.base at the path shown above with the correct filters and column layout.").addButton((btn) => btn.setButtonText("Create Base File").setCta().onClick(async () => { await this.plugin.createBaseFile(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Reorganize ────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Reorganize Files" });
    containerEl.createEl("p", { text: "Move existing book notes and the base file to match your current folder settings. Scans your entire vault first so manually-moved files are always found." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";
    new Setting(containerEl).setName("Scan & reorganize").setDesc("Scans the entire vault, shows what was found and where, then lets you confirm before moving anything.").addButton((btn) => btn.setButtonText("Scan Vault & Reorganize").setWarning().onClick(() => { new ReorganizeModal(this.app, this.plugin).open(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Modal Preferences ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Modal Preferences" });
    new Setting(containerEl)
      .setName("Default to Save & Add Another")
      .setDesc("When on, 'Save & Add Another' is the primary (highlighted) button in the confirm step. Turn off to make 'Save Book' the primary button instead.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.saveAndAddFirst).onChange(async (value) => { this.plugin.settings.saveAndAddFirst = value; await this.plugin.saveSettings(); }));

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── Custom Fields ─────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Custom Fields" });
    containerEl.createEl("p", { text: "Add your own fields to the capture modal. Each field is saved to the note's frontmatter using the field name as the YAML key." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; margin-bottom:0.75rem;";

    const fieldListEl = containerEl.createDiv(); fieldListEl.style.cssText = "margin-bottom:1rem;";
    const renderFieldList = () => {
      fieldListEl.empty();
      if (this.plugin.settings.customFields.length === 0) {
        fieldListEl.createEl("p", { text: "No custom fields yet." }).style.cssText = "color:var(--text-muted); font-size:0.85rem; font-style:italic;";
        return;
      }
      const typeBadgeStyle = "font-size:0.75rem; padding:0.1rem 0.4rem; border-radius:3px; background:var(--background-modifier-border); color:var(--text-muted); margin-left:0.5rem;";
      this.plugin.settings.customFields.forEach((field, index) => {
        const row = fieldListEl.createDiv(); row.style.cssText = "display:flex; align-items:center; justify-content:space-between; padding:0.4rem 0.6rem; border-radius:4px; margin-bottom:0.3rem; background:var(--background-secondary);";
        const nameEl = row.createDiv(); nameEl.style.cssText = "display:flex; align-items:center;";
        nameEl.createEl("span", { text: field.name }).style.cssText = "font-size:0.9rem;";
        nameEl.createEl("span", { text: field.type }).style.cssText = typeBadgeStyle;
        const deleteBtn = row.createEl("button", { text: "✕" }); deleteBtn.style.cssText = "padding:0.1rem 0.5rem; font-size:0.8rem; color:var(--text-muted);";
        deleteBtn.addEventListener("click", async () => {
          this.plugin.settings.customFields.splice(index, 1);
          await this.plugin.saveSettings();
          renderFieldList();
        });
      });
    };
    renderFieldList();

    // Add field form
    const addRow = containerEl.createDiv(); addRow.style.cssText = "display:flex; gap:0.5rem; align-items:center;";
    const nameInput = addRow.createEl("input", { type: "text", placeholder: "Field name" }); nameInput.style.cssText = "flex:1; padding:0.35rem;";
    const typeSelect = addRow.createEl("select"); typeSelect.style.cssText = "padding:0.35rem;";
    (["text", "number", "date", "boolean"] as const).forEach((t) => { const opt = typeSelect.createEl("option", { text: t }); opt.value = t; });
    const addBtn = addRow.createEl("button", { text: "Add Field" }); addBtn.style.cssText = "padding:0.35rem 0.75rem; background:var(--interactive-accent); color:var(--text-on-accent); border-radius:4px;";
    addBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const key = toYamlKey(name);
      if (this.plugin.settings.customFields.some((f) => toYamlKey(f.name) === key)) { new Notice("A field with that name already exists."); return; }
      this.plugin.settings.customFields.push({ id: `cf-${Date.now()}`, name, type: typeSelect.value as CustomField["type"] });
      await this.plugin.saveSettings();
      nameInput.value = "";
      renderFieldList();
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addBtn.click(); });

    containerEl.createEl("hr").style.margin = "1.5rem 0";

    // ── API ───────────────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "API" });
    new Setting(containerEl).setName("Google Books API key").setDesc("Optional. Used as a fallback if Open Library returns no results. Get a free key at console.cloud.google.com.").addText((text) => text.setPlaceholder("AIza...").setValue(this.plugin.settings.googleBooksApiKey).onChange(async (value) => { this.plugin.settings.googleBooksApiKey = value; await this.plugin.saveSettings(); }));
  }
}
