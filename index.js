import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message]
});

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(
    Routes.applicationGuildCommands(DISCORD_APP_ID, COMMAND_GUILD_ID),
    { body: COMMANDS }
  );
});

client.on("messageCreate", async (message) => {
  if (!message.guild) return;
  const cfg = await getConfig(message.guild.id);
  if (message.author.id !== cfg.rumble_bot_id) return;

  const match = message.content.match(/<@!?(\d{17,20})>/);
  if (!match) return;

  const winnerId = match[1];

  if (await hasRumblePaid(message.guild.id, message.id)) {
    await message.react("⏭️");
    return;
  }

  const amount = Number(cfg.rumble_win_amount);

  await supabase.from("users").upsert({
    guild_id: message.guild.id,
    user_id: winnerId
  }, { onConflict: "guild_id,user_id" });

  const row = await getUserRow(message.guild.id, winnerId);
  const newBal = Number(row.balance) + amount;

  await supabase.from("users")
    .update({ balance: newBal })
    .eq("guild_id", message.guild.id)
    .eq("user_id", winnerId);

  await markRumblePaid(message.guild.id, message.id, winnerId, amount);
  await message.react("💸");
});

client.login(DISCORD_TOKEN);
