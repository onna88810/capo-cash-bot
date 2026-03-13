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
  InteractionType,
  ChannelType
} from "discord.js";

import fs from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import GIFEncoder from "gif-encoder-2";
// Roles that get FULL locked (no messages + no reactions/emojis)
const FULL_LOCK_ROLE_IDS = [
  "1457174938380402739", // L
  "1457169070452379680", // N
  "1457168952936501248"  // S
];

// Role that should STILL be able to send messages, but can't react/use external emojis
const EMOJI_ONLY_LOCK_ROLE_ID = "1387100823078699148"; // GH

// The ONE channel you want /lock and /unlock to affect:
const LOCK_CHANNEL_ID = "1469891401314603018";

console.log("🎁 Monthly Booster Gift block loaded");
// ===== Monthly Booster Gift =====
const BOOSTER_ROLE_ID = "1193404745516339272";
const BOOSTER_GIFT_CHANNEL_ID = "1262579520251105300";
const BOOSTER_GIFT_AMOUNT = 1000;
const BOOSTER_GIFT_EMOJI = "<a:CC:1472329566289657890>";
const BOOSTER_TIMEZONE = "America/Chicago";

// ===============================
// KLEPTO SYSTEM
// ===============================
const BANDITS_ROLE_ID = "1481896783377465344";
const KLEPTO_CHANNEL_IDS = [
  "1393270443175055440", // current syndicate-gambling
  "1198016598947139644"  // gen chat
];

const KLEPTO_MIN_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const KLEPTO_MAX_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const KLEPTO_DROP_DURATION_MS = 60 * 1000; // 60 seconds

function getRandomKleptoDelay() {
  return Math.floor(
    Math.random() * (KLEPTO_MAX_INTERVAL_MS - KLEPTO_MIN_INTERVAL_MS + 1)
  ) + KLEPTO_MIN_INTERVAL_MS;
}

let kleptoDropActive = false;
let kleptoDropEndsAt = 0;
let activeKleptoChannelId = null;
const kleptoParticipants = new Set();

// ==============================
// PRIVATE ROOMS (Ghosty Gambling)
// ==============================
const GHOSTY_PRIVATE_HUB_CHANNEL_ID = "1462504562995892376";
const PRIVATE_ROOM_PARENT_CATEGORY_ID = "1301576482644295731";
const PRIVATE_ROOM_IDLE_DAYS = 3;
const PRIVATE_ROOM_TTL_MS = PRIVATE_ROOM_IDLE_DAYS * 24 * 60 * 60 * 1000;
const PRV_CREATE_BTN_PREFIX = "pr:ghosty_gambling:create";
const PRV_CREATE_BTN = "pr:ghosty_gambling:create";
const PRIVATE_HUB_TYPE = "ghosty_gambling";
const PRIVATE_GHOSTY_CATEGORY_ID = PRIVATE_ROOM_PARENT_CATEGORY_ID;
const PRV_ADD_BTN = "pr:ghosty:add";
const PRV_REMOVE_BTN = "pr:ghosty:remove";
const PRV_ADD_MODAL = "pr:ghosty:add_modal";
const PRV_REMOVE_MODAL = "pr:ghosty:remove_modal";
const PRIVATE_EMBED_THROTTLE = new Map(); // channelId -> lastEditMs
// Step 1) Helper: use the category of the channel where the panel button is clicked
function getPrivateRoomCategoryId(interaction) {
  // parentId = category id (or null if the channel isn't in a category)
  return interaction.channel?.parentId || null;
}

function buildPrivateRoomControlsEmbed({ ownerId, lastActivityIso }) {
  const last = lastActivityIso ? new Date(lastActivityIso) : new Date();
  const expiresAt = new Date(last.getTime() + PRIVATE_ROOM_TTL_MS);
  const expiresUnix = Math.floor(expiresAt.getTime() / 1000);

  return new EmbedBuilder()
    .setTitle("👻 Ghosty Private Room")
    .setDescription(
      "**🎛️ Room Controls**\n" +
      "Use the buttons below to manage access to your private gambling room.\n\n" +
      `⏳ **Resets on activity**\n` +
      `🧨 **Auto-deletes:** <t:${expiresUnix}:R>\n\n` +
      "• Add trusted players\n" +
      "• Remove unwanted users\n"
    )
    .addFields({
      name: "Room Owner",
      value: `<@${ownerId}>`,
      inline: true
    })
    .setTimestamp(new Date());
}

// Guest perms (same as owner EXCEPT ManageChannels)
const PRV_GUEST_ALLOW = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.SendMessages,
  PermissionsBitField.Flags.EmbedLinks,
  PermissionsBitField.Flags.AttachFiles,
  PermissionsBitField.Flags.AddReactions,
  PermissionsBitField.Flags.UseExternalEmojis,
  PermissionsBitField.Flags.UseExternalStickers,
  PermissionsBitField.Flags.ManageMessages,
  PermissionsBitField.Flags.ReadMessageHistory,
  PermissionsBitField.Flags.UseApplicationCommands
];

// Accepts: <@123>, <@!123>, or 123
function parseUserIdInput(str = "") {
  const m = String(str).match(/(\d{17,20})/);
  return m ? m[1] : null;
}
async function resolveUserIdFromInput(guild, raw) {
  const str = String(raw || "").trim();

  // 1) Mention or raw ID
  const id = parseUserIdInput(str);
  if (id) return id;

  // 2) Plain username typed in modal (like @Madame or Madame)
  const q = str.replace(/^@+/, "").trim();
  if (!q) return null;

  try {
    const found = await guild.members.fetch({ query: q, limit: 1 });
    const member = found?.first();
    return member?.id ?? null;
  } catch {
    return null;
  }
}

