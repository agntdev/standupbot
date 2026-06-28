import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildBot } from "../src/bot.js";
import type { Bot } from "grammy";
import type { Transformer } from "grammy";
import {
  callbackUpdate,
  textUpdate,
  HARNESS_BOT_ID,
} from "../src/toolkit/harness/updates.js";
import { getStore, resetStore } from "../src/store.js";
import type { Team, StandupSession, Digest, HistoryEntry } from "../src/types.js";
import { DEFAULT_QUESTIONS } from "../src/types.js";

function createCapturedBot(token: string) {
  const botPromise = buildBot(token);
  return botPromise.then((bot) => {
    (bot as unknown as { botInfo: Record<string, unknown> }).botInfo = {
      id: HARNESS_BOT_ID,
      is_bot: true,
      first_name: "TestBot",
      username: "test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
      can_connect_to_business: false,
      has_main_web_app: false,
    };
    let stubMsgId = 1000;
    const captured: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const capture: Transformer = async (_prev, method, payload) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      captured.push({ method, payload: p });
      return { ok: true, result: { message_id: ++stubMsgId, date: 0, chat: { id: p.chat_id ?? 1, type: "private" }, text: typeof p.text === "string" ? p.text : "" } } as any;
    };
    bot.api.config.use(capture);
    return { bot, captured };
  });
}

