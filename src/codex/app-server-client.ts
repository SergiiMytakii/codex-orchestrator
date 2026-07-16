import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export interface JsonRpcError { code: number; message: string; data?: unknown }
export interface AppServerNotification { method: string; params?: unknown }
export interface AppServerClientOptions {
  onServerRequest?: (request: { method: string; params?: unknown; threadId?: string }) => void | Promise<void>;
  onNotification?: (notification: AppServerNotification) => void;
  onActivity?: () => void;
}

export class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notificationWaiters = new Set<{ method: string; predicate: (params: any) => boolean; resolve: (params: any) => void; reject: (error: Error) => void }>();
  private closedError: Error | undefined;
  private readonly listeners = new Set<(notification: AppServerNotification) => void>();
  private readonly activityListeners = new Set<() => void>();

  public constructor(private readonly input: Writable, output: Readable, private readonly options: AppServerClientOptions = {}) {
    const lines = createInterface({ input: output, crlfDelay: Infinity });
    lines.on('line', (line) => this.receive(line));
    lines.on('close', () => this.close(new Error('orchestrator-app-server-protocol-death')));
    output.on('error', (error) => this.close(error));
    input.on('error', (error) => this.close(error));
  }

  public async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closedError) throw this.closedError;
    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
    this.write({ method, id, ...(params === undefined ? {} : { params }) });
    return result;
  }

  public notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  public waitForNotification<T = unknown>(method: string, predicate: (params: T) => boolean = () => true): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<T>((resolve, reject) => this.notificationWaiters.add({ method, predicate, resolve, reject }));
  }

  public onNotification(listener: (notification: AppServerNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onActivity(listener: () => void): () => void {
    this.activityListeners.add(listener);
    return () => this.activityListeners.delete(listener);
  }

  public close(error = new Error('orchestrator-app-server-client-closed')): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const waiter of this.notificationWaiters) waiter.reject(error);
    this.notificationWaiters.clear();
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    this.options.onActivity?.();
    for (const listener of this.activityListeners) listener();
    let message: any;
    try { message = JSON.parse(line); } catch { this.close(new Error('orchestrator-app-server-malformed-json')); return; }
    if (message && typeof message.id === 'number' && ('result' in message || 'error' in message) && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) { this.close(new Error(`orchestrator-app-server-unknown-response:${message.id}`)); return; }
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`app-server ${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message && typeof message.method === 'string' && 'id' in message) { this.handleServerRequest(message); return; }
    if (message && typeof message.method === 'string') {
      const notification = { method: message.method, params: message.params };
      this.options.onNotification?.(notification);
      for (const listener of this.listeners) listener(notification);
      for (const waiter of [...this.notificationWaiters]) if (waiter.method === message.method && waiter.predicate(message.params)) {
        this.notificationWaiters.delete(waiter); waiter.resolve(message.params);
      }
      return;
    }
    this.close(new Error('orchestrator-app-server-malformed-message'));
  }

  private handleServerRequest(message: { id: number | string; method: string; params?: any }): void {
    const resultByMethod: Record<string, unknown> = {
      'item/commandExecution/requestApproval': { decision: 'decline' },
      'item/fileChange/requestApproval': { decision: 'decline' },
      'execCommandApproval': { decision: 'denied' },
      'applyPatchApproval': { decision: 'denied' },
      'item/tool/requestUserInput': { answers: {} },
      'mcpServer/elicitation/request': { action: 'decline', content: null, _meta: null },
      'item/permissions/requestApproval': { permissions: {}, scope: 'turn', strictAutoReview: false },
      'item/tool/call': { contentItems: [], success: false },
    };
    if (message.method in resultByMethod) {
      this.write({ id: message.id, result: resultByMethod[message.method] });
      this.notifyUnexpectedRequest(message);
      return;
    }
    if (['account/chatgptAuthTokens/refresh', 'attestation/generate', 'currentTime/read'].includes(message.method)) {
      this.write({ id: message.id, error: { code: -32001, message: 'orchestrator-server-request-disabled' } });
      this.notifyUnexpectedRequest(message);
      return;
    }
    this.write({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    this.notifyUnexpectedRequest(message);
  }

  private notifyUnexpectedRequest(message: { method: string; params?: any }): void {
    const threadId = typeof message.params?.threadId === 'string' ? message.params.threadId : undefined;
    void Promise.resolve(this.options.onServerRequest?.({ method: message.method, params: message.params, threadId }))
      .catch((error) => this.close(error instanceof Error ? error : new Error(String(error))));
  }

  private write(message: unknown): void {
    if (this.closedError) throw this.closedError;
    this.input.write(`${JSON.stringify(message)}\n`);
  }
}
