import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { Team, Member } from "../types.js";
import { DEFAULT_QUESTIONS } from "../types.js";

registerMainMenuItem({ label: "🔧 Teams", data: "team:menu", order: 10 });

const composer = new Composer<Ctx>();

function backToTeamMenu() {
  return inlineKeyboard([
    [inlineButton("➕ Create Team", "team:create")],
    [inlineButton("📋 My Teams", "team:list")],
    [inlineButton("⬅️ Back to menu", "menu:main")],
  ]);
}

function parseChannelId(input: string): number | null {
  const trimmed = input.trim();
  if (/^-?\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    if (num < 0) return num;
    return null;
  }
  return null;
}

async function loadTeam(id: string): Promise<Team | null> {
  const store = getStore();
  const raw = await store.get(`team:${id}`);
  if (!raw) return null;
  return JSON.parse(raw) as Team;
}

async function saveTeam(team: Team): Promise<void> {
  const store = getStore();
  await store.set(`team:${team.id}`, JSON.stringify(team));
}

async function listTeamsForOwner(ownerId: number): Promise<Team[]> {
  const store = getStore();
  const keys = await store.keys("team:*");
  const teams: Team[] = [];
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const t = JSON.parse(raw) as Team;
    if (t.ownerId === ownerId) teams.push(t);
  }
  return teams;
}

async function loadMember(telegramId: number): Promise<Member | null> {
  const store = getStore();
  const raw = await store.get(`member:${telegramId}`);
  if (!raw) return null;
  return JSON.parse(raw) as Member;
}

async function saveMember(member: Member): Promise<void> {
  const store = getStore();
  await store.set(`member:${member.telegramId}`, JSON.stringify(member));
}

async function getOrCreateMember(telegramId: number, displayName: string): Promise<Member> {
  let member = await loadMember(telegramId);
  if (!member) {
    member = {
      telegramId,
      displayName,
      timezone: "UTC",
      optedIn: false,
      skipFlags: [],
    };
    await saveMember(member);
  }
  return member;
}

function formatDays(workingDays: number[]): string {
  return workingDays
    .map((d) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d])
    .join(", ");
}

