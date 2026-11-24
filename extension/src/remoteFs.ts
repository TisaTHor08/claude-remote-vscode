import * as vscode from 'vscode';
import { EventEmitter } from 'events';
import { ProjectConnection, ConnStatus, RemoteError, KeysProvider, deriveKeys, parseKeys, serializeKeys, StoredKeys } from './core';

export const SCHEME = 'claude-remote';
export interface Relay { url: string; token: string }

/** Crée le fournisseur de clés d'un projet : réutilise les clés mémorisées (SecretStorage), sinon demande le mot de passe. */
export function makeKeysProvider(secrets: vscode.SecretStorage, projectId: string, label: string, presetPassword?: string): KeysProvider {
  let lock: Promise<unknown> = Promise.resolve();
  return (salt, retry) => {
    const run = async () => {
      const k = `claudeRemote.viewer.${projectId}`;
      if (presetPassword !== undefined) {
        if (retry) { await secrets.delete(k); return undefined; } // mot de passe fourni par programme et refusé : pas de boucle
        const keys = await deriveKeys(presetPassword, salt);
        await secrets.store(k, JSON.stringify(serializeKeys(keys)));
        return keys;
      }
      if (!retry) {
        const raw = await secrets.get(k);
        if (raw) { const s = JSON.parse(raw) as StoredKeys; if (s.salt === salt) return parseKeys(s); }
      }
      await secrets.delete(k);
      const pw = await vscode.window.showInputBox({
        title: `Claude Remote — « ${label} »`,
        prompt: retry ? 'Mot de passe incorrect, réessaie.' : 'Mot de passe défini lors de la synchronisation de ce projet.',
        password: true, ignoreFocusOut: true,
      });
      if (!pw) return undefined;
      const keys = await deriveKeys(pw, salt);
      await secrets.store(k, JSON.stringify(serializeKeys(keys)));
      return keys;
    };
    const p = lock.then(run, run);
    lock = p.catch(() => undefined);
    return p;
  };
}

/** Système de fichiers virtuel `claude-remote://<projet>/…` : chaque opération est relayée, chiffrée, vers la machine hôte. */
export class RemoteFs implements vscode.FileSystemProvider {
  private conns = new Map<string, ProjectConnection>();
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;
  readonly statusEmitter = new EventEmitter();

  constructor(private secrets: vscode.SecretStorage, private getRelay: () => Promise<Relay | undefined>, private log: (m: string) => void) {}

  async conn(authority: string): Promise<ProjectConnection> {
    let c = this.conns.get(authority);
    if (c && c.state !== 'closed' && c.state !== 'auth-failed') return c;
    c?.stop();
    const relay = await this.getRelay();
    if (!relay) throw vscode.FileSystemError.NoPermissions('Relais non configuré (commande « Claude Remote: Configurer le relais »).');
    c = new ProjectConnection(relay.url, relay.token, authority, makeKeysProvider(this.secrets, authority, authority));
    c.on('status', (s: ConnStatus, d?: string) => { this.log(`[${authority}] ${s}${d ? ' — ' + d : ''}`); this.statusEmitter.emit('status', authority, s, d); });
    c.on('event', (e: any) => {
      if (e?.k !== 'fs') return;
      this._emitter.fire((e.changes as Array<[string, number]>).map(([p, t]) => ({ type: t as vscode.FileChangeType, uri: vscode.Uri.from({ scheme: SCHEME, authority, path: p }) })));
    });
    this.conns.set(authority, c);
    c.start();
    return c;
  }
  existing(authority: string) { return this.conns.get(authority); }
  dispose() { for (const c of this.conns.values()) c.stop(); this.conns.clear(); }

  private async call<T>(uri: vscode.Uri, op: string, a: Record<string, unknown>): Promise<T> {
    const c = await this.conn(uri.authority);
    try { return await c.request<T>(op, a); }
    catch (e: any) {
      if (e instanceof RemoteError) {
        switch (e.code) {
          case 'FileNotFound': throw vscode.FileSystemError.FileNotFound(uri);
          case 'FileExists': throw vscode.FileSystemError.FileExists(uri);
          case 'NoPermissions': throw vscode.FileSystemError.NoPermissions(e.message);
          default: throw vscode.FileSystemError.Unavailable(e.message);
        }
      }
      throw e;
    }
  }

  watch(): vscode.Disposable { return new vscode.Disposable(() => undefined); }
  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const s = await this.call<{ type: number; size: number; ctime: number; mtime: number }>(uri, 'fs.stat', { path: uri.path });
    return { type: s.type, size: s.size, ctime: s.ctime, mtime: s.mtime };
  }
  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> { return this.call(uri, 'fs.readDirectory', { path: uri.path }); }
  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const r = await this.call<{ data: string }>(uri, 'fs.readFile', { path: uri.path });
    return Buffer.from(r.data, 'base64');
  }
  async writeFile(uri: vscode.Uri, content: Uint8Array, o: { create: boolean; overwrite: boolean }): Promise<void> {
    await this.call(uri, 'fs.writeFile', { path: uri.path, data: Buffer.from(content).toString('base64'), create: o.create, overwrite: o.overwrite });
  }
  async delete(uri: vscode.Uri, o: { recursive: boolean }): Promise<void> { await this.call(uri, 'fs.delete', { path: uri.path, recursive: o.recursive }); }
  async rename(a: vscode.Uri, b: vscode.Uri, o: { overwrite: boolean }): Promise<void> { await this.call(a, 'fs.rename', { from: a.path, to: b.path, overwrite: o.overwrite }); }
  async createDirectory(uri: vscode.Uri): Promise<void> { await this.call(uri, 'fs.mkdir', { path: uri.path }); }
}