import { DateTime } from "luxon";
import { COMMANDS } from "./commands.js";
import {
  getConfig,
  getUserRow,
  upsertUserRow,
  supabase,
  insertTransaction,
  hasRumblePaid,
  markRumblePaid,
    // 👻 Private Rooms
  getActivePrivateRoomByOwner,
  insertPrivateRoom,
  touchPrivateRoom,
  getExpiredPrivateRooms,
  markPrivateRoomDeleted,
  getSticky,
  upsertSticky,
  clearSticky,
  updateStickyLastPosted,
  hasMonthlyBoosterGift,
  markMonthlyBoosterGift,
  getPickpocketState,
  setPickpocketState,
  getKleptoInventory,
  addKleptoItem,
  useKleptoItem,
  hasKleptoItem
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

const SLOT_PAYTABLE = {
  single: {       // 5/line bet tier
    coin: 10,
    dice: 10,
    raccoon: 12,
    cashstack: 14,
    moneybag: 16,
    briefcase: 18,
    diamond: 22
  },
  all10: {        // 10/line bet tier
    coin: 18,
    dice: 18,
    raccoon: 22,
    cashstack: 28,
    moneybag: 34,
    briefcase: 40,
    diamond: 55
  },
  max50: {        // 50/line bet tier
    coin: 80,
    dice: 80,
    raccoon: 95,
    cashstack: 120,
    moneybag: 150,
    briefcase: 190,
    diamond: 260,
    capo: 0 // keep CAPO payout handled ONLY by jackpot logic (recommended)
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
  // 4) Left column
  [[0,0],[1,0],[2,0]],
  // 5) Middle column
  [[0,1],[1,1],[2,1]],
  // 6) Right column
  [[0,2],[1,2],[2,2]],
  // 7) Diagonal TL -> BR
  [[0,0],[1,1],[2,2]],
  // 8) Diagonal TR -> BL
  [[0,2],[1,1],[2,0]],
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
// ✅ Single Lines should hit more often: smaller pool (more 3-of-a-kind)
const SINGLE_SYMBOLS = [
  { id: "diamond", weight: 25 },
  { id: "dice",    weight: 25 },
  { id: "raccoon", weight: 25 },
  { id: "coin",    weight: 25 },
];

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
  const lines = Number(state.linesCount || 0);
  const tierId = state.tierId || (lines === 8 ? "all10" : "single");

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        // ✅ encode lines + tier into the button id
        .setCustomId(`sl:again:${lines}:${tierId}:${key}`)
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
    GatewayIntentBits.GuildMembers,
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

function buildLeaderboardEmbed({ guildName, currencyName, page, totalPages, rows, requesterId }) {
  const embed = new EmbedBuilder()
    .setTitle(`📊 ${currencyName} Leaderboard`)
    .setDescription(`**${guildName}**\nPage **${page} / ${totalPages}**`)
    .setTimestamp(new Date());

  if (!rows || rows.length === 0) {
    embed.addFields({ name: "No results", value: "No leaderboard entries yet." });
    return embed;
  }

  const lines = rows
    .map((r) => {
      const pin = requesterId && String(r.user_id) === String(requesterId) ? " 📌" : "";
      return `**${r.rank}.** <@${r.user_id}>${pin} — **${fmt(r.balance)}** ${currencyName}`;
    })
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

// ==============================
// 🕵️ KLEPTO HELPERS
// ==============================
const PICKPOCKET_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours
function formatCooldownTime(ms) {
  const totalMinutes = Math.ceil(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function getPickpocketCooldownMessage(ms) {
  const timeText = formatCooldownTime(ms);

  const messages = [
    `🚔 Lay low… you can pickpocket again in **${timeText}**.`,
    `🕶️ Too many eyes around… try again in **${timeText}**.`,
    `👮 The heat is on. Come back in **${timeText}**.`,
    `⏳ You need to wait **${timeText}** before your next pickpocket.`,
    `💼 This place is too hot right now. Try again in **${timeText}**.`
  ];

  return messages[Math.floor(Math.random() * messages.length)];
}
const KLEPTO_ITEMS = {
  gloves: { id: "gloves", name: "Gloves", price: 1000, uses: 3 },
  mask: { id: "mask", name: "Mask", price: 2500, uses: 1 },
  lockpick: { id: "lockpick", name: "Lockpick", price: 5000, uses: 2 }
};

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildKleptoShopEmbed(cfg, inv = {}) {
  return new EmbedBuilder()
    .setTitle("🛒 Klepto Shop")
    .setDescription(
      `Use ${cfg.currency_name} to buy gear for **/pickpocket**.\n` +
      `These items **do not apply to /klepto drops**.\n\n` +
      `**🧤 Gloves — 1,000 ${cfg.currency_name}**\n` +
      `Improves loot quality\nUses: 3\n\n` +
      `**😷 Mask — 2,500 ${cfg.currency_name}**\n` +
      `Blocks one caught penalty\nUses: 1\n\n` +
      `**🔓 Lockpick — 5,000 ${cfg.currency_name}**\n` +
      `Required for locked targets\nUses: 2\n\n` +
      `**Inventory**\n` +
      `🧤 Gloves: **${Number(inv.gloves_uses || 0)}**\n` +
      `😷 Mask: **${Number(inv.mask_count || 0)}**\n` +
      `🔓 Lockpick: **${Number(inv.lockpick_uses || 0)}**`
    )
    .setTimestamp(new Date());
}

function kleptoShopButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("kp:buy:gloves")
        .setLabel("Buy Gloves")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("kp:buy:mask")
        .setLabel("Buy Mask")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("kp:buy:lockpick")
        .setLabel("Buy Lockpick")
        .setStyle(ButtonStyle.Success)
    )
  ];
}

function pickpocketItemButtons(inv = {}) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("pp:item:none")
        .setLabel("No Item")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("pp:item:gloves")
        .setLabel(`Gloves (${Number(inv.gloves_uses || 0)})`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(Number(inv.gloves_uses || 0) <= 0),

      new ButtonBuilder()
        .setCustomId("pp:item:mask")
        .setLabel(`Mask (${Number(inv.mask_count || 0)})`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(Number(inv.mask_count || 0) <= 0),

      new ButtonBuilder()
        .setCustomId("pp:item:lockpick")
        .setLabel(`Lockpick (${Number(inv.lockpick_uses || 0)})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(Number(inv.lockpick_uses || 0) <= 0)
    )
  ];
}

function pickpocketTargetButtons(hasLockpick = false) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pp:target:coat")
      .setLabel("🧥 Coat Pocket")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("pp:target:purse")
      .setLabel("👜 Purse")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("pp:target:phone")
      .setLabel("📱 Phone")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("pp:target:chips")
      .setLabel("🎲 Casino Chips")
      .setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("pp:target:briefcase")
      .setLabel("💼 Briefcase 🔒")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasLockpick),

    new ButtonBuilder()
      .setCustomId("pp:target:hidden")
      .setLabel("🗄 Hidden Compartment 🔒")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!hasLockpick)
  );

  return [row1, row2];
}

function resolveKleptoDropOutcome() {
  const roll = Math.random() * 100;

  if (roll < 35) return { type: "small", amount: randomInt(2000, 8000) };
  if (roll < 60) return { type: "medium", amount: randomInt(9000, 18000) };
  if (roll < 70) return { type: "big", amount: randomInt(19000, 35000) };
  if (roll < 73) return { type: "jackpot", amount: randomInt(36000, 60000) };
  if (roll < 88) return { type: "nothing", amount: 0 };
  return { type: "caught", amount: randomInt(1000, 6000) };
}

function resolvePickpocketOutcome({ locked = false, item = "none" } = {}) {
  const roll = Math.random() * 100;

  if (!locked) {
    if (item === "gloves") {
      if (roll < 40) return { type: "small", amount: randomInt(3000, 9000) };
      if (roll < 72) return { type: "medium", amount: randomInt(10000, 20000) };
      if (roll < 87) return { type: "big", amount: randomInt(21000, 38000) };
      if (roll < 92) return { type: "jackpot", amount: randomInt(39000, 60000) };
      if (roll < 97) return { type: "nothing", amount: 0 };
      return { type: "caught", amount: randomInt(2000, 9000) };
    }

    if (roll < 35) return { type: "small", amount: randomInt(2000, 8000) };
    if (roll < 60) return { type: "medium", amount: randomInt(9000, 18000) };
    if (roll < 70) return { type: "big", amount: randomInt(19000, 35000) };
    if (roll < 73) return { type: "jackpot", amount: randomInt(36000, 60000) };
    if (roll < 88) return { type: "nothing", amount: 0 };
    return { type: "caught", amount: randomInt(2000, 10000) };
  }

  if (roll < 35) return { type: "medium", amount: randomInt(12000, 25000) };
  if (roll < 60) return { type: "big", amount: randomInt(26000, 45000) };
  if (roll < 70) return { type: "jackpot", amount: randomInt(46000, 80000) };
  if (roll < 80) return { type: "nothing", amount: 0 };
  return { type: "caught", amount: randomInt(5000, 15000) };
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
const TIMEZONE = "America/Chicago";

// October–March (left column)
const standardTimes = [
  "00:06","01:07","02:08","03:09",
  "04:01","04:10","05:11","06:12","06:21",
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

// March–October (right column)
const dstTimes = [
  "01:06","02:07","03:08","04:09",
  "05:01","05:10","06:11","07:12","07:21",
  "08:13","08:31","08:37",
  "09:14","09:41",
  "10:15","10:51",
  "11:16","12:17",
  "13:18","14:19",
  "15:02","15:20",
  "16:12","16:21",
  "17:22","18:23","18:32",
  "19:00",
  "20:01","20:11",
  "21:02","21:22",
  "22:03","22:33",
  "23:04","23:44"
];

const nowChicago = DateTime.now().setZone(TIMEZONE);
const dailyTimes = nowChicago.isInDST ? dstTimes : standardTimes;

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

  // ===== Klepto drop scheduler =====
  async function startKleptoDrop() {
    try {
      const channelId =
        KLEPTO_CHANNEL_IDS[Math.floor(Math.random() * KLEPTO_CHANNEL_IDS.length)];

      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) {
        return scheduleNextKleptoDrop();
      }

      kleptoDropActive = true;
      kleptoDropEndsAt = Date.now() + KLEPTO_DROP_DURATION_MS;
      activeKleptoChannelId = channelId;
      kleptoParticipants.clear();

      await channel.send({
        content:
          `<@&${BANDITS_ROLE_ID}>\n` +
          `👜 **A Distracted Stranger Appears!**\n` +
          `Their wallet is hanging out of their pocket...\n` +
          `Use **/klepto** within **60 seconds** to try your luck.`
      });

      setTimeout(async () => {
        try {
          kleptoDropActive = false;
          kleptoDropEndsAt = 0;
          activeKleptoChannelId = null;
          kleptoParticipants.clear();

          const endChannel = await client.channels.fetch(channelId).catch(() => null);
          if (endChannel && endChannel.isTextBased()) {
            await endChannel.send("The stranger noticed the chaos and disappeared.");
          }
        } catch (err) {
          console.error("Klepto drop cleanup error:", err);
        } finally {
          scheduleNextKleptoDrop();
        }
      }, KLEPTO_DROP_DURATION_MS);

    } catch (err) {
      console.error("Klepto drop start error:", err);
      scheduleNextKleptoDrop();
    }
  }

  function scheduleNextKleptoDrop() {
    const delay = getRandomKleptoDelay();
    console.log(`Next klepto drop in ${Math.round(delay / 60000)} minutes`);

    setTimeout(async () => {
      if (kleptoDropActive) return scheduleNextKleptoDrop();
      await startKleptoDrop();
    }, delay);
  }

  scheduleNextKleptoDrop();
  });
  
// ===== PRIVATE ROOMS CLEANUP (every hour) =====
cron.schedule("0 * * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - PRIVATE_ROOM_TTL_MS).toISOString();
    const expired = await getExpiredPrivateRooms(cutoff);

    for (const r of expired) {
      const guild = await client.guilds.fetch(r.guild_id).catch(() => null);
      if (!guild) {
        await markPrivateRoomDeleted(r.channel_id);
        continue;
      }

      const ch = await guild.channels.fetch(r.channel_id).catch(() => null);

      // If already gone, just mark deleted
      if (!ch) {
        await markPrivateRoomDeleted(r.channel_id);
        continue;
      }

      await ch.delete("Private room expired (3 days inactivity)").catch(() => {});
      await markPrivateRoomDeleted(r.channel_id);
    }
  } catch (e) {
    console.error("Private room cleanup error:", e?.message || e);
  }
});

// ==============================
// 🎁 Monthly Booster Gift (Role -> 1,000 CC + ping)
// ==============================
const BOOST_ROLE_ID = "1193404745516339272";
const BOOST_CHANNEL_ID = "1262579520251105300";
const BOOST_AMOUNT = 1000;
const BOOST_TIMEZONE = "America/Chicago";

function monthKeyInTz(tz = BOOST_TIMEZONE) {
  // e.g. "2026-03"
  return DateTime.now().setZone(tz).toFormat("yyyy-LL");
}

// helper: pay + announce (combined message)
async function runMonthlyBoosterGift({ guildId, tz = BOOST_TIMEZONE } = {}) {
  console.log("🎁 Booster gift starting", guildId);

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return;

  const members = await guild.members.fetch({ force: true }).catch(() => null);
  console.log("👥 members fetched:", members?.size);

  if (!members) {
    console.error("Booster gift: Could not fetch members. Is GuildMembers intent enabled?");
    return;
  }

  const boosters = members.filter(m => !!m.premiumSince);
  console.log("🚀 boosters found:", boosters.size);
  if (!boosters.size) return;

  const monthKey = monthKeyInTz(tz);
  console.log("🗓 monthKey:", monthKey);

  const paidMentions = [];

  for (const m of boosters.values()) {
    const already = await hasMonthlyBoosterGift(guild.id, m.id, monthKey);
    if (already) continue;

    const res = await applyBalanceChange({
      guildId: guild.id,
      userId: m.id,
      amount: BOOST_AMOUNT,
      type: "boost_monthly",
      reason: `Monthly booster gift ${monthKey}`,
      actorId: "system"
    });

    console.log("applyBalanceChange result:", m.id, res);

    if (res?.ok) {
      await markMonthlyBoosterGift(guild.id, m.id, monthKey);
      paidMentions.push(`<@${m.id}>`);
    }
  }

  console.log("✅ paidMentions:", paidMentions.length, paidMentions);

  if (!paidMentions.length) return;

  const ch = await client.channels.fetch(BOOST_CHANNEL_ID).catch(() => null);
  if (!ch || !ch.isTextBased()) return;

  const msg =
    `Thank you ${paidMentions.join(", ")} for boosting our server, ` +
    `here is a gift from us to you **${BOOST_AMOUNT.toLocaleString("en-US")}**. ${CC_EMOJI}`;

  await ch.send({ content: msg }).catch((e) => {
    console.error("❌ Booster gift send failed:", e?.message || e);
  });

  console.log("📨 Booster gift message sent in channel", BOOST_CHANNEL_ID);
}

// ---------- REAL: Run on the 1st of every month at 12:05 AM Chicago ----------
cron.schedule(
  "5 0 1 * *",
  async () => {
    try {
      await runMonthlyBoosterGift({ guildId: "1192712272469041152", tz: BOOST_TIMEZONE });
      console.log("✅ Monthly booster payout ran.");
    } catch (e) {
      console.error("Monthly booster payout error:", e?.message || e);
    }
  },
  { timezone: BOOST_TIMEZONE }
);

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

// ===== AUTO-DELETE SPECIFIC INVITE (TARGETED BOT + EMBEDS/COMPONENTS) =====
const BLOCKED_INVITE_CODE = "2EusmmaqvY";
const BLOCKED_BOT_ID = "1279816474441289870";

const INVITE_RE = new RegExp(
  String.raw`(?:https?:\/\/)?(?:discord\.gg|discord\.com\/invite)\/${BLOCKED_INVITE_CODE}`,
  "i"
);

function embedContainsInvite(embed) {
  if (!embed) return false;

  const parts = [];
  if (embed.title) parts.push(embed.title);
  if (embed.description) parts.push(embed.description);
  if (embed.url) parts.push(embed.url);
  if (embed.footer?.text) parts.push(embed.footer.text);
  if (embed.author?.name) parts.push(embed.author.name);
  if (embed.author?.url) parts.push(embed.author.url);

  if (Array.isArray(embed.fields)) {
    for (const f of embed.fields) {
      if (f?.name) parts.push(f.name);
      if (f?.value) parts.push(f.value);
    }
  }

  return INVITE_RE.test(parts.join("\n"));
}

function componentsContainInvite(message) {
  return (message.components || []).some(row =>
    (row.components || []).some(comp =>
      comp?.url && INVITE_RE.test(comp.url)
    )
  );
}

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    // ✅ only delete when THAT bot posts it
    if (message.author?.id !== BLOCKED_BOT_ID) return;

    const contentHit = INVITE_RE.test(message.content || "");
    const embedHit = (message.embeds || []).some(embedContainsInvite);
    const componentHit = componentsContainInvite(message);

    if (contentHit || embedHit || componentHit) {
      await message.delete().catch(() => {});
      console.log("Deleted blocked invite embed/message.");
    }
  } catch (err) {
    console.error("Auto-delete error:", err?.message || err);
  }
});

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const room = await touchPrivateRoom(message.channel.id);
    if (!room) return;

    // throttle embed updates (max once per minute)
    const lastEdit = PRIVATE_EMBED_THROTTLE.get(room.channel_id) || 0;
    if (Date.now() - lastEdit < 60_000) return;
    PRIVATE_EMBED_THROTTLE.set(room.channel_id, Date.now());

    if (!room.control_message_id) return;

    const ch = message.channel;
    if (!ch.isTextBased()) return;

    const controlMsg = await ch.messages.fetch(room.control_message_id).catch(() => null);
    if (!controlMsg) return;

    const embed = buildPrivateRoomControlsEmbed({
      ownerId: room.owner_id,
      lastActivityIso: room.last_activity_at
    });

    await controlMsg.edit({ embeds: [embed] }).catch(() => null);

  } catch (err) {
    console.error("Private room touch error:", err);
  }
});

// ==============================
// 📌 STICKY: Repost on activity
// ==============================
const STICKY_THROTTLE = new Map(); // channelId -> lastMs
const STICKY_MIN_MS = 500;

client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author.bot) return;

    const guildId = message.guild.id;
    const channelId = message.channel.id;

    const sticky = await getSticky(guildId, channelId);
    if (!sticky) return;

    // ignore if the sticky message itself somehow triggered this
    if (sticky.sticky_message_id && message.id === sticky.sticky_message_id) return;

    const last = STICKY_THROTTLE.get(channelId) || 0;
    if (Date.now() - last < STICKY_MIN_MS) return;
    STICKY_THROTTLE.set(channelId, Date.now());

    // delete the old sticky first
    if (sticky.sticky_message_id) {
      const oldMsg = await message.channel.messages
        .fetch(sticky.sticky_message_id)
        .catch(() => null);

      if (oldMsg) {
        await oldMsg.delete().catch((err) => {
          console.error("Sticky old delete failed:", err?.message || err);
        });
      }
    }

    // repost it at the bottom
    let posted;

    if (sticky.type === "embed") {
      const embed = new EmbedBuilder().setTimestamp(new Date());

      if (sticky.embed_title) embed.setTitle(sticky.embed_title);
      if (sticky.embed_description) embed.setDescription(sticky.embed_description);

      posted = await message.channel.send({ embeds: [embed] });
    } else {
      posted = await message.channel.send({
        content: sticky.content || ""
      });
    }

    await upsertSticky({
      guild_id: guildId,
      channel_id: channelId,
      type: sticky.type,
      content: sticky.content,
      embed_title: sticky.embed_title,
      embed_description: sticky.embed_description,
      sticky_message_id: posted.id,
      last_posted_at: new Date().toISOString(),
      created_by: sticky.created_by
    });

    console.log(`✅ Sticky reposted in ${channelId}`);
  } catch (err) {
    console.error("Sticky repost error FULL:", err);
  }
});

// ==============================
// 🎰 SLOT IMAGE HELPERS
// ==============================

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

 async function getSymbolDataUri(symbolId) {
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

async function getSymbolImage(symbolId) {
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
 async function buildSlotsSpinGif(
  finalGrid,
  symbolPool,
  {
    width = 720,
    height = 720,
    cellSize = 220,     // bigger cells for cleaner icons
    padding = 30,
    frames = 18,
    msPerFrame = 90
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
  enc.setRepeat(-1); // ✅ play once (no loop)
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

// Draw winning lines (polyline through all 3 points)
winningLines.forEach((line) => {
  const points = line
    .map(([r, c]) => {
      const x = padding + c * cellSize + cellSize / 2;
      const y = padding + r * cellSize + cellSize / 2;
      return `${x},${y}`;
    })
    .join(" ");

  svg += `
    <polyline points="${points}"
      fill="none"
      stroke="#ff0033"
      stroke-width="12"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.85"/>
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

   // ---------- PRIVATE ROOM BUTTON ----------
if (interaction.isButton() && interaction.customId === PRV_CREATE_BTN) {
  // we are creating a channel -> use deferReply (not deferUpdate)
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId;
  const userId = interaction.user.id;

  // 1) if they already have an active room, just point them to it
  const existing = await getActivePrivateRoomByOwner(guildId, userId, PRIVATE_HUB_TYPE);
  if (existing) {
    const ch = await interaction.guild.channels.fetch(existing.channel_id).catch(() => null);
    if (ch) {
      return interaction.editReply(`✅ You already have a room: <#${existing.channel_id}>`);
    }
    // if channel was deleted manually, mark deleted in DB so they can make a new one
    await markPrivateRoomDeleted(existing.channel_id);
  }

  // 2) create channel under category
  const safeName = interaction.user.username
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "")
    .slice(0, 16);

  const channelName = `🎲│ghosty-${safeName || "player"}`;

  const created = await interaction.guild.channels.create({
    name: channelName,
    parent: getPrivateRoomCategoryId(interaction) || PRIVATE_GHOSTY_CATEGORY_ID,
    type: ChannelType.GuildText,
    reason: `Ghosty private room for ${interaction.user.tag}`,
    permissionOverwrites: [
      // deny everyone
      {
        id: interaction.guild.roles.everyone.id,
        deny: [
          PermissionsBitField.Flags.ViewChannel
        ]
      },
      // allow owner (all perms you listed)
      {
        id: userId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.AttachFiles,
          PermissionsBitField.Flags.AddReactions,
          PermissionsBitField.Flags.UseExternalEmojis,
          PermissionsBitField.Flags.UseExternalStickers,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.UseApplicationCommands
        ]
      },
      // always allow the bot
      {
        id: interaction.client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ManageMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.EmbedLinks,
          PermissionsBitField.Flags.AttachFiles
        ]
      }
    ]
  });

try {
  const parentId = getPrivateRoomCategoryId(interaction) || PRIVATE_GHOSTY_CATEGORY_ID;
await created.setParent(parentId, { lockPermissions: false });
} catch (err) {
  console.error("setParent failed:", err);
}
  // 3) insert DB row
  await insertPrivateRoom({
    channel_id: created.id,
    guild_id: guildId,
    owner_id: userId,
    hub_type: PRIVATE_HUB_TYPE
  });

const manageRow = new ActionRowBuilder().addComponents(
  new ButtonBuilder()
    .setCustomId(PRV_ADD_BTN)
    .setLabel("Add user")
    .setStyle(ButtonStyle.Success),
  new ButtonBuilder()
    .setCustomId(PRV_REMOVE_BTN)
    .setLabel("Remove user")
    .setStyle(ButtonStyle.Danger)
);

const controlEmbed = new EmbedBuilder()
  .setTitle("👻 Ghosty Private Room")
  .setDescription(
    "### 🎛 Room Controls\n" +
    "Use the buttons below to manage access to your private gambling room.\n\n" +
    "• Add trusted players\n" +
    "• Remove unwanted users\n" +
    "• Activity resets the 3-day timer"
  )
  .setColor(0x6a0dad)
  .setThumbnail(interaction.guild.iconURL({ dynamic: true }))
  .setFooter({ text: `Room Owner: ${interaction.user.username}` })
  .setTimestamp();

const updatedEmbed = buildPrivateRoomControlsEmbed({
  ownerId: userId,
  lastActivityIso: new Date().toISOString()
});

const controlMsg = await created.send({
  embeds: [controlEmbed],
  components: [manageRow]
});

// save the control message id so we can edit it later
await supabase
  .from("private_rooms")
  .update({ control_message_id: controlMsg.id })
  .eq("channel_id", created.id)
  .is("deleted_at", null);

// (optional) pin it
await controlMsg.pin().catch(() => {});

  // 4) confirm
  return interaction.editReply(`✅ Room created: <#${created.id}>`);
}

// ---------- PRIVATE ROOM: ADD/REMOVE BUTTONS ----------
if (interaction.isButton() && (interaction.customId === PRV_ADD_BTN || interaction.customId === PRV_REMOVE_BTN)) {
  // Only works inside the private room itself
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const channelId = interaction.channelId;

 const existing = await getActivePrivateRoomByOwner(guildId, userId, PRIVATE_HUB_TYPE);
if (!existing || String(existing.channel_id) !== String(channelId)) {
  return interaction.reply({ content: "🚫 Only the room owner can use these buttons.", ephemeral: true });
}

  const isAdd = interaction.customId === PRV_ADD_BTN;

  const modal = new ModalBuilder()
    .setCustomId(`${isAdd ? PRV_ADD_MODAL : PRV_REMOVE_MODAL}:${channelId}`)
    .setTitle(isAdd ? "Add a user to this room" : "Remove a user from this room");

  const input = new TextInputBuilder()
    .setCustomId("pr_user")
    .setLabel("User mention or ID")
    .setStyle(TextInputStyle.Short)
    .setPlaceholder("Example: @Jake or 123456789012345678")
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return interaction.showModal(modal);
}
// ---------- PRIVATE ROOM: ADD/REMOVE MODALS ----------
if (
  interaction.type === InteractionType.ModalSubmit &&
  (interaction.customId.startsWith(`${PRV_ADD_MODAL}:`) || interaction.customId.startsWith(`${PRV_REMOVE_MODAL}:`))
) {
  const guildId = interaction.guildId;
  const ownerId = interaction.user.id;

 const parts = interaction.customId.split(":");
const channelId = parts[parts.length - 1];
const modalId = parts.slice(0, parts.length - 1).join(":");
const isAdd = modalId === PRV_ADD_MODAL;

  // Verify ownership again
  const existing = await getActivePrivateRoomByOwner(guildId, ownerId, PRIVATE_HUB_TYPE);
if (!existing || String(existing.channel_id) !== String(channelId)) {
  return interaction.reply({ content: "🚫 Only the room owner can do that.", ephemeral: true });
}

  const raw = interaction.fields.getTextInputValue("pr_user") || "";
  const targetId = await resolveUserIdFromInput(interaction.guild, raw);

  if (!targetId) {
    return interaction.reply({ content: "⚠️ I couldn’t read that user. Paste an @mention or a user ID.", ephemeral: true });
  }

  if (targetId === ownerId) {
    return interaction.reply({ content: "⚠️ You already own this room.", ephemeral: true });
  }

  const ch = await interaction.guild.channels.fetch(channelId).catch(() => null);
  if (!ch) {
    return interaction.reply({ content: "⚠️ Channel not found (it may have been deleted).", ephemeral: true });
  }

  if (isAdd) {
    // Add with guest perms (no ManageChannels)
    await ch.permissionOverwrites.edit(targetId, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      AttachFiles: true,
      AddReactions: true,
      UseExternalEmojis: true,
      UseExternalStickers: true,
      ManageMessages: true,
      ReadMessageHistory: true,
      UseApplicationCommands: true
    });

    return interaction.reply({ content: `✅ Added <@${targetId}> to this room.`, ephemeral: true });
  } else {
    // Remove overwrite (they lose access)
    await ch.permissionOverwrites.delete(targetId).catch(() => null);
    return interaction.reply({ content: `🗑️ Removed <@${targetId}> from this room.`, ephemeral: true });
  }
}
// ---------- KLEPTO SHOP BUTTONS ----------
if (interaction.isButton() && interaction.customId.startsWith("kp:")) {
  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const cfg = await getConfig(guildId);

  const itemId = interaction.customId.split(":")[2];
  const item = KLEPTO_ITEMS[itemId];
  if (!item) return;

  const take = await applyBalanceChange({
    guildId,
    userId,
    amount: -item.price,
    type: "klepto_shop",
    reason: `Bought ${item.name}`,
    actorId: userId
  });

  if (!take.ok) {
    return interaction.followUp({
      content: `❌ You don’t have enough ${cfg.currency_name}.`,
      ephemeral: true
    });
  }

  await addKleptoItem(guildId, userId, itemId, item.uses);

  const inv = await getKleptoInventory(guildId, userId);

  return interaction.editReply({
    content: `✅ You bought **${item.name}** for **${item.price.toLocaleString("en-US")}** ${cfg.currency_name}.`,
    embeds: [buildKleptoShopEmbed(cfg, inv)],
    components: kleptoShopButtons()
  });
}
// ---------- PICKPOCKET ITEM BUTTONS ----------
if (interaction.isButton() && interaction.customId.startsWith("pp:item:")) {
  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const inv = await getKleptoInventory(guildId, userId);

  const itemId = interaction.customId.split(":")[2];
  const hasLockpick = Number(inv.lockpick_uses || 0) > 0 || itemId === "lockpick";

  const embed = new EmbedBuilder()
    .setTitle("🕵️ Pick a Pocket")
    .setDescription(
      `Choose where to steal from.\n\n` +
      `Selected item: **${itemId === "none" ? "No Item" : KLEPTO_ITEMS[itemId]?.name || itemId}**`
    )
    .setFooter({ text: `pp_item:${itemId}` })
    .setTimestamp(new Date());

  return interaction.editReply({
    embeds: [embed],
    components: pickpocketTargetButtons(hasLockpick)
  });
}

// ---------- PICKPOCKET TARGET BUTTONS ----------
if (interaction.isButton() && interaction.customId.startsWith("pp:target:")) {
  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const cfg = await getConfig(guildId);

  const ppState = await getPickpocketState(guildId, userId);
  const inv = await getKleptoInventory(guildId, userId);

  const lastAt = ppState?.last_pickpocket_at
    ? new Date(ppState.last_pickpocket_at).getTime()
    : 0;

  if (lastAt && Date.now() - lastAt < PICKPOCKET_COOLDOWN_MS) {
  const remainingMs = PICKPOCKET_COOLDOWN_MS - (Date.now() - lastAt);

  return interaction.followUp({
    content: getPickpocketCooldownMessage(remainingMs),
    ephemeral: true
  });
}

  const targetId = interaction.customId.split(":")[2];
  const originalEmbed = interaction.message?.embeds?.[0];
  const footerText = originalEmbed?.footer?.text || "";
  const selectedItem = footerText.startsWith("pp_item:")
    ? footerText.replace("pp_item:", "")
    : "none";

  const locked = targetId === "briefcase" || targetId === "hidden";

  if (locked && selectedItem !== "lockpick" && Number(inv.lockpick_uses || 0) <= 0) {
    return interaction.followUp({
      content: "🔒 You need a **Lockpick** to attempt that target.",
      ephemeral: true
    });
  }

  let effectiveItem = selectedItem;

  if (effectiveItem === "lockpick") {
    await useKleptoItem(guildId, userId, "lockpick", 1);
  }

  const outcome = resolvePickpocketOutcome({
    locked,
    item: effectiveItem
  });

  let message = "";

  if (outcome.type === "caught" && effectiveItem === "mask" && Number(inv.mask_count || 0) > 0) {
    await useKleptoItem(guildId, userId, "mask", 1);
    message = "😷 Your mask kept you hidden. You escaped without penalty.";
  } else if (outcome.type === "caught") {
    await applyBalanceChange({
      guildId,
      userId,
      amount: -outcome.amount,
      type: "pickpocket_fail",
      reason: `Caught pickpocketing (${targetId})`,
      actorId: "system"
    });

    message = `🚨 You got caught and lost **${outcome.amount.toLocaleString("en-US")}** ${cfg.currency_name}.`;
  } else if (["small", "medium", "big", "jackpot"].includes(outcome.type)) {
    await applyBalanceChange({
      guildId,
      userId,
      amount: outcome.amount,
      type: "pickpocket_win",
      reason: `Pickpocket success (${targetId})`,
      actorId: "system"
    });

    message = `💰 You stole **${outcome.amount.toLocaleString("en-US")}** ${cfg.currency_name}.`;
  } else {
    message = "🫠 You found absolutely nothing useful.";
  }

  if (effectiveItem === "gloves" && Number(inv.gloves_uses || 0) > 0) {
    await useKleptoItem(guildId, userId, "gloves", 1);
  }

  await setPickpocketState(guildId, userId, new Date().toISOString());

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🕵️ Pickpocket Result")
        .setDescription(message)
        .setTimestamp(new Date())
    ],
    components: []
  });
}

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
  guildName: interaction.guild?.name || "Server",
  currencyName: cfg.currency_name || "Capo Cash",
  page: pageData.page,
  totalPages: pageData.totalPages,
  rows: pageData.rows,
  requesterId: callerId
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
const symbolPool = SINGLE_SYMBOLS;
const grid = slotsBuildGrid(symbolPool);

  const { wins } = slotsEval(grid, lines);

  let payout = wins.reduce((sum, w) => {
  const table = SLOT_PAYTABLE[tier.id] || {};
  return sum + Number(table[w.sym] ?? 0);
}, 0);

