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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

const COIN = "<a:CC:1472374417920229398>";
const CC_EMOJI = COIN;
const fmtNum = (n) => Number(n ?? 0).toLocaleString("en-US");

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_APP_ID env vars.");
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

    const amount = Number(cfg.rumble_win_amount || 75);

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

// ===== SLASH COMMANDS + LEADERBOARD BUTTONS =====
client.on("interactionCreate", async (interaction) => {
  // --- Leaderboard buttons ---
  if (interaction.isButton() && interaction.customId.startsWith("lb:")) {
    try {
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
    } catch (e) {
      console.error("Leaderboard button error:", e?.message || e);
      return;
    }
  }
// ===== Blackjack buttons + replay (must be BEFORE isChatInputCommand return) =====

// ----------------------------------------------------
// 0) "New bet" modal submit -> starts a new game
// ----------------------------------------------------
if (interaction.type === InteractionType.ModalSubmit && interaction.customId.startsWith("bj:newbet:")) {
  try {
    const key = interaction.customId.split(":")[2]; // bj:newbet:<key>

    const betRaw = interaction.fields.getTextInputValue("bj_bet_amt") || "";
    const bet = Math.floor(Number(betRaw.replace(/[^\d]/g, "")));

    if (!bet || bet <= 0) {
      return interaction.reply({ content: "⚠️ Please enter a valid bet amount.", ephemeral: true });
    }

    const [guildId, channelId, userId] = key.split("_");
    if (interaction.guildId !== guildId || interaction.channelId !== channelId) {
      return interaction.reply({ content: "⚠️ That replay is no longer valid in this channel.", ephemeral: true });
    }
    if (interaction.user.id !== userId) {
      return interaction.reply({ content: "🚫 That replay isn’t for you.", ephemeral: true });
    }

    const cfg = await getConfig(guildId);
    const currency = BJ_PAGE_CURRENCY(cfg);

    const existing = BJ_GAMES.get(key);
    if (existing && !bjIsExpired(existing)) {
      return interaction.reply({ content: "🃏 You already have an active blackjack game here.", ephemeral: true });
    }
    BJ_GAMES.delete(key);

    // take bet up front
    const take = await applyBalanceChange({
      guildId,
      userId,
      amount: -bet,
      type: "bj_bet",
      reason: "Blackjack bet (replay new)",
      actorId: userId
    });

    if (!take.ok) {
      return interaction.reply({ content: `❌ You don’t have enough ${currency} for that bet. ${CC_EMOJI}`, ephemeral: true });
    }

    // deal
    const playerHand = [bjDrawCard(), bjDrawCard()];
    const dealerHand = [bjDrawCard(), bjDrawCard()];

    const playerScore = bjScore(playerHand);
    const dealerScore = bjScore(dealerHand);
    const playerBJ = playerScore === 21 && playerHand.length === 2;
    const dealerBJ = dealerScore === 21 && dealerHand.length === 2;

    // natural blackjack (3:2)
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
          reason: "Blackjack (natural) result",
          actorId: "system"
        });
      }

      const row = await getUserRow(guildId, userId);
      const newBal = Number(row?.balance ?? 0);

      const headline =
        result === "win"
          ? `🂡 **BLACKJACK!** Pays **3:2** ✅`
          : result === "lose"
          ? `💀 **Dealer has Blackjack.**`
          : `🤝 **Double Blackjack — Push.**`;

      const tempState = {
        bet,
        dealerHand,
        hands: [playerHand],
        activeHandIndex: 0,
        handBets: [bet],
        messageLine: headline
      };

      const embed = bjBuildEmbed(cfg, tempState, {
        revealDealer: true,
        // IMPORTANT: keep footer plain text (custom emoji won't render here reliably)
        footerText: `New Balance: ${fmt(newBal)} ${currency}`
      }).setDescription(
        `${headline}\n` +
        `**Bet:** ${fmt(bet)} ${currency}\n` +
        `**Payout:** ${fmt(payout)} ${currency}\n` +
        `**Net:** ${result === "win" ? `+${fmt(payout - bet)}` : result === "push" ? "0" : `-${fmt(bet)}`} ${currency} ${CC_EMOJI}`
      );

      return interaction.reply({
        embeds: [embed],
        components: bjReplayButtons(bet)
      });
    }

    // normal interactive game
    const state = {
      key,
      createdAt: Date.now(),
      guildId,
      channelId,
      userId,

      bet,
      dealerHand,

      hands: [playerHand],
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
  } catch (e) {
    console.error("Blackjack modal submit error:", e?.message || e);
    return interaction.reply({ content: "⚠️ Something went wrong. Please try again.", ephemeral: true });
  }
}

