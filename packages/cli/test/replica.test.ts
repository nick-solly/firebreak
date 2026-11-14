import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRecording, readConfig } from "@firebreak/recorder";
import type { StreamFrame } from "@firebreak/engine";
import {
  jsonSchema,
  resolveConfig,
  type DeliveredMessage,
  type ToolDef,
  type WorldHandle,
} from "@firebreak/runtime";
import { BandTransport, LocalRoomTransport, bandLatencySampler } from "@firebreak/teams";

const AGENTS = ["scout", "ff1", "ff2", "engineer", "rescuer"];
const EOL = "\n";

/** Just enough of a world for a transport: a clock you can move, and the frames it records. */
function fakeWorld() {
  const frames: StreamFrame[] = [];
  let t = 0;
  const world = {
    worldId: "w1-test",
    team: "test",
    config: resolveConfig({ overrides: { seed: 7 } }).config,
    signal: new AbortController().signal,
    now: () => t,
    state: () => ({ tick: 0 }),
    emit: (f: object) => frames.push({ world_id: "w1-test", ...f } as StreamFrame),
  } as unknown as WorldHandle;
  return { world, frames, setTime: (ms: number) => (t = ms) };
}

async function connected(addressing: "mentions" | "broadcast", latencyMs = () => 0) {
  const w = fakeWorld();
  const transport = new LocalRoomTransport({ addressing, latencyMs });
  await transport.setup(w.world, AGENTS);
  const inbox: Record<string, DeliveredMessage[]> = Object.fromEntries(AGENTS.map((a) => [a, []]));
  for (const a of AGENTS) transport.onDeliver(a, (m) => inbox[a]!.push(m));
  return { ...w, transport, inbox };
}

const schemas = (defs: ToolDef[]) =>
  defs.map((d) => ({ name: d.name, description: d.description, input_schema: jsonSchema(d) }));