let jackpotHit = false;
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

  // ✅ Prevent double spins
  if (state.isSpinning) {
    return interaction.followUp({
      content: "⏳ You’ve already selected this spin.",
      ephemeral: true
    });
  }

  state.isSpinning = true;
  SLOT_GAMES.set(state.key, state);

  try {
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

      return interaction.editReply({
        embeds: [embed],
        components: slotsLineButtons(state),
        attachments: [],
        files: []
      });
    }

    const symbolPool =
  tier.id === "single"
    ? SINGLE_SYMBOLS
    : tier.id === "max50"
      ? [...BASE_SYMBOLS, CAPO_SYMBOL]
      : BASE_SYMBOLS;

    const grid = slotsBuildGrid(symbolPool);
    const { wins } = slotsEval(grid, linesCount);

   let payout = wins.reduce((sum, w) => {
  const table = SLOT_PAYTABLE[tier.id] || {};
  return sum + Number(table[w.sym] ?? 0);
}, 0);

let jackpotHit = false;
    if (linesCount === 8 && wins.length === 8 && tier.jackpot) {
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
        reason: jackpotHit
          ? `Slots JACKPOT (${tier.label})`
          : `Slots win (${tier.label})`,
        actorId: "system"
      });
    }

    const row = await getUserRow(state.guildId, state.userId);
    const newBal = Number(row?.balance ?? 0);
    const net = payout - totalBet;

    const status =
      jackpotHit
        ? `🏆 **JACKPOT!** You hit **${fmt(payout)}** ${currency}! ${CC_EMOJI}\n💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`
        : payout > 0
        ? `✅ You won **${fmt(payout)}** ${currency} (${net >= 0 ? "+" : ""}${fmt(net)} net) ${CC_EMOJI}\n💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`
        : `❌ No winning lines — **-${fmt(totalBet)}** ${currency} ${CC_EMOJI}\n💰 New Balance: **${fmt(newBal)} ${currency}** ${CC_EMOJI}`;

    state.linesCount = linesCount;
    state.tierId = tier.id;
    state.lastBetTotal = totalBet;
    SLOT_GAMES.set(state.key, state);

    const winningLinePaths = wins.map((w) => SLOT_PAYLINES[w.line - 1]);

    // Instant "Spinning..." feedback
    const spinningEmbed = slotsEmbed(cfg, state, {
      status: "🎰 Spinning...",
      grid: null,
      wins: [],
      payout: 0,
      tier,
      totalBet
    });

    await interaction.editReply({
      embeds: [spinningEmbed],
      components: slotsReplayButtons(state),
      attachments: [],
      files: []
    });

    const pngPromise = buildSlotsBoardImage(grid, winningLinePaths)
      .catch(() => null);

    let spinGif = null;
    try {
      spinGif = await buildSlotsSpinGif(grid, symbolPool, {
        width: 720,
        height: 720,
        frames: 18,
        msPerFrame: 90
      });
    } catch {}

    const embed = slotsEmbed(cfg, state, {
      status,
      grid: null,
      wins,
      payout,
      tier,
      totalBet
    });

    if (spinGif) {
      const gifName = `slots-spin-${Date.now()}.gif`;
      embed.setImage(`attachment://${gifName}`);

      await interaction.editReply({
        embeds: [embed],
        attachments: [],
        files: [{ attachment: spinGif, name: gifName }],
        components: slotsReplayButtons(state)
      });

      await new Promise((r) => setTimeout(r, 1200));
    }

    const boardPng = await pngPromise;

    if (boardPng) {
      const pngName = `slots-${Date.now()}.png`;
      embed.setImage(`attachment://${pngName}`);

      return interaction.editReply({
        embeds: [embed],
        attachments: [],
        files: [{ attachment: boardPng, name: pngName }],
        components: slotsReplayButtons(state)
      });
    }

    embed.setImage(null);
    return interaction.editReply({
      embeds: [embed],
      attachments: [],
      files: [],
      components: slotsReplayButtons(state)
    });

  } finally {
    state.isSpinning = false;
    SLOT_GAMES.set(state.key, state);
  }
};