// ----------------------------------------------------
// 1) Button clicks (hit/stand/double/split + replay)
// ----------------------------------------------------
if (interaction.isButton() && interaction.customId.startsWith("bj:")) {
  try {
    const parts = interaction.customId.split(":");
    const action = parts[1];

    // REPLAY NEW BET -> show modal (DO NOT deferUpdate before showModal)
    if (action === "replay_new") {
      const guildId = interaction.guildId;
      const callerId = interaction.user.id;
      const key = bjGameKey(guildId, callerId, interaction.channelId);

      const modal = new ModalBuilder()
        .setCustomId(`bj:newbet:${key}`)
        .setTitle("Blackjack - New Bet");

      const betInput = new TextInputBuilder()
        .setCustomId("bj_bet_amt")
        .setLabel("Enter your bet amount")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("e.g. 2500");

      modal.addComponents(new ActionRowBuilder().addComponents(betInput));
      return interaction.showModal(modal);
    }

    // Everything else can deferUpdate
    await interaction.deferUpdate();

    // REPLAY SAME BET -> auto-start new game
    if (action === "replay_same") {
      const lastBet = Math.floor(Number(parts[2] || 0));
      if (!lastBet || lastBet <= 0) {
        return interaction.editReply({ content: "⚠️ Invalid replay bet.", components: [] });
      }

      const guildId = interaction.guildId;
      const callerId = interaction.user.id;

      const cfg = await getConfig(guildId);
      const currency = BJ_PAGE_CURRENCY(cfg);

      const key = bjGameKey(guildId, callerId, interaction.channelId);

      const existing = BJ_GAMES.get(key);
      if (existing && !bjIsExpired(existing)) {
        return interaction.editReply({ content: "🃏 You already have an active blackjack game here.", components: [] });
      }
      BJ_GAMES.delete(key);

      const take = await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: -lastBet,
        type: "bj_bet",
        reason: "Blackjack bet (replay same)",
        actorId: callerId
      });

      if (!take.ok) {
        return interaction.editReply({ content: `❌ You don’t have enough ${currency} for that bet. ${CC_EMOJI}`, components: [] });
      }

      const playerHand = [bjDrawCard(), bjDrawCard()];
      const dealerHand = [bjDrawCard(), bjDrawCard()];

      const playerScore = bjScore(playerHand);
      const dealerScore = bjScore(dealerHand);
      const playerBJ = playerScore === 21 && playerHand.length === 2;
      const dealerBJ = dealerScore === 21 && dealerHand.length === 2;

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
            userId: callerId,
            amount: payout,
            type: "bj_payout",
            reason: "Blackjack (natural) replay same",
            actorId: "system"
          });
        }

        const row = await getUserRow(guildId, callerId);
        const newBal = Number(row?.balance ?? 0);

        const headline =
          result === "win"
            ? `🂡 **BLACKJACK!** Pays **3:2** ✅`
            : result === "lose"
            ? `💀 **Dealer has Blackjack.**`
            : `🤝 **Double Blackjack — Push.**`;

        const tempState = {
          bet: lastBet,
          dealerHand,
          hands: [playerHand],
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
          `**Net:** ${result === "win" ? `+${fmt(payout - lastBet)}` : result === "push" ? "0" : `-${fmt(lastBet)}`} ${currency} ${CC_EMOJI}`
        );

        return interaction.editReply({
          embeds: [embed],
          components: bjReplayButtons(lastBet)
        });
      }

      const state = {
        key,
        createdAt: Date.now(),
        guildId,
        channelId: interaction.channelId,
        userId: callerId,

        bet: lastBet,
        dealerHand,

        hands: [playerHand],
        activeHandIndex: 0,

        didSplit: false,
        handBets: [lastBet],
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

    // NORMAL GAME BUTTON FLOW (hit/stand/double/split)
    const key = parts.slice(2).join(":");
    const state = BJ_GAMES.get(key);

    if (!state) {
      return interaction.editReply({ content: "⚠️ This blackjack game is no longer active.", components: [] });
    }
    if (interaction.user.id !== state.userId) {
      return interaction.followUp({ content: "🚫 This isn’t your blackjack game.", ephemeral: true });
    }
    if (bjIsExpired(state)) {
      BJ_GAMES.delete(key);
      return interaction.editReply({ content: "⏳ This blackjack game expired. Start a new one with `/blackjack`.", components: [] });
    }

    const guildId = state.guildId;
    const cfg = await getConfig(guildId);
    const currency = BJ_PAGE_CURRENCY(cfg);

    const currentHand = state.hands[state.activeHandIndex];

    const dealerPlay = () => {
      while (bjScore(state.dealerHand) < 17) state.dealerHand.push(bjDrawCard());
    };

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

    const finalizeGame = async () => {
      dealerPlay();

      for (let i = 0; i < state.hands.length; i++) {
        if (!state.handResults[i]) state.handResults[i] = settleHand(state.hands[i]);
      }

      const payout = computePayout();

      if (payout > 0) {
        await applyBalanceChange({
          guildId,
          userId: state.userId,
          amount: payout,
          type: "bj_payout",
          reason: "Blackjack result",
          actorId: "system"
        });
      }

      const row = await getUserRow(guildId, state.userId);
      const newBal = Number(row?.balance ?? 0);

      let resultLine = "";
      if (state.hands.length === 1) {
        const r = state.handResults[0];
        resultLine = r === "win" ? "✅ You win!" : r === "push" ? "🤝 Push!" : "❌ You lose.";
      } else {
        const toEmoji = (r) => (r === "win" ? "✅" : r === "push" ? "🤝" : "❌");
        resultLine = `Hand 1: ${toEmoji(state.handResults[0])}  •  Hand 2: ${toEmoji(state.handResults[1])}`;
      }

      const embed = bjBuildEmbed(cfg, state, {
        revealDealer: true,
        footerText: `New Balance: ${fmt(newBal)} ${currency}`
      }).setDescription(
        `**Final:** ${resultLine}\n` +
        `**Payout:** ${fmt(payout)} ${currency}\n` +
        `**Net:** ${payout > 0 ? "+" : ""}${fmt(payout - state.bet)} ${currency} ${CC_EMOJI}`
      );

      BJ_GAMES.delete(state.key);

      return interaction.editReply({
        embeds: [embed],
        components: bjReplayButtons(state.bet)
      });
    };

    const goNextHandOrFinish = async () => {
      if (state.hands.length === 2 && state.activeHandIndex === 0) {
        state.activeHandIndex = 1;
        state.messageLine = "Now playing Hand 2.";
        const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
        return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
      }
      return finalizeGame();
    };

    if (action === "hit") {
      currentHand.push(bjDrawCard());
      state.messageLine = `➕ Hit on Hand ${state.activeHandIndex + 1}.`;

      const total = bjScore(currentHand);
      if (total > 21) {
        state.handResults[state.activeHandIndex] = "lose";
        state.messageLine = `💥 Bust on Hand ${state.activeHandIndex + 1}.`;
        return goNextHandOrFinish();
      }
      if (total === 21) {
        state.messageLine = `🎯 21 on Hand ${state.activeHandIndex + 1}! (Auto-stand)`;
        return goNextHandOrFinish();
      }

      const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
      return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
    }

    if (action === "stand") {
      state.messageLine = `🛑 Stood on Hand ${state.activeHandIndex + 1}.`;
      return goNextHandOrFinish();
    }

    if (action === "double") {
      const handIndex = state.activeHandIndex;

      if (currentHand.length !== 2) {
        return interaction.followUp({ content: "⚠️ You can only Double Down on your first two cards.", ephemeral: true });
      }
      if (state.didDoubleOnHand[handIndex]) {
        return interaction.followUp({ content: "⚠️ You already doubled on this hand.", ephemeral: true });
      }

      const takeMore = await applyBalanceChange({
        guildId,
        userId: state.userId,
        amount: -state.handBets[handIndex],
        type: "bj_double",
        reason: "Blackjack double down",
        actorId: state.userId
      });
      if (!takeMore.ok) {
        return interaction.followUp({ content: `❌ You don’t have enough ${currency} to double down.`, ephemeral: true });
      }

      state.didDoubleOnHand[handIndex] = true;
      state.handBets[handIndex] = state.handBets[handIndex] * 2;
      state.messageLine = `⏫ Double Down on Hand ${handIndex + 1}. (One card then stand)`;

      currentHand.push(bjDrawCard());

      if (bjScore(currentHand) > 21) {
        state.handResults[handIndex] = "lose";
        state.messageLine = `💥 Bust after Double Down on Hand ${handIndex + 1}.`;
      }

      return goNextHandOrFinish();
    }

    if (action === "split") {
      if (state.didSplit) {
        return interaction.followUp({ content: "⚠️ You can only split once.", ephemeral: true });
      }
      if (!bjCanSplit(currentHand)) {
        return interaction.followUp({ content: "⚠️ Split is only available when your first two cards match in value.", ephemeral: true });
      }

      const takeMore = await applyBalanceChange({
        guildId,
        userId: state.userId,
        amount: -state.bet,
        type: "bj_split",
        reason: "Blackjack split",
        actorId: state.userId
      });
      if (!takeMore.ok) {
        return interaction.followUp({ content: `❌ You don’t have enough ${currency} to split.`, ephemeral: true });
      }

      state.didSplit = true;

      const [c1, c2] = currentHand;
      state.hands = [[c1], [c2]];
      state.hands[0].push(bjDrawCard());
      state.hands[1].push(bjDrawCard());

      state.handBets = [state.bet, state.bet];
      state.handResults = [null, null];
      state.didDoubleOnHand = [false, false];
      state.activeHandIndex = 0;

      state.messageLine = "✂️ Split! Now playing Hand 1.";

      const embed = bjBuildEmbed(cfg, state, { revealDealer: false });
      return interaction.editReply({ embeds: [embed], components: bjButtons(state) });
    }

    return interaction.followUp({ content: "⚠️ Unknown blackjack action.", ephemeral: true });
  } catch (e) {
    console.error("Blackjack button error:", e?.message || e);
    return interaction.followUp({ content: "⚠️ Something went wrong. Please try again.", ephemeral: true });
  }
}

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

  // --- Slash commands ---
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  await interaction.deferReply();
  
  const guildId = interaction.guild.id;
  const callerId = interaction.user.id;

