import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import tseslint from "typescript-eslint";
import { DEFAULT_ACRONYMS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/acronyms.js";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
  { ignores: ["node_modules/**", "main.js", "esbuild.config.mjs", "eslint.config.mjs"] },
  ...obsidianmd.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "obsidianmd/ui/sentence-case": ["error", {
        // Acronyms and brand names absent from the rule's default dictionaries
        acronyms: [...DEFAULT_ACRONYMS, "ISBN", "UPC", "USD", "CD", "LP"],
        brands: [...DEFAULT_BRANDS, "Book Catalog", "Music Catalog", "Google Books", "Open Library", "Discogs", "MusicBrainz", "Bases"],
        ignoreRegex: [
          "^← Back$",                      // arrow prefix confuses first-word detection
          "^AIza",                          // Google API key placeholder
          "console\\.cloud\\.google\\.com", // rule mis-corrects casing inside URLs
          "'Save & add another'",           // references exact button labels
          "Reorganize files below",         // references exact button label
          "^Log into Discogs"               // references exact Discogs UI labels
        ],
      }],
    },
  },
]);
