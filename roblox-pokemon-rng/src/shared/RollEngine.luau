--!strict
--[[
	RollEngine
	Pure roll mathematics. No Roblox APIs, no state, no side effects -- give it a
	random source and a luck multiplier and it hands back a result.

	The server owns the only real rolls. The client requires this module solely to
	display odds ("1 in 12,000") without a round trip.

	A roll is two independent stages:

	  1. Tier. Walk the rarity ladder from rarest to most common and take the
	     first tier that passes its own 1-in-N check. Luck divides N. Common is
	     the fallback when everything else misses, so the tier probabilities
	     always sum to exactly 1 no matter how the ladder is tuned.

	  2. Species. Pick a species inside the chosen tier, weighted. This is what
	     keeps a species' displayed rarity honest: a tier at 1 in 12,000 holding
	     four equally weighted species means each of them is 1 in 48,000.

	Variants (Shiny / Alpha / Shadow) roll independently of both stages and can
	stack.
]]

local Config = require(script.Parent.Config)
local Rarity = require(script.Parent.Rarity)
local Species = require(script.Parent.Species)

export type RollOptions = {
	luck: number?,
	variantLuck: number?,
	coinMult: number?,
	xpMult: number?,
}

export type RollResult = {
	speciesId: number,
	name: string,
	tier: string,
	tierIndex: number,
	variants: { string },
	variantKey: string,
	-- The species' honest 1-in-N at 1x luck, ignoring variants. This is the
	-- number shown in the index and never moves when the player buys luck.
	rarity: number,
	-- 1-in-N including whichever variants landed. Used for records and value.
	effectiveRarity: number,
	valueMult: number,
	coins: number,
	xp: number,
	luckUsed: number,
}

local RollEngine = {}

--[[
	The 1-in-N a species is quoted at, at the given luck.
]]
function RollEngine.speciesChance(speciesId: number, luck: number): number
	local species = Species.byId[speciesId]
	if not species then
		return 0
	end
	return Rarity.tierChance(species.tierIndex, luck) * Species.shareOfTier(species)
end

function RollEngine.speciesRarity(speciesId: number, luck: number): number
	local chance = RollEngine.speciesChance(speciesId, luck)
	if chance <= 0 then
		return math.huge
	end
	return 1 / chance
end

--[[
	Chance of a single variant landing, given the variant luck multiplier
	(the shiny charm). Capped at 1 so absurd charm stacks stay well defined.
]]
function RollEngine.variantChance(variant: Config.Variant, variantLuck: number): number
	return math.min(1, variantLuck / variant.rarity)
end

--[[
	Combine a list of variant keys into the canonical storage key. Variants are
	emitted in Config order so "Alpha + Shiny" is always "AS", never "SA".
	An empty list is the normal (no-variant) form.
]]
function RollEngine.variantKey(variants: { string }): string
	if #variants == 0 then
		return ""
	end

	local ordered = {}
	for _, variant in Config.Variants do
		if table.find(variants, variant.key) then
			table.insert(ordered, variant.key)
		end
	end
	return table.concat(ordered)
end

function RollEngine.variantsFromKey(key: string): { string }
	local out = {}
	for _, variant in Config.Variants do
		if string.find(key, variant.key, 1, true) then
			table.insert(out, variant.key)
		end
	end
	return out
end

function RollEngine.variantByKey(key: string): Config.Variant?
	for _, variant in Config.Variants do
		if variant.key == key then
			return variant
		end
	end
	return nil
end

function RollEngine.variantValueMult(variantKey: string): number
	local mult = 1
	for _, key in RollEngine.variantsFromKey(variantKey) do
		local variant = RollEngine.variantByKey(key)
		if variant then
			mult *= variant.valueMult
		end
	end
	return mult
end

