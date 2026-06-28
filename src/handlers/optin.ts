import { Composer } from "grammy";
import type { Ctx } from "../bot.js";
import {
  registerMainMenuItem,
  inlineButton,
  inlineKeyboard,
} from "../toolkit/index.js";
import { getStore } from "../store.js";
import type { Team, Member } from "../types.js";

registerMainMenuItem({ label: "🔔 My Status", data: "optin:status", order: 40 });

const composer = new Composer<Ctx>();

async function loadMember(userId: number): Promise<Member | null> {
  const store = getStore();
  const raw = await store.get(`member:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw) as Member;
}

async function saveMember(member: Member): Promise<void> {
  const store = getStore();
  await store.set(`member:${member.telegramId}`, JSON.stringify(member));
}

async function listTeamsForMember(userId: number): Promise<Team[]> {
  const store = getStore();
  const keys = await store.keys("team:*");
  const teams: Team[] = [];
  for (const k of keys) {
    const raw = await store.get(k);
    if (!raw) continue;
    const t = JSON.parse(raw) as Team;
    if (t.memberIds.includes(userId)) teams.push(t);
  }
  return teams;
}

composer.callbackQuery("optin:status", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const member = await loadMember(userId);
  const teams = await listTeamsForMember(userId);

  if (teams.length === 0) {
    await ctx.editMessageText(
      "You're not a member of any teams yet. Ask your team lead to add you.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  const optedIn = member?.optedIn ?? false;
  const statusEmoji = optedIn ? "✅" : "⭕";
  const statusText = optedIn ? "You are opted in to receive standups." : "You are currently opted out and will not receive standups.";

  const teamNames = teams.map((t) => t.name).join(", ");

  await ctx.editMessageText(
    `${statusEmoji} ${statusText}\n\nTeams: ${teamNames}\n\nTap the button below to toggle your participation status.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton(
          optedIn ? "⭕ Opt out of standups" : "✅ Opt in to standups",
          "optin:toggle",
        )],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

composer.callbackQuery("optin:toggle", async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from!.id;
  const teams = await listTeamsForMember(userId);

  if (teams.length === 0) {
    await ctx.editMessageText(
      "You're not a member of any teams yet.",
      {
        reply_markup: inlineKeyboard([
          [inlineButton("⬅️ Back to menu", "menu:main")],
        ]),
      },
    );
    return;
  }

  let member = await loadMember(userId);
  if (!member) {
    member = {
      telegramId: userId,
      displayName: ctx.from?.first_name ?? "Unknown",
      timezone: "UTC",
      optedIn: true,
      skipFlags: [],
    };
  }
  member.optedIn = !member.optedIn;
  await saveMember(member);

  const optedIn = member.optedIn;
  const statusEmoji = optedIn ? "✅" : "⭕";
  const statusText = optedIn ? "You are now opted in and will receive standups." : "You are now opted out and will not receive standups.";

  const teamNames = teams.map((t) => t.name).join(", ");

  await ctx.editMessageText(
    `${statusEmoji} ${statusText}\n\nTeams: ${teamNames}\n\nTap the button below to toggle again.`,
    {
      reply_markup: inlineKeyboard([
        [inlineButton(
          optedIn ? "⭕ Opt out of standups" : "✅ Opt in to standups",
          "optin:toggle",
        )],
        [inlineButton("⬅️ Back to menu", "menu:main")],
      ]),
    },
  );
});

export default composer;