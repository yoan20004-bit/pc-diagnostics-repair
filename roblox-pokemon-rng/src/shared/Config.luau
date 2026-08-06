--!strict
--[[
	Config
	Every tunable number in the game lives here. Nothing in this module touches
	Roblox APIs, so it can be required from the server, the client, or the
	offline balance simulator in tools/simulate.luau.
]]

local Config = {}

Config.GameName = "PokeRNG"
Config.Version = "1.0.0"

--------------------------------------------------------------------------------
-- Rolling
--------------------------------------------------------------------------------

Config.Roll = {
	-- Seconds between rolls before any upgrades.
	BaseCooldown = 3.0,
	-- Cooldown can never drop below this, no matter how many upgrades stack.
	MinCooldown = 0.25,
	-- Server-side grace so a client with lag isn't rejected for rolling 30ms early.
	CooldownGrace = 0.08,
	-- Hard ceiling on requests per second per player. Anything above this is an
	-- exploit, not lag, and the request is dropped.
	MaxRequestsPerSecond = 12,
	-- Auto-roll unlocks at this trainer level (or via the Auto Roll pass).
	AutoRollLevel = 25,
}

--------------------------------------------------------------------------------
-- Luck
--------------------------------------------------------------------------------

Config.Luck = {
	-- Everyone starts at 1x.
	Base = 1,
	-- Ceiling, to keep the odds math well behaved at absurd multipliers.
	Max = 100000,
	-- Permanent luck per trainer level.
	PerLevel = 0.02,
	-- Permanent luck per unique species registered in the index.
	PerIndexEntry = 0.005,
	-- Permanent luck for completing every species in a tier.
	PerTierComplete = 0.05,
	-- Permanent luck for owning every species of a given elemental type.
	PerTypeMastery = 0.10,
	-- Permanent luck per prestige ("Champion Rebirth").
	PerPrestige = 0.25,
	-- Equipping a buddy grants luck scaled by how rare that buddy is.
	-- bonus = BuddyScale * log10(rarity)
	BuddyScale = 0.03,
}

--------------------------------------------------------------------------------
-- Variants (independent modifiers rolled alongside the species)
--------------------------------------------------------------------------------

export type Variant = {
	key: string,
	name: string,
	rarity: number, -- 1 in N, before the shiny charm
	valueMult: number,
	color: { number }, -- RGB, converted to Color3 on the client
	order: number,
}

Config.Variants = {
	{ key = "A", name = "Alpha", rarity = 1024, valueMult = 2, color = { 255, 138, 61 }, order = 1 },
	{ key = "D", name = "Shadow", rarity = 4096, valueMult = 3, color = { 122, 92, 200 }, order = 2 },
	{ key = "S", name = "Shiny", rarity = 8192, valueMult = 5, color = { 255, 214, 84 }, order = 3 },
} :: { Variant }

--------------------------------------------------------------------------------
-- Economy
--------------------------------------------------------------------------------

Config.Economy = {
	-- Coins for a roll = floor(CoinBase + rarity ^ CoinExponent), then multiplied
	-- by variant value and any coin bonuses.
	CoinBase = 2,
	CoinExponent = 0.55,
	-- XP uses a flatter curve so levelling doesn't outpace the coin economy.
	XpBase = 1,
	XpExponent = 0.35,
	-- XP needed to go from level L to L+1.
	LevelCurveBase = 100,
	LevelCurveExponent = 1.45,
	MaxLevel = 500,
	-- Selling a duplicate refunds this fraction of its roll value.
	SellRefund = 0.35,
}

--------------------------------------------------------------------------------
-- Prestige
--------------------------------------------------------------------------------

Config.Prestige = {
	RequiredLevel = 50,
	RequiredIndexEntries = 60,
	-- Coin multiplier gained per prestige, stacking additively.
	CoinBonus = 0.25,
	MaxPrestige = 25,
}

--------------------------------------------------------------------------------
-- Daily reward
--------------------------------------------------------------------------------

Config.Daily = {
	CooldownSeconds = 20 * 60 * 60, -- claimable after 20h
	ResetSeconds = 48 * 60 * 60, -- streak breaks after 48h
	BaseCoins = 1000,
	CoinsPerStreakDay = 750,
	MaxStreak = 7,
	-- Streak day -> free potion id awarded on top of coins.
	StreakPotions = {
		[3] = "luck2",
		[5] = "speed1",
		[7] = "luck3",
	},
}

--------------------------------------------------------------------------------
-- Announcements & effects
--------------------------------------------------------------------------------

Config.Announce = {
	-- Tier index at or above which a roll is broadcast to the whole server.
	MinTierIndex = 6,
	-- Variants always announce, even on a common species.
	AlwaysAnnounceVariants = true,
}

Config.Effects = {
	-- Tier index at or above which the client plays the long cutscene-style reveal.
	CinematicTierIndex = 6,
	-- Tier index at or above which the screen shakes.
	ShakeTierIndex = 5,
}

--------------------------------------------------------------------------------
-- Persistence
--------------------------------------------------------------------------------

Config.Data = {
	StoreName = "PokeRNG_Profiles_v1",
	KeyPrefix = "player_",
	AutosaveInterval = 120,
	-- Retries for a failed DataStore call, with exponential backoff.
	MaxRetries = 5,
	RetryBackoff = 2,
	-- If a profile fails to load, the player plays on a temporary profile that is
	-- never written back, so a DataStore outage can't wipe anyone.
	FailSafeReadOnly = true,
}

Config.Leaderboard = {
	StoreRarest = "PokeRNG_Rarest_v1",
	StoreRolls = "PokeRNG_Rolls_v1",
	TopCount = 25,
	RefreshInterval = 60,
}

--------------------------------------------------------------------------------
-- Monetisation -- fill these in with real IDs from the Creator Dashboard.
-- A value of 0 means "not configured", and the code silently skips it.
--------------------------------------------------------------------------------

Config.Passes = {
	{ id = 0, key = "luck2x", name = "2x Luck", luckMult = 2 },
	{ id = 0, key = "coins2x", name = "2x Coins", coinMult = 2 },
	{ id = 0, key = "autoroll", name = "Auto Roll", autoRoll = true },
	{ id = 0, key = "fastroll", name = "Fast Rolls", cooldownMult = 0.6 },
	{ id = 0, key = "vip", name = "VIP", luckMult = 1.5, coinMult = 1.5, cooldownMult = 0.85 },
}

Config.Products = {
	{ id = 0, key = "coins_small", name = "10,000 Coins", coins = 10000 },
	{ id = 0, key = "coins_large", name = "150,000 Coins", coins = 150000 },
	{ id = 0, key = "elixir", name = "Master Elixir", potion = "luck4" },
}

return Config