// ===== RUMBLE (admin) =====
if (interaction.commandName === "rumble") {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;

  if (sub === "payoutamount") {
    const amount = interaction.options.getInteger("amount", true);

    const { error } = await supabase
      .from("config")
      .update({ rumble_win_amount: amount })
      .eq("guild_id", guildId);

    if (error) {
      console.error("Rumble payout update error:", error);
      return interaction.editReply("❌ Failed to update payout amount.");
    }

    return interaction.editReply(
      `✅ Rumble payout amount set to **${amount} Capo Cash** server-wide.`
    );
  }
}

// BLACKJACK (interactive + dealer peek + 3:2)
if (interaction.commandName === "blackjack") {
  const bet = Math.max(1, interaction.options.getInteger("bet", true));
  await upsertUserRow(guildId, callerId);

  const key = bjGameKey(guildId, callerId, interaction.channelId);

  const existing = BJ_GAMES.get(key);
  if (existing && !bjIsExpired(existing)) {
    return interaction.editReply("🃏 You already have an active blackjack game here. Finish it or wait for it to expire.");
  }
  BJ_GAMES.delete(key);

  // ✅ get cfg BEFORE using it anywhere
  const cfg = await getConfig(guildId);
  const currency = BJ_PAGE_CURRENCY(cfg);

  // take bet up front
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

  // Natural blackjack handling (pays 3:2)
  if (playerBJ || dealerBJ) {
    let result = "push";
    if (playerBJ && !dealerBJ) result = "win";
    else if (!playerBJ && dealerBJ) result = "lose";

    // bet already deducted; blackjack win pays 3:2 => return 2.5x bet
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

    const profit = result === "win" ? (payout - bet) : result === "push" ? 0 : -bet;

    const headline =
      result === "win"
        ? `🂡 **BLACKJACK!** Pays **3:2** ✅ ${CC_EMOJI}`
        : result === "lose"
        ? `💀 **Dealer has Blackjack.** ${CC_EMOJI}`
        : `🤝 **Double Blackjack — Push.** ${CC_EMOJI}`;

    const outcomeLine =
      result === "win"
        ? `You win **+${new Intl.NumberFormat("en-US").format(profit)}** ${currency}!`
        : result === "lose"
        ? `You lose **${new Intl.NumberFormat("en-US").format(bet)}** ${currency}.`
        : `Your bet was returned.`;

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
      footerText: `New Balance: ${new Intl.NumberFormat("en-US").format(newBal)} ${currency} ${CC_EMOJI}`
    }).setDescription(
      `${headline}\n${outcomeLine}\n\n` +
      `**Bet:** ${new Intl.NumberFormat("en-US").format(bet)} ${currency}\n` +
      `**Payout:** ${new Intl.NumberFormat("en-US").format(payout)} ${currency}`
    );

    // ✅ show play again buttons even on natural blackjack
    return interaction.editReply({ embeds: [embed], components: bjReplayButtons(bet) });
  }

  // Normal interactive game
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
// 🔒 LOCK / 🔓 UNLOCK COMMANDS
if (interaction.isChatInputCommand() && (interaction.commandName === "lock" || interaction.commandName === "unlock")) {
  await interaction.deferReply({ ephemeral: true });

  // permission check (you can change this if you want different perms)
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.editReply("❌ You don’t have permission to use this.");
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    return interaction.editReply("❌ This must be used in a text channel.");
  }

  const isLock = interaction.commandName === "lock";

  try {
    for (const roleId of LOCK_ROLE_IDS) {
      if (isLock) {
        // Deny messages in channel AND threads
        await channel.permissionOverwrites.edit(roleId, {
          SendMessages: false,
          SendMessagesInThreads: false
        });
      } else {
        // Cleanly remove the overwrite entirely (best “unlock”)
        await channel.permissionOverwrites.delete(roleId).catch(() => {});
      }
    }

    return interaction.editReply(
      isLock
        ? "🔒 Locked: team roles can’t send messages here."
        : "🔓 Unlocked: team roles restored."
    );
  } catch (e) {
    console.error("Lock/unlock error:", e);
    return interaction.editReply("⚠️ Failed to update channel permissions. (Check bot perms/role order.)"
      );
  }
}
   // BALANCE
