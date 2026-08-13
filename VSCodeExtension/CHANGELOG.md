# Changelog

All notable changes to the SQL 4 CDS extension for Visual Studio Code are documented here.

## [0.3.0] - Unreleased

### Added

- A dedicated Query Results view in the VS Code bottom panel, consistent with the MSSQL extension experience.
- Per-editor result state with compact result-set tabs, paged grids, and copy actions.
- Full-result export to CSV, Excel, JSON, Markdown, and XML.
- Text exports open automatically in VS Code; Excel exports offer actions to open the workbook in its default application or reveal it in Finder/Explorer.
- Query metadata in the VS Code status bar, including rows returned, rows affected, execution state, and elapsed time.

### Changed

- Query execution starts on Messages, switches to Results when a result set becomes available, and remains on Messages for errors or queries that return no result sets.
- Result paging and export controls use a compact grid-focused layout to maximize the available space for data.

## [0.1.0] - Unreleased

### Added

- Saved Dataverse connection profiles with secrets stored in VS Code Secret Storage.
- Interactive, application-user, username/password, Windows-integrated, and connection-string authentication options.
- Per-editor connections and a connection status indicator.
- Dataverse Object Explorer with metadata browsing and query creation.
- SQL execution for the complete document or the current selection, cancellation, messages, and multiple result sets.
- Result copying and CSV export.
- SQL language-service completion and diagnostics for `.sql4cds` documents.
- Configurable safeguards for data modification and result limits.
- Startup validation and actionable diagnostics for the bundled language service and .NET 8 Runtime.
- Automatic language-service crash recovery with manual restart guidance when recovery is exhausted.
- Usage and error telemetry disabled for the Visual Studio Code language-service process.
- Authentication token caching moved from the extension installation directory to VS Code global storage.
- Common password, client-secret, bearer-token, and credentialed-URL forms redacted from user-visible errors.
- Automated TypeScript checks, runtime tests, language-service builds, and VSIX packaging in CI.
