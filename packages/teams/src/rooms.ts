import { z } from "zod";
import type { ToolDef, ToolResult } from "@firebreak/runtime";

/**
 * Band's room tools and COMMUNICATION text (SPEC §7.3). Shared with the band-replica control team
 * (SPEC §7.7), so both teams show the model exactly the same text. Any change here changes both.
 */
export const BAND_COMMS = `You are connected to your teammates through Band, a messaging platform for agents.
- There is a team room called "team" with all 5 of you. You can also create smaller rooms for a specific task (e.g. "fire-12-7" with ff1 and ff2) and add teammates to them.
- Every message must @mention at least one teammate, and ONLY the mentioned teammates receive it. Use mentions: ["all"] to reach everyone in the room.
- Mention exactly who needs to know. Do not spam: every message wakes up its recipients.
- Messages arrive in about a second. Share what matters: fires you see, civilians, debris, the wind forecast, and what you are doing next.`;

export function bandTools(): ToolDef[] {
  return [
    {
      name: "send_message",
      description:
        'Post a message in a Band room. Only the teammates you @mention receive it. mentions: teammate ids (scout, ff1, ff2, engineer, rescuer) or ["all"].',
      schema: {
        room: z.string().describe('room name, e.g. "team"'),
        text: z.string(),
        mentions: z.array(z.string()).min(1),
      },
    },
    {
      name: "create_room",
      description: "Create a new Band room for a task and add teammates to it (you are added automatically).",
      schema: {
        name: z.string().describe('short name, e.g. "fire-12-7"'),
        participants: z.array(z.string()),
      },
    },
    {
      name: "add_participant",
      description: "Add a teammate to an existing room.",
      schema: { room: z.string(), agent: z.string() },
    },
  ];
}

export interface RoomMembers {
  name: string;
  members: Set<string>;
}

/** The room a send_message goes to; the sender must be a member. */
function senderRoom<R extends RoomMembers>(
  rooms: Map<string, R>,
  agent: string,
  roomName: string,
): R | ToolResult {
  const room = rooms.get(roomName.replace(/^#/, ""));
  if (!room) return { text: `no room "${roomName}". Rooms: ${[...rooms.keys()].join(", ")}`, isError: true };
  if (!room.members.has(agent)) return { text: `you are not in "${room.name}"`, isError: true };
  return room;
}

/**
 * Who receives a send_message, by Band's rules (SPEC §7.3): the sender must be in the room,
 * every mentioned teammate must be too, and at least one teammate must be mentioned.
 * `["all"]` means every other room member. Returns an error result when the send is rejected.
 */
export function bandRecipients<R extends RoomMembers>(
  rooms: Map<string, R>,
  agent: string,
  roomName: string,
  mentions: string[],
): { room: R; targets: string[] } | ToolResult {
  const room = senderRoom(rooms, agent, roomName);
  if ("isError" in room) return room;
  const targets = mentions.includes("all")
    ? [...room.members].filter((m) => m !== agent)
    : [...new Set(mentions)].filter((m) => m !== agent);
  const unknown = targets.filter((m) => !room.members.has(m));
  if (unknown.length)
    return {
      text: `not in "${room.name}": ${unknown.join(", ")}. Add them first or use another room.`,
      isError: true,
    };
  if (!targets.length) return { text: "mention at least one teammate", isError: true };
  return { room, targets };
}

/** The two lines of BAND_COMMS that describe mention-only delivery, and their broadcast versions. */
const MENTION_RULE = `- Every message must @mention at least one teammate, and ONLY the mentioned teammates receive it. Use mentions: ["all"] to reach everyone in the room.`;
const MENTION_SPAM = `- Mention exactly who needs to know. Do not spam: every message wakes up its recipients.`;

/**
 * BAND_COMMS for the chat-broadcast control team (SPEC §7.7): the same text, except that every
 * message reaches everyone in the room. Built from BAND_COMMS so the other lines cannot drift.
 */
export const BROADCAST_COMMS = BAND_COMMS.replace(
  MENTION_RULE,
  "- Every message is delivered to everyone in the room.",
).replace(MENTION_SPAM, "- Do not spam: every message wakes up everyone in the room.");

export function broadcastTools(): ToolDef[] {
  const [send, ...rest] = bandTools();
  return [
    {
      name: send!.name,
      description: "Post a message in a Band room. Every teammate in the room receives it.",
      schema: { room: send!.schema.room!, text: send!.schema.text! },
    },
    ...rest,
  ];
}

/** Who receives a send_message when every room member gets every message. */
export function broadcastRecipients<R extends RoomMembers>(
  rooms: Map<string, R>,
  agent: string,
  roomName: string,
): { room: R; targets: string[] } | ToolResult {
  const room = senderRoom(rooms, agent, roomName);
  if ("isError" in room) return room;
  const targets = [...room.members].filter((m) => m !== agent);
  if (!targets.length) return { text: `nobody else is in "${room.name}"`, isError: true };
  return { room, targets };
}
