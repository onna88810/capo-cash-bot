import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars.");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

export async function getConfig(guildId) {
  const { data, error } = await supabase
    .from("config")
    .select("*")
    .eq("guild_id", guildId)
    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const { data: inserted, error: insErr } = await supabase
    .from("config")
    .insert({ guild_id: guildId })
    .select("*")
    .single();

  if (insErr) throw insErr;
  return inserted;
}

export async function getUserRow(guildId, userId) {
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function upsertUserRow(guildId, userId) {
  const { data, error } = await supabase
    .from("users")
    .upsert({ guild_id: guildId, user_id: userId }, { onConflict: "guild_id,user_id" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function insertTransaction(row) {
  const { error } = await supabase.from("transactions").insert(row);
  if (error) throw error;
}

export async function hasRumblePaid(guildId, messageId) {
  const { data, error } = await supabase
    .from("rumble_payouts")
    .select("source_message_id")
    .eq("guild_id", guildId)
    .eq("source_message_id", messageId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

export async function markRumblePaid(guildId, messageId, winnerUserId, amount) {
  const { error } = await supabase
    .from("rumble_payouts")
    .insert({
      guild_id: guildId,
      source_message_id: messageId,
      winner_user_id: winnerUserId,
      amount
    });
  if (error) throw error;
}