// -----------------------------
// Route actions
// -----------------------------
if (action === "all10") {
  state.linesCount = 8;
  state.tierId = "all10";
  SLOT_GAMES.set(state.key, state);
  return spin(8, "all10");
}

if (action === "max50") {
  state.linesCount = 8;
  state.tierId = "max50";
  SLOT_GAMES.set(state.key, state);
  return spin(8, "max50");
}

if (action === "again") {
  const linesCount = Number(parts[2] || 0);
  const replayTierId =
    parts[3] || (linesCount === 8 ? "all10" : "single");

  const keyFromBtn = parts.slice(4).join(":");
  const resolvedKey = keyFromBtn || key;

  let s = SLOT_GAMES.get(resolvedKey);

  if (!s) return;

  if (interaction.user.id !== s.userId) {
    return interaction.followUp({
      content: "🚫 This isn’t your slots game.",
      ephemeral: true
    });
  }

  state = s;
  return spin(linesCount, replayTierId);
}

if (action === "new_game") {
  state.linesCount = null;
  state.tierId = null;
  SLOT_GAMES.set(state.key, state);

  const embed = slotsEmbed(cfg, state, {
    status: "Select how you want to play."
  });

  return interaction.editReply({
    embeds: [embed],
    components: slotsLineButtons(state),
    attachments: [],
    files: []
  });
}

