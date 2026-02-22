import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} from "discord.js";
// Roles that get muted when /lock is used
const LOCK_ROLE_IDS = [
  "1457168952936501248",
  "1457169070452379680",
  "1457174938380402739"
];
// The ONE channel you want /lock and /unlock to affect:
const LOCK_CHANNEL_ID = "1469891401314603018";
import { DateTime } from "luxon";
import { COMMANDS } from "./commands.js";
import {
  getConfig,
  getUserRow,
  upsertUserRow,
  supabase,
  insertTransaction,
  hasRumblePaid,
  markRumblePaid
} from "./db.js";
import cron from "node-cron";
import { Resvg } from "@resvg/resvg-js";

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

const COIN = "<a:CC:1472374417920229398>";
const CC_EMOJI = COIN;
const fmtNum = (n) => Number(n ?? 0).toLocaleString("en-US");

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_APP_ID env vars.");
}

// =====================================================
// 🎰 SLOTS (interactive) — UPDATED PAYOUT RULES
// =====================================================
const SLOT_GAMES = new Map();
const SLOT_TTL_MS = 5 * 60 * 1000;

// 8 pay lines total (player can pick 1–7 lines, or choose an 8-line tier)
const SLOT_LINES_TOTAL = 8;

// Tier definitions (based on your spec)
const SLOT_TIERS = {
  single: {
    id: "single",
    label: "Single Lines",
    maxLines: 7,
    betPerLine: 5,
    winPerLine: 10,      // total return per winning line
    profitPerLine: 5     // informational
  },
  all10: {
    id: "all10",
    label: "All Lines",
    lines: 8,
    betPerLine: 10,
    winPerLine: 50,      // total return per winning line
    profitPerLine: 40,
    jackpot: { amount: 1600, chance: 0.18 } // only if ALL 8 lines win
  },
  max50: {
    id: "max50",
    label: "MAX BET",
    lines: 8,
    betPerLine: 50,
    winPerLine: 300,     // total return per winning line
    profitPerLine: 250,
    jackpot: { amount: 3200, chance: 0.10 } // only if ALL 8 lines win (max bet only)
  }
};

// 3x3 grid indices: [row][col] where row 0=top, 1=mid, 2=bot; col 0..2
const SLOT_PAYLINES = [
  // 1) Top row
  [[0,0],[0,1],[0,2]],
  // 2) Middle row
  [[1,0],[1,1],[1,2]],
  // 3) Bottom row
  [[2,0],[2,1],[2,2]],
  // 4) Diagonal TL -> BR
  [[0,0],[1,1],[2,2]],
  // 5) Diagonal BL -> TR
  [[2,0],[1,1],[0,2]],
  // 6) "V" (top corners, bottom middle)
  [[0,0],[2,1],[0,2]],
  // 7) Inverted "V" (bottom corners, top middle)
  [[2,0],[0,1],[2,2]],
  // 8) "Arch" (top corners, center middle)
  [[0,0],[1,1],[0,2]],
];

// ============================================
// 🎰 SLOT SYMBOL DEFINITIONS (ID BASED)
// ============================================

const BASE_SYMBOLS = [
  { id: "diamond", weight: 5 },
  { id: "briefcase", weight: 6 },
  { id: "moneybag", weight: 8 },
  { id: "cashstack", weight: 10 },
  { id: "coin", weight: 14 },
  { id: "dice", weight: 16 },
  { id: "raccoon", weight: 12 }, // ✅ add normal symbol
];

const CAPO_SYMBOL = { id: "capo", weight: 1 }; // jackpot only

function slotsKey(guildId, channelId, userId) {
  return `slots_${guildId}_${channelId}_${userId}`;
}
function slotsExpired(state) {
  return Date.now() - state.createdAt > SLOT_TTL_MS;
}
function slotsPickSymbol(symbolPool = BASE_SYMBOLS) {
  const total = symbolPool.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;

  for (const x of symbolPool) {
    r -= x.weight;
    if (r <= 0) return x.id;
  }

  return symbolPool[0].id;
}

function slotsBuildGrid(symbolPool = BASE_SYMBOLS) {
  return [
    [slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool)],
    [slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool)],
    [slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool), slotsPickSymbol(symbolPool)],
  ];
}
function slotsFmtGrid(grid) {
  const row = (r) => `${grid[r][0]} ${grid[r][1]} ${grid[r][2]}`;
  return `\n${row(0)}\n${row(1)}\n${row(2)}\n`;
}

// Evaluate wins (payout is computed later based on tier)
function slotsEval(grid, linesCount) {
  const wins = [];

  for (let i = 0; i < linesCount; i++) {
    const line = SLOT_PAYLINES[i];
    const a = grid[line[0][0]][line[0][1]];
    const b = grid[line[1][0]][line[1][1]];
    const c = grid[line[2][0]][line[2][1]];

    if (a === b && b === c) {
      wins.push({ line: i + 1, sym: a });
    }
  }

  return { wins };
}

// Determine tier + pricing based on the user's selection
function slotsResolveTier(linesCount, tierId) {
  // tierId can be "all10" or "max50" when linesCount===8
  if (linesCount === 8) {
    return SLOT_TIERS[tierId === "max50" ? "max50" : "all10"];
  }
  return SLOT_TIERS.single;
}

function slotsLineButtons(state) {
  const key = state.key;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`sl:picklines:${key}`)
      .setLabel("Lines")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`sl:all10:${key}`)
      .setLabel("All Lines")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`sl:max50:${key}`)
      .setLabel("MAX BET")
      .setStyle(ButtonStyle.Success),
  );

  return [row];
}

function slotsReplayButtons(state) {
  const key = state.key;
  const lines = state.linesCount ?? 0;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`sl:again_same:${key}`)
        .setLabel("Play again (same bet)")
        .setStyle(ButtonStyle.Success)
        .setDisabled(lines <= 0),
      new ButtonBuilder()
        .setCustomId(`sl:new_game:${key}`)
        .setLabel("New game")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function slotsEmbed(cfg, state, {
  title = "🎰 Capo Cash Slots",
  status = "",
  grid = null,
  wins = [],
  payout = 0,
  tier = null,
  totalBet = 0
} = {}) {
  const currency = cfg?.currency_name || "Capo Cash";
  const lines = state.linesCount ?? 0;

  const winLinesText =
    wins.length === 0
      ? "None"
      : wins.map(w => `Line ${w.line}: ${w.sym}`).join("\n");

  const tierLine = tier
    ? `**Mode:** ${tier.label}\n**Bet:** ${fmt(totalBet)} ${currency} (${fmt(tier.betPerLine)}/line)\n`
    : "";

  const desc =
    (lines > 0
      ? `**Lines:** ${lines}/${SLOT_LINES_TOTAL}\n${tierLine}`
      : `Pick your play:\n• **1–7 lines** (${fmt(SLOT_TIERS.single.betPerLine)}/line)\n• **All Lines** (${fmt(SLOT_TIERS.all10.betPerLine)}/line)\n• **MAX BET** (${fmt(SLOT_TIERS.max50.betPerLine)}/line)\n`) +
    (status ? `\n**Status:** ${status}\n` : "") +
    (grid ? `\n\`\`\`\n${slotsFmtGrid(grid)}\`\`\`\n` : "") +
    (lines > 0
      ? `**Winning Lines:**\n${winLinesText}\n\n**Payout:** ${fmt(payout)} ${currency}\n`
      : "");

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setTimestamp(new Date());
}

// ===== Blackjack: in-memory active games (per user per channel) =====
const BJ_GAMES = new Map(); // key => state
const BJ_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BJ_PAGE_CURRENCY = (cfg) => cfg?.currency_name || "Capo Cash";

function fmt(n) {
  return Number(n).toLocaleString("en-US");
}

const SUITS = ["♠", "♥", "♦", "♣"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function bjCardValue(rank) {
  if (rank === "A") return 11;
  if (["K","Q","J"].includes(rank)) return 10;
  return Number(rank);
}

function bjDrawCard() {
  const suit = SUITS[Math.floor(Math.random() * SUITS.length)];
  const rank = RANKS[Math.floor(Math.random() * RANKS.length)];
  return { rank, suit, value: bjCardValue(rank) };
}

function bjScore(hand) {
  let total = hand.reduce((s, c) => s + c.value, 0);
  let aces = hand.filter(c => c.rank === "A").length;
  while (aces > 0 && total > 21) { total -= 10; aces--; }
  return total;
}

function bjScoreWithSoft(hand) {
  let total = 0;
  let aces = 0;

  for (const c of hand) {
    if (c.rank === "A") {
      aces++;
      total += 11;
    } else {
      total += c.value;
    }
  }

  // Convert Aces from 11 -> 1 as needed
  while (aces > 0 && total > 21) {
    total -= 10;
    aces--;
  }

  // If we still have an ace counted as 11, it's a "soft" total
  const soft = aces > 0;

  return { total, soft };
}

function bjFmtHand(hand) {
  return hand.map(c => `\`${c.rank}${c.suit}\``).join(" ");
}

function bjFmtDealerHand(dealerHand, revealAll) {
  if (revealAll) return bjFmtHand(dealerHand);
  const up = dealerHand[0] ? `\`${dealerHand[0].rank}${dealerHand[0].suit}\`` : "`?`";
  return `${up} \`🂠\``; // face-down card
}

function bjCanSplit(hand) {
  if (!hand || hand.length !== 2) return false;
  return bjCardValue(hand[0].rank) === bjCardValue(hand[1].rank); // 10/J/Q/K all count as 10
}

function bjGameKey(guildId, userId, channelId) {
  return `${guildId}_${channelId}_${userId}`; // no colons
}

function bjIsExpired(state) {
  return Date.now() - state.createdAt > BJ_TTL_MS;
}

function bjButtons(state) {
  const inSplit = state.hands.length === 2;
  const currentHand = state.hands[state.activeHandIndex];

  const canSplit =
    !state.didSplit &&
    state.hands.length === 1 &&
    bjCanSplit(currentHand) &&
    currentHand.length === 2;

  const canDouble =
    currentHand.length === 2 &&
    !state.didDoubleOnHand[state.activeHandIndex];

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`bj:hit:${state.key}`)
      .setLabel(inSplit ? `Hit (Hand ${state.activeHandIndex + 1})` : "Hit")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`bj:stand:${state.key}`)
      .setLabel(inSplit ? `Stand (Hand ${state.activeHandIndex + 1})` : "Stand")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId(`bj:double:${state.key}`)
      .setLabel("Double Down")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!canDouble),

    new ButtonBuilder()
      .setCustomId(`bj:split:${state.key}`)
      .setLabel("Split")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!canSplit)
  );

  return [row];
}

