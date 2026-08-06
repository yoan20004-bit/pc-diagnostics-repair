--!nonstrict
--[[
	Balance simulator.

	Runs the real RollEngine -- the same module the server uses -- over a large
	number of rolls and reports what actually comes out, so a change to the
	rarity ladder can be checked before it ships.

	Run it with:  python3 tools/run_simulation.py [rolls] [luck]

	That wrapper exists because the modules use Roblox-style
	`require(script.Parent.X)`, which the standalone Luau CLI does not
	understand. It rewrites those to path requires in a temp directory and runs
	this file against the copy. Nothing in src/ is modified.
]]

local Config = require("./Config")
local Rarity = require("./Rarity")
local Species = require("./Species")
local Format = require("./Format")
local RollEngine = require("./RollEngine")

local args = { ... }
local ROLLS = tonumber(args[1]) or 1000000
local LUCK = tonumber(args[2]) or 1

-- Deterministic, but from Luau's own PRNG rather than a hand-rolled one. The
-- distribution being measured here is the roll table's; a homemade generator
-- would put its own bias into every number below and there would be no way to
-- tell the two apart.
local SEED = tonumber(args[3]) or 20240607
math.randomseed(SEED)

local function nextRandom(): number
	return math.random()
end

local function pad(text: string, width: number): string
	local out = text
	while #out < width do
		out ..= " "
	end
	return out
end

local function padLeft(text: string, width: number): string
	local out = text
	while #out < width do
		out = " " .. out
	end
	return out
end

print(string.format("PokeRNG balance simulation -- %s rolls at %s luck", Format.comma(ROLLS), Format.multiplier(LUCK)))
print(string.rep("-", 78))

--------------------------------------------------------------------------------
-- Static checks: what the config claims, before any rolling happens
--------------------------------------------------------------------------------

print("\nTIER LADDER (theoretical, at this luck)")
print(pad("tier", 14) .. padLeft("configured", 16) .. padLeft("effective", 18) .. padLeft("share", 12))

local totalChance = 0
for i = #Rarity.tiers, 1, -1 do
	local tier = Rarity.tiers[i]
	local chance = Rarity.tierChance(i, LUCK)
	totalChance += chance

	print(
		pad(tier.name, 14)
			.. padLeft(i == 1 and "fallback" or Format.rarity(tier.rarity), 16)
			.. padLeft(chance > 0 and Format.rarity(1 / chance) or "impossible", 18)
			.. padLeft(Format.percent(chance, 4), 12)
	)
end

print(string.format("\ntier probabilities sum to %.10f (must be 1.0)", totalChance))
assert(math.abs(totalChance - 1) < 1e-9, "tier probabilities do not sum to 1")

--------------------------------------------------------------------------------
-- Roster sanity
--------------------------------------------------------------------------------

