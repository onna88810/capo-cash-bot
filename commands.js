import { PermissionsBitField, SlashCommandBuilder } from "discord.js";

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check Capo Cash balance")
    .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(false)),

  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily Capo Cash"),

  new SlashCommandBuilder()
    .setName("weekly")
    .setDescription("Claim your weekly Capo Cash"),

  new SlashCommandBuilder()
    .setName("give")
    .setDescription("Give Capo Cash (admin)")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("take")
    .setDescription("Take Capo Cash (admin)")
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false))
    .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild),

  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Gamble: coinflip")
    .addIntegerOption(o => o.setName("bet").setDescription("Bet amount").setRequired(true))
    .addStringOption(o =>
      o.setName("choice")
        .setDescription("heads or tails")
        .setRequired(true)
        .addChoices({ name: "heads", value: "heads" }, { name: "tails", value: "tails" })
    ),

  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Gamble: roll a die")
    .addIntegerOption(o => o.setName("bet").setDescription("Bet amount").setRequired(true)),

  new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Gamble: slots")
    .addIntegerOption(o => o.setName("bet").setDescription("Bet amount").setRequired(true))
].map(c => c.toJSON());
// CONFIG
{
  name: "config",
  description: "Admin config for Capo Cash",
  default_member_permissions: String(PermissionsBitField.Flags.ManageGuild),
  options: [
    {
      type: 1,
      name: "rumble_message",
      description: "Set the rumble winner announcement message template",
      options: [
        {
          type: 3,
          name: "template",
          description: "Use {user} {amount} {currency}. Example: 🏆 {user} won {amount} {currency}!",
          required: true
        }
      ]
    },
    {
      type: 1,
      name: "view",
      description: "View current config"
    }
  ]
},

// LEADERBOARD
{
  name: "leaderboard",
  description: "Show the richest Capo Cash holders",
  options: [
    {
      type: 4,
      name: "page",
      description: "Page number (10 per page)",
      required: false
    }
  ]
},

// GAMBLING
{
  name: "coinflip",
  description: "Bet on a coin flip",
  options: [
    { type: 4, name: "bet", description: "Bet amount", required: true },
    {
      type: 3,
      name: "choice",
      description: "heads or tails",
      required: true,
      choices: [
        { name: "heads", value: "heads" },
        { name: "tails", value: "tails" }
      ]
    }
  ]
},
{
  name: "slots",
  description: "Spin the slots",
  options: [{ type: 4, name: "bet", description: "Bet amount", required: true }]
},
{
  name: "blackjack",
  description: "Simple blackjack (dealer draws to 17)",
  options: [{ type: 4, name: "bet", description: "Bet amount", required: true }]
},

// ROB
{
  name: "rob",
  description: "Rob another user (they must have rob enabled)",
  options: [{ type: 6, name: "user", description: "Target user", required: true }]
},
{
  name: "robsettings",
  description: "Enable/disable being robbable",
  options: [
    {
      type: 3,
      name: "mode",
      description: "on or off",
      required: true,
      choices: [
        { name: "on", value: "on" },
        { name: "off", value: "off" }
      ]
    }
  ]
},
