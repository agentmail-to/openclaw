import { describe, expect, it, vi } from "vitest";
import {
  normalizeAgentMailTarget,
  parseAgentMailMessageTarget,
  reconcileAgentMailUnknownSend,
  sendAgentMailReply,
} from "./send.js";

const reply = vi.fn(async () => ({ messageId: "reply_1", threadId: "thread_1" }));
const loadAgentMailOutboundAttachments = vi.hoisted(() =>
  vi.fn(async () => [
    {
      filename: "proof.txt",
      contentType: "text/plain",
      contentDisposition: "attachment",
      content: "cHJvb2Y=",
    },
  ]),
);

vi.mock("./media.js", () => ({
  loadAgentMailOutboundAttachments,
}));

describe("AgentMail reply-only outbound", () => {
  it("accepts only message targets", () => {
    expect(normalizeAgentMailTarget("message:msg_123")).toBe("message:msg_123");
    expect(normalizeAgentMailTarget("message:<rfc-message@example.com>")).toBe(
      "message:<rfc-message@example.com>",
    );
    expect(normalizeAgentMailTarget("message:bad id")).toBeNull();
    expect(normalizeAgentMailTarget("thread:thread_1")).toBeNull();
    expect(normalizeAgentMailTarget("person@example.com")).toBeNull();
    expect(() => parseAgentMailMessageTarget("person@example.com")).toThrow("message:<messageId>");
  });

  it("replies to the triggering message once without recipient overrides", async () => {
    reply.mockClear();
    const onPlatformSendDispatch = vi.fn(async () => undefined);
    await sendAgentMailReply(
      {
        cfg: {
          channels: {
            agentmail: {
              apiKey: "key",
              inboxId: "inbox_1",
              mediaMaxMb: 20,
            },
          },
        },
        to: "message:msg_1",
        text: "Hello",
        payload: { text: "Hello", mediaUrls: ["file:///proof.txt"] },
        replyToId: "msg_1",
        replyToIdSource: "implicit",
        deliveryQueueId: "queue_1",
        onPlatformSendDispatch,
      },
      { client: { inboxes: { messages: { reply } } } as never },
    );

    expect(onPlatformSendDispatch).toHaveBeenCalledOnce();
    expect(reply).toHaveBeenCalledOnce();
    const [inboxId, messageId, request, requestOptions] = reply.mock.calls[0]!;
    expect(inboxId).toBe("inbox_1");
    expect(messageId).toBe("msg_1");
    expect(request).toEqual({
      text: "Hello",
      attachments: [expect.objectContaining({ filename: "proof.txt" })],
      replyAll: false,
    });
    expect(request).not.toHaveProperty("to");
    expect(request).not.toHaveProperty("cc");
    expect(request).not.toHaveProperty("bcc");
    expect(request).not.toHaveProperty("replyTo");
    expect(requestOptions.idempotencyKey).toMatch(/^openclaw-agentmail-[a-f0-9]{64}$/u);
  });

  it("rejects a different target than the active turn's triggering message", async () => {
    await expect(
      sendAgentMailReply(
        {
          cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
          to: "message:msg_b",
          text: "Wrong recipient",
          replyToId: "msg_a",
          replyToIdSource: "implicit",
          deliveryQueueId: "queue_1",
        },
        { client: { inboxes: { messages: { reply } } } as never },
      ),
    ).rejects.toThrow("triggering message");
  });

  it("rejects explicit and proactive message targets", async () => {
    const base = {
      cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
      to: "message:msg_1",
      text: "Not an automatic source reply",
      deliveryQueueId: "queue_1",
    };
    await expect(
      sendAgentMailReply(
        { ...base, replyToId: "msg_1", replyToIdSource: "explicit" },
        { client: { inboxes: { messages: { reply } } } as never },
      ),
    ).rejects.toThrow("triggering message");
    await expect(
      sendAgentMailReply(base, {
        client: { inboxes: { messages: { reply } } } as never,
      }),
    ).rejects.toThrow("triggering message");
  });

  it("refuses delivery without a durable queue id", async () => {
    await expect(
      sendAgentMailReply(
        {
          cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
          to: "message:msg_1",
          text: "Hello",
          replyToId: "msg_1",
          replyToIdSource: "implicit",
        },
        { client: { inboxes: { messages: { reply } } } as never },
      ),
    ).rejects.toThrow("durable OpenClaw delivery queue ID");
  });

  it("reconciles an unknown send with the same queue-derived idempotency key", async () => {
    reply.mockClear();
    loadAgentMailOutboundAttachments.mockClear();
    const now = 10_000;
    const mediaReadFile = vi.fn(async () => Buffer.from("proof"));
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_1",
        accountId: "default",
        enqueuedAt: now - 1_000,
        retryCount: 1,
        effectiveReplyToId: "msg_1",
        payloads: [{ text: "Hello", mediaUrls: ["file:///proof.txt"] }],
        mediaAccess: { localRoots: ["/"] },
        mediaLocalRoots: ["/"],
        mediaReadFile,
      },
      { client: { inboxes: { messages: { reply } } } as never, now: () => now },
    );
    expect(result.status).toBe("sent");
    expect(loadAgentMailOutboundAttachments).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaAccess: { localRoots: ["/"] },
        mediaLocalRoots: ["/"],
        mediaReadFile,
      }),
    );
    expect(reply.mock.calls[0]?.[3]).toEqual({
      idempotencyKey: expect.stringMatching(/^openclaw-agentmail-[a-f0-9]{64}$/u),
    });
  });

  it("fails closed before AgentMail's idempotency key can expire", async () => {
    reply.mockClear();
    loadAgentMailOutboundAttachments.mockClear();
    const now = 24 * 60 * 60 * 1000;
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_1",
        accountId: "default",
        enqueuedAt: 0,
        platformSendStartedAt: 60 * 60 * 1000,
        retryCount: 1,
        effectiveReplyToId: "msg_1",
        payloads: [{ text: "Hello" }],
      },
      { client: { inboxes: { messages: { reply } } } as never, now: () => now },
    );

    expect(result).toEqual({
      status: "unresolved",
      error: "AgentMail recovery is too close to the provider idempotency-key expiry",
      retryable: false,
    });
    expect(reply).not.toHaveBeenCalled();
    expect(loadAgentMailOutboundAttachments).not.toHaveBeenCalled();
  });

  it("refuses recovery when the persisted reply target differs", async () => {
    const now = 10_000;
    const result = await reconcileAgentMailUnknownSend(
      {
        cfg: { channels: { agentmail: { apiKey: "key", inboxId: "inbox_1" } } },
        queueId: "queue_1",
        channel: "agentmail",
        to: "message:msg_b",
        accountId: "default",
        enqueuedAt: now - 1_000,
        retryCount: 1,
        effectiveReplyToId: "msg_a",
        payloads: [{ text: "Hello" }],
      },
      { client: { inboxes: { messages: { reply } } } as never, now: () => now },
    );
    expect(result).toEqual({
      status: "unresolved",
      error: "AgentMail recovery target is not bound to its triggering message",
      retryable: false,
    });
  });
});
