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
new SlashCommandBuilder()
  .setName("config")
  .setDescription("Admin config for Capo Cash")
  .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  .addSubcommand(sub =>
    sub
      .setName("rumble_message")
      .setDescription("Set the rumble winner announcement message template")
      .addStringOption(opt =>
        opt
          .setName("template")
          .setDescription("Use {user} {amount} {currency}")
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName("view")
      .setDescription("View current config")
  ),
