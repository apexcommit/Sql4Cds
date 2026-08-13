import * as path from "node:path";
import * as vscode from "vscode";
import { State } from "vscode-languageclient/node";
import { DocumentConnectionManager, errorMessage } from "./documentConnections";
import {
  CellValue,
  MessageParams,
  Methods,
  QueryCancelResult,
  QueryCompleteParams,
  QueryDisposeResult,
  ResultSetEventParams,
  ResultSetSummary,
  SaveResultRequestResult,
  SaveResultsAsCsvParams,
  SubsetResult
} from "./protocol";
import { Sql4CdsService } from "./serviceClient";

const pageSize = 200;

type QueryStatus = "running" | "cancelling" | "completed" | "cancelled" | "failed";

interface DisplayResult { summary: ResultSetSummary; }
interface QueryState {
  runId: number;
  messages: MessageParams["message"][];
  results: Map<string, DisplayResult>;
  status: QueryStatus;
  cancelRequested: boolean;
  started: number;
  ended?: number;
  batchElapsed?: string;
}

interface WebviewMessage {
  type?: string;
  ownerUri?: string;
  key?: string;
  page?: number;
  runId?: number;
  text?: string;
}

export class QueryController implements vscode.Disposable, vscode.WebviewViewProvider {
  private readonly states = new Map<string, QueryState>();
  private readonly cleanupPending = new Map<string, Promise<void>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly queryStatus: vscode.StatusBarItem;
  private resultsView?: vscode.WebviewView;
  private selectedUri?: string;
  private nextRunId = 1;

  constructor(private readonly service: Sql4CdsService, private readonly connections: DocumentConnectionManager) {
    const client = service.languageClient;
    this.queryStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.disposables.push(
      this.queryStatus,
      client.onNotification(Methods.queryMessage, (params: MessageParams) => this.onMessage(params)),
      client.onNotification(Methods.resultSetAvailable, (params: ResultSetEventParams) => this.onResultSummary(params)),
      client.onNotification(Methods.resultSetUpdated, (params: ResultSetEventParams) => this.onResultSummary(params)),
      client.onNotification(Methods.resultSetComplete, (params: ResultSetEventParams) => this.onResultSummary(params)),
      client.onNotification(Methods.queryComplete, (params: QueryCompleteParams) => this.onQueryComplete(params)),
      client.onDidChangeState(event => { if (event.newState === State.Stopped) { this.onServiceStopped(); } }),
      vscode.window.onDidChangeActiveTextEditor(editor => this.onActiveEditorChanged(editor)),
      vscode.workspace.onDidCloseTextDocument(document => {
        const uri = document.uri.toString();
        if (this.states.has(uri)) { void this.cleanupUri(uri, true); }
      })
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.resultsView = view;
    view.webview.options = { enableScripts: true };
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.onWebviewMessage(message), undefined, this.disposables);
    view.onDidDispose(() => {
      if (this.resultsView === view) { this.resultsView = undefined; }
    }, undefined, this.disposables);
    view.webview.html = resultsHtml(view.webview);
  }

  public async execute(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "sql4cds") {
      void vscode.window.showInformationMessage("Open a SQL 4 CDS query editor first.");
      return;
    }

    const uri = editor.document.uri.toString();
    const cleanup = this.cleanupPending.get(uri);
    if (cleanup) { await cleanup; }
    if (!this.connections.get(uri) && !await this.connections.connectEditor(undefined, editor)) { return; }
    const selection = editor.selection;
    const query = selection.isEmpty ? editor.document.getText() : editor.document.getText(selection);
    if (!query.trim()) {
      void vscode.window.showInformationMessage("There is no SQL to execute.");
      return;
    }

    const previous = this.states.get(uri);
    if (previous && isRunning(previous.status)) {
      void vscode.window.showWarningMessage(previous.status === "cancelling"
        ? "Wait for the current query cancellation to finish."
        : "A query is already running for this editor.");
      return;
    }

    if (previous) { await this.disposeStoredResults(uri, false); }

    const state: QueryState = {
      runId: this.nextRunId++,
      messages: [],
      results: new Map(),
      status: "running",
      cancelRequested: false,
      started: Date.now()
    };
    this.states.set(uri, state);
    this.selectedUri = uri;
    await this.showResultsView();
    this.publishState(uri);
    this.updateRunningContext();