async function finishTeamSave(ctx: Ctx): Promise<void> {
  const creating = ctx.session.creatingTeam;
  const editingTeamId = ctx.session.editingTeamId;

  if (!creating || !creating.name || !creating.channelId || !creating.workingDays || !creating.timezone) {
    await ctx.reply("Something went wrong. Please start again from the menu.");
    ctx.session.step = undefined;
    ctx.session.creatingTeam = undefined;
    ctx.session.editingTeamId = undefined;
    return;
  }

  const questions = creating.questions?.length ? creating.questions : DEFAULT_QUESTIONS;
  const days = formatDays(creating.workingDays);

  if (editingTeamId) {
    const existing = await loadTeam(editingTeamId);
    if (!existing) {
      await ctx.reply("Team not found.");
      ctx.session.step = undefined;
      ctx.session.creatingTeam = undefined;
      ctx.session.editingTeamId = undefined;
      return;
    }

    const updated: Team = {
      ...existing,
      name: creating.name,
      channelId: creating.channelId,
      workingDays: creating.workingDays,
      timezone: creating.timezone,
      questions,
    };

    await saveTeam(updated);

    ctx.session.step = undefined;
    ctx.session.creatingTeam = undefined;
    ctx.session.editingTeamId = undefined;

    await ctx.reply(
      `Team "${updated.name}" updated.\n\n` +
        `Channel: ${updated.channelId}\n` +
        `Days: ${days}\n` +
        `Timezone: ${updated.timezone}`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("📋 View Team", `team:view:${updated.id}`)],
          [inlineButton("⬅️ Main Menu", "menu:main")],
        ]),
      },
    );
  } else {
    const team: Team = {
      id: `team_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: creating.name,
      channelId: creating.channelId,
      workingDays: creating.workingDays,
      timezone: creating.timezone,
      questions,
      memberIds: [],
      ownerId: ctx.from!.id,
    };

    await saveTeam(team);

    ctx.session.step = undefined;
    ctx.session.creatingTeam = undefined;

    await ctx.reply(
      `Team "${team.name}" created.\n\n` +
        `Channel: ${team.channelId}\n` +
        `Days: ${days}\n` +
        `Timezone: ${team.timezone}\n` +
        `Questions: ${questions.length}`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("➕ Add Members", `team:addmembers:${team.id}`)],
          [inlineButton("🔧 Team Menu", "team:menu")],
          [inlineButton("⬅️ Main Menu", "menu:main")],
        ]),
      },
    );
  }
}

composer.callbackQuery("team:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText("🔧 Team Management — tap an option below.", {
    reply_markup: backToTeamMenu(),
  });
});

composer.callbackQuery("team:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = "awaiting_team_name";
  ctx.session.creatingTeam = {};
  ctx.session.editingTeamId = undefined;
  await ctx.editMessageText(
    "Let's create a team. First, what's the team name?",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("❌ Cancel", "team:cancel")],
      ]),
    },
  );
});

composer.callbackQuery("team:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;
  ctx.session.creatingTeam = undefined;
  ctx.session.editingTeamId = undefined;
  await ctx.editMessageText("🔧 Team Management — tap an option below.", {
    reply_markup: backToTeamMenu(),
  });
});

composer.on("message:text", async (ctx, next) => {
  const step = ctx.session.step;
  if (!step) return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  if (step === "awaiting_team_name") {
    const name = ctx.message.text.trim();
    if (!name || name.length > 100) {
      await ctx.reply("Team name must be between 1 and 100 characters. Try again:", {
        reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
      });
      return;
    }
    ctx.session.creatingTeam!.name = name;
    ctx.session.step = "awaiting_team_channel";
    await ctx.reply(
      "Got it. Now send the Telegram channel ID where standup digests will be posted.\n\n" +
        "The ID should be a negative number like -1001234567890. You can get it by forwarding a message from the channel to @getidsbot.",
      {
        reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
      },
    );
    return;
  }

  if (step === "awaiting_team_channel") {
    const channelId = parseChannelId(ctx.message.text.trim());
    if (channelId === null) {
      await ctx.reply(
        "Invalid channel ID. It should be a negative number like -1001234567890. Try again:",
        {
          reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
        },
      );
      return;
    }
    ctx.session.creatingTeam!.channelId = channelId;
    ctx.session.step = "awaiting_team_days";
    await ctx.reply(
      "Which days are working days? Tap the days or send them as numbers (0=Sun, 1=Mon, ... 6=Sat):",
      {
        reply_markup: inlineKeyboard([
          [
            inlineButton("Mon-Fri", "team:days:1,2,3,4,5"),
            inlineButton("All week", "team:days:0,1,2,3,4,5,6"),
          ],
          [inlineButton("❌ Cancel", "team:cancel")],
        ]),
      },
    );
    return;
  }

  if (step === "awaiting_team_days") {
    const text = ctx.message.text.trim();
    const days = text.split(",").map((d) => parseInt(d.trim(), 10));
    if (days.some((d) => isNaN(d) || d < 0 || d > 6) || days.length === 0) {
      await ctx.reply(
        "Please send days as comma-separated numbers (0=Sun, 1=Mon, ... 6=Sat). Example: 1,2,3,4,5 for Mon-Fri.",
        {
          reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
        },
      );
      return;
    }
    ctx.session.creatingTeam!.workingDays = days;
    ctx.session.step = "awaiting_team_tz";
    await ctx.reply(
      "What timezone should the standup use? Examples: UTC, America/New_York, Europe/London, Asia/Tokyo",
      {
        reply_markup: inlineKeyboard([
          [
            inlineButton("UTC", "team:tz:UTC"),
            inlineButton("Europe/London", "team:tz:Europe/London"),
          ],
          [
            inlineButton("America/New_York", "team:tz:America/New_York"),
            inlineButton("Asia/Tokyo", "team:tz:Asia/Tokyo"),
          ],
          [inlineButton("❌ Cancel", "team:cancel")],
        ]),
      },
    );
    return;
  }

  if (step === "awaiting_team_tz") {
    const tz = ctx.message.text.trim();
    if (!tz || tz.length > 50) {
      await ctx.reply("Please send a valid timezone like UTC, America/New_York, etc.", {
        reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
      });
      return;
    }
    ctx.session.creatingTeam!.timezone = tz;
    ctx.session.step = "awaiting_team_questions";
    await ctx.reply(
      "Custom standup questions? Send one question per message, or tap Done to use defaults:\n\n" +
        "• What did you work on yesterday?\n" +
        "• What are you working on today?\n" +
        "• Any blockers or challenges?",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Use defaults", "team:qdone")],
          [inlineButton("❌ Cancel", "team:cancel")],
        ]),
      },
    );
    return;
  }

  if (step === "awaiting_team_questions") {
    const q = ctx.message.text.trim();
    if (!q) return;
    if (!ctx.session.creatingTeam!.questions) {
      ctx.session.creatingTeam!.questions = [];
    }
    ctx.session.creatingTeam!.questions.push(q);
    const count = ctx.session.creatingTeam!.questions.length;
    await ctx.reply(
      `Question ${count} added: "${q}"\n\nSend another question or tap Done.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Done", "team:qdone")],
          [inlineButton("❌ Cancel", "team:cancel")],
        ]),
      },
    );
    return;
  }

  if (step.startsWith("adding_members:")) {
    const teamId = step.slice("adding_members:".length);
    const team = await loadTeam(teamId);
    if (!team) {
      await ctx.reply("Team not found.");
      ctx.session.step = undefined;
      return;
    }

    const memberIdText = ctx.message.text.trim();
    const memberId = parseInt(memberIdText, 10);
    if (isNaN(memberId) || memberId <= 0) {
      await ctx.reply("Please send a valid Telegram user ID (numeric).");
      return;
    }

    if (!team.memberIds.includes(memberId)) {
      team.memberIds.push(memberId);
      await saveTeam(team);
    }

    await getOrCreateMember(memberId, `Member ${memberId}`);

    await ctx.reply(
      `Added member ${memberId} to "${team.name}". Send another ID or tap Done.`,
      {
        reply_markup: inlineKeyboard([
          [inlineButton("✅ Done", `team:addmembers:done:${teamId}`)],
          [inlineButton("❌ Cancel", `team:view:${teamId}`)],
        ]),
      },
    );
    return;
  }

  return next();
});

