import {afterEach, describe, expect, it, vi} from "vitest";
import type {MessageConnection} from "vscode-jsonrpc/node";
import open from "open";
import {CodexAcpClient, type UrlElicitationRequester} from "../../CodexAcpClient";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {AppServerConnectionLostError} from "../../app-server-recovery/ConnectionLoss";
import type {AccountLoginCompletedNotification} from "../../app-server/v2";
import {CodexLoginCompletions} from "../../CodexLoginCompletions";

vi.mock("open", () => ({default: vi.fn().mockResolvedValue(undefined)}));

function fixture() {
    const notifications = new Map<string, (event: AccountLoginCompletedNotification) => void>();
    const disposeListeners = new Set<() => void>();
    const connection = {
        onUnhandledNotification: () => {},
        onRequest: () => {},
        onDispose: (listener: () => void) => {
            disposeListeners.add(listener);
            return {dispose: () => disposeListeners.delete(listener)};
        },
        onNotification: (method: string, listener: (event: AccountLoginCompletedNotification) => void) => {
            notifications.set(method, listener);
            return {dispose: () => { if (notifications.get(method) === listener) notifications.delete(method); }};
        },
        sendRequest: vi.fn(),
    } as unknown as MessageConnection;
    const appServer = new CodexAppServerClient(connection);
    vi.spyOn(appServer, "accountRead").mockResolvedValue({account: null, requiresOpenaiAuth: true});
    const start = vi.spyOn(appServer, "accountLogin").mockResolvedValue(deviceLogin("current"));
    const cancel = vi.spyOn(appServer, "accountLoginCancel").mockResolvedValue({status: "canceled"});
    const client = new CodexAcpClient(appServer);
    return {
        client, appServer, start, cancel,
        complete: (loginId: string | null, success = true) => notifications.get("account/login/completed")?.({
            loginId, success, error: success ? null : "failed", onboardingEntrypoint: null,
        }),
        listenerCount: () => notifications.has("account/login/completed") ? 1 : 0,
        disconnect: () => [...disposeListeners].forEach(listener => listener()),
    };
}

function deviceLogin(loginId: string) {
    return {type: "chatgptDeviceCode" as const, loginId, verificationUrl: "https://example.com/device", userCode: "TEST"};
}

function elicitation() {
    return {
        elicitUrl: vi.fn<UrlElicitationRequester["elicitUrl"]>().mockResolvedValue({action: "accept"}),
        completeElicitation: vi.fn<UrlElicitationRequester["completeElicitation"]>().mockResolvedValue(undefined),
    };
}