describe("band-replica transport (control for Band, SPEC §7.7)", () => {
  it("shows the model exactly the same tools and COMMUNICATION text as the Band team", () => {
    const band = new BandTransport();
    const replica = new LocalRoomTransport({ addressing: "mentions", latencyMs: () => 0 });
    for (const agent of ["scout", "ff1", "ff2", "engineer", "rescuer"]) {
      expect(schemas(replica.tools(agent))).toEqual(schemas(band.tools(agent)));
      expect(replica.promptSection(agent)).toBe(band.promptSection(agent));
    }
  });

  it("the shared Band text is what the recorded prompt v3 Band match ran with", () => {
    const db = openRecording(
      join(import.meta.dirname, "../../../recordings/20260927-183409-s11-319n.sqlite"),
    );
    const cfg = readConfig(db) as {
      prompts: Record<string, Record<string, string>>;
      tools: Record<string, Record<string, { name: string }[]>>;
    };
    db.close();
    const world = Object.keys(cfg.prompts).find((w) => w.endsWith("-band"))!;
    const band = new BandTransport();
    const names = new Set(band.tools("ff1").map((t) => t.name));
    for (const agent of ["scout", "ff1", "ff2", "engineer", "rescuer"]) {
      expect(cfg.prompts[world]![agent]).toContain(band.promptSection(agent));
      const recorded = cfg.tools[world]![agent]!.filter((t) => names.has(t.name));
      expect(recorded).toEqual(schemas(band.tools(agent)));
    }
  });

  it("delivers a message only to the mentioned teammates, as Band renders it", async () => {
    const { transport, inbox, frames } = await connected("mentions");
    const res = await transport.call("scout", "send_message", {
      room: "team",
      text: "fire at (3,4)",
      mentions: ["ff1", "ff2"],
    });
    await transport.idle();
    expect(res).toEqual({ text: "sent to ff1, ff2 in #team", isError: false });
    // Band puts the mentions in front of the text, in reverse order (all 582 recorded prompt v3 messages).
    for (const a of ["ff1", "ff2"])
      expect(inbox[a]).toEqual([
        expect.objectContaining({
          from: "scout",
          channel: "#team",
          text: "@ff2 @ff1 fire at (3,4)",
          addressed: true,
        }),
      ]);
    for (const a of ["scout", "engineer", "rescuer"]) expect(inbox[a]).toEqual([]);
    const sent = frames.filter((f) => f.kind === "message");
    expect(sent).toEqual([
      expect.objectContaining({ from: "scout", to: ["ff1", "ff2"], text: "fire at (3,4)" }),
    ]);
    const delivered = frames.filter((f) => f.kind === "delivery" && f.stage === "delivered");
    expect(delivered.map((f) => f.kind === "delivery" && f.recipient)).toEqual(["ff1", "ff2"]);
  });

  it("rejects sends the way Band does", async () => {
    const { transport, inbox, frames } = await connected("mentions");
    const send = (room: string, mentions: string[]) =>
      transport.call("scout", "send_message", { room, text: "hi", mentions });
    expect(await send("nowhere", ["ff1"])).toEqual({ text: 'no room "nowhere". Rooms: team', isError: true });
    expect(await send("team", [])).toEqual({ text: "mention at least one teammate", isError: true });
    expect(await send("team", ["scout"])).toEqual({ text: "mention at least one teammate", isError: true });
    expect(await send("team", ["ff3"])).toEqual({
      text: 'not in "team": ff3. Add them first or use another room.',
      isError: true,
    });
    await transport.idle();
    expect(Object.values(inbox).flat()).toEqual([]);
    expect(frames.filter((f) => f.kind === "message")).toEqual([]);
  });

  it('mentions: ["all"] reaches every other room member', async () => {
    const { transport, inbox } = await connected("mentions");
    expect(
      await transport.call("ff1", "send_message", { room: "#team", text: "@all go", mentions: ["all"] }),
    ).toEqual({
      text: "sent to scout, ff2, engineer, rescuer in #team",
      isError: false,
    });
    await transport.idle();
    expect(inbox.scout![0]!.text).toBe("@rescuer @engineer @ff2 @scout @all go");
    expect(inbox.ff1).toEqual([]);
  });

  it("creates task rooms and adds teammates like Band", async () => {
    const { transport, inbox, frames } = await connected("mentions");
    const call = (agent: string, tool: string, input: Record<string, unknown>) =>
      transport.call(agent, tool, input);
    expect(await call("ff1", "create_room", { name: "fire-3-4", participants: ["ff2", "ff9"] })).toEqual({
      text: 'created room "fire-3-4" with ff1, ff2',
      isError: false,
    });
    expect(await call("ff2", "create_room", { name: "fire-3-4", participants: [] })).toEqual({
      text: 'room "fire-3-4" already exists',
      isError: true,
    });
    const toEngineer = { room: "fire-3-4", text: "need a firebreak", mentions: ["engineer"] };
    expect((await call("ff1", "send_message", toEngineer)).isError).toBe(true);
    expect(await call("ff2", "add_participant", { room: "fire-3-4", agent: "engineer" })).toEqual({
      text: 'engineer is in "fire-3-4"',
      isError: false,
    });
    expect(await call("ff2", "add_participant", { room: "fire-3-4", agent: "ff9" })).toEqual({
      text: "unknown teammate ff9",
      isError: true,
    });
    expect(await call("ff2", "add_participant", { room: "nope", agent: "scout" })).toEqual({
      text: 'no room "nope"',
      isError: true,
    });
    expect((await call("ff1", "send_message", toEngineer)).isError).toBe(false);
    await transport.idle();
    expect(inbox.engineer).toEqual([
      expect.objectContaining({ channel: "#fire-3-4", text: "@engineer need a firebreak" }),
    ]);
    const rooms = frames.filter((f) => f.kind === "event" && f.type === "room_created");
    expect(rooms.map((f) => f.kind === "event" && f.payload)).toEqual([
      expect.objectContaining({ room: "team", members: AGENTS }),
      expect.objectContaining({ room: "fire-3-4", members: ["ff1", "ff2"] }),
    ]);
  });
});