function bjBuildEmbed(cfg, state, { revealDealer = false, footerText = "" } = {}) {
  const currency = BJ_PAGE_CURRENCY(cfg);
  const betText = state.hands.length === 2
    ? `${state.handBets[0]} + ${state.handBets[1]} (split)`
    : `${Number(state.handBets[0]).toLocaleString("en-US")}`

  const fields = [];

  // Player hands
  if (state.hands.length === 1) {
    const ps = bjScore(state.hands[0]);
    fields.push({
      name: `You (Total: ${ps})`,
      value: bjFmtHand(state.hands[0]) || "` `",
      inline: false
    });
  } else {
    const h1 = state.hands[0], h2 = state.hands[1];
    const s1 = bjScore(h1), s2 = bjScore(h2);
    const p1 = state.activeHandIndex === 0 ? "👉 " : "";
    const p2 = state.activeHandIndex === 1 ? "👉 " : "";
    fields.push(
      { name: `${p1}Hand 1 (Total: ${s1})`, value: bjFmtHand(h1) || "` `", inline: false },
      { name: `${p2}Hand 2 (Total: ${s2})`, value: bjFmtHand(h2) || "` `", inline: false }
    );
  }

  // Dealer
  const dealerShowing = state.dealerHand?.[0] ? bjCardValue(state.dealerHand[0].rank) : "?";
  const dealerTotal = bjScore(state.dealerHand);

  fields.push({
    name: revealDealer ? `Dealer (Total: ${dealerTotal})` : `Dealer (Showing: ${dealerShowing})`,
    value: bjFmtDealerHand(state.dealerHand, revealDealer),
    inline: false
  });

  const embed = new EmbedBuilder()
    .setTitle("🃏 Capo Cash Blackjack")
    .setDescription(
      `**Bet:** ${betText} ${currency}\n` +
      (state.messageLine ? `**Status:** ${state.messageLine}\n` : "")
    )
    .addFields(fields)
    .setTimestamp(new Date());

  if (footerText) embed.setFooter({ text: footerText });

  return embed;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel]
});

// ===== Leaderboard config/helpers =====
const LB_PAGE_SIZE = 10;

async function fetchLeaderboardPage(guildId, page, pageSize) {
  const safePage = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 10);

  // total count
  const { count, error: countErr } = await supabase
    .from("users")
    .select("user_id", { count: "exact", head: true })
    .eq("guild_id", guildId);

  if (countErr) throw countErr;

  const totalRows = Number(count || 0);
  const totalPages = Math.max(1, Math.ceil(totalRows / size));

  const finalPage = Math.min(safePage, totalPages);
  const start = (finalPage - 1) * size;
  const end = start + size - 1;

  const { data, error } = await supabase
    .from("users")
    .select("user_id,balance")
    .eq("guild_id", guildId)
    .order("balance", { ascending: false })
    .range(start, end);

  if (error) throw error;

  const rows = (data || []).map((r, idx) => ({
    rank: start + idx + 1,
    user_id: r.user_id,
    balance: Number(r.balance ?? 0)
  }));

  return { page: finalPage, totalPages, rows, pageSize: size };
}

// “Me” button: scan pages until we find the caller (simple + reliable)
async function findUserRankByScan(guildId, userId, pageSize = 1000, maxPages = 50) {
  const size = Math.max(10, Number(pageSize) || 1000);

  for (let p = 1; p <= maxPages; p++) {
    const start = (p - 1) * size;
    const end = start + size - 1;

    const { data, error } = await supabase
      .from("users")
      .select("user_id")
      .eq("guild_id", guildId)
      .order("balance", { ascending: false })
      .range(start, end);

    if (error) throw error;

    const idx = (data || []).findIndex((r) => r.user_id === userId);
    if (idx !== -1) return start + idx + 1;

    if (!data || data.length < size) break; // no more rows
  }

  return null;
}

function buildLeaderboardEmbed({ guildName, currencyName, page, totalPages, rows }) {
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${currencyName} Leaderboard`)
    .setDescription(`**${guildName}**\nPage **${page} / ${totalPages}**`)
    .setTimestamp(new Date());

  if (!rows || rows.length === 0) {
    embed.addFields({ name: "No results", value: "No leaderboard entries yet." });
    return embed;
  }

  const lines = rows
    .map((r) => `**${r.rank}.** <@${r.user_id}> — **${fmt(r.balance)}** ${currencyName}`)
    .join("\n");

  embed.addFields({ name: "Top Players", value: lines });

  return embed;
}

function leaderboardRowComponents({ page, totalPages }) {
  const p = Math.max(1, Number(page) || 1);
  const tp = Math.max(1, Number(totalPages) || 1);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb:first:${p}`)
      .setLabel("⏮️ First")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p <= 1),

    new ButtonBuilder()
      .setCustomId(`lb:prev:${p}`)
      .setLabel("◀️ Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p <= 1),

    new ButtonBuilder()
      .setCustomId(`lb:me:${p}`)
      .setLabel("⭐ Me")
      .setStyle(ButtonStyle.Primary),

    new ButtonBuilder()
      .setCustomId(`lb:next:${p}`)
      .setLabel("Next ▶️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p >= tp),

    new ButtonBuilder()
      .setCustomId(`lb:last:${p}`)
      .setLabel("Last ⏭️")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p >= tp)
  );

  return [row];
}

// ===== Locks / utilities =====
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((res) => (release = res));
  locks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

function nowInTz(tz) {
  return DateTime.now().setZone(tz || "America/Chicago");
}
function hoursBetween(a, b) {
  return b.diff(a, "hours").hours;
}
function parseFirstMentionUserId(text) {
  const m = (text || "").match(/<@!?(\d{17,20})>/);
  return m ? m[1] : null;
}

async function sendCentralLog(cfg, embed) {
  const logChannelId = cfg.log_channel_id;
  if (!logChannelId) return;
  try {
    const ch = await client.channels.fetch(logChannelId);
    if (ch && ch.isTextBased()) await ch.send({ embeds: [embed] });
  } catch (e) {
    console.error("Central log failed:", e?.message || e);
  }
}

async function applyBalanceChange({
  guildId,
  userId,
  amount,
  type,
  reason,
  actorId,
  sourceMessageId
}) {
  return withLock(`${guildId}:${userId}`, async () => {
    const cfg = await getConfig(guildId);

    const beforeRow =
      (await getUserRow(guildId, userId)) || (await upsertUserRow(guildId, userId));
    const balanceBefore = Number(beforeRow.balance || 0);
    const balanceAfter = balanceBefore + Number(amount);

    if (balanceAfter < 0) {
      return {
        ok: false,
        reason: "insufficient_funds",
        balanceBefore,
        balanceAfter: balanceBefore,
        cfg
      };
    }

    const { error: upErr } = await supabase
      .from("users")
      .update({ balance: balanceAfter })
      .eq("guild_id", guildId)
      .eq("user_id", userId);

    if (upErr) throw upErr;

    await insertTransaction({
      guild_id: guildId,
      user_id: userId,
      amount: Number(amount),
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      type,
      reason: reason || null,
      actor_id: actorId || "system",
      source_message_id: sourceMessageId || null
    });

    const embed = new EmbedBuilder()
      .setTitle("TMS Capo Cash Logs")
      .setDescription(`**${String(type).toUpperCase()}**`)
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        {
          name: "Amount",
          value: `${amount > 0 ? "+" : ""}${amount} ${cfg.currency_name}`,
          inline: true
        },
        { name: "New Balance", value: `${balanceAfter}`, inline: true },
        { name: "Source Guild", value: `${guildId}`, inline: false }
      )
      .setTimestamp(new Date());

    if (reason) embed.addFields({ name: "Reason", value: String(reason) });

    await sendCentralLog(cfg, embed);

    return { ok: true, balanceBefore, balanceAfter, cfg };
  });
}

// ===== Ready / Command registration =====
client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  // 🌎 Register GLOBAL commands
  await rest.put(
    Routes.applicationCommands(DISCORD_APP_ID),
    { body: COMMANDS }
  );
  console.log("Global slash commands registered.");

  // ===== Ghosty Role Daily Pings =====
  const GHOSTY_CHANNEL_ID = "1301577002720952321";
  const GHOSTY_ROLE_ID = "1301631283868336168";
  const TIMEZONE = "America/Chicago"; // CST/CDT auto handled

  // ✅ UPDATED CST times (no duplicates)
  const dailyTimes = [
    "00:06","01:07","02:08","03:09",
    "04:10","05:11","06:12","06:21",
    "07:13","07:31","07:37",
    "08:14","08:41",
    "09:15","09:51",
    "10:16","11:17",
    "12:18","13:19",
    "14:02","14:20",
    "15:12","15:21",
    "16:22","17:23","17:32",
    "18:00",
    "19:01","19:11",
    "20:02","20:22",
    "21:03","21:33",
    "22:04","22:44",
    "23:05","23:55"
  ];

  dailyTimes.forEach((time) => {
    const [hour, minute] = time.split(":");

    cron.schedule(
      `${minute} ${hour} * * *`,
      async () => {
        try {
          const channel = await client.channels.fetch(GHOSTY_CHANNEL_ID);
          if (!channel || !channel.isTextBased()) return;

          await channel.send(`<@&${GHOSTY_ROLE_ID}>`);
        } catch (err) {
          console.error("Ghosty ping error:", err);
        }
      },
      { timezone: TIMEZONE }
    );
  });

  console.log("👻 Ghosty role pings scheduled.");
});