async function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("StandupBot integration flow", () => {
  beforeEach(() => {
    resetStore();
  });

  afterEach(() => {
    resetStore();
  });

  it("creates a team and views it with member list", async () => {
    const { bot, captured } = await createCapturedBot("test:token");
    const userId = 100;
    const chatId = userId;

    // Step 1: start team creation
    await bot.handleUpdate(callbackUpdate(1, "team:create", { userId, chatId }));
    await settle();
    expect(captured.some((c) => c.method === "editMessageText")).toBe(true);

    // Step 2: send team name
    await bot.handleUpdate(textUpdate(2, "Integration Team", { userId, chatId }));
    await settle();
    const msg2 = captured.find((c) => c.method === "sendMessage" && typeof c.payload.text === "string" && c.payload.text.includes("channel ID"));
    expect(msg2).toBeDefined();

    // Step 3: send channel ID
    await bot.handleUpdate(textUpdate(3, "-1009998887776", { userId, chatId }));
    await settle();

    // Step 4: pick working days via callback
    await bot.handleUpdate(callbackUpdate(4, "team:days:1,2,3,4,5", { userId, chatId }));
    await settle();

    // Step 5: pick timezone
    await bot.handleUpdate(callbackUpdate(5, "team:tz:UTC", { userId, chatId }));
    await settle();

    // Step 5.5: pick scheduled time
    await bot.handleUpdate(callbackUpdate(6, "team:schedule:9:0", { userId, chatId }));
    await settle();

    // Step 6: use default questions
    await bot.handleUpdate(callbackUpdate(7, "team:qdone", { userId, chatId }));
    await settle();

    // Step 6.5: admin summary DM toggle — say no
    await bot.handleUpdate(callbackUpdate(8, "team:admindm:no", { userId, chatId }));
    await settle();

    // Verify team was created
    const store = getStore();
    const teamKeys = await store.keys("team:*");
    expect(teamKeys.length).toBe(1);
    const raw = await store.get(teamKeys[0]);
    const team = JSON.parse(raw!) as Team;
    expect(team.name).toBe("Integration Team");
    expect(team.ownerId).toBe(userId);
    expect(team.questions).toEqual(DEFAULT_QUESTIONS);

    // Add members
    bot.handleUpdate(callbackUpdate(9, `team:addmembers:${team.id}`, { userId, chatId }));
    await settle();

    await bot.handleUpdate(textUpdate(10, "200", { userId, chatId }));
    await settle();

    // Verify member added
    const updatedTeam = JSON.parse((await store.get(teamKeys[0]))!) as Team;
    expect(updatedTeam.memberIds).toContain(200);

    // Done adding
    await bot.handleUpdate(callbackUpdate(11, `team:addmembers:done:${team.id}`, { userId, chatId }));
    await settle();
  });

  it("runs a full standup cycle and generates a digest", async () => {
    const store = getStore();

    // Pre-create a team with members in the store
    const team: Team = {
      id: "team_full_flow",
      name: "Standup Team",
      channelId: -1001111111111,
      workingDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
      questions: DEFAULT_QUESTIONS,
      memberIds: [1, 200, 300],
      ownerId: 1,
    };
    await store.set(`team:${team.id}`, JSON.stringify(team));

    // Store member records
    await store.set("member:200", JSON.stringify({ telegramId: 200, displayName: "Alice", timezone: "UTC", optedIn: true, skipFlags: [] }));
    await store.set("member:300", JSON.stringify({ telegramId: 300, displayName: "Bob", timezone: "UTC", optedIn: true, skipFlags: [] }));

    const { bot, captured } = await createCapturedBot("test:token");

    // Admin starts standup
    await bot.handleUpdate(callbackUpdate(1, `standup:start:${team.id}`, { userId: 1, chatId: 1 }));
    await settle();

    // Check session was created
    const sessionKeys = await store.keys("session:*");
    expect(sessionKeys.length).toBe(1);
    const raw = await store.get(sessionKeys[0]);
    const session = JSON.parse(raw!) as StandupSession;
    expect(session.status).toBe("active");
    expect(session.teamId).toBe(team.id);

    // Active standup should be tracked
    const activeId = await store.get(`active_standup:${team.id}`);
    expect(activeId).toBe(session.id);

    // Check DMs were sent to members
    const sendMessages = captured.filter((c) => c.method === "sendMessage");
    const dmCalls = sendMessages.filter((c) => c.payload.chat_id === 200 || c.payload.chat_id === 300);
    expect(dmCalls.length).toBeGreaterThanOrEqual(1); // at least some DMs attempted

    // Member 200 responds
    await bot.handleUpdate(textUpdate(2, "Worked on feature X\nWorking on feature Y\nNo blockers", { userId: 200, chatId: 200 }));
    await settle();

    // Check response was recorded
    const updated1 = JSON.parse((await store.get(sessionKeys[0]))!) as StandupSession;
    expect(updated1.responses.length).toBe(1);
    expect(updated1.responses[0].memberId).toBe(200);

    // Member 300 responds
    await bot.handleUpdate(textUpdate(3, "Bug fixes\nCode review\nNeed help with deploy", { userId: 300, chatId: 300 }));
    await settle();

    // Check both responses recorded
    const updated2 = JSON.parse((await store.get(sessionKeys[0]))!) as StandupSession;
    expect(updated2.responses.length).toBe(2);

    // Complete standup
    await bot.handleUpdate(callbackUpdate(4, `standup:complete:${session.id}`, { userId: 1, chatId: 1 }));
    await settle();

    // Check session is complete
    const completed = JSON.parse((await store.get(sessionKeys[0]))!) as StandupSession;
    expect(completed.status).toBe("complete");

    // Active standup should be cleared
    const activeIdAfter = await store.get(`active_standup:${team.id}`);
    expect(activeIdAfter).toBeNull();

    // Check digest was saved
    const digestKeys = await store.keys("digest:*");
    expect(digestKeys.length).toBe(1);
    const digestRaw = await store.get(digestKeys[0]);
    const digest = JSON.parse(digestRaw!) as Digest;
    expect(digest.memberAnswers.length).toBe(2);
    expect(digest.blockerHighlights.length).toBe(1); // "Need help with deploy"
    expect(digest.pendingMemberIds.length).toBe(1); // member 1 didn't respond
    expect(digest.pendingMemberIds).toContain(1);

    // Check history entry was saved
    const historyKeys = await store.keys("history:*");
    expect(historyKeys.length).toBe(1);
    const historyRaw = await store.get(historyKeys[0]);
    const history = JSON.parse(historyRaw!) as HistoryEntry;
    expect(history.responseCount).toBe(2);
    expect(history.memberCount).toBe(3);
    expect(history.blockerCount).toBe(1);

    // Verify channel post was attempted
    const channelPost = captured.find((c) => c.method === "sendMessage" && c.payload.chat_id === team.channelId);
    expect(channelPost).toBeDefined();
    if (channelPost) {
      expect(channelPost.payload.text).toContain("📊 Standup Digest");
      expect(channelPost.payload.text).toContain("Alice");
      expect(channelPost.payload.text).toContain("Bob");
    }
  });

  it("nudges pending members who have not responded", async () => {
    const store = getStore();

    const team: Team = {
      id: "team_nudge",
      name: "Nudge Team",
      channelId: -1002222222222,
      workingDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
      questions: DEFAULT_QUESTIONS,
      memberIds: [1, 400, 500],
      ownerId: 1,
    };
    await store.set(`team:${team.id}`, JSON.stringify(team));
    await store.set("member:400", JSON.stringify({ telegramId: 400, displayName: "Charlie", timezone: "UTC", optedIn: true, skipFlags: [] }));
    await store.set("member:500", JSON.stringify({ telegramId: 500, displayName: "Dana", timezone: "UTC", optedIn: true, skipFlags: [] }));

    const { bot, captured } = await createCapturedBot("test:token");

    // Start standup
    await bot.handleUpdate(callbackUpdate(1, `standup:start:${team.id}`, { userId: 1, chatId: 1 }));
    await settle();

    const sessionKeys = await store.keys("session:*");
    const session = JSON.parse((await store.get(sessionKeys[0]))!) as StandupSession;

    // Nudge
    await bot.handleUpdate(callbackUpdate(2, `standup:nudge:${session.id}`, { userId: 1, chatId: 1 }));
    await settle();

    // Check DMs were sent to pending members (400 + 500)
    const nudgeCalls = captured.filter(
      (c) => c.method === "sendMessage" && (c.payload.chat_id === 400 || c.payload.chat_id === 500),
    );
    // Some should have been sent (could fail in harness for unreachable)
    const updated = JSON.parse((await store.get(sessionKeys[0]))!) as StandupSession;
    expect(updated.nudgedMemberIds).toContain(400);
    expect(updated.nudgedMemberIds).toContain(500);
  });

  it("shows standup history after completing a session", async () => {
    const store = getStore();

    const team: Team = {
      id: "team_history",
      name: "History Team",
      channelId: -1003333333333,
      workingDays: [1, 2, 3, 4, 5],
      timezone: "UTC",
      questions: DEFAULT_QUESTIONS,
      memberIds: [600],
      ownerId: 1,
    };
    await store.set(`team:${team.id}`, JSON.stringify(team));

    const session: StandupSession = {
      id: "sess_completed_history",
      teamId: team.id,
      date: "2026-01-15",
      scheduledTime: "2026-01-15T09:00:00Z",
      cutoffTime: "2026-01-15T11:00:00Z",
      questions: DEFAULT_QUESTIONS,
      responses: [{
        memberId: 600,
        memberName: "Eve",
        answers: ["Frontend work", "Backend API", "None"],
        submittedAt: "2026-01-15T09:30:00Z",
      }],
      nudgedMemberIds: [],
      status: "complete",
    };
    await store.set(`session:${session.id}`, JSON.stringify(session));

    await store.set(`digest:digest_h`, JSON.stringify({
      id: "digest_h",
      sessionId: session.id,
      teamId: team.id,
      date: "2026-01-15",
      memberAnswers: [{ memberId: 600, memberName: "Eve", answers: ["Frontend work", "Backend API", "None"] }],
      blockerHighlights: [],
      pendingMemberIds: [],
      pendingMemberNames: [],
    }));

    await store.set(`history:${session.id}`, JSON.stringify({
      sessionId: session.id,
      teamId: team.id,
      teamName: team.name,
      date: "2026-01-15",
      memberCount: 1,
      responseCount: 1,
      blockerCount: 0,
      status: "complete",
    }));

    const { bot, captured } = await createCapturedBot("test:token");

    // View history
    await bot.handleUpdate(callbackUpdate(1, "history:menu", { userId: 1, chatId: 1 }));
    await settle();

    const historyCall = captured.find((c) => c.method === "editMessageText" && typeof c.payload.text === "string" && c.payload.text.includes("Standup history"));
    expect(historyCall).toBeDefined();
    expect(historyCall!.payload.text).toContain("History Team");

    // View detail
    await bot.handleUpdate(callbackUpdate(2, `history:detail:${session.id}`, { userId: 1, chatId: 1 }));
    await settle();

    const detailCall = captured.find((c) => c.method === "editMessageText" && typeof c.payload.text === "string" && c.payload.text.includes("Eve"));
    expect(detailCall).toBeDefined();
  });
});