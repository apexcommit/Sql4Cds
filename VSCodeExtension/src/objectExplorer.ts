import * as vscode from "vscode";
import { State } from "vscode-languageclient/node";
import { ConnectionProfile, NodeInfo, ObjectMetadata } from "./protocol";
import { ProfileStore } from "./profileStore";
import { Sql4CdsService } from "./serviceClient";
import { errorMessage } from "./documentConnections";

interface ExplorerSession { sessionId: string; root: NodeInfo; }

export class Sql4CdsTreeItem extends vscode.TreeItem {
  constructor(
    public readonly profile: ConnectionProfile,
    public readonly node?: NodeInfo,
    public readonly sessionId?: string
  ) {
    super(node?.label ?? profile.name, node?.isLeaf ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed);
    if (!node) {
      this.contextValue = "sql4cds.profile";
      this.description = profile.url;
      this.iconPath = new vscode.ThemeIcon("database");
      this.tooltip = `${profile.name}\n${profile.url ?? "Connection string"}`;
    } else {
      const type = node.nodeType.toLowerCase();
      this.contextValue = isTable(node) ? "sql4cds.table" : `sql4cds.${type}`;
      this.iconPath = new vscode.ThemeIcon(iconFor(type));
      this.tooltip = node.errorMessage || node.metadata?.urn || node.label;
    }
  }
}

