import type {Disposable} from "vscode-jsonrpc";
import type {CodexAppServerClient} from "./CodexAppServerClient";
import type {AccountLoginCompletedNotification} from "./app-server/v2";
import {AppServerConnectionLostError} from "./app-server-recovery/ConnectionLoss";

/** Routes one app-server notification handler to the active login attempts. */
export class CodexLoginCompletions {
    private readonly pending = new Set<CodexLoginCompletion>();
    private subscription: Disposable | undefined;
    private removeConnectionListener: () => void = () => {};

    constructor(private readonly client: CodexAppServerClient) {}

    begin(): CodexLoginCompletion {
        const completion = new CodexLoginCompletion(() => this.release(completion));
        this.pending.add(completion);
        if (this.pending.size === 1) {
            this.subscription = this.client.connection.onNotification("account/login/completed", event => {
                for (const pending of [...this.pending]) pending.receive(event);
            });
            this.removeConnectionListener = this.client.connectionLoss.onLost(() => {
                for (const pending of [...this.pending]) {
                    pending.fail(new AppServerConnectionLostError("account/login/completed"));
                }
            });
        }
        return completion;
    }

    private release(completion: CodexLoginCompletion): void {
        this.pending.delete(completion);
        if (this.pending.size === 0) {
            this.subscription?.dispose();
            this.subscription = undefined;
            this.removeConnectionListener();
        }
    }
}

/** Captures completion before the start response identifies this login. */
export class CodexLoginCompletion {
    readonly result: Promise<AccountLoginCompletedNotification>;
    private resolve!: (event: AccountLoginCompletedNotification) => void;
    private reject!: (error: Error) => void;
    private buffered: AccountLoginCompletedNotification[] = [];
    private loginId: string | null | undefined;
    private disposed = false;
    private didComplete = false;

    constructor(private readonly release: () => void) {
        this.result = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
        // Setup can fail before its caller awaits the completion.
        this.result.catch(() => {});
    }

    get completed(): boolean {
        return this.didComplete;
    }

    select(loginId: string | null): void {
        this.loginId = loginId;
        const buffered = this.buffered;
        this.buffered = [];
        for (const event of buffered) this.receive(event);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.release();
        this.buffered = [];
    }

    fail(error: Error): void {
        this.reject(error);
        this.dispose();
    }

    receive(event: AccountLoginCompletedNotification): void {
        if (this.disposed) return;
        if (this.loginId === undefined) {
            this.buffered.push(event);
        } else if (event.loginId === this.loginId) {
            this.didComplete = true;
            this.resolve(event);
            this.dispose();
        }
    }
}
