import { describe, expect, it, vi } from "vitest";
import { createWhatsAppDurableInboundReceiveJournal } from "./durable-receive.js";

const mocks = vi.hoisted(() => ({
  queue: {},
  createJournal: vi.fn((_options: unknown) => ({})),
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  createDurableInboundReceiveJournalFromQueue: mocks.createJournal,
}));

vi.mock("../runtime.js", () => ({
  getWhatsAppRuntime: () => ({
    state: {
      resolveStateDir: () => "/tmp/openclaw-state",
      openChannelIngressQueue: () => mocks.queue,
    },
  }),
}));

describe("WhatsApp durable receive policy", () => {
  it("keeps the 450-row bound as retention rather than reject-new admission", () => {
    mocks.createJournal.mockClear();
    createWhatsAppDurableInboundReceiveJournal("default");

    expect(mocks.createJournal).toHaveBeenCalledWith(
      expect.objectContaining({
        queue: mocks.queue,
        retention: expect.objectContaining({ pendingMaxEntries: 450 }),
      }),
    );
    expect(mocks.createJournal.mock.calls[0]?.[0]).not.toHaveProperty("admission");
  });
});