return;
}

    // ====================================================
    // SLASH COMMANDS
    // ====================================================
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guild) return;

    const EPHEMERAL_CMDS = new Set(["sticky", "unstick"]);
await interaction.deferReply({ ephemeral: EPHEMERAL_CMDS.has(interaction.commandName) });
    const guildId = interaction.guildId;
const callerId = interaction.user.id;
const cfg = await getConfig(guildId);
const tz = cfg.timezone || "America/Chicago";
// ==============================
// 📌 STICKY (Slash Commands)
// ==============================
if (interaction.commandName === "sticky") {
  const member = interaction.member;
  const isStaff =
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    member.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isStaff) return interaction.editReply("❌ Staff only.");

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  const authorId = interaction.user.id;

  const type = interaction.options.getString("type", true);
  const text = interaction.options.getString("text");
  const title = interaction.options.getString("title");
  const description = interaction.options.getString("description");

  // validation
  if (type === "message" && !text) {
    return interaction.editReply("❌ For a message sticky, fill in the `text` field.");
  }

  // delete old sticky message if it exists
  const existing = await getSticky(guildId, channelId);
  if (existing?.sticky_message_id) {
    const ch = interaction.channel;
    const oldMsg = await ch.messages.fetch(existing.sticky_message_id).catch(() => null);
    if (oldMsg) await oldMsg.delete().catch(() => {});
  }

  // ---------- message sticky ----------
  if (type === "message") {
    const posted = await interaction.channel.send({ content: text });

    await upsertSticky({
      guild_id: guildId,
      channel_id: channelId,
      type: "message",
      content: text,
      embed_title: null,
      embed_description: null,
      sticky_message_id: posted.id,
      last_posted_at: new Date().toISOString(),
      created_by: authorId
    });

    return interaction.editReply("✅ Sticky message set.");
  }

  // ---------- embed sticky ----------
  if (type === "embed") {
    const embed = new EmbedBuilder().setTimestamp(new Date());

    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);

    const posted = await interaction.channel.send({ embeds: [embed] });

    await upsertSticky({
  guild_id: guildId,
  channel_id: channelId,
  type: "embed",
  content: "",
  embed_title: title || null,
  embed_description: description || null,
  sticky_message_id: posted.id,
  last_posted_at: new Date().toISOString(),
  created_by: authorId
});

    return interaction.editReply("✅ Sticky embed set.");
  }

  return interaction.editReply("❌ Invalid sticky type.");
}