// ===== AUTO RUMBLE PAYOUT =====
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    const guildId = message.guild.id;

    const cfg = await getConfig(guildId);

    if (message.author.id !== cfg.rumble_bot_id) return;

    const winnerId = parseFirstMentionUserId(message.content);
    if (!winnerId) return;

    if (await hasRumblePaid(guildId, message.id)) {
      try { await message.react("⏭️"); } catch {}
      return;
    }

    // Check channel-specific payout first
const { data: channelCfg } = await supabase
  .from("rumble_channel_config")
  .select("payout_amount")
  .eq("guild_id", guildId)
  .eq("channel_id", message.channel.id)
  .single();

const amount =
  channelCfg?.payout_amount ??
  Number(cfg.rumble_win_amount || 75);

    const res = await applyBalanceChange({
      guildId,
      userId: winnerId,
      amount,
      type: "rumble",
      reason: "Rumble Royals win",
      actorId: "system",
      sourceMessageId: message.id
    });

    if (res.ok) {
      await markRumblePaid(guildId, message.id, winnerId, amount);

      try { await message.react("💸"); } catch (e) {
        console.error("Rumble react failed:", e?.message || e);
      }

      const tpl =
        "<a:CC:1472374417920229398> {user} was awarded **{amount} {currency}** for winning **Rumble Royale**! <a:CC:1472374417920229398> ";

      const announce = tpl
        .replaceAll("{user}", `<@${winnerId}>`)
        .replaceAll("{amount}", String(amount))
        .replaceAll("{currency}", cfg.currency_name);

      try {
        await message.channel.send(announce);
      } catch (e) {
        console.error("Rumble announce failed:", e?.message || e);
      }
    } else {
      try { await message.react("⚠️"); } catch {}
    }
  } catch (e) {
    console.error("Rumble payout error:", e?.message || e);
  }
});

// ==============================
// 🎰 SLOT IMAGE HELPERS
// ==============================

import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import GIFEncoder from "gif-encoder-2";

const SLOT_ICON_DIR = path.resolve(process.cwd(), "assets");

const SYMBOL_TO_ICON_FILE = {
  raccoon: "IMG_0767.png",
  diamond: "IMG_0773.png",
  briefcase: "IMG_0786.png",
  moneybag: "IMG_0777.png",

  // ✅ normal coin icon
  coin: "IMG_0780.png",

  dice: "IMG_0783.png",

  // ✅ jackpot-only capo symbol
  capo: "IMG_0781.png",

  // if you still use this symbol id anywhere, map it too:
  cashstack: "IMG_0774.png",
};

// ---------- DataURI cache (optional; useful if you still embed PNGs into SVG elsewhere)
const ICON_DATAURI_CACHE = new Map(); // symbolId -> dataUri

export async function getSymbolDataUri(symbolId) {
  const cached = ICON_DATAURI_CACHE.get(symbolId);
  if (cached) return cached;

  const file = SYMBOL_TO_ICON_FILE[symbolId];
  if (!file) return null;

  try {
    const abs = path.join(SLOT_ICON_DIR, file);
    const buf = await fs.readFile(abs);
    const b64 = buf.toString("base64");
    const dataUri = `data:image/png;base64,${b64}`;

    ICON_DATAURI_CACHE.set(symbolId, dataUri);
    return dataUri;
  } catch (e) {
    console.error("Slots icon missing:", symbolId, e?.message || e);
    return null;
  }
}

// ---------- Loaded Image cache (for canvas/GIF rendering)
const ICON_IMAGE_CACHE = new Map(); // symbolId -> loaded Image

export async function getSymbolImage(symbolId) {
  const cached = ICON_IMAGE_CACHE.get(symbolId);
  if (cached) return cached;

  const file = SYMBOL_TO_ICON_FILE[symbolId];
  if (!file) return null;

  try {
    const abs = path.join(SLOT_ICON_DIR, file);
    const buf = await fs.readFile(abs);
    const img = await loadImage(buf);

    ICON_IMAGE_CACHE.set(symbolId, img);
    return img;
  } catch (e) {
    console.error("Slots image load failed:", symbolId, e?.message || e);
    return null;
  }
}

/**
 * Build a "reel spin" GIF that lands on finalGrid.
 * - Each column scrolls through random symbols then stops.
 *
 * finalGrid is 3x3 of symbol IDs: grid[row][col]
 * symbolPool is array like BASE_SYMBOLS or [...BASE_SYMBOLS, CAPO_SYMBOL] (objects with .id)
 */
export async function buildSlotsSpinGif(
  finalGrid,
  symbolPool,
  {
    width = 720,
    height = 720,
    cellSize = 220,     // bigger cells for cleaner icons
    padding = 30,
    frames = 18,
    msPerFrame = 55
  } = {}
) {
  const boardSize = cellSize * 3;
  const W = width;
  const H = height;

  // Pre-pick symbol ids for reels (each reel list ends with final column symbols)
  const poolIds = (symbolPool || []).map((s) => s.id).filter(Boolean);
  if (poolIds.length === 0) throw new Error("buildSlotsSpinGif: symbolPool is empty");

  const reelList = (col) => {
    const seq = [];
    // random feed
    for (let i = 0; i < 12; i++) {
      seq.push(poolIds[Math.floor(Math.random() * poolIds.length)]);
    }
    // ensure it lands on final (top->mid->bot for this col)
    seq.push(finalGrid[0][col], finalGrid[1][col], finalGrid[2][col]);
    return seq;
  };

  const reels = [reelList(0), reelList(1), reelList(2)];

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");

  const enc = new GIFEncoder(W, H);
  enc.setRepeat(0);         // loop forever
  enc.setDelay(msPerFrame); // ms per frame
  enc.setQuality(10);       // lower = better quality / bigger file
  enc.start();

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  // icon size inside cell (take up most of the cell)
  const iconSize = Math.floor(cellSize * 0.86);

  for (let f = 0; f < frames; f++) {
    const t = easeOutCubic(frames === 1 ? 1 : f / (frames - 1));

    // Background
    ctx.fillStyle = "#050505";
    ctx.fillRect(0, 0, W, H);

    // Outer board
    ctx.fillStyle = "#1a1a1a";
    ctx.strokeStyle = "#00b36b";
    ctx.lineWidth = 6;
    roundRect(ctx, padding, padding, boardSize, boardSize, 28, true, true);

    // Cells + reels
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) {
        const x = padding + col * cellSize;
        const y = padding + row * cellSize;

        // Cell
        ctx.fillStyle = "#0a0a0a";
        ctx.strokeStyle = "#1f1f1f";
        ctx.lineWidth = 3;
        roundRect(ctx, x, y, cellSize, cellSize, 26, true, true);

        // Reel pick
        const reel = reels[col];

        // stagger stop feel: col 0 stops first, col 2 last (tighter than before)
        const maxScrollCells = 12 + col * 3;
        const scrollCells = Math.floor((1 - t) * maxScrollCells);

        // landing set uses last 3 entries: [top, mid, bot]
        const indexFromEnd = 3 - row;
        const landingIndex = reel.length - indexFromEnd;
        const pickIndex = Math.max(0, landingIndex - scrollCells);

        const symId = reel[pickIndex];

        const img = await getSymbolImage(symId);
        if (img) {
          const ix = x + (cellSize - iconSize) / 2;
          const iy = y + (cellSize - iconSize) / 2;

          // tiny "motion blur" early on
          if (t < 0.7) {
            ctx.globalAlpha = 0.18;
            ctx.drawImage(img, ix, iy - 10, iconSize, iconSize);
            ctx.globalAlpha = 1;
          }

          ctx.drawImage(img, ix, iy, iconSize, iconSize);
        } else {
          // fallback if missing
          ctx.fillStyle = "#ffffff";
          ctx.font = "20px Arial";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(String(symId ?? "?"), x + cellSize / 2, y + cellSize / 2);
        }
      }
    }

    enc.addFrame(ctx);
  }

  enc.finish();
  return enc.out.getData(); // Buffer/Uint8Array
}

// helper for rounded rect (canvas)
function roundRect(ctx, x, y, w, h, r, fill, stroke) {
  const radius = typeof r === "number"
    ? { tl: r, tr: r, br: r, bl: r }
    : { tl: r.tl ?? 0, tr: r.tr ?? 0, br: r.br ?? 0, bl: r.bl ?? 0 };

  ctx.beginPath();
  ctx.moveTo(x + radius.tl, y);
  ctx.lineTo(x + w - radius.tr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius.tr);
  ctx.lineTo(x + w, y + h - radius.br);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius.br, y + h);
  ctx.lineTo(x + radius.bl, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius.bl);
  ctx.lineTo(x, y + radius.tl);
  ctx.quadraticCurveTo(x, y, x + radius.tl, y);
  ctx.closePath();

  if (fill) ctx.fill();
  if (stroke) ctx.stroke();
}

// ==============================
// 🎰 SLOT BOARD IMAGE GENERATOR
// ==============================