composer.callbackQuery(/^team:days:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const days = ctx.match[1].split(",").map(Number);
  ctx.session.creatingTeam!.workingDays = days;
  ctx.session.step = "awaiting_team_tz";
  await ctx.editMessageText(
    "What timezone should the standup use? Examples: UTC, America/New_York, Europe/London, Asia/Tokyo",
    {
      reply_markup: inlineKeyboard([
        [
          inlineButton("UTC", "team:tz:UTC"),
          inlineButton("Europe/London", "team:tz:Europe/London"),
        ],
        [
          inlineButton("America/New_York", "team:tz:America/New_York"),
          inlineButton("Asia/Tokyo", "team:tz:Asia/Tokyo"),
        ],
        [inlineButton("❌ Cancel", "team:cancel")],
      ]),
    },
  );
});

composer.callbackQuery(/^team:tz:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tz = ctx.match[1];
  ctx.session.creatingTeam!.timezone = tz;
  ctx.session.step = "awaiting_team_questions";
  await ctx.editMessageText(
    "Custom standup questions? Send one question per message, or tap Done to use defaults:\n\n" +
      "• What did you work on yesterday?\n" +
      "• What are you working on today?\n" +
      "• Any blockers or challenges?",
    {
      reply_markup: inlineKeyboard([
        [inlineButton("✅ Use defaults", "team:qdone")],
        [inlineButton("❌ Cancel", "team:cancel")],
      ]),
    },
  );
});

composer.callbackQuery("team:qdone", async (ctx) => {
  await ctx.answerCallbackQuery();
  await finishTeamSave(ctx);
});