    try {
      await this.service.languageClient.sendRequest(Methods.executeString, {
        ownerUri: uri,
        query,
        getFullColumnSchema: false,
        executionPlanOptions: undefined
      });
    } catch (error) {
      if (this.states.get(uri) !== state) { return; }
      state.status = "failed";
      state.ended = Date.now();
      const message = errorMessage(error);
      state.messages.push({ isError: true, message });
      this.publishState(uri);
      this.updateRunningContext();
    }
  }

  public async cancel(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    const state = uri ? this.states.get(uri) : undefined;
    if (!uri || !state || state.status !== "running") { return; }

    state.status = "cancelling";
    state.cancelRequested = true;
    this.publishState(uri);
    this.updateRunningContext();

    try {
      const response = await this.service.languageClient.sendRequest<QueryCancelResult>(Methods.cancelQuery, { ownerUri: uri });
      if (this.states.get(uri) !== state || state.status !== "cancelling") { return; }
      if (response.messages) {
        state.status = "running";
        state.cancelRequested = false;
        const message = `Could not cancel the query: ${response.messages}`;
        state.messages.push({ isError: true, message });
        void vscode.window.showErrorMessage(message);
        this.publishState(uri);
        this.updateRunningContext();
      }
    } catch (error) {
      if (this.states.get(uri) !== state || state.status !== "cancelling") { return; }
      state.status = "running";
      state.cancelRequested = false;
      const message = `Could not cancel the query: ${errorMessage(error)}`;
      state.messages.push({ isError: true, message });
      void vscode.window.showErrorMessage(message);
      this.publishState(uri);
      this.updateRunningContext();
    }
  }

  private onMessage(params: MessageParams): void {
    const state = this.states.get(params.ownerUri);
    if (!state) { return; }
    state.messages.push(params.message);
    this.publishState(params.ownerUri);
  }

  private onResultSummary(params: ResultSetEventParams): void {
    const state = this.states.get(params.ownerUri);
    if (!state) { return; }
    state.results.set(resultKey(params.resultSetSummary), { summary: params.resultSetSummary });
    this.publishState(params.ownerUri);
  }

  private onQueryComplete(params: QueryCompleteParams): void {
    const state = this.states.get(params.ownerUri);
    if (!state) { return; }
    state.ended = Date.now();
    state.batchElapsed = params.batchSummaries?.map(batch => batch.executionElapsed).filter(Boolean).join(" + ");
    const hasErrors = state.messages.some(message => message.isError) || Boolean(params.batchSummaries?.some(batch => batch.hasError));
    state.status = state.cancelRequested ? "cancelled" : hasErrors ? "failed" : "completed";
    this.publishState(params.ownerUri);
    this.updateRunningContext();
  }

  private onServiceStopped(): void {
    for (const [uri, state] of this.states) {
      if (!isRunning(state.status)) { continue; }
      state.status = "failed";
      state.ended = Date.now();
      state.messages.push({ isError: true, message: "The SQL 4 CDS language service stopped before the query completed." });
      this.publishState(uri);
    }
    this.updateRunningContext();
  }

  private async showResultsView(): Promise<void> {
    if (!this.resultsView) {
      await vscode.commands.executeCommand("sql4cdsQueryResults.focus", { preserveFocus: true });
    }
    this.resultsView?.show(true);
  }

  private async onWebviewMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") {
      if (this.selectedUri && this.states.has(this.selectedUri)) {
        this.publishState(this.selectedUri);
      } else {
        void this.resultsView?.webview.postMessage({ type: "empty" });
      }
      return;
    }
    const uri = message.ownerUri ?? this.selectedUri;
    if (!uri) { return; }
    switch (message.type) {
      case "page":
        await this.sendPage(uri, message);
        break;
      case "copy":
        if (typeof message.text === "string") {
          await vscode.env.clipboard.writeText(message.text);
          void vscode.window.setStatusBarMessage("SQL 4 CDS: Results copied", 2000);
        }
        break;
      case "exportCsv":
        if (message.key) { await this.exportCsv(uri, message.key); }
        break;
    }
  }

  private async sendPage(uri: string, message: WebviewMessage): Promise<void> {
    const state = this.states.get(uri);
    const result = message.key ? state?.results.get(message.key) : undefined;
    if (!state || !result || message.runId !== state.runId || !message.key) { return; }

    const maxRows = vscode.workspace.getConfiguration("SQL4CDS").get<number>("maxResultRows", 10000);
    const displayRows = Math.min(result.summary.rowCount, maxRows);
    const lastPage = Math.max(0, Math.ceil(displayRows / pageSize) - 1);
    const requestedPage = Number.isInteger(message.page) ? message.page! : 0;
    const page = Math.max(0, Math.min(requestedPage, lastPage));
    const start = page * pageSize;
    const count = Math.min(pageSize, Math.max(0, displayRows - start));

    try {
      const response = count === 0
        ? { resultSubset: { rowCount: 0, rows: [] } }
        : await this.service.languageClient.sendRequest<SubsetResult>(Methods.subset, {
          ownerUri: uri,
          batchIndex: result.summary.batchId,
          resultSetIndex: result.summary.id,
          rowsStartIndex: start,
          rowsCount: count
        });
      if (this.states.get(uri) !== state) { return; }
      const rows = (response.resultSubset?.rows ?? []).map(row => row.map(formatCell));
      void this.resultsView?.webview.postMessage({
        type: "page",
        runId: state.runId,
        key: message.key,
        page,
        rows,
        start,
        displayRows,
        totalRows: result.summary.rowCount,
        truncated: result.summary.rowCount > displayRows
      });
    } catch (error) {
      if (this.states.get(uri) !== state) { return; }
      void this.resultsView?.webview.postMessage({
        type: "pageError",
        runId: state.runId,
        key: message.key,
        page,
        message: `Could not retrieve this result page: ${errorMessage(error)}`
      });
    }
  }

  private async exportCsv(uri: string, key: string): Promise<void> {
    const state = this.states.get(uri);
    const result = state?.results.get(key);
    if (!state || !result || !result.summary.complete) {
      void vscode.window.showInformationMessage("Wait for this result set to finish before exporting it.");
      return;
    }

    const resultOrdinal = [...state.results.keys()].indexOf(key) + 1;
    const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri);
    const name = `${path.parse(document?.fileName || "query").name || "query"}-result-${resultOrdinal}.csv`;
    let defaultUri: vscode.Uri | undefined;
    if (document?.uri.scheme === "file") {
      defaultUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), name));
    } else if (vscode.workspace.workspaceFolders?.[0]) {
      defaultUri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, name);
    }
    const target = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { "CSV files": ["csv"], "All files": ["*"] },
      saveLabel: "Export full result set"
    });
    if (!target || this.states.get(uri) !== state) { return; }

    const request: SaveResultsAsCsvParams = {
      ownerUri: uri,
      filePath: target.fsPath,
      batchIndex: result.summary.batchId,
      resultSetIndex: result.summary.id,
      includeHeaders: true,
      delimiter: ",",
      lineSeperator: "\r\n",
      textIdentifier: "\"",
      encoding: "utf-8",
      maxCharsToStore: 0
    };
    try {
      const response = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Exporting SQL 4 CDS results…" },
        () => this.service.languageClient.sendRequest<SaveResultRequestResult>(Methods.saveCsv, request)
      );
      if (response.messages) { throw new Error(response.messages); }
      void vscode.window.showInformationMessage(`Exported ${result.summary.rowCount.toLocaleString()} rows to ${target.fsPath}.`);
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not export results: ${errorMessage(error)}`);
    }
  }

  private publishState(uri: string): void {
    const state = this.states.get(uri);
    if (!state || uri !== this.selectedUri) { return; }
    const maxRows = vscode.workspace.getConfiguration("SQL4CDS").get<number>("maxResultRows", 10000);
    const returnedRows = [...state.results.values()].reduce((total, result) => total + result.summary.rowCount, 0);
    const affectedRows = state.messages.map(message => affectedRowCount(message.message)).filter((value): value is number => value !== undefined);
    this.updateQueryStatus(state, returnedRows, affectedRows.length ? affectedRows.reduce((total, value) => total + value, 0) : undefined);
    if (!this.resultsView) { return; }
    void this.resultsView.webview.postMessage({
      type: "state",
      ownerUri: uri,
      runId: state.runId,
      status: state.status,
      started: state.started,
      ended: state.ended,
      batchElapsed: state.batchElapsed,
      returnedRows,
      affectedRows: affectedRows.length ? affectedRows.reduce((total, value) => total + value, 0) : undefined,
      results: [...state.results.entries()].map(([key, result], index) => ({
        key,
        ordinal: index + 1,
        rowCount: result.summary.rowCount,
        complete: result.summary.complete,
        columns: (result.summary.columnInfo ?? []).map(column => column.columnName ?? column.name ?? ""),
        displayRowCount: Math.min(result.summary.rowCount, maxRows),
        truncated: result.summary.rowCount > maxRows,
        pageSize
      })),
      messages: state.messages.map(message => ({
        isError: message.isError,
        message: message.message,
        time: message.time
      }))
    });
  }

  private updateQueryStatus(state: QueryState, returnedRows: number, affectedRows: number | undefined): void {
    const parts: string[] = [];
    if (state.results.size) { parts.push(`${returnedRows.toLocaleString()} ${returnedRows === 1 ? "row" : "rows"} returned`); }
    if (affectedRows !== undefined) { parts.push(`${affectedRows.toLocaleString()} ${affectedRows === 1 ? "row" : "rows"} affected`); }
    if (isRunning(state.status)) {
      parts.push(state.status === "cancelling" ? "$(sync~spin) Cancelling" : "$(sync~spin) Running");
    } else if (state.ended) {
      parts.push(`$(clock) ${formatDuration(state.ended - state.started)}`);
    }
    this.queryStatus.text = parts.join("  ");
    this.queryStatus.tooltip = "Query result summary";
    this.queryStatus.show();
  }

  private updateRunningContext(): void {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    void vscode.commands.executeCommand("setContext", "sql4cds.queryRunning", Boolean(uri && isRunning(this.states.get(uri)?.status)));
  }

  private onActiveEditorChanged(editor: vscode.TextEditor | undefined): void {
    this.updateRunningContext();
    if (!editor || editor.document.languageId !== "sql4cds") {
      this.selectedUri = undefined;
      this.queryStatus.hide();
      void this.resultsView?.webview.postMessage({ type: "empty" });
      return;
    }
    const uri = editor.document.uri.toString();
    this.selectedUri = uri;
    if (this.states.has(uri)) {
      this.publishState(uri);
    } else {
      this.queryStatus.hide();
      void this.resultsView?.webview.postMessage({ type: "empty" });
    }
  }

  private async disposeStoredResults(uri: string, reportErrors: boolean): Promise<void> {
    try {
      const response = await this.service.languageClient.sendRequest<QueryDisposeResult>(Methods.disposeQuery, { ownerUri: uri });
      if (response.messages && reportErrors) {
        void vscode.window.showWarningMessage(`SQL 4 CDS could not release query results: ${response.messages}`);
      }
    } catch (error) {
      if (reportErrors) { void vscode.window.showWarningMessage(`SQL 4 CDS could not release query results: ${errorMessage(error)}`); }
    }
  }

  private async cleanupUri(uri: string, cancelRunning: boolean): Promise<void> {
    const pending = this.cleanupPending.get(uri);
    if (pending) { return pending; }
    const cleanup = this.performCleanup(uri, cancelRunning);
    this.cleanupPending.set(uri, cleanup);
    try { await cleanup; }
    finally { if (this.cleanupPending.get(uri) === cleanup) { this.cleanupPending.delete(uri); } }
  }

  private async performCleanup(uri: string, cancelRunning: boolean): Promise<void> {
    const state = this.states.get(uri);
    this.states.delete(uri);
    if (this.selectedUri === uri) {
      this.selectedUri = undefined;
      this.queryStatus.hide();
      void this.resultsView?.webview.postMessage({ type: "empty" });
    }
    this.updateRunningContext();
    if (cancelRunning && state && isRunning(state.status)) {
      try { await this.service.languageClient.sendRequest<QueryCancelResult>(Methods.cancelQuery, { ownerUri: uri }); }
      catch { /* The service may already be shutting down. */ }
    }
    await this.disposeStoredResults(uri, false);
  }

  public dispose(): void {
    for (const disposable of this.disposables) { disposable.dispose(); }
    for (const uri of this.states.keys()) { void this.cleanupUri(uri, true); }
    this.resultsView = undefined;
  }
}

function resultsHtml(webview: vscode.Webview): string {
  const nonce = createNonce();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root{color-scheme:light dark}*{box-sizing:border-box}body{height:100vh;margin:0;overflow:hidden;font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background)}
    .tabs{display:flex;gap:2px;overflow:auto;height:36px;padding:4px 8px 0;border-bottom:1px solid var(--vscode-panel-border)}.tabs:empty{display:none}.tabs:empty+main{height:100vh}
    button{font:inherit;cursor:pointer}.tab{color:var(--vscode-foreground);background:transparent;border:0;border-bottom:2px solid transparent;padding:4px 10px}.tab:hover{background:var(--vscode-toolbar-hoverBackground)}.tab.active{border-bottom-color:var(--vscode-focusBorder);font-weight:600}.tab:focus-visible,.icon-button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
    main{height:calc(100vh - 36px);padding:6px 8px}.toolbar{display:flex;align-items:center;min-height:24px;gap:3px;margin-bottom:4px}.toolbar .meta{min-width:0;margin-right:auto;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.page-label{padding:0 4px;color:var(--vscode-descriptionForeground);font-variant-numeric:tabular-nums}
    .icon-button{display:grid;place-items:center;width:26px;height:26px;padding:0;color:var(--vscode-foreground);background:transparent;border:0;border-radius:3px;font-size:16px;line-height:1}.icon-button:hover:not(:disabled){background:var(--vscode-toolbar-hoverBackground)}.icon-button:disabled{opacity:.35;cursor:default}
    .result-area{display:flex;min-width:0;height:calc(100% - 28px)}.result-area.no-toolbar{height:100%}.grid{min-width:0;flex:1;overflow:auto;border-top:1px solid var(--vscode-panel-border);border-left:1px solid var(--vscode-panel-border)}.grid-actions{display:flex;flex:0 0 32px;flex-direction:column;align-items:center;gap:2px;padding:2px 3px;border-left:1px solid var(--vscode-panel-border)}
    table{border-collapse:separate;border-spacing:0;min-width:100%;font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}th,td{height:25px;max-width:360px;padding:3px 7px;border-right:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border);text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}th{position:sticky;top:0;z-index:2;min-width:80px;background:var(--vscode-editorGroupHeader-tabsBackground);resize:horizontal}td.null{color:var(--vscode-descriptionForeground);font-style:italic}
    .empty,.error{padding:20px;color:var(--vscode-descriptionForeground)}.error,.message.error{color:var(--vscode-errorForeground)}.messages{height:100%;margin:0;padding:0;overflow:auto;list-style:none}.message{padding:7px 9px;border-bottom:1px solid var(--vscode-panel-border);white-space:pre-wrap}.message time{display:block;margin-bottom:2px;color:var(--vscode-descriptionForeground);font-size:.9em}
  </style>
</head>
<body>
  <nav id="tabs" class="tabs" aria-label="Query results"></nav><main id="content"><div class="empty">Waiting for query results…</div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tabs = document.getElementById('tabs');
    const content = document.getElementById('content');
    let state;
    let active;
    let currentPage = 0;
    let currentPageData;
    let userSelectedTab = false;
    const pages = new Map();
    const pending = new Set();

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        const changedRun = !state || state.runId !== message.runId;
        state = message;
        if (changedRun) { pages.clear(); pending.clear(); active = 'messages'; userSelectedTab = false; currentPage = 0; currentPageData = undefined; }
        renderState();
      } else if (message.type === 'empty') {
        state = undefined; active = undefined; userSelectedTab = false; pages.clear(); pending.clear();
        tabs.replaceChildren();
        content.replaceChildren(makeNode('div', 'empty', 'Run a query to see its results.'));
      } else if (message.type === 'page' && state && message.runId === state.runId) {
        const cacheKey = pageKey(message.key, message.page);
        pending.delete(cacheKey);
        pages.set(cacheKey, message);
        if (active === message.key && currentPage === message.page) { renderResult(); }
      } else if (message.type === 'pageError' && state && message.runId === state.runId) {
        pending.delete(pageKey(message.key, message.page));
        if (active === message.key && currentPage === message.page) { showError(message.message); }
      }
    });

    function renderState() {
      tabs.replaceChildren();
      for (const result of state.results) { addTab(result.key, state.results.length === 1 ? 'Results' : 'Result ' + result.ordinal); }
      addTab('messages', 'Messages' + (state.messages.length ? ' (' + state.messages.length + ')' : ''));
      const hasErrors = state.status === 'failed' || state.messages.some(message => message.isError);
      if (hasErrors) {
        active = 'messages';
        userSelectedTab = false;
      } else if (!state.results.length) {
        active = 'messages';
      } else if (active === 'messages' && !userSelectedTab) {
        active = state.results[0].key;
      } else if (!active || (active !== 'messages' && !state.results.some(result => result.key === active))) {
        active = state.results[0].key;
      }
      for (const tab of tabs.children) { tab.classList.toggle('active', tab.dataset.key === active); }
      showActive();
    }

    function addTab(key, label) {
      const button = document.createElement('button');
      button.className = 'tab'; button.dataset.key = key; button.textContent = label; button.setAttribute('role', 'tab');
      button.addEventListener('click', () => { active = key; userSelectedTab = true; currentPage = 0; for (const tab of tabs.children) { tab.classList.toggle('active', tab.dataset.key === active); } showActive(); });
      tabs.append(button);
    }

    function showActive() {
      if (active === 'messages') { renderMessages(); return; }
      const result = state.results.find(item => item.key === active);
      if (!result) {
        const message = state.status === 'running' || state.status === 'cancelling' ? 'Waiting for query results…' : 'No result sets were returned.';
        content.replaceChildren(makeNode('div', 'empty', message)); return;
      }
      if (!result.complete) { content.replaceChildren(makeNode('div', 'empty', 'Waiting for this result set to finish…')); return; }
      const lastPage = Math.max(0, Math.ceil(result.displayRowCount / result.pageSize) - 1);
      currentPage = Math.min(currentPage, lastPage);
      const cached = pages.get(pageKey(active, currentPage));
      if (cached) { renderResult(); return; }
      content.replaceChildren(makeNode('div', 'empty', result.complete ? 'Loading result page…' : 'Waiting for rows…'));
      requestPage(result);
    }

    function requestPage(result) {
      const key = pageKey(result.key, currentPage);
      if (pending.has(key)) { return; }
      pending.add(key);
      vscode.postMessage({type:'page', ownerUri:state.ownerUri, runId:state.runId, key:result.key, page:currentPage});
    }

    function renderResult() {
      const result = state.results.find(item => item.key === active);
      const page = result && pages.get(pageKey(active, currentPage));
      if (!result || !page) { return; }
      currentPageData = page;
      content.replaceChildren();
      const toolbar = makeNode('div', 'toolbar');
      const firstRow = page.displayRows ? page.start + 1 : 0;
      const lastRow = page.start + page.rows.length;
      const detail = page.truncated
        ? firstRow.toLocaleString() + '–' + lastRow.toLocaleString() + ' of ' + page.displayRows.toLocaleString() + ' displayed (' + page.totalRows.toLocaleString() + ' total; display limit reached)'
        : firstRow.toLocaleString() + '–' + lastRow.toLocaleString() + ' of ' + page.totalRows.toLocaleString();
      const lastPage = Math.max(0, Math.ceil(result.displayRowCount / result.pageSize) - 1);
      const showToolbar = lastPage > 0 || page.truncated;
      if (showToolbar) {
        toolbar.append(makeNode('span', 'meta', detail));
        if (lastPage > 0) {
          toolbar.append(iconButton('First page', '⇤', () => changePage(0), currentPage === 0));
          toolbar.append(iconButton('Previous page', '‹', () => changePage(currentPage - 1), currentPage === 0));
          toolbar.append(makeNode('span', 'page-label', (currentPage + 1) + ' / ' + (lastPage + 1)));
          toolbar.append(iconButton('Next page', '›', () => changePage(currentPage + 1), currentPage >= lastPage));
          toolbar.append(iconButton('Last page', '⇥', () => changePage(lastPage), currentPage >= lastPage));
        }
        content.append(toolbar);
      }
      if (!result.columns.length) { content.append(makeNode('div', 'empty', 'This result set has no columns.')); return; }
      const resultArea = makeNode('div', 'result-area' + (showToolbar ? '' : ' no-toolbar'));
      const wrapper = makeNode('div', 'grid');
      const table = document.createElement('table');
      const thead = document.createElement('thead'); const headerRow = document.createElement('tr');
      for (const column of result.columns) { headerRow.append(makeNode('th', '', column)); }
      thead.append(headerRow); table.append(thead);
      const tbody = document.createElement('tbody');
      for (const row of page.rows) {
        const tr = document.createElement('tr');
        for (let i = 0; i < result.columns.length; i++) {
          const value = i < row.length ? row[i] : null;
          tr.append(makeNode('td', value === null ? 'null' : '', value === null ? 'NULL' : value));
        }
        tbody.append(tr);
      }
      table.append(tbody); wrapper.append(table); resultArea.append(wrapper);
      const actions = makeNode('aside', 'grid-actions');
      actions.setAttribute('aria-label', 'Result actions');
      actions.append(iconButton('Copy current page', '⧉', () => copyPage(false), !page.rows.length));
      actions.append(iconButton('Copy current page with headers', '⧉⁺', () => copyPage(true), !page.rows.length));
      actions.append(iconButton('Export full result set as CSV', '⇩', () => vscode.postMessage({type:'exportCsv', ownerUri:state.ownerUri, key:active}), !result.complete));
      resultArea.append(actions); content.append(resultArea);
    }

    function changePage(page) { currentPage = page; currentPageData = undefined; showActive(); }
    function copyPage(headers) {
      const result = state.results.find(item => item.key === active);
      if (!result || !currentPageData) { return; }
      const rows = headers ? [result.columns, ...currentPageData.rows] : currentPageData.rows;
      const text = rows.map(row => row.map(tsv).join('\\t')).join('\\n');
      vscode.postMessage({type:'copy', ownerUri:state.ownerUri, text});
    }
    function tsv(value) { const text = value === null ? 'NULL' : String(value); return /[\\t\\r\\n\"]/.test(text) ? '\"' + text.replace(/\"/g, '\"\"') + '\"' : text; }
    function renderMessages() {
      content.replaceChildren();
      if (!state.messages.length) { content.append(makeNode('div', 'empty', state.status === 'running' ? 'Running query…' : 'No messages.')); return; }
      const list = makeNode('ol', 'messages');
      for (const message of state.messages) {
        const item = makeNode('li', 'message' + (message.isError ? ' error' : ''));
        if (message.time) { const time = document.createElement('time'); const date = new Date(message.time); time.textContent = Number.isNaN(date.valueOf()) ? message.time : date.toLocaleTimeString(); item.append(time); }
        item.append(document.createTextNode(message.message)); list.append(item);
      }
      content.append(list);
    }
    function showError(message) { content.replaceChildren(makeNode('div', 'error', message)); }
    function iconButton(label, glyph, handler, disabled) { const button = makeNode('button', 'icon-button', glyph); button.title = label; button.setAttribute('aria-label', label); button.disabled = disabled; button.addEventListener('click', handler); return button; }
    function makeNode(tag, className, text) { const node = document.createElement(tag); if (className) { node.className = className; } if (text !== undefined) { node.textContent = text; } return node; }
    function pageKey(key, page) { return state.runId + ':' + key + ':' + page; }
    vscode.postMessage({type:'ready'});
  </script>
</body>
</html>`;
}

function formatCell(cell: CellValue): string | null {
  if (cell.isNull) { return null; }
  return cell.displayValue ?? cell.invariantCultureDisplayValue ?? String(cell.rawObject ?? "");
}

function affectedRowCount(message: string): number | undefined {
  const match = message.match(/^\(?\s*([\d,]+)\s+.+?\s+(?:created|inserted|updated|deleted|affected)\)?\s*$/i);
  if (!match) { return undefined; }
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(value) ? value : undefined;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) { return `${milliseconds} ms`; }
  if (milliseconds < 60000) { return `${(milliseconds / 1000).toFixed(1)} s`; }
  const minutes = Math.floor(milliseconds / 60000);
  const seconds = Math.floor((milliseconds % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function isRunning(status: QueryStatus | undefined): boolean { return status === "running" || status === "cancelling"; }
function resultKey(summary: ResultSetSummary): string { return `${summary.batchId}:${summary.id}`; }
function createNonce(): string {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) { value += characters.charAt(Math.floor(Math.random() * characters.length)); }
  return value;
}
