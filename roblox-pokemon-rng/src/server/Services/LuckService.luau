--!nonstrict
--[[
	LuckService
	The single place that answers "what are this player's current multipliers?".

	Additive sources (levels, collection bonuses, prestige, the Lucky Charm,
	the equipped buddy) sum into a base multiplier. Multiplicative sources
	(potions, game passes) then scale that base. Keeping the two kinds separate
	is what stops a mid-game potion from being worth more than a whole prestige.

	`compute` also returns a human-readable breakdown, because a player staring
	at "48.60x" wants to know where it came from -- and so does anyone debugging
	a balance complaint.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Upgrades = require(Shared.Upgrades)
local RollEngine = require(Shared.RollEngine)

local InventoryService = require(script.Parent.InventoryService)
local PassService = require(script.Parent.PassService)

local LuckService = {}

--[[
	Drop effects whose expiry has passed. Returns true if anything was removed,
	which the caller uses to decide whether to re-sync the client.
]]
function LuckService.pruneEffects(profile: any): boolean
	local now = os.time()
	local removed = false

	for i = #profile.effects, 1, -1 do
		if (profile.effects[i].expires or 0) <= now then
			table.remove(profile.effects, i)
			removed = true
		end
	end

	return removed
end

local function effectMultipliers(profile: any)
	local luck, speed, variant = 1, 1, 1
	local now = os.time()

	for _, effect in profile.effects do
		local potion = Upgrades.potionsById[effect.potionId]
		if potion and (effect.expires or 0) > now then
			luck *= potion.luckMult or 1
			speed *= potion.speedMult or 1
			variant *= potion.variantMult or 1
		end
	end

	return luck, speed, variant
end

--[[
	Luck granted by the equipped buddy, scaled by how rare it is. Logarithmic:
	a 1-in-100,000,000 buddy is worth about twice a 1-in-10,000 one, not ten
	thousand times as much.
]]
function LuckService.buddyLuck(profile: any): number
	local buddy = profile.buddy
	if not buddy then
		return 0
	end

	local rarity = RollEngine.speciesRarity(buddy.speciesId, Config.Luck.Base)
		* RollEngine.variantRarityMult(buddy.variantKey or "")
	if rarity == math.huge or rarity <= 1 then
		return 0
	end

	return Config.Luck.BuddyScale * math.log10(rarity)
end

function LuckService.compute(player: Player, profile: any)
	local upgradeLevels = profile.upgrades
	local bonuses = InventoryService.bonuses(profile)
	local passes = PassService.multipliers(player)
	local potionLuck, potionSpeed, potionVariant = effectMultipliers(profile)

	-- Additive layer.
	local levelLuck = (profile.level - 1) * Config.Luck.PerLevel
	local indexLuck = bonuses.indexCount * Config.Luck.PerIndexEntry
	local tierLuck = bonuses.tiersComplete * Config.Luck.PerTierComplete
	local typeLuck = bonuses.typesMastered * Config.Luck.PerTypeMastery
	local prestigeLuck = profile.prestige * Config.Luck.PerPrestige
	local charmLuck = Upgrades.effectAt("luckCharm", upgradeLevels.luckCharm or 0)
	local buddyLuck = LuckService.buddyLuck(profile)

	local additive = Config.Luck.Base
		+ levelLuck
		+ indexLuck
		+ tierLuck
		+ typeLuck
		+ prestigeLuck
		+ charmLuck
		+ buddyLuck

	-- Multiplicative layer.
	local luck = math.clamp(additive * potionLuck * passes.luckMult, Config.Luck.Base, Config.Luck.Max)

	local coinMult = (1 + Upgrades.effectAt("coinPouch", upgradeLevels.coinPouch or 0) + profile.prestige * Config.Prestige.CoinBonus)
		* passes.coinMult
	local xpMult = 1 + Upgrades.effectAt("expShare", upgradeLevels.expShare or 0)
	local variantLuck = (1 + Upgrades.effectAt("shinyCharm", upgradeLevels.shinyCharm or 0)) * potionVariant

	local cooldown = Config.Roll.BaseCooldown
		* (1 - Upgrades.effectAt("speedTrainer", upgradeLevels.speedTrainer or 0))
		* passes.cooldownMult
		* potionSpeed
	cooldown = math.max(Config.Roll.MinCooldown, cooldown)

	local autoRoll = passes.autoRoll
		or profile.level >= Config.Roll.AutoRollLevel
		or (upgradeLevels.autoRoll or 0) > 0

	-- Only non-zero contributions are listed, so the panel stays short early on
	-- and grows as the player unlocks things.
	local breakdown = {}
	local function push(label: string, value: number, kind: string)
		if math.abs(value) > 0.0001 then
			table.insert(breakdown, { label = label, value = value, kind = kind })
		end
	end

	push("Base", Config.Luck.Base, "add")
	push(`Trainer level {profile.level}`, levelLuck, "add")
	push(`Index ({bonuses.indexCount}/{bonuses.indexTotal})`, indexLuck, "add")
	push(`Tiers completed ({bonuses.tiersComplete})`, tierLuck, "add")
	push(`Types mastered ({bonuses.typesMastered})`, typeLuck, "add")
	push(`Prestige {profile.prestige}`, prestigeLuck, "add")
	push("Lucky Charm", charmLuck, "add")
	push("Buddy", buddyLuck, "add")

	if potionLuck ~= 1 then
		table.insert(breakdown, { label = "Potions", value = potionLuck, kind = "mult" })
	end
	if passes.luckMult ~= 1 then
		table.insert(breakdown, { label = "Game passes", value = passes.luckMult, kind = "mult" })
	end

	return {
		luck = luck,
		variantLuck = variantLuck,
		coinMult = coinMult,
		xpMult = xpMult,
		cooldown = cooldown,
		autoRoll = autoRoll,
		breakdown = breakdown,
	}
end

--[[
	XP needed to advance from `level` to the next one.
]]
function LuckService.xpForLevel(level: number): number
	local economy = Config.Economy
	return math.floor(economy.LevelCurveBase * level ^ economy.LevelCurveExponent)
end

--[[
	Apply XP and roll the player up through as many levels as it covers.
	Returns how many levels were gained.
]]
function LuckService.awardXp(profile: any, amount: number): number
	if profile.level >= Config.Economy.MaxLevel then
		profile.xp = 0
		return 0
	end

	profile.xp += math.max(0, math.floor(amount))

	local gained = 0
	while profile.level < Config.Economy.MaxLevel do
		local needed = LuckService.xpForLevel(profile.level)
		if profile.xp < needed then
			break
		end
		profile.xp -= needed
		profile.level += 1
		gained += 1
	end

	if profile.level >= Config.Economy.MaxLevel then
		profile.xp = 0
	end

	return gained
end

return LuckService
