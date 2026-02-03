import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  EmbedBuilder,
  PermissionsBitField
} from "discord.js";
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

// Simple per-user lock to avoid race conditions (e.g. 2 commands at once)
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
    if (ch && ch.isTextBased()) {
      await ch.send({ embeds: [embed] });
    }
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

    // Central embed log
    const embed = new EmbedBuilder()
      .setTitle("TMS Capo Cash Logs")
      .setDescription(`**${type.toUpperCase()}**`)
      .addFields(
        { name: "User", value: `<@${userId}>`, inline: true },
        { name: "Amount", value: `${amount > 0 ? "+" : ""}${amount} ${cfg.currency_name}`, inline: true },
        { name: "New Balance", value: `${balanceAfter}`, inline: true },
        { name: "Source Guild", value: `${guildId}`, inline: false }
      )
      .setTimestamp(new Date());

    if (reason) embed.addFields({ name: "Reason", value: reason });

    await sendCentralLog(cfg, embed);

    return { ok: true, balanceBefore, balanceAfter, cfg };
  });
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Register slash commands to your test guild (fast updates)
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);

  if (COMMAND_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_APP_ID, COMMAND_GUILD_ID),
      { body: COMMANDS }
    );
    console.log("Slash commands registered for guild:", COMMAND_GUILD_ID);
  } else {
    console.log("COMMAND_GUILD_ID not set; skipping guild command registration.");
  }
});

/**
 * ✅ AUTO RUMBLE PAYOUT
 * Watches for messages from Rumble Royals containing a winner mention.
 */
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;

    const guildId = message.guild.id;
    const cfg = await getConfig(guildId);

    // Only respond to the Rumble Royals bot
    if (message.author.id !== cfg.rumble_bot_id) return;

    // Must contain a winner mention like <@123...>
    const winnerId = parseFirstMentionUserId(message.content);
    if (!winnerId) return;

    // Prevent duplicate payouts for same message
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

      // React 💸
      try { await message.react("💸"); } catch (e) {
        console.error("Rumble react failed:", e?.message || e);
      }

      // ✅ Announce payout in the same channel
      try {
        await message.channel.send(
          `🏆 <@${winnerId}> was awarded **${amount} ${cfg.currency_name}** for winning **Rumble Royals**! 💸`
        );
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

/**
 * ✅ SLASH COMMANDS
 * Uses deferReply to avoid "application did not respond" when DB is slow.
 */
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) return;

  // Prevent timeouts
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guild.id;
  const callerId = interaction.user.id;

  try {
    const cfg = await getConfig(guildId);
    const tz = cfg.tz || "America/Chicago";

    if (interaction.commandName === "balance") {
      const u = interaction.options.getUser("user") || interaction.user;
      const row = (await getUserRow(guildId, u.id)) || (await upsertUserRow(guildId, u.id));
      return interaction.editReply(`💸 <@${u.id}> has **${row.balance ?? 0}** ${cfg.currency_name}.`);
    }

    if (interaction.commandName === "give" || interaction.commandName === "take") {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.editReply("❌ You don’t have permission.");
      }

      const target = interaction.options.getUser("user");
      const amt = Math.abs(interaction.options.getInteger("amount"));
      const reason = interaction.options.getString("reason") || null;
      const signed = interaction.commandName === "take" ? -amt : amt;

      const res = await applyBalanceChange({
        guildId,
        userId: target.id,
        amount: signed,
        type: interaction.commandName,
        reason: reason || interaction.commandName,
        actorId: callerId
      });

      if (!res.ok && res.reason === "insufficient_funds") {
        return interaction.editReply("❌ Insufficient funds to take that amount.");
      }

      return interaction.editReply(
        `✅ ${interaction.commandName} <@${target.id}> **${signed > 0 ? "+" : ""}${signed}** ${cfg.currency_name}.`
      );
    }

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

      const grace = Number(cfg.daily_grace_hours ?? 3); // 27h total window
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

      await supabase.from("users")
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

      await supabase.from("users")
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

    return interaction.editReply("⚠️ Command not implemented yet.");
  } catch (e) {
    console.error("Interaction error:", e?.message || e);
    return interaction.editReply("⚠️ Something went wrong (check Railway logs).");
  }
});

client.login(DISCORD_TOKEN);