print(string.format("\nROSTER: %d species across %d tiers", Species.count, #Rarity.tiers))

local emptyTiers = {}
for _, tier in Rarity.tiers do
	local pool = Species.byTier[tier.id]
	if not pool or #pool == 0 then
		table.insert(emptyTiers, tier.id)
	end
end
assert(#emptyTiers == 0, "tiers with no species: " .. table.concat(emptyTiers, ", "))

-- The rarest species in a tier must never be more common than the most common
-- species in the tier below it, or the ladder reads as scrambled to players.
local previousRarest = 0
local orderingOk = true
for _, tier in Rarity.tiers do
	local pool = Species.byTier[tier.id]
	local best, worst = math.huge, 0
	for _, species in pool do
		local rarity = RollEngine.speciesRarity(species.id, 1)
		best = math.min(best, rarity)
		worst = math.max(worst, rarity)
	end

	local flag = ""
	if best < previousRarest then
		flag = "  <-- overlaps the tier below"
		orderingOk = false
	end
	previousRarest = worst

	print(
		string.format(
			"%s%s species, each %s .. %s%s",
			pad(tier.name, 14),
			padLeft(tostring(#pool), 4),
			Format.rarity(best),
			Format.rarity(worst),
			flag
		)
	)
end

--------------------------------------------------------------------------------
-- Empirical: actually roll
--------------------------------------------------------------------------------

local tierCounts = {}
local speciesCounts = {}
local variantCounts = {}
local totalCoins = 0
local totalXp = 0
local rarest = nil

for _ = 1, ROLLS do
	local result = RollEngine.roll(nextRandom, { luck = LUCK })

	tierCounts[result.tier] = (tierCounts[result.tier] or 0) + 1
	speciesCounts[result.speciesId] = (speciesCounts[result.speciesId] or 0) + 1
	if result.variantKey ~= "" then
		variantCounts[result.variantKey] = (variantCounts[result.variantKey] or 0) + 1
	end

	totalCoins += result.coins
	totalXp += result.xp

	if not rarest or result.effectiveRarity > rarest.effectiveRarity then
		rarest = result
	end
end

print("\nOBSERVED TIER DISTRIBUTION")
print(pad("tier", 14) .. padLeft("hits", 12) .. padLeft("observed", 18) .. padLeft("expected", 18))

for i = #Rarity.tiers, 1, -1 do
	local tier = Rarity.tiers[i]
	local hits = tierCounts[tier.id] or 0
	local observed = hits > 0 and Format.rarity(ROLLS / hits) or "none seen"
	local expected = Rarity.tierChance(i, LUCK)

	print(
		pad(tier.name, 14)
			.. padLeft(Format.comma(hits), 12)
			.. padLeft(observed, 18)
			.. padLeft(expected > 0 and Format.rarity(1 / expected) or "-", 18)
	)
end

print("\nVARIANTS")
if next(variantCounts) == nil then
	print("  none rolled")
else
	for _, variant in Config.Variants do
		local hits = 0
		for key, count in variantCounts do
			if string.find(key, variant.key, 1, true) then
				hits += count
			end
		end
		print(
			string.format(
				"  %s%s  observed %s  (configured %s)",
				pad(variant.name, 10),
				padLeft(Format.comma(hits), 10),
				hits > 0 and Format.rarity(ROLLS / hits) or "none seen",
				Format.rarity(variant.rarity)
			)
		)
	end
end

print("\nECONOMY")
print(string.format("  coins per roll (mean)  %s", Format.comma(math.floor(totalCoins / ROLLS))))
print(string.format("  xp per roll (mean)     %s", Format.comma(math.floor(totalXp / ROLLS))))
print(string.format("  total coins earned     %s", Format.abbreviate(totalCoins)))

if rarest then
	local variantName = RollEngine.variantDisplayName(rarest.variantKey)
	print(
		string.format(
			"\n  rarest roll seen:      %s%s (%s)",
			variantName ~= "" and (variantName .. " ") or "",
			rarest.name,
			Format.rarity(rarest.effectiveRarity)
		)
	)
end

local discovered = 0
for _ in speciesCounts do
	discovered += 1
end
print(string.format("  unique species seen:   %d / %d", discovered, Species.count))

--------------------------------------------------------------------------------
-- Assertions over the other pure shared modules, so a config edit that breaks
-- them is caught here rather than in a live server.
--------------------------------------------------------------------------------

local Upgrades = require("./Upgrades")

print("\nUPGRADE COSTS (total to max out)")
for _, upgrade in Upgrades.list do
	local total = 0
	for level = 0, upgrade.maxLevel - 1 do
		local cost = Upgrades.costFor(upgrade.id, level)
		assert(cost and cost > 0, `{upgrade.id} has no cost at level {level}`)
		total += cost
	end

	-- Buying past max must be refused, not priced.
	assert(Upgrades.costFor(upgrade.id, upgrade.maxLevel) == nil, `{upgrade.id} is purchasable past max`)

	print(
		string.format(
			"  %s max %s  %s coins total  (final effect %s)",
			pad(upgrade.name, 16),
			padLeft(tostring(upgrade.maxLevel), 3),
			padLeft(Format.abbreviate(total), 9),
			Format.percent(Upgrades.effectAt(upgrade.id, upgrade.maxLevel), 0)
		)
	)
end

-- Effects must be clamped at max level: a profile claiming level 999 of an
-- upgrade must not grant 999 levels of the bonus.
for _, upgrade in Upgrades.list do
	assert(
		Upgrades.effectAt(upgrade.id, upgrade.maxLevel + 500) == Upgrades.effectAt(upgrade.id, upgrade.maxLevel),
		`{upgrade.id} effect is not clamped at max level`
	)
end

assert(Format.comma(1234567) == "1,234,567", "Format.comma is wrong")
assert(Format.comma(-1234) == "-1,234", "Format.comma mishandles negatives")
assert(Format.comma(0) == "0", "Format.comma mishandles zero")
assert(Format.abbreviate(999) == "999", "Format.abbreviate should not abbreviate below 1000")
assert(Format.abbreviate(1500) == "1.5K", "Format.abbreviate is wrong")
assert(Format.rarity(math.huge) == "1 in ?", "Format.rarity mishandles infinity")
assert(Format.duration(0) == "0s", "Format.duration mishandles zero")
assert(Format.dex(25) == "#025", "Format.dex is wrong")

-- Variant keys must round-trip through their canonical form, since the save
-- schema validates stored keys by comparing against exactly this.
for _, variant in Config.Variants do
	local key = RollEngine.variantKey({ variant.key })
	assert(RollEngine.variantKey(RollEngine.variantsFromKey(key)) == key, `variant key {key} does not round-trip`)
end
local stacked = RollEngine.variantKey({ "S", "A" })
assert(stacked == RollEngine.variantKey({ "A", "S" }), "variant key ordering is not canonical")
assert(RollEngine.variantKey({}) == "", "empty variant list must produce an empty key")

print("\nshared module assertions passed")

print("\n" .. string.rep("-", 78))
if orderingOk then
	print("OK: tier probabilities sum to 1 and species rarities are monotonic across tiers.")
else
	print("WARNING: species rarity ranges overlap between tiers. Check the roster weights.")
end