describe("Login attempt isolation", {timeout: 5000}, () => {
    afterEach(() => vi.clearAllMocks());

    it("ignores a previous or null completion while the device login waits", async () => {
        const f = fixture();
        const ui = elicitation();
        let settled = false;
        const login = f.client.authenticate({methodId: "chat-gpt-device-code"}, ui).then(result => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => expect(ui.elicitUrl).toHaveBeenCalledOnce());
        f.complete("previous", false);
        f.complete(null, false);
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(ui.completeElicitation).not.toHaveBeenCalled();
        f.complete("current");
        await expect(login).resolves.toBe(true);
        expect(ui.completeElicitation).toHaveBeenCalledOnce();
        expect(f.listenerCount()).toBe(0);
    });

    it("captures its completion before the start response", async () => {
        const f = fixture();
        f.start.mockImplementation(async () => {
            f.complete("old", false);
            f.complete(null, false);
            f.complete("current");
            return deviceLogin("current");
        });
        await expect(f.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation())).resolves.toBe(true);
        expect(f.listenerCount()).toBe(0);
    });

    it("keeps concurrent device logins independent on one connection", async () => {
        const f = fixture();
        f.start.mockResolvedValueOnce(deviceLogin("first")).mockResolvedValueOnce(deviceLogin("second"));
        const firstUi = elicitation();
        const secondUi = elicitation();
        const first = f.client.authenticate({methodId: "chat-gpt-device-code"}, firstUi);
        let secondSettled = false;
        const second = f.client.authenticate({methodId: "chat-gpt-device-code"}, secondUi).then(result => {
            secondSettled = true;
            return result;
        });
        await vi.waitFor(() => expect(secondUi.elicitUrl).toHaveBeenCalledOnce());
        f.complete("first");
        await expect(first).resolves.toBe(true);
        expect(secondSettled).toBe(false);
        expect(f.listenerCount()).toBe(1);
        f.complete("second", false);
        await expect(second).resolves.toBe(false);
        expect(f.listenerCount()).toBe(0);
        expect(f.cancel).not.toHaveBeenCalled();
    });

    it("removes the subscription when login setup fails", async () => {
        const f = fixture();
        f.start.mockRejectedValueOnce(new Error("setup failed"));
        await expect(f.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation())).rejects.toThrow("setup failed");
        expect(f.listenerCount()).toBe(0);
        expect(f.cancel).not.toHaveBeenCalled();
    });

    it("cancels the browser attempt after an opener failure before another login starts", async () => {
        const f = fixture();
        f.start.mockResolvedValueOnce({type: "chatgpt", loginId: "browser", authUrl: "https://example.com/login"});
        vi.mocked(open).mockRejectedValueOnce(new Error("spawn xdg-open ENOENT"));
        await expect(f.client.authenticate({methodId: "chat-gpt"})).rejects.toThrow("spawn xdg-open ENOENT");
        expect(f.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "browser"});
        expect(f.listenerCount()).toBe(0);
        const ui = elicitation();
        const login = f.client.authenticate({methodId: "chat-gpt-device-code"}, ui);
        await vi.waitFor(() => expect(ui.elicitUrl).toHaveBeenCalledOnce());
        f.complete("browser", false);
        f.complete("current");
        await expect(login).resolves.toBe(true);
    });

    it("cancels only its login and closes elicitation when presentation throws", async () => {
        const f = fixture();
        const ui = elicitation();
        ui.elicitUrl.mockImplementation(() => { throw new Error("presentation failed"); });
        await expect(f.client.authenticate({methodId: "chat-gpt-device-code"}, ui)).rejects.toThrow("presentation failed");
        expect(f.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "current"});
        expect(ui.completeElicitation).toHaveBeenCalledOnce();
        expect(f.listenerCount()).toBe(0);
    });

    it.each(["decline", "cancel"] as const)("cancels its login after the client answers %s", async action => {
        const f = fixture();
        const ui = elicitation();
        ui.elicitUrl.mockResolvedValue({action});
        await expect(f.client.authenticate({methodId: "chat-gpt-device-code"}, ui)).rejects.toMatchObject({code: -32800});
        expect(f.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "current"});
        expect(ui.completeElicitation).not.toHaveBeenCalled();
        expect(f.listenerCount()).toBe(0);
    });

    it("releases an unexpected login response and cancels its returned id", async () => {
        const f = fixture();
        f.start.mockResolvedValueOnce({type: "chatgpt", loginId: "unexpected", authUrl: "https://example.com/login"});
        await expect(f.client.authenticate({methodId: "chat-gpt-device-code"}, elicitation())).resolves.toBe(false);
        expect(f.cancel).toHaveBeenCalledExactlyOnceWith({loginId: "unexpected"});
        expect(f.listenerCount()).toBe(0);
    });

    it("closes elicitation and removes the subscription when the connection is lost", async () => {
        const f = fixture();
        const ui = elicitation();
        const login = f.client.authenticate({methodId: "chat-gpt-device-code"}, ui);
        const failed = expect(login).rejects.toBeInstanceOf(AppServerConnectionLostError);
        await vi.waitFor(() => expect(ui.elicitUrl).toHaveBeenCalledOnce());
        f.disconnect();
        await failed;
        expect(ui.completeElicitation).toHaveBeenCalledOnce();
        expect(f.cancel).not.toHaveBeenCalled();
        expect(f.listenerCount()).toBe(0);
    });

    it("keeps the API-key completion without a login id separate", async () => {
        const f = fixture();
        f.start.mockImplementation(async () => {
            f.complete("foreign", false);
            f.complete(null);
            return {type: "apiKey"};
        });
        await expect(f.client.authenticate({methodId: "api-key", _meta: {"api-key": {apiKey: "test"}}})).resolves.toBe(true);
        expect(f.cancel).not.toHaveBeenCalled();
        expect(f.listenerCount()).toBe(0);
    });

    it("cleans up a waiter when its connection was already lost", async () => {
        const f = fixture();
        f.disconnect();
        const completion = new CodexLoginCompletions(f.appServer).begin();
        await expect(completion.result).rejects.toBeInstanceOf(AppServerConnectionLostError);
        expect(f.listenerCount()).toBe(0);
    });
});