if (interaction.commandName === "unstick") {
  const member = interaction.member;
  const isStaff =
    member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
    member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
    member.permissions.has(PermissionsBitField.Flags.ModerateMembers) ||
    member.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!isStaff) return interaction.editReply("❌ Staff only.");

  const guildId = interaction.guildId;
  const channelId = interaction.channelId;

  const existing = await getSticky(guildId, channelId);

  // try DB-based removal first
  if (existing?.sticky_message_id) {
    const oldMsg = await interaction.channel.messages
      .fetch(existing.sticky_message_id)
      .catch(() => null);

    if (oldMsg) await oldMsg.delete().catch(() => {});
    await clearSticky(guildId, channelId);
    return interaction.editReply("✅ Sticky removed.");
  }

  // fallback: remove most recent bot message/embed in this channel
  const recent = await interaction.channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (recent) {
    const botMsgs = [...recent.values()].filter(m => m.author?.id === client.user.id);

    for (const m of botMsgs) {
      if (m.embeds?.length || m.content) {
        await m.delete().catch(() => {});
        await clearSticky(guildId, channelId).catch(() => {});
        return interaction.editReply("✅ Sticky removed.");
      }
    }
  }

  return interaction.editReply("✅ No sticky to remove.");
}

// ---------- /private ghosty gambling ----------
if (interaction.commandName === "private") {
  const group = interaction.options.getSubcommandGroup();
  const sub = interaction.options.getSubcommand();

  if (group === "ghosty" && sub === "gambling") {

    // Optional: lock to staff/admin only
    // If you want anyone to be able to run it, remove this check.
    const member = interaction.member;
    const isStaff =
      member.permissions.has(PermissionsBitField.Flags.ManageGuild) ||
      member.permissions.has(PermissionsBitField.Flags.ManageMessages) ||
      member.permissions.has(PermissionsBitField.Flags.Administrator);

    if (!isStaff) {
      return interaction.editReply("❌ Staff only.");
    }

    // ✅ Post the panel in the channel where the command is run
    const hub = interaction.channel;
    if (!hub || !hub.isTextBased()) {
      return interaction.editReply("❌ This command must be used in a text channel.");
    }

    const embed = new EmbedBuilder()
      .setTitle("👻 Ghosty Private Gambling Rooms")
      .setDescription(
        "Press the button to create your **private gambling room**.\n\n" +
        "• Private access for you\n" +
        "• Auto-deletes after **3 days of inactivity**\n" +
        "• Activity resets the timer"
      )
      .setTimestamp(new Date());

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("pr:ghosty_gambling:create")
        .setLabel("Create Private Gambling Room")
        .setStyle(ButtonStyle.Success)
    );

    await hub.send({ embeds: [embed], components: [row] });

    return interaction.editReply("✅ Posted the Ghosty private gambling room panel.");
  }

  return interaction.editReply("❌ Unknown private subcommand.");
}