composer.callbackQuery("team:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const ownerId = ctx.from!.id;
  const teams = await listTeamsForOwner(ownerId);

  if (teams.length === 0) {
    await ctx.editMessageText(
      "No teams yet — tap ➕ to create one.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("➕ Create Team", "team:create")],
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const rows = teams.map((t) => [
    inlineButton(`${t.name} (${t.memberIds.length} members)`, `team:view:${t.id}`),
  ]);

  await ctx.editMessageText("Your teams — tap one to view:", {
    reply_markup: inlineKeyboard([
      ...rows,
      [inlineButton("➕ Create Team", "team:create")],
      [inlineButton("⬅️ Back to menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery(/^team:view:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:menu")]]),
    });
    return;
  }

  const days = formatDays(team.workingDays);
  const memberNames: string[] = [];
  for (const mid of team.memberIds) {
    const m = await loadMember(mid);
    memberNames.push(m?.displayName ?? `ID ${mid}`);
  }

  const info =
    `Team: ${team.name}\n` +
    `Channel: ${team.channelId}\n` +
    `Days: ${days}\n` +
    `Timezone: ${team.timezone}\n` +
    `Questions: ${team.questions.length}\n` +
    `Members (${team.memberIds.length}): ${memberNames.join(", ") || "none"}`;

  await ctx.editMessageText(info, {
    reply_markup: inlineKeyboard([
      [inlineButton("➕ Add Member", `team:addmembers:${team.id}`)],
      [
        inlineButton("✏️ Edit", `team:edit:${team.id}`),
        inlineButton("🗑️ Delete", `team:delete:${team.id}`),
      ],
      [inlineButton("⬅️ Back to teams", "team:list")],
      [inlineButton("⬅️ Main Menu", "menu:main")],
    ]),
  });
});

composer.callbackQuery(/^team:delete:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:menu")]]),
    });
    return;
  }

  if (team.ownerId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the team owner can delete the team.", show_alert: true });
    return;
  }

  await ctx.editMessageText(
    `Delete team "${team.name}"? This cannot be undone.`,
    {
      reply_markup: inlineKeyboard([
        [
          inlineButton("✅ Yes, delete", `team:delete:confirm:${teamId}`),
          inlineButton("❌ No, keep it", `team:view:${teamId}`),
        ],
      ]),
    },
  );
});

composer.callbackQuery(/^team:delete:confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:menu")]]),
    });
    return;
  }

  if (team.ownerId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the team owner can delete the team.", show_alert: true });
    return;
  }

  const store = getStore();
  await store.del(`team:${teamId}`);
  await ctx.editMessageText(`Team "${team.name}" deleted.`, {
    reply_markup: inlineKeyboard([
      [inlineButton("➕ Create Team", "team:create")],
      [inlineButton("⬅️ Team Menu", "team:menu")],
    ]),
  });
});

composer.callbackQuery(/^team:edit:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:menu")]]),
    });
    return;
  }

  if (team.ownerId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the team owner can edit the team.", show_alert: true });
    return;
  }

  ctx.session.step = "awaiting_team_name";
  ctx.session.editingTeamId = teamId;
  ctx.session.creatingTeam = {
    name: team.name,
    channelId: team.channelId,
    workingDays: team.workingDays,
    timezone: team.timezone,
    questions: team.questions,
  };

  await ctx.editMessageText(
    `Editing "${team.name}". First, enter a new team name (or send the current one to keep it):`,
    {
      reply_markup: inlineKeyboard([[inlineButton("❌ Cancel", "team:cancel")]]),
    },
  );
});

composer.callbackQuery(/^team:addmembers:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.", {
      reply_markup: inlineKeyboard([[inlineButton("⬅️ Back", "team:menu")]]),
    });
    return;
  }

  if (team.ownerId !== ctx.from!.id) {
    await ctx.answerCallbackQuery({ text: "Only the team owner can add members.", show_alert: true });
    return;
  }

  await ctx.editMessageText(
    `Adding members to "${team.name}". Send the Telegram user IDs of members, one per message (e.g. 123456789).\n\n` +
      `Members can DM the bot /start to register. Tap Done when finished.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("✅ Done", `team:addmembers:done:${teamId}`)],
        [inlineButton("❌ Cancel", `team:view:${teamId}`)],
      ]),
    },
  );
  ctx.session.step = `adding_members:${teamId}`;
});

composer.callbackQuery(/^team:addmembers:done:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.step = undefined;
  const teamId = ctx.match[1];
  const team = await loadTeam(teamId);
  if (!team) {
    await ctx.editMessageText("Team not found.");
    return;
  }

  const memberNames: string[] = [];
  for (const mid of team.memberIds) {
    const m = await loadMember(mid);
    memberNames.push(m?.displayName ?? `ID ${mid}`);
  }

  await ctx.editMessageText(
    `Team "${team.name}" members: ${memberNames.join(", ") || "none"}`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton("📋 View Team", `team:view:${teamId}`)],
        [inlineButton("⬅️ Team Menu", "team:menu")],
      ]),
    },
  );
});

export default composer;