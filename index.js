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
  ButtonStyle
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

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_APP_ID = process.env.DISCORD_APP_ID;
const COMMAND_GUILD_ID = process.env.COMMAND_GUILD_ID;

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  throw new Error("Missing DISCORD_TOKEN or DISCORD_APP_ID env vars.");
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
    .map((r) => `**${r.rank}.** <@${r.user_id}> — **${r.balance}** ${currencyName}`)
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

  await rest.put(
  Routes.applicationCommands(DISCORD_APP_ID),
  { body: COMMANDS }
);

console.log("Global slash commands registered.");
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
        cfg.rumble_announce_template ||
        "🏆 {user} was awarded **{amount} {currency}** for winning **Rumble Royals**! 💸";

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

  // --- Slash commands ---
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  await interaction.deferReply();

// 🔒 LOCK / 🔓 UNLOCK COMMANDS
if (interaction.commandName === "lock" || interaction.commandName === "unlock") {

  if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    return interaction.editReply("❌ You don’t have permission to use this.");
  }

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    return interaction.editReply("❌ This must be used in a text channel.");
  }

  const lock = interaction.commandName === "lock";

  try {
    for (const roleId of LOCK_ROLE_IDS) {
      await channel.permissionOverwrites.edit(roleId, {
        SendMessages: lock ? false : null
      });
    }

    return interaction.editReply(lock ? "🔒 Channel locked." : "🔓 Channel unlocked.");

  } catch (e) {
    console.error("Lock error:", e);
    return interaction.editReply("⚠️ Failed to change permissions.");
  }
}
  
  const guildId = interaction.guild.id;
  const callerId = interaction.user.id;

  try {
    const cfg = await getConfig(guildId);
    const tz = cfg.tz || "America/Chicago";

    // BALANCE
    if (interaction.commandName === "balance") {
      const row =
        (await getUserRow(guildId, callerId)) || (await upsertUserRow(guildId, callerId));
      return interaction.editReply(
        `💸 <@${callerId}> has **${row.balance ?? 0}** ${cfg.currency_name}.`
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
        const remaining = 24 - hoursBetween(last, now);
        return interaction.editReply(`⏳ Daily cooldown. Try again in ~${remaining.toFixed(1)} hours.`);
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
        `✅ Daily claimed: **+${payout}** ${cfg.currency_name} (streak **${streak}**)`
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
        const remaining = 168 - hoursBetween(last, now);
        return interaction.editReply(
          `⏳ Weekly cooldown. Try again in ~${(remaining / 24).toFixed(2)} days.`
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
        `✅ Weekly claimed: **+${payout}** ${cfg.currency_name} (streak **${streak}**)`
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
      return interaction.editReply(`✅ Gave <@${target.id}> **+${amt}** ${cfg.currency_name}.`);
    }

    // CONFIG (admin)
    if (interaction.commandName === "config") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.editReply("❌ You don’t have permission.");
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "view") {
        const tpl =
          cfg.rumble_announce_template ||
          "🏆 {user} was awarded **{amount} {currency}** for winning **Rumble Royals**! 💸";

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
      if (!take.ok) return interaction.editReply("❌ You don’t have enough Capo Cash for that bet.");

      const flip = Math.random() < 0.5 ? "heads" : "tails";
      const won = flip === choice;

      if (won) {
        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: bet * 2,
          type: "coinflip_win",
          reason: `Coinflip won (${flip})`,
          actorId: "system"
        });
        return interaction.editReply(`🪙 It landed **${flip}** — ✅ you won! (**+${bet}** profit)`);
      }

      return interaction.editReply(`🪙 It landed **${flip}** — ❌ you lost (**-${bet}**)`);
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
      if (!take.ok) return interaction.editReply("❌ You don’t have enough Capo Cash for that bet.");

      const roll = Math.floor(Math.random() * 6) + 1;

      if (roll === 6) {
        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: bet * 6,
          type: "dice_win",
          reason: "Rolled a 6",
          actorId: "system"
        });
        return interaction.editReply(`🎲 You rolled **${roll}** — ✅ JACKPOT! (**+${bet * 5}** profit)`);
      }

      return interaction.editReply(`🎲 You rolled **${roll}** — ❌ you lost (**-${bet}**)`);
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
      if (!take.ok) return interaction.editReply("❌ You don’t have enough Capo Cash for that bet.");

      const symbols = ["🍒", "🍋", "💎", "7️⃣", "🔔"];
      const spin = () => symbols[Math.floor(Math.random() * symbols.length)];

      const a = spin(), b = spin(), c = spin();
      const reel = `🎰 **${a} ${b} ${c}**`;

      let payout = 0;
      if (a === b && b === c) payout = bet * 5;
      else if (a === b || b === c || a === c) payout = bet * 2;

      if (payout > 0) {
        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: payout,
          type: "slots_win",
          reason: `Slots ${a}${b}${c}`,
          actorId: "system"
        });
      }

      if (payout === 0) return interaction.editReply(`${reel}\n❌ You lost **${bet}**.`);
      return interaction.editReply(`${reel}\n✅ You won! (**+${payout - bet}** profit)`);
    }

    // BLACKJACK
    if (interaction.commandName === "blackjack") {
      const bet = Math.max(1, interaction.options.getInteger("bet", true));
      await upsertUserRow(guildId, callerId);

      const take = await applyBalanceChange({
        guildId,
        userId: callerId,
        amount: -bet,
        type: "bj_bet",
        reason: "Blackjack bet",
        actorId: callerId
      });
      if (!take.ok) return interaction.editReply("❌ You don’t have enough Capo Cash for that bet.");

      const draw = () => {
        const v = Math.floor(Math.random() * 13) + 1;
        if (v === 1) return 11;
        if (v >= 10) return 10;
        return v;
      };
      const score = (cards) => {
        let total = cards.reduce((s, c) => s + c, 0);
        let aces = cards.filter((c) => c === 11).length;
        while (aces > 0 && total > 21) { total -= 10; aces--; }
        return total;
      };

      const player = [draw(), draw()];
      const dealer = [draw(), draw()];

      while (score(player) < 17) player.push(draw());
      while (score(dealer) < 17) dealer.push(draw());

      const ps = score(player);
      const ds = score(dealer);

      let payout = 0;
      let outcome = "";

      if (ps > 21) outcome = "❌ You busted.";
      else if (ds > 21 || ps > ds) { outcome = "✅ You win!"; payout = bet * 2; }
      else if (ps === ds) { outcome = "🤝 Push (tie)."; payout = bet; }
      else outcome = "❌ Dealer wins.";

      if (payout > 0) {
        await applyBalanceChange({
          guildId,
          userId: callerId,
          amount: payout,
          type: "bj_payout",
          reason: `Blackjack P:${ps} D:${ds}`,
          actorId: "system"
        });
      }

      return interaction.editReply(
        `🃏 **Blackjack**\nYou: ${player.join(", ")} (=${ps})\nDealer: ${dealer.join(", ")} (=${ds})\n${outcome}`
      );
    }

    return interaction.editReply("⚠️ Command not implemented yet.");
  } catch (e) {
  console.error("Interaction error:", e?.message || e);

  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({
      content: "⚠️ Something went wrong. Please try again.",
      ephemeral: true
    });
  } else {
    return interaction.reply({
      content: "⚠️ Something went wrong. Please try again.",
      ephemeral: true
    });
  }
}
});

client.login(DISCORD_TOKEN);