export class ObjectExplorerProvider implements vscode.TreeDataProvider<Sql4CdsTreeItem>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<Sql4CdsTreeItem | undefined>();
  private readonly sessions = new Map<string, ExplorerSession>();
  private readonly children = new Map<string, NodeInfo[]>();
  private readonly disposables: vscode.Disposable[] = [];
  public readonly onDidChangeTreeData = this.changedEmitter.event;

  constructor(private readonly service: Sql4CdsService, private readonly profiles: ProfileStore) {
    this.disposables.push(
      profiles.onDidChange(() => this.refresh()),
      service.languageClient.onDidChangeState(event => {
        if (event.newState !== State.Stopped) { return; }
        this.sessions.clear();
        this.children.clear();
        this.changedEmitter.fire(undefined);
      })
    );
  }

  public getTreeItem(element: Sql4CdsTreeItem): vscode.TreeItem { return element; }

  public async getChildren(element?: Sql4CdsTreeItem): Promise<Sql4CdsTreeItem[]> {
    if (!element) { return this.profiles.profiles.map(profile => new Sql4CdsTreeItem(profile)); }
    try {
      if (!element.node) {
        const session = await this.ensureSession(element.profile);
        return (await this.expand(element.profile, session.sessionId, session.root.nodePath))
          .map(node => new Sql4CdsTreeItem(element.profile, node, session.sessionId));
      }
      if (element.node.isLeaf || !element.sessionId) { return []; }
      return (await this.expand(element.profile, element.sessionId, element.node.nodePath))
        .map(node => new Sql4CdsTreeItem(element.profile, node, element.sessionId));
    } catch (error) {
      const item = new Sql4CdsTreeItem(element.profile, {
        label: `Error: ${errorMessage(error)}`,
        nodePath: "error",
        nodeType: "Error",
        isLeaf: true,
        errorMessage: errorMessage(error)
      }, element.sessionId);
      item.iconPath = new vscode.ThemeIcon("error");
      return [item];
    }
  }

  public refresh(item?: Sql4CdsTreeItem): void {
    if (!item) {
      for (const session of this.sessions.values()) { void this.service.closeObjectExplorerSession(session.sessionId); }
      this.sessions.clear();
      this.children.clear();
      this.changedEmitter.fire(undefined);
      return;
    }

    if (!item.node) {
      const session = this.sessions.get(item.profile.id);
      if (session) { void this.service.closeObjectExplorerSession(session.sessionId); }
      this.sessions.delete(item.profile.id);
      this.clearProfileCache(item.profile.id);
    } else {
      this.children.delete(cacheKey(item.profile.id, item.node.nodePath));
    }
    this.changedEmitter.fire(item);
  }

  public async searchTables(profile?: ConnectionProfile): Promise<{ profile: ConnectionProfile; node: NodeInfo } | undefined> {
    profile ??= await this.profiles.pick("Select a connection to search");
    if (!profile) { return undefined; }

    try {
      const session = await this.ensureSession(profile);
      const root = await this.expand(profile, session.sessionId, session.root.nodePath);
      const tableFolders = root.filter(node => !node.isLeaf && ["Tables", "Long Term Retention", "Recycle Bin", "Metadata"].includes(node.label));
      const tableGroups = await Promise.all(tableFolders.map(async folder => ({
        folder,
        nodes: (await this.expand(profile!, session.sessionId, folder.nodePath)).filter(isTable)
      })));
      const picks = tableGroups.flatMap(group => group.nodes.map(node => ({
        label: node.label,
        description: node.metadata?.schema ?? group.folder.label,
        detail: `${profile!.name} — ${node.metadata?.schema ?? "dbo"}.${node.metadata?.name ?? node.label}`,
        node
      })));
      const selection = await vscode.window.showQuickPick(picks, {
        title: `Search Dataverse tables — ${profile.name}`,
        placeHolder: "Type a logical table name",
        matchOnDescription: true,
        matchOnDetail: true,
        ignoreFocusOut: true
      });
      return selection ? { profile, node: selection.node } : undefined;
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not search tables: ${errorMessage(error)}`);
      return undefined;
    }
  }

  public async removeProfile(item: Sql4CdsTreeItem): Promise<void> {
    const session = this.sessions.get(item.profile.id);
    if (session) { await this.service.closeObjectExplorerSession(session.sessionId); this.sessions.delete(item.profile.id); }
    this.clearProfileCache(item.profile.id);
    await this.profiles.remove(item.profile.id);
  }

  private async expand(profile: ConnectionProfile, sessionId: string, nodePath: string): Promise<NodeInfo[]> {
    const key = cacheKey(profile.id, nodePath);
    const cached = this.children.get(key);
    if (cached) { return cached; }
    const response = await this.service.expandObjectExplorer(sessionId, nodePath);
    const nodes = response.nodes ?? [];
    this.children.set(key, nodes);
    return nodes;
  }

  private clearProfileCache(profileId: string): void {
    const prefix = `${profileId}\n`;
    for (const key of this.children.keys()) {
      if (key.startsWith(prefix)) { this.children.delete(key); }
    }
  }

  private async ensureSession(profile: ConnectionProfile): Promise<ExplorerSession> {
    const existing = this.sessions.get(profile.id);
    if (existing) { return existing; }
    const created = await this.service.createObjectExplorerSession(await this.profiles.toConnectionDetails(profile));
    if (!created.rootNode) { throw new Error("The language service did not return an Object Explorer root."); }
    const session = { sessionId: created.sessionId, root: created.rootNode };
    this.sessions.set(profile.id, session);
    return session;
  }

  public dispose(): void {
    for (const disposable of this.disposables) { disposable.dispose(); }
    for (const session of this.sessions.values()) { void this.service.closeObjectExplorerSession(session.sessionId); }
    this.children.clear();
    this.changedEmitter.dispose();
  }
}

export function selectTopQuery(metadata: ObjectMetadata | undefined): string | undefined {
  if (!metadata?.name) { return undefined; }
  const quote = (value: string) => `[${value.replace(/]/g, ']]')}]`;
  return `SELECT TOP 1000 *\nFROM ${quote(metadata.schema || "dbo")}.${quote(metadata.name)};`;
}

export function sqlIdentifier(metadata: ObjectMetadata | undefined, fallback?: string): string | undefined {
  const name = metadata?.name ?? fallback;
  if (!name) { return undefined; }
  const quote = (value: string) => `[${value.replace(/]/g, "]]")}]`;
  if (metadata?.metadataTypeName?.toLowerCase() === "column" || (!metadata?.schema && name.includes("."))) {
    return quote(name.split(".").pop()!);
  }
  return metadata?.schema ? `${quote(metadata.schema)}.${quote(name)}` : quote(name);
}

function isTable(node: NodeInfo): boolean { return node.nodeType.toLowerCase() === "table"; }
function cacheKey(profileId: string, nodePath: string): string { return `${profileId}\n${nodePath}`; }
function iconFor(type: string): string {
  if (type === "folder") { return "folder"; }
  if (type === "table") { return "table"; }
  if (type === "column") { return "symbol-field"; }
  if (type === "storedprocedure") { return "symbol-method"; }
  if (type === "function") { return "symbol-function"; }
  if (type === "error") { return "error"; }
  return "symbol-misc";
}
