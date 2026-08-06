--!nonstrict
--[[
	InventoryService
	Owns the inventory and the index (this game's Pokedex), and derives the
	collection bonuses that feed into luck.

	Inventory is stored as counts, not instances: inventory["25"]["S"] = 3 means
	three shiny Pikachu. A player who rolls for a week would otherwise accumulate
	tens of thousands of individual entries, which is both a DataStore size
	problem and a replication problem.

	Collection bonuses are O(number of species) to compute, and luck is read on
	every single roll, so the result is cached on the profile and invalidated
	only when the index actually gains an entry.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local InventoryService = {}

function InventoryService.countOf(profile: any, speciesId: number, variantKey: string): number
	local entry = profile.inventory[tostring(speciesId)]
	if not entry then
		return 0
	end
	return entry[variantKey] or 0
end

function InventoryService.isDiscovered(profile: any, speciesId: number): boolean
	return profile.index[tostring(speciesId)] == true
end

--[[
	Add to the inventory. Returns whether this was a first-ever discovery of the
	species, and whether it was a first-ever discovery of that exact variant --
	the UI celebrates them differently.
]]
function InventoryService.add(profile: any, speciesId: number, variantKey: string, count: number?): (boolean, boolean)
	local amount = math.max(1, math.floor(count or 1))
	local key = tostring(speciesId)

	local entry = profile.inventory[key]
	if not entry then
		entry = {}
		profile.inventory[key] = entry
	end

	local newVariant = (entry[variantKey] or 0) == 0
	entry[variantKey] = (entry[variantKey] or 0) + amount

	local newSpecies = profile.index[key] ~= true
	if newSpecies then
		profile.index[key] = true
		-- The index gained an entry, so the collection bonuses moved.
		InventoryService.invalidate(profile)
	end

	return newSpecies, newVariant
end

--[[
	Remove `count` of a stack. Returns how many were actually removed, which is
	the caller's cue for how much to pay out. Never removes the buddy's stack out
	from under it -- the caller is expected to unequip first.
]]
function InventoryService.remove(profile: any, speciesId: number, variantKey: string, count: number): number
	local key = tostring(speciesId)
	local entry = profile.inventory[key]
	if not entry then
		return 0
	end

	local owned = entry[variantKey] or 0
	local removed = math.min(owned, math.max(0, math.floor(count)))
	if removed <= 0 then
		return 0
	end

	local remaining = owned - removed
	if remaining > 0 then
		entry[variantKey] = remaining
	else
		entry[variantKey] = nil
		if next(entry) == nil then
			profile.inventory[key] = nil
		end
	end

	-- The index deliberately keeps the entry: the Pokedex records what you have
	-- seen, and selling a duplicate should not cost you a permanent bonus.
	return removed
end

function InventoryService.invalidate(profile: any)
	profile._bonuses = nil
end

--[[
	Collection bonuses.

	  * indexCount   -- unique species registered
	  * tiersComplete -- rarity tiers where every species is registered
	  * typesMastered -- elemental types where every species is registered
]]
function InventoryService.bonuses(profile: any)
	local cached = profile._bonuses
	if cached then
		return cached
	end

	local index = profile.index

	local indexCount = 0
	for _ in index do
		indexCount += 1
	end

	local tiersComplete = 0
	local tierProgress = {}
	for _, tier in Rarity.tiers do
		local pool = Species.byTier[tier.id]
		local owned = 0
		if pool then
			for _, species in pool do
				if index[tostring(species.id)] then
					owned += 1
				end
			end
			tierProgress[tier.id] = { owned = owned, total = #pool }
			if owned == #pool then
				tiersComplete += 1
			end
		end
	end

	local typesMastered = 0
	local typeProgress = {}
	for _, typeName in Species.typeList do
		local pool = Species.byType[typeName]
		local owned = 0
		for _, species in pool do
			if index[tostring(species.id)] then
				owned += 1
			end
		end
		typeProgress[typeName] = { owned = owned, total = #pool }
		if owned == #pool then
			typesMastered += 1
		end
	end

	local result = {
		indexCount = indexCount,
		indexTotal = Species.count,
		tiersComplete = tiersComplete,
		typesMastered = typesMastered,
		tierProgress = tierProgress,
		typeProgress = typeProgress,
	}

	profile._bonuses = result
	return result
end

--[[
	The luck contributed purely by what the player has collected.
]]
function InventoryService.collectionLuck(profile: any): number
	local bonuses = InventoryService.bonuses(profile)
	return bonuses.indexCount * Config.Luck.PerIndexEntry
		+ bonuses.tiersComplete * Config.Luck.PerTierComplete
		+ bonuses.typesMastered * Config.Luck.PerTypeMastery
end

--[[
	What one copy of a species is worth when sold.
]]
function InventoryService.valueOf(speciesId: number, variantKey: string): number
	local rarity = RollEngine.speciesRarity(speciesId, Config.Luck.Base)
	if rarity == math.huge then
		return 0
	end

	local economy = Config.Economy
	local base = economy.CoinBase + rarity ^ economy.CoinExponent
	local value = base * RollEngine.variantValueMult(variantKey) * economy.SellRefund
	return math.max(1, math.floor(value))
end

--[[
	Bulk-sell duplicates, keeping `keep` copies of every stack. The buddy's stack
	is protected so a player can't accidentally sell the creature they have
	equipped.

	Returns the coins earned and how many creatures were sold.
]]
function InventoryService.sellDuplicates(profile: any, keep: number, tierFilter: { [string]: boolean }?): (number, number)
	local keepCount = math.max(1, math.floor(keep))
	local buddy = profile.buddy

	local earned = 0
	local sold = 0

	for speciesKey, variants in profile.inventory do
		local speciesId = tonumber(speciesKey)
		local species = speciesId and Species.byId[speciesId]
		if species and (tierFilter == nil or tierFilter[species.tier]) then
			for variantKey, count in variants do
				local protected = 0
				if buddy and buddy.speciesId == speciesId and buddy.variantKey == variantKey then
					protected = 1
				end

				local surplus = count - math.max(keepCount, protected)
				if surplus > 0 then
					local removed = InventoryService.remove(profile, speciesId, variantKey, surplus)
					earned += InventoryService.valueOf(speciesId, variantKey) * removed
					sold += removed
				end
			end
		end
	end

	return earned, sold
end

--[[
	A flat, client-friendly view of the inventory. The client needs species
	metadata anyway (it has the same shared modules), so this only carries what
	the server actually owns: what you have and how many.
]]
function InventoryService.snapshot(profile: any)
	local entries = {}
	for speciesKey, variants in profile.inventory do
		local speciesId = tonumber(speciesKey)
		if speciesId then
			for variantKey, count in variants do
				table.insert(entries, {
					speciesId = speciesId,
					variantKey = variantKey,
					count = count,
				})
			end
		end
	end
	return entries
end

return InventoryService