--[[
	The rarity multiplier the variant combination adds, e.g. a Shiny at 1 in 8192
	multiplies the species' 1-in-N by 8192.
]]
function RollEngine.variantRarityMult(variantKey: string): number
	local mult = 1
	for _, key in RollEngine.variantsFromKey(variantKey) do
		local variant = RollEngine.variantByKey(key)
		if variant then
			mult *= variant.rarity
		end
	end
	return mult
end

function RollEngine.variantDisplayName(variantKey: string): string
	if variantKey == "" then
		return ""
	end
	local names = {}
	for _, key in RollEngine.variantsFromKey(variantKey) do
		local variant = RollEngine.variantByKey(key)
		if variant then
			table.insert(names, variant.name)
		end
	end
	return table.concat(names, " ")
end

--[[
	Stage 1. `random` must return a float in [0, 1).
]]
function RollEngine.rollTier(random: () -> number, luck: number): Rarity.Tier
	for i = Rarity.count, 2, -1 do
		local tier = Rarity.tiers[i]
		if random() < math.min(1, luck / tier.rarity) then
			return tier
		end
	end
	return Rarity.tiers[1]
end

--[[
	Stage 2.
]]
function RollEngine.rollSpecies(random: () -> number, tierId: string): Species.Species
	local pool = Species.byTier[tierId]
	assert(pool and #pool > 0, `rarity tier "{tierId}" has no species`)

	local total = Species.tierWeight[tierId]
	local target = random() * total

	local cursor = 0
	for _, species in pool do
		cursor += species.weight
		if target < cursor then
			return species
		end
	end

	-- Floating point can leave `target` a hair past the final boundary.
	return pool[#pool]
end

function RollEngine.rollVariants(random: () -> number, variantLuck: number): { string }
	local landed = {}
	for _, variant in Config.Variants do
		if random() < RollEngine.variantChance(variant, variantLuck) then
			table.insert(landed, variant.key)
		end
	end
	return landed
end

--[[
	A full roll. Deterministic given `random`, which makes the balance simulator
	in tools/ reproducible.
]]
function RollEngine.roll(random: () -> number, options: RollOptions?): RollResult
	local opts = options or {}
	local luck = math.clamp(opts.luck or Config.Luck.Base, 0, Config.Luck.Max)
	local variantLuck = opts.variantLuck or 1
	local coinMult = opts.coinMult or 1
	local xpMult = opts.xpMult or 1

	local tier = RollEngine.rollTier(random, luck)
	local species = RollEngine.rollSpecies(random, tier.id)
	local variants = RollEngine.rollVariants(random, variantLuck)
	local variantKey = RollEngine.variantKey(variants)

	-- Quoted at 1x luck so the number a player sees is a property of the
	-- species, not of whatever potion happened to be active.
	local rarity = RollEngine.speciesRarity(species.id, Config.Luck.Base)
	local effectiveRarity = rarity * RollEngine.variantRarityMult(variantKey)
	local valueMult = RollEngine.variantValueMult(variantKey)

	local economy = Config.Economy
	local coins = math.floor((economy.CoinBase + rarity ^ economy.CoinExponent) * valueMult * coinMult)
	local xp = math.floor((economy.XpBase + rarity ^ economy.XpExponent) * xpMult)

	return {
		speciesId = species.id,
		name = species.name,
		tier = tier.id,
		tierIndex = tier.index,
		variants = variants,
		variantKey = variantKey,
		rarity = rarity,
		effectiveRarity = effectiveRarity,
		valueMult = valueMult,
		coins = math.max(1, coins),
		xp = math.max(1, xp),
		luckUsed = luck,
	}
end

--[[
	Score used to rank a roll against a player's personal best and on the global
	leaderboard. Log-scaled so it fits inside an OrderedDataStore's signed 64-bit
	integer even at Celestial-with-every-variant rarities.
]]
function RollEngine.score(effectiveRarity: number): number
	if effectiveRarity <= 1 then
		return 0
	end
	return math.floor(math.log10(effectiveRarity) * 1e6)
end

return RollEngine