if (interaction.commandName === "balance") {
  const target = interaction.options.getUser("user") ?? interaction.user;

  const row =
    (await getUserRow(guildId, target.id)) || (await upsertUserRow(guildId, target.id));

  return interaction.editReply(
    `💸 <@${target.id}> has **${Number(row.balance ?? 0).toLocaleString("en-US")}** ${cfg.currency_name} <a:CC:1472374417920229398>`
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

  return interaction.editReply(
    `⏳ Daily cooldown. Try again <t:${unix}:R>`
  );
}

      const grace = Number(cfg.daily_grace_hours ?? 3);
      let streak = Number(row.daily_streak ?? 0);

      if (!last) streak = 1;
      else {
        const h = hoursBetween(last, now);
        streak = h <= (24 + grace) ? (streak + 1) : 1;
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
  `✅ Daily claimed: **+${fmtNum(payout)}** ${cfg.currency_name} ${CC_EMOJI} (streak **${fmtNum(streak)}**)`
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

  return interaction.editReply(
    `⏳ Weekly cooldown. Try again <t:${unix}:R>`
  );
}

      const grace = Number(cfg.weekly_grace_hours ?? 12);
      let streak = Number(row.weekly_streak ?? 0);

      if (!last) streak = 1;
      else {
        const h = hoursBetween(last, now);
        streak = h <= (168 + grace) ? (streak + 1) : 1;
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
  `✅ Weekly claimed: **+${fmtNum(payout)}** ${cfg.currency_name} ${CC_EMOJI} (streak **${fmtNum(streak)}**)`
);
    }

    // GIVE (admin only)
    if (interaction.commandName === "give") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.editReply("❌ You don’t have permission.");
      }

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