async function buildSlotsBoardImage(grid, winningLines = []) {
  const cellSize = 190;
  const padding = 40;
  const boardSize = cellSize * 3;
  const width = boardSize + padding * 2;
  const height = boardSize + padding * 2;

  let svg = `
  <svg width="${width}" height="${height}"
    xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#050505"/>
    <rect x="${padding}" y="${padding}" width="${boardSize}" height="${boardSize}" rx="25"
      fill="#1a1a1a" stroke="#00b36b" stroke-width="6"/>
  `;

  // Draw cells + custom icon images
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x = padding + col * cellSize;
      const y = padding + row * cellSize;

      svg += `
        <rect x="${x}" y="${y}" width="${cellSize}" height="${cellSize}" rx="20"
          fill="#0a0a0a" stroke="#1f1f1f" stroke-width="3"/>
      `;

      // IMPORTANT: grid now contains symbol IDs like "diamond", "coin", etc.
      const symbolId = grid[row][col];

      const dataUri = await getSymbolDataUri(symbolId);

      if (dataUri) {
        const size = 175;
        const ix = x + (cellSize - size) / 2;
        const iy = y + (cellSize - size) / 2;

        svg += `
          <image x="${ix}" y="${iy}" width="${size}" height="${size}" href="${dataUri}" />
        `;
      } else {
        // fallback if the icon file is missing
        svg += `
          <text
            x="${x + cellSize / 2}"
            y="${y + cellSize / 2}"
            font-size="22"
            text-anchor="middle"
            dominant-baseline="middle"
            fill="white"
            font-family="Arial"
          >${String(symbolId).slice(0, 10)}</text>
        `;
      }
    }
  }

  // Draw winning lines
  winningLines.forEach((line) => {
    const start = line[0];
    const end = line[2];

    const x1 = padding + start[1] * cellSize + cellSize / 2;
    const y1 = padding + start[0] * cellSize + cellSize / 2;
    const x2 = padding + end[1] * cellSize + cellSize / 2;
    const y2 = padding + end[0] * cellSize + cellSize / 2;

    svg += `
      <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"
        stroke="#ff0033" stroke-width="12" stroke-linecap="round" opacity="0.85"/>
    `;
  });

  svg += `</svg>`;

  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 1300 } });
  const pngData = resvg.render();
  return pngData.asPng();
}

