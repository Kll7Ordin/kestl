# Changelog

## [2.2.1](https://github.com/Kll7Ordin/kestl/compare/v2.2.0...v2.2.1) (2026-04-22)


### Bug Fixes

* show spent for zero-target categories, always render YTD columns, align Add button ([7536070](https://github.com/Kll7Ordin/kestl/commit/7536070fa46ed3ecc2ed79b886ed9ca701873564))

## [2.2.0](https://github.com/Kll7Ordin/kestl/compare/v2.1.5...v2.2.0) (2026-04-22)


### Features

* fix duplicate transactions, improve budget UX, spread demo data across Canada ([1f50910](https://github.com/Kll7Ordin/kestl/commit/1f50910611499a4f33de5b40250e08244ee31880))

## [2.1.5](https://github.com/Kll7Ordin/kestl/compare/v2.1.4...v2.1.5) (2026-04-22)


### Bug Fixes

* correct tauri-action version to v0.6 (v5 does not exist) ([3259986](https://github.com/Kll7Ordin/kestl/commit/32599865ee2373aff9bd8ac1a33dd4f65203ee3a))

## [2.1.4](https://github.com/Kll7Ordin/kestl/compare/v2.1.3...v2.1.4) (2026-04-22)


### Bug Fixes

* use PAT for release-please so tag push triggers Release workflow ([f81a348](https://github.com/Kll7Ordin/kestl/commit/f81a3486e3c0b612eb02f1202340f934e9ea3a6d))

## [2.1.3](https://github.com/Kll7Ordin/kestl/compare/v2.1.2...v2.1.3) (2026-04-22)


### Bug Fixes

* restore corrupted tauri.conf.json and prevent recurrence ([e9899cd](https://github.com/Kll7Ordin/kestl/commit/e9899cd3e9e97c63caa4517990ee26185b220f7d))

## [2.1.2](https://github.com/Kll7Ordin/kestl/compare/v2.1.1...v2.1.2) (2026-04-22)


### Bug Fixes

* use tauri-action@v5 for Tauri 2 compatibility ([6426b4e](https://github.com/Kll7Ordin/kestl/commit/6426b4e962bd15d95d5d3083deeb3d26c4ff5784))

## [2.1.1](https://github.com/Kll7Ordin/kestl/compare/v2.1.0...v2.1.1) (2026-04-22)


### Bug Fixes

* restore corrupted tauri.conf.json (release-please ([17bcfa7](https://github.com/Kll7Ordin/kestl/commit/17bcfa711d44c0fe2082c3e46fc414fd953680ea))

## [2.1.0](https://github.com/Kll7Ordin/kestl/compare/v2.0.0...v2.1.0) (2026-04-22)


### Features

* replace splash screen title with kestl SVG logo wordmark ([bdabf76](https://github.com/Kll7Ordin/kestl/commit/bdabf76ce1c5eee344011af1ff71fcdfcc63d4f6))

## [2.0.0](https://github.com/Kll7Ordin/kestl/compare/v1.0.0...v2.0.0) (2026-04-22)


### ⚠ BREAKING CHANGES

* rename product to kestl, start window maximized

### Features

* add AI lookup toggle, on-demand Ollama prompt, and parser deep-link ([5239e1e](https://github.com/Kll7Ordin/kestl/commit/5239e1ec761de6bb7ff1d72664b410aa768fa5ab))
* add purge-by-instrument, delete-mortgage, and reorder-rules to data layer ([6ebbe6f](https://github.com/Kll7Ordin/kestl/commit/6ebbe6f52dc37d2c542572902c63a90b5a955b2d))
* add release-please, single-source version, CLAUDE.md ([8ecb862](https://github.com/Kll7Ordin/kestl/commit/8ecb8625767d54edb836586f28bff8861343ac00))
* chart overhaul, consistent category colors, remove Ctrl+Z hint, README demo note ([131bcb0](https://github.com/Kll7Ordin/kestl/commit/131bcb032eb6d80420882f9705308b7112974f9b))
* configurable color thresholds, fix Uncategorized filter, fix Year Spent from Savings ([88f4873](https://github.com/Kll7Ordin/kestl/commit/88f487382cbb0b1ce53d3f648cbc1a05c029f9bc))
* doughnut slice labels for large segments, side legend for small ones ([175e32e](https://github.com/Kll7Ordin/kestl/commit/175e32ed5032e386ebed0f4a65f060f459504241))
* inline savings entry, parser rename, template cleanup, budget template rename ([5f9cedd](https://github.com/Kll7Ordin/kestl/commit/5f9cedd07997fc606261748f61f93a0b79fff6d4))
* link custom parsers in Import view to Settings; compact ImportBudgetCard ([412f12f](https://github.com/Kll7Ordin/kestl/commit/412f12f82061e06328d8523ff23b0c00dd6ffb2c))
* mortgage setup UX overhaul — full width layout, category-first with inference, inline sections ([8472193](https://github.com/Kll7Ordin/kestl/commit/8472193fe4bc71572a2e772f876858bdae005760))
* mortgage tool overhaul with ledger, category linking, and experimental flag ([b23512b](https://github.com/Kll7Ordin/kestl/commit/b23512b0c97fb7656f0e6e633dad47c852985d65))
* rebrand accent colour from teal to blue; polish CSS ([693ace4](https://github.com/Kll7Ordin/kestl/commit/693ace416fda3eed74d3c44c3da29c67cb43b2c0))
* redesign budget summary cards as proportional inline grid ([6413c3a](https://github.com/Kll7Ordin/kestl/commit/6413c3a7a0fb7f74cab53bd9fa29edc8c8e2b647))
* rename Experimental Budgets to Budget Sandbox; reset baseline to v1.0.0 ([4a28dba](https://github.com/Kll7Ordin/kestl/commit/4a28dba6f6169b20549615cc69968b3cac5a9d3e))
* rename product to kestl, start window maximized ([96bb159](https://github.com/Kll7Ordin/kestl/commit/96bb159cc9c4a14c1f8ca04eb7c304faedd27d13))
* Settings — run-rule-on-history, purge-by-instrument, drag-reorder rules, delete-mortgage ([8526562](https://github.com/Kll7Ordin/kestl/commit/8526562d5c29fd5cd4f8f4c4a41832be57c8b496))
* Tools tab, Mortgage Tool, settings/savings cleanup ([e3584a7](https://github.com/Kll7Ordin/kestl/commit/e3584a799d378aa471595def747a662a95959b2e))
* update app icons for kestl branding; add SVG, iOS, and Android variants ([99124fc](https://github.com/Kll7Ordin/kestl/commit/99124fca629a7173a138482a226873700bdc48e2))
* year view — full month+year axis labels and collapsible monthly table ([344b1c8](https://github.com/Kll7Ordin/kestl/commit/344b1c85457e70414588b920f5999f499c6c4764))


### Bug Fixes

* apply category rules in declaration order; add run-rule-on-history ([c9e6fd6](https://github.com/Kll7Ordin/kestl/commit/c9e6fd6fed655ba5bc32fd5fe4ec9421e96c6755))
* confirm dialog for bucket deletion; undo support for all deletions ([a92d211](https://github.com/Kll7Ordin/kestl/commit/a92d21182c54edad45d33384469f69ef7f4aa19f))
* date picker closes on click-away; fix biweekly vs semi-monthly frequency detection ([7678b0e](https://github.com/Kll7Ordin/kestl/commit/7678b0ec8e6ac63f74548dcafbe82b3b7172f0c4))
* parser preview — regenerate button, view code, better 0-result diagnostics ([c738e9f](https://github.com/Kll7Ordin/kestl/commit/c738e9f553550845afcbc53be17c6620f9ac1eeb))
* remove spent column from budget, PayPal nav button, house icon from tools; move experimental to own settings section ([f3dc5e4](https://github.com/Kll7Ordin/kestl/commit/f3dc5e4a80db25e7076ebab0c280c3e8aa503061))
* render SearchableSelect dropdown via portal; only attach listeners when open ([7465358](https://github.com/Kll7Ordin/kestl/commit/7465358c7d6c32a816390d0d2408cc401b6b05d7))
* replace all date inputs in MortgageTool with text-based DateInput component ([613dae7](https://github.com/Kll7Ordin/kestl/commit/613dae7e5a9b9b43ef7157c8d814efad5ee8ed37))
* replace text DateInput with custom React calendar picker ([0c182e7](https://github.com/Kll7Ordin/kestl/commit/0c182e7ff1773638c24532b5a58035c810ce85c2))
* replace useRef rev pattern with useState to fix react-hooks/refs lint errors ([0c04bcd](https://github.com/Kll7Ordin/kestl/commit/0c04bcd5977d59e1fb0055037001482a45d1d0be))
* restore line chart labels/font, double doughnut size ([0113e77](https://github.com/Kll7Ordin/kestl/commit/0113e778996049b58139da9a21ddcba05b9b2631))
* show Ollama start/install modal in parser generator instead of error text ([41352ba](https://github.com/Kll7Ordin/kestl/commit/41352bacfff39110c10e3b98e3d14d84ca2ab576))
* smarter parser 0-result diagnosis — auto-regenerate if sample also fails ([f30c111](https://github.com/Kll7Ordin/kestl/commit/f30c1114732e17163d926692e0bc8251c04fd017))


### Performance Improvements

* memoize TransactionView derived data; add AI lookup toggle prop ([fb9534e](https://github.com/Kll7Ordin/kestl/commit/fb9534e59349c544be3591a77ed92fc6816b5109))
