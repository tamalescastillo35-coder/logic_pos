/**
 * Generation-aware Firestore connection controller.
 *
 * Enforces that POS checkout and stock transfers only occur when the Firestore
 * connection is verified live ('ready'). Stale probes from network drops,
 * timeouts, or company switches cannot overwrite newer state.
 */

export type ConnectionStatus = 'checking' | 'ready' | 'offline' | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  generation: number;
  companyId: string | null;
  lastCheckedAt: number | null;
  errorMessage?: string | null;
}

export interface NetworkStatus {
  connected: boolean;
  connectionType?: string;
}

export type ProbeFn = (companyId: string, signal?: AbortSignal) => Promise<void>;

export type SetTimeoutFn = (callback: () => void, ms?: number) => any;
export type ClearTimeoutFn = (timerId: any) => void;

export interface ConnectionControllerOptions {
  probeFn?: ProbeFn;
  probeTimeoutMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  nowFn?: () => number;
  onStateChange?: (state: ConnectionState) => void;
}

export class FirestoreConnectionController {
  private status: ConnectionStatus = 'checking';
  private generation: number = 0;
  private companyId: string | null = null;
  private lastCheckedAt: number | null = null;
  private errorMessage: string | null = null;

  private isNetworkConnected: boolean = true;
  private isDisposed: boolean = false;
  private inFlightAbortController: AbortController | null = null;
  private inFlightTimerId: any = null;

  private readonly probeFn: ProbeFn;
  private readonly probeTimeoutMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly nowFn: () => number;
  private readonly listeners: Set<(state: ConnectionState) => void> = new Set();

  constructor(options: ConnectionControllerOptions = {}) {
    this.probeFn = options.probeFn || (async () => {});
    this.probeTimeoutMs = options.probeTimeoutMs ?? 8000;
    this.setTimeoutFn = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn || ((id) => clearTimeout(id));
    this.nowFn = options.nowFn || (() => Date.now());

    if (options.onStateChange) {
      this.listeners.add(options.onStateChange);
    }
  }

  public getState(): ConnectionState {
    return {
      status: this.status,
      generation: this.generation,
      companyId: this.companyId,
      lastCheckedAt: this.lastCheckedAt,
      errorMessage: this.errorMessage,
    };
  }

  public subscribe(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  public setCompanyId(companyId: string | null): void {
    if (this.isDisposed) return;
    if (this.companyId === companyId && this.status === 'ready') return;

    this.companyId = companyId;
    this.cancelInFlight();

    if (!companyId) {
      this.updateState({
        status: 'offline',
        errorMessage: 'No hay empresa activa seleccionada',
      });
      return;
    }

    this.startProbe({ force: true });
  }

  public notifyNetwork(status: NetworkStatus): void {
    if (this.isDisposed) return;
    this.isNetworkConnected = status.connected;

    if (!status.connected) {
      this.cancelInFlight();
      this.updateState({
        status: 'offline',
        errorMessage: 'Sin conexión a internet',
      });
      return;
    }

    // Network restored
    if (this.status !== 'ready' && this.companyId) {
      this.startProbe({ force: true });
    }
  }

  /**
   * The native network plugin could not report a status at all (for example an older Android
   * build that predates the plugin). That is "unknown", not "offline": assume connectivity and
   * let the Firestore probe decide, exactly as the app behaved before the plugin existed.
   */
  public notifyNetworkUnknown(): void {
    if (this.isDisposed) return;
    this.isNetworkConnected = true;
    if (this.status !== 'ready' && this.companyId) {
      this.startProbe({ force: true });
    }
  }

  public retry(): void {
    if (this.isDisposed) return;
    // A manual retry (or a resume from background) must be able to recover from a false
    // "offline" report — e.g. Network.getStatus() resolving late with a stale value, or a lost
    // networkStatusChange event. The probe itself verifies connectivity, so clear the flag and
    // let it run instead of waiting for a "connected: true" event that may never arrive.
    this.isNetworkConnected = true;
    this.startProbe({ force: true });
  }

  public startProbe(options: { force?: boolean } = {}): void {
    if (this.isDisposed) return;

    if (!this.companyId) {
      this.updateState({
        status: 'offline',
        errorMessage: 'No hay empresa activa',
      });
      return;
    }

    if (!this.isNetworkConnected) {
      this.updateState({
        status: 'offline',
        errorMessage: 'Sin conexión a internet',
      });
      return;
    }

    // Duplicate in-flight probe suppression
    if (this.status === 'checking' && !options.force) {
      return;
    }

    this.cancelInFlight();

    const currentGen = ++this.generation;
    const targetCompanyId = this.companyId;
    const abortController = new AbortController();
    this.inFlightAbortController = abortController;

    this.updateState({
      status: 'checking',
      errorMessage: null,
    });

    // Bounded timeout
    this.inFlightTimerId = this.setTimeoutFn(() => {
      if (this.isDisposed || this.generation !== currentGen) return;
      abortController.abort();
      this.updateState({
        status: 'offline',
        errorMessage: 'Tiempo de espera agotado al verificar conexión con Firestore',
      });
    }, this.probeTimeoutMs);

    this.probeFn(targetCompanyId, abortController.signal)
      .then(() => {
        if (this.isDisposed || this.generation !== currentGen) {
          return;
        }
        this.clearTimeoutFn(this.inFlightTimerId!);
        this.inFlightTimerId = null;
        this.inFlightAbortController = null;
        this.lastCheckedAt = this.nowFn();
        this.updateState({
          status: 'ready',
          errorMessage: null,
        });
      })
      .catch((err: unknown) => {
        if (this.isDisposed || this.generation !== currentGen) {
          return;
        }
        this.clearTimeoutFn(this.inFlightTimerId!);
        this.inFlightTimerId = null;
        this.inFlightAbortController = null;

        const isOffline =
          abortController.signal.aborted ||
          (typeof err === 'object' &&
            err !== null &&
            ('code' in err &&
              (err.code === 'unavailable' ||
                err.code === 'firestore/unavailable' ||
                err.code === 'deadline-exceeded' ||
                err.code === 'failed-precondition')));

        const message = err instanceof Error ? err.message : String(err);

        this.updateState({
          status: isOffline ? 'offline' : 'error',
          errorMessage: message,
        });
      });
  }

  public dispose(): void {
    this.isDisposed = true;
    this.cancelInFlight();
    this.listeners.clear();
  }

  private cancelInFlight(): void {
    if (this.inFlightTimerId) {
      this.clearTimeoutFn(this.inFlightTimerId);
      this.inFlightTimerId = null;
    }
    if (this.inFlightAbortController) {
      this.inFlightAbortController.abort();
      this.inFlightAbortController = null;
    }
  }

  private updateState(partial: Partial<ConnectionState>): void {
    if (partial.status !== undefined) this.status = partial.status;
    if (partial.errorMessage !== undefined) this.errorMessage = partial.errorMessage;
    if (partial.lastCheckedAt !== undefined) this.lastCheckedAt = partial.lastCheckedAt;

    const snapshot = this.getState();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
