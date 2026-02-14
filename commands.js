import { SlashCommandBuilder, PermissionsBitField } from "discord.js";

export const COMMANDS = [
  // BALANCE
  new SlashCommandBuilder()
    .setName("balance")
    .setDescription("Check your Capo Cash balance"),

  // DAILY
  new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily Capo Cash"),

  // WEEKLY
  new SlashCommandBuilder()
    .setName("weekly")
    .setDescription("Claim your weekly Capo Cash"),

  // GIVE
  new SlashCommandBuilder()
    .setName("give")
    .setDescription("Give Capo Cash to a user")
    .addUserOption((o) =>
      o.setName("user").setDescription("User to give cash to").setRequired(true)
    )
    .addIntegerOption((o) =>
      o.setName("amount").setDescription("Amount to give").setRequired(true)
    ),

  // LEADERBOARD
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the richest Capo Cash holders")
    .addIntegerOption((o) =>
      o.setName("page").setDescription("Page number").setRequired(false)
    ),

  // COINFLIP
  new SlashCommandBuilder()
    .setName("coinflip")
    .setDescription("Bet on a coin flip")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("Bet amount").setRequired(true)
    )
    .addStringOption((o) =>
      o
        .setName("choice")
        .setDescription("heads or tails")
        .setRequired(true)
        .addChoices(
          { name: "heads", value: "heads" },
          { name: "tails", value: "tails" }
        )
    ),

  // DICE
  new SlashCommandBuilder()
    .setName("dice")
    .setDescription("Roll a die")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("Bet amount").setRequired(true)
    ),

  // SLOTS
  new SlashCommandBuilder()
    .setName("slots")
    .setDescription("Spin the slots")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("Bet amount").setRequired(true)
    ),

  // BLACKJACK
  new SlashCommandBuilder()
    .setName("blackjack")
    .setDescription("Play blackjack")
    .addIntegerOption((o) =>
      o.setName("bet").setDescription("Bet amount").setRequired(true)
    ),

  // LOCK
new SlashCommandBuilder()
  .setName("lock")
  .setDescription("Lock the current channel (remove Send Messages for configured roles)"
    ),
  
// UNLOCK
new SlashCommandBuilder()
  .setName("unlock")
  .setDescription("Unlock the current channel (restore Send Messages for configured roles)"
    ),
  
  // RUMBLE (admin)
new SlashCommandBuilder()
  .setName("rumble")
  .setDescription("Rumble settings (admin)")
  .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageGuild)
  .addSubcommand(sub =>
    sub
      .setName("payoutamount")
      .setDescription("Set the server-wide Capo Cash payout for Rumble wins")
      .addIntegerOption(opt =>
        opt
          .setName("amount")
          .setDescription("New payout amount (ex: 75)")
          .setRequired(true)
          .setMinValue(1)
      )
  ),
].map((c) => c.toJSON());
