--!nonstrict
--[[
	Schema
	The shape of a saved profile, plus migration and sanitisation.

	Two rules govern everything in here:

	  * Every map that could be keyed by a number is keyed by a *string*
	    instead. DataStores round-trip through JSON, and JSON has no integer
	    keys -- a table with keys 1..n comes back as an array and a sparse one
	    comes back mangled. Species ids are therefore "25", not 25.

	  * Nothing loaded from a DataStore is trusted. `sanitise` runs on every
	    load and clamps anything out of range, because a profile written by an
	    older (or buggier) version of the game still has to boot today.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Species = require(Shared.Species)
local Upgrades = require(Shared.Upgrades)
local RollEngine = require(Shared.RollEngine)

local Schema = {}

Schema.CURRENT_VERSION = 1

function Schema.default(): { [string]: any }
	local now = os.time()
	return {
		version = Schema.CURRENT_VERSION,

		coins = 0,
		lifetimeCoins = 0,
		level = 1,
		xp = 0,
		prestige = 0,
		rolls = 0,

		-- inventory["25"]["S"] = 3  -> three shiny Pikachu
		inventory = {},
		-- index["25"] = true -> discovered, counts toward completion bonuses
		index = {},

		upgrades = {},
		-- Unused potions sitting in the bag.
		potions = {},
		-- Currently ticking buffs: { potionId = "luck2", expires = <unix time> }
		effects = {},

		buddy = nil,
		best = nil,

		settings = {
			autoRoll = false,
			cinematics = true,
			lowEffects = false,
			hideOthersAnnouncements = false,
		},

		daily = { lastClaim = 0, streak = 0 },
		redeemedCodes = {},

		createdAt = now,
		lastSeen = now,
		playtime = 0,
	}
end

--[[
	Bring an older save up to the current version. Each step mutates in place and
	falls through to the next, so a v1 profile loaded by a future v4 server walks
	1 -> 2 -> 3 -> 4 in one pass.
]]
function Schema.migrate(profile: { [string]: any })
	profile.version = profile.version or 0

	-- Example of the shape future migrations take:
	--
	-- if profile.version < 2 then
	--     profile.newField = computeFrom(profile)
	--     profile.version = 2
	-- end

	profile.version = Schema.CURRENT_VERSION
end

local function toPositiveInt(value: any, fallback: number): number
	if type(value) ~= "number" or value ~= value or value == math.huge then
		return fallback
	end
	return math.max(0, math.floor(value))
end

--[[
	Clamp and prune anything a load could have handed us. Unknown species ids,
	unknown upgrade ids and expired effects are dropped rather than repaired --
	content can be removed between versions and a stale key should not keep
	granting a bonus.
]]
function Schema.sanitise(profile: { [string]: any })
	local base = Schema.default()

	-- Underscore-prefixed keys are runtime-only and are stripped before saving.
	-- Clearing them on load as well covers profiles written by an older build
	-- that persisted a derived cache, which must never be trusted as current.
	for key in profile do
		if type(key) == "string" and string.sub(key, 1, 1) == "_" then
			profile[key] = nil
		end
	end

	for key, value in base do
		if profile[key] == nil then
			profile[key] = value
		end
	end

	profile.coins = toPositiveInt(profile.coins, 0)
	profile.lifetimeCoins = toPositiveInt(profile.lifetimeCoins, profile.coins)
	profile.xp = toPositiveInt(profile.xp, 0)
	profile.rolls = toPositiveInt(profile.rolls, 0)
	profile.playtime = toPositiveInt(profile.playtime, 0)
	profile.level = math.clamp(toPositiveInt(profile.level, 1), 1, Config.Economy.MaxLevel)
	profile.prestige = math.clamp(toPositiveInt(profile.prestige, 0), 0, Config.Prestige.MaxPrestige)

	-- Inventory: drop unknown species and unknown variant combinations.
	local inventory = {}
	if type(profile.inventory) == "table" then
		for speciesKey, variants in profile.inventory do
			local speciesId = tonumber(speciesKey)
			if speciesId and Species.byId[speciesId] and type(variants) == "table" then
				local cleaned = {}
				local any = false
				for variantKey, count in variants do
					if type(variantKey) == "string" and RollEngine.variantKey(RollEngine.variantsFromKey(variantKey)) == variantKey then
						local amount = toPositiveInt(count, 0)
						if amount > 0 then
							cleaned[variantKey] = amount
							any = true
						end
					end
				end
				if any then
					inventory[tostring(speciesId)] = cleaned
				end
			end
		end
	end
	profile.inventory = inventory

	local index = {}
	if type(profile.index) == "table" then
		for speciesKey, discovered in profile.index do
			local speciesId = tonumber(speciesKey)
			if speciesId and Species.byId[speciesId] and discovered then
				index[tostring(speciesId)] = true
			end
		end
	end
	profile.index = index

	local upgrades = {}
	if type(profile.upgrades) == "table" then
		for upgradeId, level in profile.upgrades do
			local upgrade = Upgrades.byId[upgradeId]
			if upgrade then
				local owned = math.clamp(toPositiveInt(level, 0), 0, upgrade.maxLevel)
				if owned > 0 then
					upgrades[upgradeId] = owned
				end
			end
		end
	end
	profile.upgrades = upgrades

	local potions = {}
	if type(profile.potions) == "table" then
		for potionId, count in profile.potions do
			if Upgrades.potionsById[potionId] then
				local amount = toPositiveInt(count, 0)
				if amount > 0 then
					potions[potionId] = amount
				end
			end
		end
	end
	profile.potions = potions

	-- Effects store an absolute expiry, so a potion keeps burning while the
	-- player is offline. Anything already expired is dropped on load.
	local now = os.time()
	local effects = {}
	if type(profile.effects) == "table" then
		for _, effect in profile.effects do
			if
				type(effect) == "table"
				and Upgrades.potionsById[effect.potionId]
				and type(effect.expires) == "number"
				and effect.expires > now
			then
				table.insert(effects, { potionId = effect.potionId, expires = effect.expires })
			end
		end
	end
	profile.effects = effects

	-- Buddy has to be something the player actually owns.
	if type(profile.buddy) == "table" then
		local speciesId = tonumber(profile.buddy.speciesId)
		local variantKey = profile.buddy.variantKey
		if type(variantKey) ~= "string" then
			variantKey = ""
		end
		local owned = speciesId and inventory[tostring(speciesId)]
		if owned and owned[variantKey] and owned[variantKey] > 0 then
			profile.buddy = { speciesId = speciesId, variantKey = variantKey }
		else
			profile.buddy = nil
		end
	else
		profile.buddy = nil
	end

	if type(profile.best) == "table" then
		local speciesId = tonumber(profile.best.speciesId)
		if speciesId and Species.byId[speciesId] then
			profile.best = {
				speciesId = speciesId,
				variantKey = type(profile.best.variantKey) == "string" and profile.best.variantKey or "",
				rarity = math.max(1, tonumber(profile.best.rarity) or 1),
				at = toPositiveInt(profile.best.at, now),
			}
		else
			profile.best = nil
		end
	else
		profile.best = nil
	end

	if type(profile.settings) ~= "table" then
		profile.settings = base.settings
	else
		for key, value in base.settings do
			if type(profile.settings[key]) ~= "boolean" then
				profile.settings[key] = value
			end
		end
	end

	if type(profile.daily) ~= "table" then
		profile.daily = base.daily
	else
		profile.daily.lastClaim = toPositiveInt(profile.daily.lastClaim, 0)
		profile.daily.streak = math.clamp(toPositiveInt(profile.daily.streak, 0), 0, Config.Daily.MaxStreak)
	end

	if type(profile.redeemedCodes) ~= "table" then
		profile.redeemedCodes = {}
	end

	profile.createdAt = toPositiveInt(profile.createdAt, now)
	profile.lastSeen = now

	return profile
end

return Schema