// ---------- /shop ----------
if (interaction.commandName === "shop") {
  await upsertUserRow(guildId, callerId);
  const inv = await getKleptoInventory(guildId, callerId);

  return interaction.editReply({
    embeds: [buildKleptoShopEmbed(cfg, inv)],
    components: kleptoShopButtons()
  });
}

// ---------- /inventory ----------
if (interaction.commandName === "inventory") {
  await upsertUserRow(guildId, callerId);
  const inv = await getKleptoInventory(guildId, callerId);

  return interaction.editReply(
    `🧤 Gloves: **${Number(inv.gloves_uses || 0)}**\n` +
    `😷 Mask: **${Number(inv.mask_count || 0)}**\n` +
    `🔓 Lockpick: **${Number(inv.lockpick_uses || 0)}**`
  );
}

// ---------- /klepto ----------
if (interaction.commandName === "klepto") {
  if (!kleptoDropActive || Date.now() > kleptoDropEndsAt) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.deleteReply().catch(() => {});
      }
    } catch {}
    return;
  }

    if (interaction.channelId !== activeKleptoChannelId) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.deleteReply().catch(() => {});
      }
    } catch {}
    return;
  }

  if (kleptoParticipants.has(callerId)) {
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.deleteReply().catch(() => {});
      }
    } catch {}
    return;
  }

  kleptoParticipants.add(callerId);

  const outcome = resolveKleptoDropOutcome();

  if (outcome.type === "caught") {
    await applyBalanceChange({
      guildId,
      userId: callerId,
      amount: -outcome.amount,
      type: "klepto_fail",
      reason: "Caught during live klepto drop",
      actorId: "system"
    });

    return interaction.editReply(
      `🚨 The stranger noticed. You lost **${outcome.amount.toLocaleString("en-US")}** ${cfg.currency_name}.`
    );
  }

  if (["small", "medium", "big", "jackpot"].includes(outcome.type)) {
    await applyBalanceChange({
      guildId,
      userId: callerId,
      amount: outcome.amount,
      type: "klepto_win",
      reason: "Live klepto drop win",
      actorId: "system"
    });

    return interaction.editReply(
      `💰 You lifted **${outcome.amount.toLocaleString("en-US")}** ${cfg.currency_name}.`
    );
  }

  return interaction.editReply("🫠 You found nothing useful.");
}

