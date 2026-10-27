import {describe, expect, it} from "vitest";
import type {ClientCapabilities} from "@agentclientprotocol/sdk/unstable";
import {getCodexAuthMethods, getCodexAuthMethodsV2} from "../../CodexAuthMethod";

describe.each(["v1", "v2"] as const)("Auth methods for ACP %s", protocol => {
    function methods(capabilities?: ClientCapabilities, env: NodeJS.ProcessEnv = {}) {
        return protocol === "v1"
            ? getCodexAuthMethods(capabilities, env).map(method => method.id)
            : getCodexAuthMethodsV2(capabilities, env).map(method => method.methodId);
    }

    it("offers device login without a backend browser when the user is elsewhere", () => {
        expect(methods({_meta: {"user-colocated": false}, elicitation: {url: {}}}))
            .toEqual(["api-key", "chat-gpt-device-code"]);
    });

    it("keeps browser login for a local user", () => {
        expect(methods({_meta: {"user-colocated": true}, elicitation: {url: {}}}))
            .toEqual(["api-key", "chat-gpt", "chat-gpt-device-code"]);
    });

    it("preserves browser login when colocation is absent", () => {
        expect(methods()).toEqual(["api-key", "chat-gpt"]);
    });

    it("does not offer device login without URL elicitation", () => {
        expect(methods({_meta: {"user-colocated": false}, elicitation: {form: {}}}))
            .toEqual(["api-key"]);
    });

    it("honors NO_BROWSER even when the user is local", () => {
        expect(methods({_meta: {"user-colocated": true}, elicitation: {url: {}}}, {NO_BROWSER: "1"}))
            .toEqual(["api-key", "chat-gpt-device-code"]);
    });

    it("preserves the separate gateway capability", () => {
        expect(methods({_meta: {"user-colocated": false}, auth: {_meta: {gateway: true}}}))
            .toEqual(["api-key", "gateway"]);
    });
});