describe("control transports at the end of a match", () => {
  it("drop deliveries still pending at teardown, so nothing is recorded after the match ends", async () => {
    const { transport, inbox, frames } = await connected("mentions", () => 20);
    await transport.call("scout", "send_message", { room: "team", text: "late", mentions: ["ff1"] });
    await transport.teardown();
    await new Promise((r) => setTimeout(r, 40));
    expect(inbox.ff1).toEqual([]);
    expect(frames.filter((f) => f.kind === "delivery")).toEqual([]);
    expect(await transport.idle()).toBe(false);
  });
});

describe("chat-broadcast transport (control for Band, SPEC §7.7)", () => {
  it("delivers every message to everyone else in the room, with no mentions", async () => {
    const { transport, inbox, frames } = await connected("broadcast");
    expect(await transport.call("scout", "send_message", { room: "team", text: "fire at (3,4)" })).toEqual({
      text: "sent to ff1, ff2, engineer, rescuer in #team",
      isError: false,
    });
    await transport.idle();
    for (const a of ["ff1", "ff2", "engineer", "rescuer"])
      expect(inbox[a]).toEqual([
        expect.objectContaining({ from: "scout", text: "fire at (3,4)", addressed: true }),
      ]);
    expect(inbox.scout).toEqual([]);
    expect(frames.filter((f) => f.kind === "message")).toEqual([
      expect.objectContaining({ to: ["ff1", "ff2", "engineer", "rescuer"] }),
    ]);
  });

  it("differs from Band only in how a message is addressed", () => {
    const band = new BandTransport();
    const chat = new LocalRoomTransport({ addressing: "broadcast", latencyMs: () => 0 });
    const [bandSend, ...bandRest] = schemas(band.tools("ff1"));
    const [chatSend, ...chatRest] = schemas(chat.tools("ff1"));
    expect(chatRest).toEqual(bandRest);
    expect(chatSend!.name).toBe("send_message");
    expect(Object.keys(chatSend!.input_schema.properties as object)).toEqual(["room", "text"]);
    expect(chatSend!.description).not.toBe(bandSend!.description);
    const bandLines = band.promptSection("ff1").split(EOL);
    const chatLines = chat.promptSection("ff1").split(EOL);
    expect(chatLines).toHaveLength(bandLines.length);
    const changed = chatLines.flatMap((l, i) => (l === bandLines[i] ? [] : [i]));
    expect(changed).toEqual([2, 3]); // the mention rule and the "who wakes up" line
    expect(chat.promptSection("ff1")).not.toMatch(/mention/i);
  });
});

describe("Band delivery latency for the control teams", () => {
  it("follows the delays measured on Band, and repeats for the same seed", () => {
    const sample = bandLatencySampler(7);
    const xs = Array.from({ length: 10_000 }, sample).sort((a, b) => a - b);
    const q = (p: number) => xs[Math.round(p * (xs.length - 1))]!;
    // Measured on 1,448 deliveries in the seven curated recordings: min 365, p50 409, p90 561, p95 724, max 1044 ms.
    expect(xs[0]).toBeGreaterThanOrEqual(365);
    expect(xs.at(-1)).toBeLessThanOrEqual(1044);
    expect(q(0.5)).toBeGreaterThan(395);
    expect(q(0.5)).toBeLessThan(425);
    expect(q(0.9)).toBeGreaterThan(520);
    expect(q(0.9)).toBeLessThan(610);
    const again = bandLatencySampler(7);
    const other = bandLatencySampler(8);
    const first = Array.from({ length: 20 }, bandLatencySampler(7));
    expect(Array.from({ length: 20 }, again)).toEqual(first);
    expect(Array.from({ length: 20 }, other)).not.toEqual(first);
  });
});
