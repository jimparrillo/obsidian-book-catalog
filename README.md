# Book Catalog

An Obsidian plugin for cataloging your book collection. Scan ISBN barcodes or search by title and author to automatically pull metadata from Open Library and Google Books, then save a structured note for each book directly in your vault.

## Features

- **Barcode scanning** — scan ISBN barcodes with a USB or Bluetooth barcode scanner; the code is captured instantly as if typed into the input field
- **Manual search** — search by title and optional author when no barcode is available, with results shown inline from Open Library and Google Books
- **Automatic metadata** — title, authors, editors, publisher, year, page count, cover image, and subjects are fetched and written to the note's frontmatter automatically
- **Condition tracking** — record physical condition using standard collector grades: New, Fine, Very Good, Good, Fair, Poor
- **Copies tracking** — track how many copies of a title you own; if you scan a duplicate, the plugin detects it and offers to update the copy count rather than creating a duplicate note
- **Valuation** — record the estimated value of each book
- **Acquisition date** — defaults to today, editable before saving
- **Custom fields** — add your own fields to the capture modal (text, number, date, or boolean toggle); all custom values are saved to the note's frontmatter
- **Configurable save behavior** — choose whether "Save & Add Another" or "Save Book" is the primary button in settings, useful for single-add vs. batch workflows
- **Catalog view** — a dedicated ribbon icon opens the Book Catalog base table view directly
- **Obsidian Bases integration** — automatically creates and manages a `.base` file with pre-configured table views: All Books, By Year, and Needs Condition
- **Vault reorganization** — a built-in tool scans your entire vault for book notes (by tag) and moves them to your configured folder, regardless of where they currently live
- **iOS compatible** — notes and the Base table view sync to iOS via Obsidian Sync and are fully readable on mobile (plugin features require desktop)

## Network Use

This plugin makes network requests to third-party services to retrieve book metadata. No personal data, vault content, or user information is ever sent. The only data transmitted is the ISBN or search terms you enter.

| Service | Purpose | When used | Authentication |
|---------|---------|-----------|----------------|
| [Open Library](https://openlibrary.org) (Internet Archive) | ISBN lookup and title/author search | Every lookup and search | None required |
| [Google Books](https://books.google.com) | ISBN lookup and title/author search (fallback) | When Open Library returns no results | Optional API key (yours) |

No telemetry, analytics, or usage data of any kind is collected or transmitted by this plugin.

## Requirements

- Obsidian v1.8.0 or later (required for Obsidian Bases support)
- Desktop Obsidian (community plugins are not supported on iOS/Android)

## Installation

### From the Obsidian Community Plugin Store (recommended)

1. Open Obsidian **Settings → Community plugins**
2. Turn off Restricted mode if prompted
3. Click **Browse** and search for **Book Catalog**
4. Click **Install**, then **Enable**

### Manual installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/jimparrillo/obsidian-book-catalog/releases)
2. Create a folder called `book-catalog` inside your vault's `.obsidian/plugins/` directory
3. Copy both files into that folder
4. Reload Obsidian and enable the plugin in **Settings → Community plugins**

## Setup

### 1. Configure your folders

Go to **Settings → Book Catalog → File Organization** and set:

- **Catalog folder** — where `Book Catalog.base` will be created (e.g. `Books` or `03 Resources/Books`)
- **Notes subfolder** — subfolder inside the catalog folder for individual book notes (e.g. `Notes`); leave blank to store notes directly in the catalog folder

### 2. Create the Base file

Click **Create Base File** in settings. This creates `Book Catalog.base` at your configured path with all table views pre-configured. You need [Obsidian Bases](https://obsidian.md/bases) enabled (available in Obsidian v1.8+).

### 3. Optional: Google Books API key

Open Library is used as the primary metadata source and requires no API key. Google Books is used as a fallback. For higher rate limits on Google Books, add a free API key from [Google Cloud Console](https://console.cloud.google.com) in **Settings → Book Catalog → API**.

## Usage

### Adding a book by barcode

1. Click the **book-plus icon** in the left ribbon, or use the command palette → **Add book by ISBN**
2. The modal opens with focus in the barcode field — scan or type an ISBN
3. Press Enter or click **Look Up Book**
4. Review the metadata preview, set condition, copies, acquisition date, and value
5. Click **Save Book** or **Save & Add Another** to save and immediately scan the next item

### Adding a book by title search

1. Open the Add Book modal and click the **Search by Title** tab
2. Enter a title (required) and optionally an author
3. Click **Search Books** — results appear inline below the form
4. Click any result card to proceed to the confirm step

### Viewing the catalog

Click the **library icon** in the left ribbon to open the Book Catalog table view directly.

### Handling duplicates

If you scan a book that already exists in your catalog, the plugin shows the existing entry with the current copy count and offers to update it rather than creating a duplicate note.

### Custom fields

Go to **Settings → Book Catalog → Custom Fields** to add your own fields. Each field has a name and a type (text, number, date, or boolean toggle). Custom fields appear in the confirm modal below the standard fields and are saved to the note's frontmatter using the field name as the YAML key (spaces become hyphens).

Examples: `dewey-decimal` (text), `purchase-price` (number), `signed` (boolean), `read-date` (date).

## Note format

Each book is saved as a Markdown file with YAML frontmatter:

```yaml
---
title: "The Design of Everyday Things"
authors: ["Don Norman"]
editors: []
publisher: "Basic Books"
published: 2013
pages: "368"
isbn: "9780465050659"
cover: "https://..."
condition: "Very Good"
acquired: "2026-03-16"
valuation: 18
copies: 1
subjects: ["Design", "Human factors"]
tags: ["book"]
---
```

Followed by a cover image and a `## Notes` section for personal annotations. Any custom fields you have configured appear between `subjects` and `tags`.

## Condition grades

| Grade | Description |
|-------|-------------|
| New | Unread, as purchased |
| Fine | Read but no visible wear |
| Very Good | Minor wear, no defects |
| Good | Wear consistent with use |
| Fair | Heavy wear but complete |
| Poor | Heavily damaged |

## Reorganizing existing notes

If you change your folder settings after adding books, use **Settings → Reorganize Files → Scan Vault & Reorganize**. The tool scans your entire vault for notes tagged `#book`, shows you what it found and where, then moves everything to the correct location after you confirm.

## Settings reference

| Setting | Description | Default |
|---------|-------------|---------|
| Catalog folder | Where `Book Catalog.base` is created | `Books` |
| Notes subfolder | Subfolder inside catalog folder for book notes | `Notes` |
| Default to Save & Add Another | Makes "Save & Add Another" the primary button | On |
| Custom Fields | Add user-defined fields to the capture modal | None |
| Google Books API key | Optional fallback API key | Empty |

## Support

For bug reports and feature requests, please use the [GitHub Issues page](https://github.com/jimparrillo/obsidian-book-catalog/issues).
