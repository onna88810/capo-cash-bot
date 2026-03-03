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

export async function hasMonthlyBoosterGift(guildId, userId, monthKey) {
  const { data, error } = await supabase
    .from("monthly_booster_gifts")
    .select("guild_id")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("month_key", monthKey)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

export async function markMonthlyBoosterGift(guildId, userId, monthKey) {
  const { error } = await supabase
    .from("monthly_booster_gifts")
    .insert([{ guild_id: guildId, user_id: userId, month_key: monthKey }]);

  // ignore duplicate inserts safely (primary key already exists)
  if (error && !String(error.message || "").toLowerCase().includes("duplicate")) {
    throw error;
  }
}

// ==============================
// STICKY MESSAGES
// ==============================

export async function getSticky(guildId, channelId) {
  const { data, error } = await supabase
    .from("stickies")
    .select("*")
    .eq("guild_id", guildId)
    .eq("channel_id", channelId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function upsertSticky(row) {
  const { data, error } = await supabase
    .from("stickies")
    .upsert(row, { onConflict: "guild_id,channel_id" })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function clearSticky(guildId, channelId) {
  const { error } = await supabase
    .from("stickies")
    .delete()
    .eq("guild_id", guildId)
    .eq("channel_id", channelId);

  if (error) throw error;
}

export async function updateStickyLastPosted(guildId, channelId, messageId) {
  const { error } = await supabase
    .from("stickies")
    .update({ last_posted_message_id: messageId, updated_at: new Date().toISOString() })
    .eq("guild_id", guildId)
    .eq("channel_id", channelId);

  if (error) throw error;
}
// ==============================
// PRIVATE ROOMS (Ghosty Gambling)
// ==============================

export async function getActivePrivateRoomByOwner(guildId, ownerId, hubType) {
  const { data, error } = await supabase
    .from("private_rooms")
    .select("*")
    .eq("guild_id", guildId)
    .eq("owner_id", ownerId)
    .eq("hub_type", hubType)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function insertPrivateRoom({ channel_id, guild_id, owner_id, hub_type }) {
  const { error } = await supabase
    .from("private_rooms")
    .upsert(
      {
        channel_id,
        guild_id,
        owner_id,
        hub_type,
        deleted_at: null,
        last_activity_at: new Date().toISOString()
      },
      { onConflict: "channel_id" }
    );

  if (error) {
    console.error("insertPrivateRoom upsert error:", error);
    return null; // do NOT throw
  }

  return true;
}

export async function touchPrivateRoom(channelId) {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("private_rooms")
    .update({ last_activity_at: now })
    .eq("channel_id", channelId)
    .is("deleted_at", null)
    .select("channel_id, guild_id, owner_id, last_activity_at, control_message_id")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function getExpiredPrivateRooms(cutoffIso) {
  const { data, error } = await supabase
    .from("private_rooms")
    .select("channel_id, guild_id")
    .is("deleted_at", null)
    .lt("last_activity_at", cutoffIso)
    .limit(200);

  if (error) throw error;
  return data || [];
}

export async function markPrivateRoomDeleted(channelId) {
  const { error } = await supabase
    .from("private_rooms")
    .update({ deleted_at: new Date().toISOString() })
    .eq("channel_id", channelId);

  if (error) throw error;
}