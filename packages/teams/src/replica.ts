import {
  MessageLog,
  type TeamFactory,
  type DeliveredMessage,
  type ToolDef,
  type ToolResult,
  type Transport,
  type WorldHandle,
} from "@firebreak/runtime";
import { PeerTeam } from "./peer";
import {
  BAND_COMMS,
  BROADCAST_COMMS,
  bandRecipients,
  bandTools,
  broadcastRecipients,
  broadcastTools,
  type RoomMembers,
} from "./rooms";

export type Addressing = "mentions" | "broadcast";

/**
 * In-process copy of the Band transport (SPEC §7.7). It isolates what Band's platform adds
 * from what any inter-agent chat adds.
 */
export class LocalRoomTransport implements Transport {
  readonly name: string;
  private world!: WorldHandle;
  private log!: MessageLog;
  private rooms = new Map<string, RoomMembers>();
  private agentIds = new Set<string>();
  private delivery = new Map<string, (m: DeliveredMessage) => void>();
  private pending = new Set<Promise<void>>();
  private cancel = new Map<Promise<void>, () => void>();
  private stopped = false;

  /** `latencyMs` defaults to the match's `replica.latency_ms` setting, read at setup. */
  constructor(private o: { addressing: Addressing; latencyMs?: () => number }) {
    this.name = o.addressing === "mentions" ? "band-replica" : "chat-broadcast";
  }

  async setup(world: WorldHandle, agentIds: string[]): Promise<void> {
    this.world = world;
    this.log = new MessageLog(world);
    this.agentIds = new Set(agentIds);
    if (!this.o.latencyMs) {
      const lat = world.config.replica.latency_ms;
      this.o.latencyMs = lat === "band" ? bandLatencySampler(world.config.seed) : () => lat;
    }
    this.createRoom(agentIds[0]!, "team", agentIds);
  }

  private createRoom(owner: string, name: string, members: string[]): RoomMembers {
    const room = { name, members: new Set([owner, ...members]) };
    this.rooms.set(name, room);
    this.world.emit({
      kind: "event",
      tick: this.world.state().tick,
      t_ms: this.world.now(),
      type: "room_created",
      agent_id: owner,
      payload: { room: name, members: [...room.members] },
    });
    return room;
  }

  private get mentions(): boolean {
    return this.o.addressing === "mentions";
  }

  tools(_agent: string): ToolDef[] {
    return this.mentions ? bandTools() : broadcastTools();
  }

  promptSection(_agent: string): string {
    return this.mentions ? BAND_COMMS : BROADCAST_COMMS;
  }

  onDeliver(agent: string, cb: (m: DeliveredMessage) => void): void {
    this.delivery.set(agent, cb);
  }

  async call(agent: string, tool: string, input: Record<string, unknown>): Promise<ToolResult> {
    if (tool === "send_message")
      return this.send(
        agent,
        String(input.room ?? "team"),
        String(input.text ?? ""),
        (input.mentions as string[]) ?? [],
      );
    if (tool === "create_room") {
      const name = String(input.name ?? "").trim() || `room-${this.rooms.size + 1}`;
      if (this.rooms.has(name)) return { text: `room "${name}" already exists`, isError: true };
      const members = [...new Set([agent, ...((input.participants as string[]) ?? [])])].filter((m) =>
        this.agentIds.has(m),
      );
      const room = this.createRoom(agent, name, members);
      return { text: `created room "${name}" with ${[...room.members].join(", ")}`, isError: false };
    }
    if (tool === "add_participant") {
      // Like Band: any teammate may add anyone to any room, even one they are not in.
      const room = this.rooms.get(String(input.room));
      const who = String(input.agent);
      if (!room) return { text: `no room "${input.room}"`, isError: true };
      if (!this.agentIds.has(who)) return { text: `unknown teammate ${who}`, isError: true };
      room.members.add(who);
      return { text: `${who} is in "${room.name}"`, isError: false };
    }
    return { text: `unknown tool ${tool}`, isError: true };
  }

  private send(agent: string, roomName: string, text: string, mentions: string[]): ToolResult {
    const r = this.mentions
      ? bandRecipients(this.rooms, agent, roomName, mentions)
      : broadcastRecipients(this.rooms, agent, roomName);
    if ("isError" in r) return r;
    const { room, targets } = r;
    const channel = `#${room.name}`;
    const { id, t_ms } = this.log.sent(agent, {
      to: targets,
      channel,
      text,
      meta: { addressed_to: targets },
    });
    // Band puts the mentions in front of the text, last mention first.
    const prefix = [...targets].reverse().map((m) => `@${m} `);
    const shown = this.mentions ? `${prefix.join("")}${text}`.trim() : text;
    for (const to of targets) this.later(() => this.deliver(id, t_ms, agent, to, channel, shown));
    return { text: `sent to ${targets.join(", ")} in ${channel}`, isError: false };
  }

  private deliver(id: string, sent_ms: number, from: string, to: string, channel: string, text: string) {
    const delivered_ms = this.log.delivered(id, to);
    this.delivery.get(to)?.({ id, from, channel, text, sent_ms, delivered_ms, addressed: true });
  }

  /** Run `fn` after a sampled delivery delay; idle() waits for it, teardown() drops it. */
  private later(fn: () => void) {
    if (this.stopped) return;
    let cancel = () => {};
    const p: Promise<void> = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(p);
        this.cancel.delete(p);
        if (!this.world.signal.aborted) fn();
        resolve();
      }, this.o.latencyMs!());
      cancel = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.pending.add(p);
    this.cancel.set(p, cancel);
  }

  /** Waits until no delivery is pending. Returns whether there was anything to wait for. */
  async idle(): Promise<boolean> {
    if (!this.pending.size) return false;
    while (this.pending.size) await Promise.all([...this.pending]);
    return true;
  }

  async teardown(): Promise<void> {
    this.stopped = true;
    for (const p of this.pending) this.cancel.get(p)?.();
    this.pending.clear();
    this.cancel.clear();
  }
}

/**
 * Band's send-to-delivery delay in ms at every 5th percentile (p0, p5, ... p100), measured on
 * 1,448 deliveries in the seven curated recordings of 2026-09-27 (recordings/README.md).
 */
const BAND_LATENCY_QUANTILES = [
  365, 375, 379, 383, 386, 390, 392, 396, 400, 405, 409, 414, 420, 427, 435, 445, 463, 490, 561, 724, 1044,
];

/**
 * Samples a delivery delay from Band's measured distribution. Seeded so a match's delays repeat.
 * (Not the engine's roll(): delays are transport timing, not world randomness.)
 */
export function bandLatencySampler(seed: number): () => number {
  let s = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const q = BAND_LATENCY_QUANTILES;
  return () => {
    const x = next() * (q.length - 1);
    const i = Math.floor(x);
    return Math.round(q[i]! + (q[Math.min(i + 1, q.length - 1)]! - q[i]!) * (x - i));
  };
}

export const bandReplica: TeamFactory = {
  type: "band-replica",
  label: "Band replica (local)",
  usesLlm: true,
  create: () => new PeerTeam({ transport: new LocalRoomTransport({ addressing: "mentions" }), view: "self" }),
};

export const chatBroadcast: TeamFactory = {
  type: "chat-broadcast",
  label: "Broadcast chat (local)",
  usesLlm: true,
  create: () =>
    new PeerTeam({ transport: new LocalRoomTransport({ addressing: "broadcast" }), view: "self" }),
};