// ===== SLASH COMMANDS + BUTTONS =====
client.on("interactionCreate", async (interaction) => {
  try {

    // ====================================================
    // BUTTON HANDLERS (ALWAYS BEFORE SLASH COMMAND CHECK)
    // ====================================================

    // ---------- LEADERBOARD BUTTONS ----------
    if (interaction.isButton() && interaction.customId.startsWith("lb:")) {
      await interaction.deferUpdate();

      const guildId = interaction.guildId;
      const callerId = interaction.user.id;

      const cfg = await getConfig(guildId);
      const currencyName = cfg.currency_name || "Capo Cash";
      const guildName = interaction.guild?.name || "Server";

      const parts = interaction.customId.split(":");
      const action = parts[1];
      const currentPage = Number(parts[2] || 1);

      const base = await fetchLeaderboardPage(guildId, 1, LB_PAGE_SIZE);
      let targetPage = currentPage;

      if (action === "first") targetPage = 1;
      else if (action === "last") targetPage = base.totalPages;
      else if (action === "prev") targetPage = Math.max(1, currentPage - 1);
      else if (action === "next") targetPage = Math.min(base.totalPages, currentPage + 1);
      else if (action === "me") {
        const rank = await findUserRankByScan(guildId, callerId);
        targetPage = rank ? Math.ceil(rank / LB_PAGE_SIZE) : 1;
      }

      const pageData = await fetchLeaderboardPage(guildId, targetPage, LB_PAGE_SIZE);

      const embed = buildLeaderboardEmbed({
        guildName,
        currencyName,
        page: pageData.page,
        totalPages: pageData.totalPages,
        rows: pageData.rows,
        pageSize: pageData.pageSize
      });

      return interaction.editReply({
        embeds: [embed],
        components: leaderboardRowComponents({
          page: pageData.page,
          totalPages: pageData.totalPages
        })
      });
    }
// ---------- BLACKJACK BUTTONS ----------
if (interaction.isButton() && interaction.customId.startsWith("bj:")) {
  const parts = interaction.customId.split(":");
  const action = parts[1];

  // ✅ If showing a modal, DO NOT deferUpdate()
  if (action === "replay_new") {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;

    const key = bjGameKey(guildId, userId, channelId);

    const modal = new ModalBuilder()
      .setCustomId(`bj:newbet:${key}`)
      .setTitle("Blackjack — New Bet");

    const input = new TextInputBuilder()
      .setCustomId("bj_bet_amt")
      .setLabel("Bet amount")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. 50")
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // For all other BJ button actions, defer the update
  await interaction.deferUpdate();

  // =========================
  // Replay same bet
  // =========================
  if (action === "replay_same") {
    const lastBet = Math.max(1, Number(parts[2] || 0));

    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const userId = interaction.user.id;

    const cfg = await getConfig(guildId);
    const currency = BJ_PAGE_CURRENCY(cfg);

    await upsertUserRow(guildId, userId);

    const key = bjGameKey(guildId, userId, channelId);

    const existing = BJ_GAMES.get(key);
    if (existing && !bjIsExpired(existing)) {
      const embed = bjBuildEmbed(cfg, existing, { revealDealer: false });
      return interaction.editReply({ embeds: [embed], components: bjButtons(existing) });
    }
    BJ_GAMES.delete(key);

    const take = await applyBalanceChange({
      guildId,
      userId,
      amount: -lastBet,
      type: "bj_bet",
      reason: "Blackjack bet (replay same)",
      actorId: userId
    });

    if (!take.ok) {
      return interaction.editReply(`❌ You don’t have enough ${currency} for that bet. ${CC_EMOJI}`);
    }

   const player = [bjDrawCard(), bjDrawCard()];
const dealer = [bjDrawCard(), bjDrawCard()];

const playerScore = bjScore(player);
const dealerScore = bjScore(dealer);
const playerBJ = player.length === 2 && playerScore === 21;
const dealerBJ = dealer.length === 2 && dealerScore === 21;

// ✅ AUTO-FINISH natural blackjack (EXACT behavior like old code)
if (playerBJ || dealerBJ) {
  let result = "push";
  if (playerBJ && !dealerBJ) result = "win";
  else if (!playerBJ && dealerBJ) result = "lose";

  let payout = 0;
  if (result === "win") payout = Math.floor(lastBet * 2.5);
  else if (result === "push") payout = lastBet;

  if (payout > 0) {
    await applyBalanceChange({
      guildId,
      userId,
      amount: payout,
      type: "bj_payout",
      reason: "Blackjack (natural) replay same",
      actorId: "system"
    });
  }

  const row = await getUserRow(guildId, userId);
  const newBal = Number(row?.balance ?? 0);

  const profit = result === "win" ? payout - lastBet : result === "push" ? 0 : -lastBet;

  const headline =
    result === "win"
      ? `🂡 **BLACKJACK!** Pays **3:2** ✅ ${CC_EMOJI}`
      : result === "lose"
      ? `💀 **Dealer has Blackjack.** ${CC_EMOJI}`
      : `🤝 **Double Blackjack — Push.** ${CC_EMOJI}`;

  const tempState = {
    bet: lastBet,
    dealerHand: dealer,
    hands: [player],
    activeHandIndex: 0,
    handBets: [lastBet],
    messageLine: headline
  };

  const embed = bjBuildEmbed(cfg, tempState, {
    revealDealer: true,
    footerText: `New Balance: ${fmt(newBal)} ${currency}`
  }).setDescription(
    `${headline}\n` +
      `**Bet:** ${fmt(lastBet)} ${currency}\n` +
      `**Payout:** ${fmt(payout)} ${currency}\n` +
      `**Net:** ${profit >= 0 ? "+" : ""}${fmt(profit)} ${currency} ${CC_EMOJI}`
  );

  return interaction.editReply({ embeds: [embed], components: bjReplayButtons(lastBet) });
}

// otherwise start normal interactive game
const state = {
  key,
  createdAt: Date.now(),
  guildId,
  channelId,
  userId,
  bet: lastBet,
  dealerHand: dealer,
  hands: [player],
  activeHandIndex: 0,
  didSplit: false,
  handBets: [lastBet],
  handResults: [null],
  didDoubleOnHand: [false],
  messageLine: `Choose your move. ${CC_EMOJI}`
};

BJ_GAMES.set(key, state);

const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
  }

  // =========================
  // In-game action buttons
  // =========================
  const gameKey = parts[2]; // bj:hit:<gameKey>
  const state = BJ_GAMES.get(gameKey);

  if (!state || bjIsExpired(state)) {
    BJ_GAMES.delete(gameKey);
    return interaction.editReply({
      content: "⏳ Blackjack game expired. Run `/blackjack` again.",
      components: []
    });
  }

  if (interaction.user.id !== state.userId) {
    return interaction.followUp({ content: "🚫 This isn’t your blackjack game.", ephemeral: true });
  }

  const cfg = await getConfig(state.guildId);
  const currency = BJ_PAGE_CURRENCY(cfg);

  const currentHand = state.hands[state.activeHandIndex];

const settleAndPayout = async () => {
  // Dealer draws to 17+
  while (true) {
  const { total, soft } = bjScoreWithSoft(state.dealerHand);

  // HIT on anything under 17, AND hit on soft 17
  if (total < 17 || (total === 17 && soft)) {
    state.dealerHand.push(bjDrawCard());
    continue;
  }

  break;
}

  const settleHand = (hand) => {
    const ps = bjScore(hand);
    const ds = bjScore(state.dealerHand);
    if (ps > 21) return "lose";
    if (ds > 21) return "win";
    if (ps > ds) return "win";
    if (ps === ds) return "push";
    return "lose";
  };

  const computePayout = () => {
    let payout = 0;
    for (let i = 0; i < state.hands.length; i++) {
      const res = state.handResults[i];
      const handBet = state.handBets[i];
      if (res === "win") payout += handBet * 2;
      else if (res === "push") payout += handBet;
    }
    return payout;
  };

  // Settle any unsettled hands
  for (let i = 0; i < state.hands.length; i++) {
    if (!state.handResults[i]) state.handResults[i] = settleHand(state.hands[i]);
  }

  const payout = computePayout();

  // Apply payout once (total)
  if (payout > 0) {
    await applyBalanceChange({
      guildId: state.guildId,
      userId: state.userId,
      amount: payout,
      type: "bj_payout",
      reason: "Blackjack result",
      actorId: "system"
    });
  }

  const row = await getUserRow(state.guildId, state.userId);
  const newBal = Number(row?.balance ?? 0);

  // EXACT old result text format
  let resultLine = "";
  if (state.hands.length === 1) {
    const r = state.handResults[0];
    resultLine = r === "win" ? "✅ You win!" : r === "push" ? "🤝 Push!" : "❌ You lose.";
  } else {
    const toEmoji = (r) => (r === "win" ? "✅" : r === "push" ? "🤝" : "❌");
    resultLine = `Hand 1: ${toEmoji(state.handResults[0])}  •  Hand 2: ${toEmoji(state.handResults[1])}`;
  }

  // Calculate total risked across all hands (handles split + double correctly)
const totalRisked = state.handBets.reduce(
  (sum, b) => sum + Number(b || 0),
  0
);

const net = payout - totalRisked;

const embed = bjBuildEmbed(cfg, state, {
  revealDealer: true,
  footerText: `New Balance: ${fmt(newBal)} ${currency}`
}).setDescription(
  `**Final:** ${resultLine}\n` +
  `**Payout:** ${fmt(payout)} ${currency}\n` +
  `**Net:** ${net >= 0 ? "+" : ""}${fmt(net)} ${currency} ${CC_EMOJI}`
);

  BJ_GAMES.delete(state.key);

  return interaction.editReply({
    embeds: [embed],
    components: bjReplayButtons(state.bet)
  });
};

  if (action === "hit") {
    currentHand.push(bjDrawCard());
    
    const score = bjScore(currentHand);

// ✅ Auto-stand on 21
if (score === 21) {
  state.messageLine = "🃏 21!";

  // If split and still on first hand → move to second
  if (state.hands.length === 2 && state.activeHandIndex === 0) {
    state.activeHandIndex = 1;
    state.messageLine = "21! Now playing Hand 2.";
    BJ_GAMES.set(state.key, state);
    const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
    return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
  }

  BJ_GAMES.set(state.key, state);
  return settleAndPayout();
}

    if (bjScore(currentHand) > 21) {
      state.messageLine = "💥 Bust!";

      if (state.hands.length === 2 && state.activeHandIndex === 0) {
        state.activeHandIndex = 1;
        state.messageLine = "Hand 1 bust — now playing Hand 2.";
        BJ_GAMES.set(state.key, state);
        const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
        return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
      }

      BJ_GAMES.set(state.key, state);
      return settleAndPayout();
    }

    state.messageLine = "Hit! Choose your move.";
    BJ_GAMES.set(state.key, state);
    const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
    return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
  }

  if (action === "stand") {
    if (state.hands.length === 2 && state.activeHandIndex === 0) {
      state.activeHandIndex = 1;
      state.messageLine = "Now playing Hand 2.";
      BJ_GAMES.set(state.key, state);
      const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
      return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
    }

    state.messageLine = "Standing...";
    BJ_GAMES.set(state.key, state);
    return settleAndPayout();
  }

  if (action === "double") {
    const betToAdd = Number(state.handBets[state.activeHandIndex] || state.bet);

    const take = await applyBalanceChange({
      guildId: state.guildId,
      userId: state.userId,
      amount: -betToAdd,
      type: "bj_bet",
      reason: "Blackjack double down",
      actorId: state.userId
    });

    if (!take.ok) {
      return interaction.followUp({
        content: `❌ Not enough ${currency} to double down.`,
        ephemeral: true
      });
    }

    state.handBets[state.activeHandIndex] = betToAdd * 2;
    state.didDoubleOnHand[state.activeHandIndex] = true;

    currentHand.push(bjDrawCard());
    state.messageLine = "Double down!";
    BJ_GAMES.set(state.key, state);

    if (state.hands.length === 2 && state.activeHandIndex === 0) {
      state.activeHandIndex = 1;
      state.messageLine = "Double down complete — now playing Hand 2.";
      BJ_GAMES.set(state.key, state);
      const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
      return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
    }

    return settleAndPayout();
  }

  if (action === "split") {
    const canSplit = bjCanSplit(currentHand) && !state.didSplit && state.hands.length === 1;
    if (!canSplit) {
      return interaction.followUp({ content: "⚠️ You can’t split right now.", ephemeral: true });
    }

    const baseBet = Number(state.handBets[0] || state.bet);

    const take = await applyBalanceChange({
      guildId: state.guildId,
      userId: state.userId,
      amount: -baseBet,
      type: "bj_bet",
      reason: "Blackjack split",
      actorId: state.userId
    });

    if (!take.ok) {
      return interaction.followUp({
        content: `❌ Not enough ${currency} to split.`,
        ephemeral: true
      });
    }

    const c1 = currentHand[0];
    const c2 = currentHand[1];

    const hand1 = [c1, bjDrawCard()];
    const hand2 = [c2, bjDrawCard()];

    state.hands = [hand1, hand2];
    state.handBets = [baseBet, baseBet];
    state.handResults = [null, null];
    state.didDoubleOnHand = [false, false];
    state.activeHandIndex = 0;
    state.didSplit = true;
    state.messageLine = "Split! Now playing Hand 1.";

    BJ_GAMES.set(state.key, state);
    const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
    return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
  }

  return;
}
    // ---------- BLACKJACK MODAL ----------
    if (
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId.startsWith("bj:newbet:")
    ) {
      const key = interaction.customId.split(":")[2];
      const betRaw = interaction.fields.getTextInputValue("bj_bet_amt") || "";
      const bet = Math.floor(Number(betRaw.replace(/[^\d]/g, "")));

      if (!bet || bet <= 0) {
        return interaction.reply({
          content: "⚠️ Please enter a valid bet amount.",
          ephemeral: true
        });
      }

      const [guildId, channelId, userId] = key.split("_");

      if (interaction.user.id !== userId) {
        return interaction.reply({
          content: "🚫 That replay isn’t for you.",
          ephemeral: true
        });
      }

      const cfg = await getConfig(guildId);
      const currency = BJ_PAGE_CURRENCY(cfg);

      const take = await applyBalanceChange({
        guildId,
        userId,
        amount: -bet,
        type: "bj_bet",
        reason: "Blackjack bet (replay new)",
        actorId: userId
      });

      if (!take.ok) {
        return interaction.reply({
          content: `❌ You don’t have enough ${currency} for that bet. ${CC_EMOJI}`,
          ephemeral: true
        });
      }

            const player = [bjDrawCard(), bjDrawCard()];
      const dealer = [bjDrawCard(), bjDrawCard()];

      // ✅ AUTO-FINISH natural blackjack (same as old behavior)
      const playerScore = bjScore(player);
      const dealerScore = bjScore(dealer);
      const playerBJ = player.length === 2 && playerScore === 21;
      const dealerBJ = dealer.length === 2 && dealerScore === 21;

      if (playerBJ || dealerBJ) {
        let result = "push";
        if (playerBJ && !dealerBJ) result = "win";
        else if (!playerBJ && dealerBJ) result = "lose";

        let payout = 0;
        if (result === "win") payout = Math.floor(bet * 2.5);
        else if (result === "push") payout = bet;

        if (payout > 0) {
          await applyBalanceChange({
            guildId,
            userId,
            amount: payout,
            type: "bj_payout",
            reason: "Blackjack (natural) replay new",
            actorId: "system"
          });
        }

        const row = await getUserRow(guildId, userId);
        const newBal = Number(row?.balance ?? 0);

        const profit = result === "win" ? payout - bet : result === "push" ? 0 : -bet;

        const headline =
          result === "win"
            ? `🂡 **BLACKJACK!** Pays **3:2** ✅ ${CC_EMOJI}`
            : result === "lose"
            ? `💀 **Dealer has Blackjack.** ${CC_EMOJI}`
            : `🤝 **Double Blackjack — Push.** ${CC_EMOJI}`;

        const tempState = {
          bet,
          dealerHand: dealer,
          hands: [player],
          activeHandIndex: 0,
          handBets: [bet],
          messageLine: headline
        };

        const embed = bjBuildEmbed(cfg, tempState, {
          revealDealer: true,
          footerText: `New Balance: ${fmt(newBal)} ${currency}`
        }).setDescription(
          `${headline}\n` +
            `**Bet:** ${fmt(bet)} ${currency}\n` +
            `**Payout:** ${fmt(payout)} ${currency}\n` +
            `**Net:** ${profit >= 0 ? "+" : ""}${fmt(profit)} ${currency} ${CC_EMOJI}`
        );

        return interaction.reply({ embeds: [embed], components: bjReplayButtons(bet) });
      }

      const state = {
        key,
        createdAt: Date.now(),
        guildId,
        channelId,
        userId,
        bet,
        dealerHand: dealer,
        hands: [player],
        activeHandIndex: 0,
        didSplit: false,
        handBets: [bet],
        handResults: [null],
        didDoubleOnHand: [false],
        messageLine: `Choose your move. ${CC_EMOJI}`
      };

    BJ_GAMES.set(key, state);

const embed = bjBuildEmbed(cfg, state, { revealDealer: false });

return interaction.reply({
  embeds: [embed],
  components: bjButtons(state)
});
}

// ---------- SLOTS LINES MODAL ----------
if (
  interaction.type === InteractionType.ModalSubmit &&
  interaction.customId.startsWith("sl:linesmodal:")
) {
  const parts = interaction.customId.split(":");
  const key = parts[2];   // sl:linesmodal:<key>:<msgId>
  // const msgId = parts[3]; // optional, not needed

  const raw = interaction.fields.getTextInputValue("sl_lines") || "";
  const lines = Math.floor(Number(raw.replace(/[^\d]/g, "")));

  if (!lines || lines < 1 || lines > 7) {
    return interaction.reply({
      content: "⚠️ Enter a number of lines from **1 to 7**.",
      ephemeral: true
    });
  }

  // Pull state (or rebuild from key if missing)
  let state = SLOT_GAMES.get(key);
  if (!state) {
    const partsKey = key.split("_"); // slots_${guildId}_${channelId}_${userId}
    const guildId = partsKey[1];
    const channelId = partsKey[2];
    const userId = partsKey[3];

    state = {
      key,
      createdAt: Date.now(),
      guildId,
      channelId,
      userId,
      linesCount: null,
      tierId: null
    };
    SLOT_GAMES.set(key, state);
  }

  // Only the owner can submit
  if (interaction.user.id !== state.userId) {
    return interaction.reply({ content: "🚫 This isn’t your slots game.", ephemeral: true });
  }

  // Refresh TTL + selection
  state.createdAt = Date.now();
  state.linesCount = lines;
  state.tierId = "single";
  SLOT_GAMES.set(key, state);

  const cfg = await getConfig(state.guildId);
  const currency = cfg.currency_name || "Capo Cash";

  const tier = slotsResolveTier(lines, "single"); // always single here
  const betPerLine = tier.betPerLine;
  const totalBet = lines * betPerLine;

  const take = await applyBalanceChange({
    guildId: state.guildId,
    userId: state.userId,
    amount: -totalBet,
    type: "slots_bet",
    reason: `Slots bet (${tier.label}, ${lines} lines)`,
    actorId: state.userId
  });

  if (!take.ok) {
    const embed = slotsEmbed(cfg, state, {
      status: `❌ Not enough ${currency}.`,
      tier,
      totalBet
    });

    return interaction.reply({
      embeds: [embed],
      components: slotsLineButtons(state),
      ephemeral: true
    });
  }

  // Single tier = no CAPO symbol
const symbolPool = BASE_SYMBOLS; // uses your weighted id symbols
const grid = slotsBuildGrid(symbolPool);

  const { wins } = slotsEval(grid, lines);

  let payout = wins.length * tier.winPerLine;
  let jackpotHit = false; // single tier won't ever jackpot, but keeping consistent

  // (this will never run for single, but harmless)
  if (tier.lines === 8 && wins.length === 8 && tier.jackpot) {
    if (Math.random() < tier.jackpot.chance) {
      payout = tier.jackpot.amount;
      jackpotHit = true;
    }
  }

  if (payout > 0) {
    await applyBalanceChange({
      guildId: state.guildId,
      userId: state.userId,
      amount: payout,
      type: jackpotHit ? "slots_jackpot" : "slots_win",
      reason: jackpotHit ? `Slots JACKPOT (${tier.label})` : `Slots win (${tier.label})`,
      actorId: "system"
    });
  }

  const row = await getUserRow(state.guildId, state.userId);
  const newBal = Number(row?.balance ?? 0);

  const winningLinePaths = wins.map((w) => SLOT_PAYLINES[w.line - 1]);

  let boardPng = null;
  try {
    boardPng = await buildSlotsBoardImage(grid, winningLinePaths);
  } catch (err) {
    console.error("Slots board image render failed:", err?.message || err);
  }

  const net = payout - totalBet;

  const status =
    payout > 0
      ? `✅ You won **${fmt(payout)}** ${currency} (${net >= 0 ? "+" : ""}${fmt(net)} net) ${CC_EMOJI}\n` +
        `💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`
      : `❌ No winning lines — **-${fmt(totalBet)}** ${currency} ${CC_EMOJI}\n` +
        `💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`;

  state.lastBetTotal = totalBet;
  SLOT_GAMES.set(key, state);

  const embed = slotsEmbed(cfg, state, {
    status,
    grid: boardPng ? null : grid, // text fallback if image fails
    wins,
    payout,
    tier,
    totalBet
  });

  const filename = `slots-${Date.now()}.png`;
  if (boardPng) embed.setImage(`attachment://${filename}`);
  else embed.setImage(null);

  return interaction.reply({
    embeds: [embed],
    files: boardPng ? [{ attachment: boardPng, name: filename }] : [],
    components: slotsReplayButtons(state)
  });
}

// ---------- SLOTS BUTTONS ----------
if (interaction.isButton() && interaction.customId.startsWith("sl:")) {
  const parts = interaction.customId.split(":");
  const action = parts[1];
  const key = parts.slice(2).join(":"); // slots_${guildId}_${channelId}_${userId}

  // ✅ Lines button -> show modal (DO NOT deferUpdate)
  if (action === "picklines") {
    const msgId = interaction.message?.id;

    const modal = new ModalBuilder()
      .setCustomId(`sl:linesmodal:${key}:${msgId}`)
      .setTitle("Slots — Choose Lines");

    const input = new TextInputBuilder()
      .setCustomId("sl_lines")
      .setLabel("How many lines? (1–7)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("e.g. 3")
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ✅ everything else uses deferUpdate
  await interaction.deferUpdate();

  // -----------------------------
  // Load/rebuild state
  // -----------------------------
  let state = SLOT_GAMES.get(key);

  if (!state) {
    const partsKey = key.split("_"); // slots_${guildId}_${channelId}_${userId}
    const guildId = partsKey[1];
    const channelId = partsKey[2];
    const userId = partsKey[3];

    state = {
      key,
      createdAt: Date.now(),
      guildId,
      channelId,
      userId,
      linesCount: null,
      tierId: null
    };

    SLOT_GAMES.set(key, state);
  }

  // refresh TTL
  state.createdAt = Date.now();
  SLOT_GAMES.set(key, state);

  // Only owner can use buttons
  if (interaction.user.id !== state.userId) {
    return interaction.followUp({
      content: "🚫 This isn’t your slots game.",
      ephemeral: true
    });
  }

  const cfg = await getConfig(state.guildId);
  const currency = cfg.currency_name || "Capo Cash";

  // -----------------------------
  // Spin helper (one source of truth)
  // -----------------------------
  const spin = async (linesCount, tierId = null) => {
    const tier = slotsResolveTier(linesCount, tierId);

    const totalBet = linesCount * tier.betPerLine;

    // Take bet
    const take = await applyBalanceChange({
      guildId: state.guildId,
      userId: state.userId,
      amount: -totalBet,
      type: "slots_bet",
      reason: `Slots bet (${tier.label}, ${linesCount} lines)`,
      actorId: state.userId
    });

    if (!take.ok) {
      const embed = slotsEmbed(cfg, state, {
        status: `❌ Not enough ${currency}.`,
        tier,
        totalBet
      });

      // Clear old images on edit
      return interaction.editReply({
        embeds: [embed],
        components: slotsLineButtons(state),
        attachments: [],
        files: []
      });
    }

    // CAPO symbol only on MAX BET tier
   const isJackpotTier = tier.id === "all10" || tier.id === "max50";
const symbolPool = isJackpotTier
  ? [...BASE_SYMBOLS, CAPO_SYMBOL]
  : BASE_SYMBOLS;

    // Spin grid + evaluate
    const grid = slotsBuildGrid(symbolPool);
    const { wins } = slotsEval(grid, linesCount);

    // Base payout = #winning lines * winPerLine
    let payout = wins.length * tier.winPerLine;
    let jackpotHit = false;

    // Jackpot only possible when playing 8 lines AND all 8 lines win
    if (linesCount === 8 && wins.length === 8 && tier.jackpot) {
      if (Math.random() < tier.jackpot.chance) {
        payout = tier.jackpot.amount;
        jackpotHit = true;
      }
    }

    // Pay winnings
    if (payout > 0) {
      await applyBalanceChange({
        guildId: state.guildId,
        userId: state.userId,
        amount: payout,
        type: jackpotHit ? "slots_jackpot" : "slots_win",
        reason: jackpotHit ? `Slots JACKPOT (${tier.label})` : `Slots win (${tier.label})`,
        actorId: "system"
      });
    }

    // Get new balance
    const row = await getUserRow(state.guildId, state.userId);
    const newBal = Number(row?.balance ?? 0);

    // Build win overlays
    const winningLinePaths = wins.map((w) => SLOT_PAYLINES[w.line - 1]);

    let boardPng = null;
    try {
      boardPng = await buildSlotsBoardImage(grid, winningLinePaths);
    } catch (err) {
      console.error("Slots board image render failed:", err?.message || err);
    }

    const net = payout - totalBet;

    const status =
      jackpotHit
        ? `🏆 **JACKPOT!** You hit **${fmt(payout)}** ${currency}! ${CC_EMOJI}\n` +
          `💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`
        : payout > 0
        ? `✅ You won **${fmt(payout)}** ${currency} (${net >= 0 ? "+" : ""}${fmt(net)} net) ${CC_EMOJI}\n` +
          `💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`
        : `❌ No winning lines — **-${fmt(totalBet)}** ${currency} ${CC_EMOJI}\n` +
          `💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`;

    // Save latest selection
    state.linesCount = linesCount;
    state.tierId = tier.id;
    state.lastBetTotal = totalBet;
    SLOT_GAMES.set(key, state);

    const embed = slotsEmbed(cfg, state, {
      status,
      // If image fails, show text grid
      grid: boardPng ? null : grid,
      wins,
      payout,
      tier,
      totalBet
    });

    const filename = `slots-${Date.now()}.png`;
    if (boardPng) embed.setImage(`attachment://${filename}`);
    else embed.setImage(null);

    return interaction.editReply({
      embeds: [embed],
      attachments: [], // ✅ clears stale image
      files: boardPng ? [{ attachment: boardPng, name: filename }] : [],
      components: slotsReplayButtons(state)
    });
  };

  // -----------------------------
  // Route actions
  // -----------------------------
  if (action === "all10") {
    state.linesCount = 8;
    state.tierId = "all10";
    SLOT_GAMES.set(key, state);
    return spin(8, "all10");
  }

  if (action === "max50") {
    state.linesCount = 8;
    state.tierId = "max50";
    SLOT_GAMES.set(key, state);
    return spin(8, "max50");
  }

  if (action === "again_same") {
    const linesCount = Number(state.linesCount || 0);
    if (!linesCount) {
      const embed = slotsEmbed(cfg, state, { status: "Pick your play first." });
      return interaction.editReply({
        embeds: [embed],
        components: slotsLineButtons(state),
        attachments: [],
        files: []
      });
    }

    const replayTierId =
      state.tierId || (linesCount === 8 ? "all10" : "single");

    return spin(linesCount, replayTierId);
  }

  if (action === "new_game") {
    state.linesCount = null;
    state.tierId = null;
    SLOT_GAMES.set(key, state);

    const embed = slotsEmbed(cfg, state, { status: "Select how you want to play." });

    return interaction.editReply({
      embeds: [embed],
      components: slotsLineButtons(state),
      attachments: [],
      files: []
    });
  }

  // unknown action -> ignore
  return;
}

    // ====================================================
    // SLASH COMMANDS
    // ====================================================
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    await interaction.deferReply();

    const guildId = interaction.guild.id;
    const callerId = interaction.user.id;
    const cfg = await getConfig(guildId);
    const tz = cfg?.timezone || "America/Chicago";

    // ---------- /slots ----------
    // NOTE: This index already expects /slots with NO bet option.
    // If Discord still shows a bet option, remove it from commands.js then re-deploy.
    if (interaction.commandName === "slots") {
      await upsertUserRow(guildId, callerId);

      const key = slotsKey(guildId, interaction.channelId, callerId);

      const state = {
        key,
        createdAt: Date.now(),
        guildId,
        channelId: interaction.channelId,
        userId: callerId,
        linesCount: null,
        tierId: null
      };

      SLOT_GAMES.set(key, state);

      const embed = slotsEmbed(cfg, state, {
        status: "Select how you want to play."
      });

      return interaction.editReply({
        embeds: [embed],
        components: slotsLineButtons(state)
      });
    }

    // ===== RUMBLE (admin) =====
    if (interaction.commandName === "rumble") {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (group === "payout" && sub === "amount") {
    const amount = interaction.options.getInteger("amount", true);
    const channelId = interaction.channelId;

    const { error } = await supabase
      .from("rumble_channel_config")
      .upsert({
        guild_id: guildId,
        channel_id: channelId,
        payout_amount: amount
      });

    if (error) {
      console.error("Rumble channel payout error:", error);
      return interaction.editReply("❌ Failed to update payout.");
    }

    return interaction.editReply(
      `✅ Rumble payout set to **${amount} Capo Cash** for this channel.`
    );
  }
}

    // BLACKJACK (slash command)
    if (interaction.commandName === "blackjack") {
      const bet = Math.max(1, interaction.options.getInteger("bet", true));
      await upsertUserRow(guildId, callerId);

      const key = bjGameKey(guildId, callerId, interaction.channelId);

      const existing = BJ_GAMES.get(key);
      if (existing && !bjIsExpired(existing)) {
        return interaction.editReply(
          "🃏 You already have an active blackjack game here. Finish it or wait for it to expire."
        );
      }
      BJ_GAMES.delete(key);

      const currency = BJ_PAGE_CURRENCY(cfg);

      const take = await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: -bet,
        type: "bj_bet",
        reason: "Blackjack bet",
        actorId: callerId
      });

      if (!take.ok) {
        return interaction.editReply(`❌ You don’t have enough ${currency} for that bet. ${CC_EMOJI}`);
      }

      const player = [bjDrawCard(), bjDrawCard()];
      const dealer = [bjDrawCard(), bjDrawCard()];

      const playerScore = bjScore(player);
      const dealerScore = bjScore(dealer);
      const playerBJ = player.length === 2 && playerScore === 21;
      const dealerBJ = dealer.length === 2 && dealerScore === 21;

      if (playerBJ || dealerBJ) {
        let result = "push";
        if (playerBJ && !dealerBJ) result = "win";
        else if (!playerBJ && dealerBJ) result = "lose";

        let payout = 0;
        if (result === "win") payout = Math.floor(bet * 2.5);
        else if (result === "push") payout = bet;

        if (payout > 0) {
          await applyBalanceChange({
            guildId,
            userId: callerId,
            amount: payout,
            type: "bj_payout",
            reason: "Blackjack (natural)",
            actorId: "system"
          });
        }

        const row = await getUserRow(guildId, callerId);
        const newBal = Number(row?.balance ?? 0);

        const profit = result === "win" ? payout - bet : result === "push" ? 0 : -bet;

        const headline =
          result === "win"
            ? `🂡 **BLACKJACK!** Pays **3:2** ✅ ${CC_EMOJI}`
            : result === "lose"
            ? `💀 **Dealer has Blackjack.** ${CC_EMOJI}`
            : `🤝 **Double Blackjack — Push.** ${CC_EMOJI}`;

        const tempState = {
          bet,
          dealerHand: dealer,
          hands: [player],
          activeHandIndex: 0,
          handBets: [bet],
          messageLine: headline
        };

        const embed = bjBuildEmbed(cfg, tempState, {
          revealDealer: true,
          footerText: `New Balance: ${fmt(newBal)} ${currency}`
        }).setDescription(
          `${headline}\n` +
            `**Bet:** ${fmt(bet)} ${currency}\n` +
            `**Payout:** ${fmt(payout)} ${currency}\n` +
            `**Net:** ${profit >= 0 ? "+" : ""}${fmt(profit)} ${currency} ${CC_EMOJI}`
        );

        return interaction.editReply({ embeds: [embed], components: bjReplayButtons(bet) });
      }

      const state = {
        key,
        createdAt: Date.now(),
        guildId,
        channelId: interaction.channelId,
        userId: callerId,

        bet,
        dealerHand: dealer,

        hands: [player],
        activeHandIndex: 0,

        didSplit: false,
        handBets: [bet],
        handResults: [null],
        didDoubleOnHand: [false],

        messageLine: `Choose your move. ${CC_EMOJI}`
      };

      BJ_GAMES.set(key, state);

      const embed = bjBuildEmbed(cfg, state, { revealDealer: false });

      return interaction.editReply({
        embeds: [embed],
        components: bjButtons(state)
      });
    }

    // 🔒 LOCK / 🔓 UNLOCK (single channel only)
    if (interaction.commandName === "lock" || interaction.commandName === "unlock") {
      const isLock = interaction.commandName === "lock";

      try {
        const channel = await interaction.client.channels.fetch(LOCK_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          return interaction.editReply("❌ Lock channel not found or not a text channel.");
        }

        for (const roleId of LOCK_ROLE_IDS) {
          if (isLock) {
            await channel.permissionOverwrites.edit(roleId, {
              SendMessages: false,
              SendMessagesInThreads: false
            });
          } else {
            await channel.permissionOverwrites.edit(roleId, {
              SendMessages: true,
              SendMessagesInThreads: true,
              EmbedLinks: true,
              AttachFiles: true,
              ReadMessageHistory: true
            });
          }
        }

        return interaction.editReply(
          isLock
            ? `🔒 The arena is now locked.`
            : `🔓 The arena is now open.`
        );
      } catch (e) {
        console.error("Lock/unlock error:", e?.message || e);
        return interaction.editReply("⚠️ Failed to update channel permissions.");
      }
    }

    // BALANCE
    if (interaction.commandName === "balance") {
      const target = interaction.options.getUser("user") ?? interaction.user;

      const row =
        (await getUserRow(guildId, target.id)) || (await upsertUserRow(guildId, target.id));

      return interaction.editReply(
        `💸 <@${target.id}> has **${Number(row.balance ?? 0).toLocaleString(
          "en-US"
        )}** ${cfg.currency_name} ${CC_EMOJI}`
      );
    }

    // DAILY
    if (interaction.commandName === "daily") {
      await upsertUserRow(guildId, callerId);
      const row = await getUserRow(guildId, callerId);

      const now = nowInTz(tz);
      const last = row.last_daily_claim_at
        ? DateTime.fromISO(row.last_daily_claim_at).setZone(tz)
        : null;

      if (last && hoursBetween(last, now) < 24) {
        const next = last.plus({ hours: 24 });
        const unix = Math.floor(next.toSeconds());
        return interaction.editReply(`⏳ Daily cooldown. Try again <t:${unix}:R>`);
      }

      const grace = Number(cfg.daily_grace_hours ?? 3);
      let streak = Number(row.daily_streak ?? 0);

      if (!last) streak = 1;
      else {
        const h = hoursBetween(last, now);
        streak = h <= 24 + grace ? streak + 1 : 1;
      }

      const base = Number(cfg.daily_base ?? 20);
      const per = Number(cfg.daily_bonus_per_streak ?? 2);
      const cap = Number(cfg.daily_bonus_cap ?? 40);
      const bonus = Math.min(per * streak, cap);
      const payout = base + bonus;

      await supabase
        .from("users")
        .update({ last_daily_claim_at: now.toISO(), daily_streak: streak })
        .eq("guild_id", guildId)
        .eq("user_id", callerId);

      await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: payout,
        type: "daily",
        reason: `Daily claim (streak ${streak})`,
        actorId: callerId
      });

      return interaction.editReply(
        `✅ Daily claimed: **+${fmtNum(payout)}** ${cfg.currency_name} ${CC_EMOJI} (streak **${fmtNum(
          streak
        )}**)`
      );
    }

    // WEEKLY
    if (interaction.commandName === "weekly") {
      await upsertUserRow(guildId, callerId);
      const row = await getUserRow(guildId, callerId);

      const now = nowInTz(tz);
      const last = row.last_weekly_claim_at
        ? DateTime.fromISO(row.last_weekly_claim_at).setZone(tz)
        : null;

      if (last && hoursBetween(last, now) < 168) {
        const next = last.plus({ hours: 168 });
        const unix = Math.floor(next.toSeconds());
        return interaction.editReply(`⏳ Weekly cooldown. Try again <t:${unix}:R>`);
      }

      const grace = Number(cfg.weekly_grace_hours ?? 12);
      let streak = Number(row.weekly_streak ?? 0);

      if (!last) streak = 1;
      else {
        const h = hoursBetween(last, now);
        streak = h <= 168 + grace ? streak + 1 : 1;
      }

      const base = Number(cfg.weekly_base ?? 150);
      const per = Number(cfg.weekly_bonus_per_streak ?? 10);
      const cap = Number(cfg.weekly_bonus_cap ?? 100);
      const bonus = Math.min(per * streak, cap);
      const payout = base + bonus;

      await supabase
        .from("users")
        .update({ last_weekly_claim_at: now.toISO(), weekly_streak: streak })
        .eq("guild_id", guildId)
        .eq("user_id", callerId);

      await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: payout,
        type: "weekly",
        reason: `Weekly claim (streak ${streak})`,
        actorId: callerId
      });

      return interaction.editReply(
        `✅ Weekly claimed: **+${fmtNum(payout)}** ${cfg.currency_name} ${CC_EMOJI} (streak **${fmtNum(
          streak
        )}**)`
      );
    }

    // GIVE (admin only)
    if (interaction.commandName === "give") {

      const target = interaction.options.getUser("user", true);
      const amt = Math.max(1, Math.abs(interaction.options.getInteger("amount", true)));

      const res = await applyBalanceChange({
        guildId,
        userId: target.id,
        amount: amt,
        type: "give",
        reason: "Manual give",
        actorId: callerId
      });

      if (!res.ok) return interaction.editReply("❌ Could not give cash.");

      const row = await getUserRow(guildId, target.id);
      const newBal = Number(row?.balance ?? 0);

      return interaction.editReply(
        `✅ Gave <@${target.id}> **+${fmtNum(amt)}** ${cfg.currency_name}. ` +
          `New balance **${fmtNum(newBal)}** ${cfg.currency_name} ${CC_EMOJI}`
      );
    }

    // REMOVE (staff only)
    if (interaction.commandName === "remove") {
      const member = interaction.member;

      const isStaff =
        member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
        member.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
        member.permissions.has(PermissionsBitField.Flags.ManageMessages);

      if (!isStaff) {
        return interaction.editReply("❌ Staff only.");
      }

      const target = interaction.options.getUser("user", true);
      const amt = Math.max(1, Math.abs(interaction.options.getInteger("amount", true)));

      const res = await applyBalanceChange({
        guildId,
        userId: target.id,
        amount: -amt,
        type: "remove",
        reason: "Manual remove",
        actorId: callerId
      });

      if (!res.ok) return interaction.editReply("❌ Could not remove cash.");

      const row = await getUserRow(guildId, target.id);
      const newBal = Number(row?.balance ?? 0);

      return interaction.editReply(
        `🗑️ Removed **${fmtNum(amt)}** ${cfg.currency_name} from <@${target.id}>.\n` +
        `New balance: **${fmtNum(newBal)}** ${cfg.currency_name} ${CC_EMOJI}`
      );
    }

    // CONFIG (admin)
    if (interaction.commandName === "config") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.editReply("❌ You don’t have permission.");
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "view") {
        const tpl =
          "<a:CC:1472374417920229398> {user} was awarded **{amount} {currency}** for winning **Rumble Royale**! <a:CC:1472374417920229398> ";

        return interaction.editReply(
          `⚙️ **Capo Cash Config**\n` +
            `• Currency: **${cfg.currency_name}**\n` +
            `• Rumble win amount: **${cfg.rumble_win_amount || 75}**\n` +
            `• Rumble message template:\n\`${tpl}\``
        );
      }

      if (sub === "rumble_message") {
        const template = interaction.options.getString("template", true);

        if (!template.includes("{user}")) {
          return interaction.editReply(
            "❌ Template must include `{user}`. You can also use `{amount}` and `{currency}`."
          );
        }

        const { error } = await supabase
          .from("config")
          .update({ rumble_announce_template: template })
          .eq("guild_id", guildId);

        if (error) throw error;

        return interaction.editReply("✅ Updated Rumble winner message template.");
      }
    }

    // LEADERBOARD (command)
    if (interaction.commandName === "leaderboard") {
      const page = Math.max(1, interaction.options.getInteger("page") || 1);

      const pageData = await fetchLeaderboardPage(guildId, page, LB_PAGE_SIZE);

      const embed = buildLeaderboardEmbed({
        guildName: interaction.guild?.name || "Server",
        currencyName: cfg.currency_name || "Capo Cash",
        page: pageData.page,
        totalPages: pageData.totalPages,
        rows: pageData.rows,
        pageSize: pageData.pageSize
      });

      return interaction.editReply({
        embeds: [embed],
        components: leaderboardRowComponents({
          page: pageData.page,
          totalPages: pageData.totalPages
        })
      });
    }

    // COINFLIP
    if (interaction.commandName === "coinflip") {
      const bet = Math.max(1, interaction.options.getInteger("bet", true));
      const choice = interaction.options.getString("choice", true);

      await upsertUserRow(guildId, callerId);

      const take = await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: -bet,
        type: "coinflip_bet",
        reason: `Coinflip bet (${choice})`,
        actorId: callerId
      });

      if (!take.ok) {
        return interaction.editReply(`❌ You don’t have enough ${cfg.currency_name} for that bet. ${CC_EMOJI}`);
      }

      const flip = Math.random() < 0.5 ? "heads" : "tails";
      const won = flip === choice;

      if (won) {
        const payout = bet * 2;
        const profit = payout - bet;

        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: payout,
          type: "coinflip_win",
          reason: `Coinflip won (${flip})`,
          actorId: "system"
        });

        const row = await getUserRow(guildId, callerId);
        const newBal = Number(row?.balance ?? 0);

        return interaction.editReply(
          `🪙 It landed on **${flip}**!\n` +
            `<@${callerId}> won **${fmt(profit)} ${cfg.currency_name}** ${CC_EMOJI}\n` +
            `New Balance: **${fmt(newBal)} ${cfg.currency_name}** ${CC_EMOJI}`
        );
      }

      const row = await getUserRow(guildId, callerId);
      const newBal = Number(row?.balance ?? 0);

      return interaction.editReply(
        `🪙 It landed on **${flip}**!\n` +
          `<@${callerId}> lost **${fmt(bet)} ${cfg.currency_name}** ${CC_EMOJI}\n` +
          `New Balance: **${fmt(newBal)} ${cfg.currency_name}** ${CC_EMOJI}`
      );
    }

    // DICE
    if (interaction.commandName === "dice") {
      const bet = Math.max(1, interaction.options.getInteger("bet", true));
      await upsertUserRow(guildId, callerId);

      const take = await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: -bet,
        type: "dice_bet",
        reason: "Dice bet",
        actorId: callerId
      });

      if (!take.ok) {
        return interaction.editReply(`❌ You don’t have enough ${cfg.currency_name} for that bet. ${CC_EMOJI}`);
      }

      const roll = Math.floor(Math.random() * 6) + 1;

      let payout = 0;
      let resultText = "";

      if (roll === 6) {
        payout = bet * 6;
        const profit = payout - bet;

        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: payout,
          type: "dice_win",
          reason: "Rolled a 6",
          actorId: "system"
        });

        resultText =
          `🎲 You rolled **${roll}** — ✅ <@${callerId}> won **${fmt(profit)} ${cfg.currency_name}** ${CC_EMOJI}`;
      } else {
        resultText =
          `🎲 You rolled **${roll}** — ❌ <@${callerId}> lost **${fmt(bet)} ${cfg.currency_name}** ${CC_EMOJI}`;
      }

      const row = await getUserRow(guildId, callerId);
      const newBal = Number(row?.balance ?? 0);

      return interaction.editReply(
        `${resultText}\n💰 New Balance: **${fmt(newBal)} ${cfg.currency_name}** ${CC_EMOJI}`
      );
    }
  } catch (e) {
    console.error("Interaction error:", e?.message || e);

    try {
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply({
          content: "⚠️ Something went wrong. Try again.",
          ephemeral: true
        });
      }
      return interaction.reply({
        content: "⚠️ Something went wrong. Try again.",
        ephemeral: true
      });
    } catch (e) {
      return;
    }
  }

}); // ✅ end interactionCreate (ONLY ONE)

// ----------------------------------------------------
// 2) Replay buttons (no key needed)
// ----------------------------------------------------
function bjReplayButtons(lastBet) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`bj:replay_same:${lastBet}`)
        .setLabel("Play again (same bet)")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId("bj:replay_new")
        .setLabel("Play again (new bet)")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

client.login(DISCORD_TOKEN);