// ---------- /pickpocket ----------
if (interaction.commandName === "pickpocket") {
  await upsertUserRow(guildId, callerId);

  const ppState = await getPickpocketState(guildId, callerId);
  const inv = await getKleptoInventory(guildId, callerId);

  const lastAt = ppState?.last_pickpocket_at
    ? new Date(ppState.last_pickpocket_at).getTime()
    : 0;

  if (lastAt && Date.now() - lastAt < PICKPOCKET_COOLDOWN_MS) {
  const remainingMs = PICKPOCKET_COOLDOWN_MS - (Date.now() - lastAt);

  return interaction.editReply(
    getPickpocketCooldownMessage(remainingMs)
  );
}

  if (
    Number(inv.gloves_uses || 0) <= 0 &&
    Number(inv.mask_count || 0) <= 0 &&
    Number(inv.lockpick_uses || 0) <= 0
  ) {
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setTitle("🕵️ Pick a Pocket")
          .setDescription("Choose where to steal from.")
          .setFooter({ text: "pp_item:none" })
          .setTimestamp(new Date())
      ],
      components: pickpocketTargetButtons(false)
    });
  }

  return interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle("🕵️ Pickpocket")
        .setDescription("Choose an item to use, or continue with no item.")
        .setTimestamp(new Date())
    ],
    components: pickpocketItemButtons(inv)
  });
}

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

    // ===== FULL LOCK ROLES (L/N/S) =====
    for (const roleId of FULL_LOCK_ROLE_IDS) {
      if (isLock) {
        await channel.permissionOverwrites.edit(roleId, {
          SendMessages: false,
          SendMessagesInThreads: false,
          AddReactions: false,
          UseExternalEmojis: false
        });
      } else {
        // ✅ force allow back on (do NOT set null)
await channel.permissionOverwrites.edit(roleId, {
  SendMessages: true,
  SendMessagesInThreads: true,
  AddReactions: true,
  UseExternalEmojis: true,
  UseExternalStickers: true
});
      }
    }

    // ===== EMOJI-ONLY LOCK ROLE (GH) =====
if (isLock) {
  await channel.permissionOverwrites.edit(EMOJI_ONLY_LOCK_ROLE_ID, {
    AddReactions: false,
    UseExternalEmojis: false,
    UseExternalStickers: false
  });
} else {
  // ✅ force allow (do NOT set null)
  await channel.permissionOverwrites.edit(EMOJI_ONLY_LOCK_ROLE_ID, {
    AddReactions: true,
    UseExternalEmojis: true,
    UseExternalStickers: true
  });
}

    return interaction.editReply(
      isLock ? "🔒 The arena is now locked." : "🔓 The arena is now open."
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

let streak = Number(row.daily_streak ?? 0);

if (last) {
  const lastDay = last.startOf("day");
  const today = now.startOf("day");
  const dayDiff = Math.floor(today.diff(lastDay, "days").days);

  // already claimed today
  if (dayDiff === 0) {
    const next = today.plus({ days: 1 }); // next midnight in tz
    const unix = Math.floor(next.toSeconds());
    return interaction.editReply(`⏳ Daily cooldown. Try again <t:${unix}:R>`);
  }

  // claimed yesterday -> continue streak
  if (dayDiff === 1) streak = streak + 1;
  else streak = 1; // missed 1+ full days
} else {
  streak = 1;
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
  requesterId: callerId
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
    console.error("Interaction error FULL:", e);

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