// get updated balance
const row = await getUserRow(guildId, target.id);
const newBal = Number(row?.balance ?? 0);

return interaction.editReply(
  `✅ Gave <@${target.id}> **+${fmtNum(amt)}** ${cfg.currency_name}. ` +
  `New balance **${fmtNum(newBal)}** ${cfg.currency_name} <a:CC:1472374417920229398>`
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

    // LEADERBOARD (embed + buttons)
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
    return interaction.editReply(
      `❌ You don’t have enough ${cfg.currency_name} for that bet. ${CC_EMOJI}`
    );
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
    return interaction.editReply(
      `❌ You don’t have enough ${cfg.currency_name} for that bet. ${CC_EMOJI}`
    );
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

// SLOTS
if (interaction.commandName === "slots") {
  const bet = Math.max(1, interaction.options.getInteger("bet", true));
  await upsertUserRow(guildId, callerId);

  const take = await applyBalanceChange({
    guildId,
    userId: callerId,
    amount: -bet,
    type: "slots_bet",
    reason: "Slots bet",
    actorId: callerId
  });

  if (!take.ok) {
    return interaction.editReply(
      `❌ You don’t have enough ${cfg.currency_name} for that bet. ${CC_EMOJI}`
    );
  }

  const symbols = ["🍒", "🍋", "💎", "7️⃣", "🔔"];
  const spin = () => symbols[Math.floor(Math.random() * symbols.length)];

  const a = spin(), b = spin(), c = spin();
  const reel = `🎰 **${a} ${b} ${c}**`;

  let payout = 0;
  if (a === b && b === c) payout = bet * 5;
  else if (a === b || b === c || a === c) payout = bet * 2;

  const rowBefore = await getUserRow(guildId, callerId);
  const balBefore = Number(rowBefore?.balance ?? 0);

  if (payout > 0) {
    await applyBalanceChange({
      guildId,
      userId: callerId,
      amount: payout,
      type: "slots_win",
      reason: `Slots ${a}${b}${c}`,
      actorId: "system"
    });

    const profit = payout - bet;
    const rowAfter = await getUserRow(guildId, callerId);
    const newBal = Number(rowAfter?.balance ?? 0);

    return interaction.editReply(
      `${reel}\n` +
      `✅ <@${callerId}> won **${fmt(profit)} ${cfg.currency_name}** ${CC_EMOJI}\n` +
      `💰 New Balance: **${fmt(newBal)} ${cfg.currency_name}** ${CC_EMOJI}`
    );
  }

  // lost (no payout)
  const rowAfter = await getUserRow(guildId, callerId);
  const newBal = Number(rowAfter?.balance ?? 0);

  return interaction.editReply(
    `${reel}\n` +
    `❌ <@${callerId}> lost **${fmt(bet)} ${cfg.currency_name}** ${CC_EMOJI}\n` +
    `💰 New Balance: **${fmt(newBal)} ${cfg.currency_name}** ${CC_EMOJI}`
  );
}

// ✅ end of try/catch + interactionCreate handler
} catch (e) {
  console.error("Interaction error:", e?.message || e);

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({
      content: "⚠️ Something went wrong. Try again.",
      ephemeral: true
    });
  } else {
    return interaction.reply({
      content: "⚠️ Something went wrong. Try again.",
      ephemeral: true
    });
  }
}
}); // ✅ MUST be `});` (NOT `));`)

client.login(DISCORD_TOKEN);