--!nonstrict
--[[
	ShopService
	Spending coins: permanent upgrades, potions, bulk-selling duplicates,
	equipping a buddy, and prestige.

	Every handler re-derives the price from shared config rather than trusting
	anything in the request. The client sends an id and nothing else.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local Upgrades = require(Shared.Upgrades)
local Format = require(Shared.Format)
local RollEngine = require(Shared.RollEngine)

local InventoryService = require(script.Parent.InventoryService)
local LuckService = require(script.Parent.LuckService)
local RateLimit = require(script.Parent.Parent.Util.RateLimit)

local ShopService = {}

local ctx

function ShopService.init(dependencies)
	ctx = dependencies
end

local function guard(player: Player, action: string, rate: number): any?
	if not RateLimit.check(player, action, rate, rate * 2) then
		return nil
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return nil
	end
	if ctx.dataService.isReadOnly(player) then
		ctx.notify(player, "Your save could not be loaded, so purchases are disabled this session.", "error")
		return nil
	end

	return profile
end

function ShopService.buyUpgrade(player: Player, upgradeId: string)
	local profile = guard(player, "buy", 6)
	if not profile then
		return
	end

	local upgrade = Upgrades.byId[upgradeId]
	if not upgrade then
		return
	end

	local level = profile.upgrades[upgradeId] or 0
	local cost = Upgrades.costFor(upgradeId, level)
	if not cost then
		ctx.notify(player, `{upgrade.name} is already maxed.`, "error")
		return
	end

	if profile.coins < cost then
		ctx.notify(player, `You need {Format.comma(cost - profile.coins)} more coins.`, "error")
		return
	end

	profile.coins -= cost
	profile.upgrades[upgradeId] = level + 1
	ctx.dataService.markDirty(player)
	ctx.rollService.updateLeaderstats(player, profile)

	ctx.notify(player, `{upgrade.name} is now level {level + 1}.`, "success")
end

function ShopService.buyPotion(player: Player, potionId: string, useNow: boolean?)
	local profile = guard(player, "buy", 6)
	if not profile then
		return
	end

	local potion = Upgrades.potionsById[potionId]
	if not potion then
		return
	end

	if profile.coins < potion.cost then
		ctx.notify(player, `You need {Format.comma(potion.cost - profile.coins)} more coins.`, "error")
		return
	end

	profile.coins -= potion.cost
	profile.potions[potionId] = (profile.potions[potionId] or 0) + 1
	ctx.dataService.markDirty(player)

	if useNow then
		ShopService.usePotion(player, potionId)
	else
		ctx.notify(player, `Bought {potion.name}.`, "success")
	end
end

--[[
	Drinking a second potion of the same kind extends the timer rather than
	stacking the multiplier -- otherwise buying ten cheap potions would beat one
	expensive one.
]]
function ShopService.usePotion(player: Player, potionId: string)
	local profile = guard(player, "potion", 4)
	if not profile then
		return
	end

	local potion = Upgrades.potionsById[potionId]
	if not potion then
		return
	end

	local owned = profile.potions[potionId] or 0
	if owned <= 0 then
		ctx.notify(player, `You don't have a {potion.name}.`, "error")
		return
	end

	profile.potions[potionId] = owned - 1
	if profile.potions[potionId] <= 0 then
		profile.potions[potionId] = nil
	end

	LuckService.pruneEffects(profile)

	local now = os.time()
	local existing
	for _, effect in profile.effects do
		if effect.potionId == potionId then
			existing = effect
			break
		end
	end

	if existing then
		existing.expires = math.max(existing.expires, now) + potion.duration
	else
		table.insert(profile.effects, { potionId = potionId, expires = now + potion.duration })
	end

	ctx.dataService.markDirty(player)
	ctx.notify(player, `{potion.name} active for {Format.duration(potion.duration)}.`, "success")
end

--[[
	Bulk sell. `keep` is how many of each stack to hold on to.
]]
function ShopService.sellDuplicates(player: Player, keep: number, tierIds: { string }?)
	local profile = guard(player, "sell", 3)
	if not profile then
		return
	end

	if type(keep) ~= "number" or keep ~= keep then
		keep = 1
	end
	keep = math.clamp(math.floor(keep), 1, 99)

	local filter = nil
	if type(tierIds) == "table" and #tierIds > 0 then
		filter = {}
		for _, tierId in tierIds do
			if type(tierId) == "string" and Rarity.byId[tierId] then
				filter[tierId] = true
			end
		end
		if next(filter) == nil then
			filter = nil
		end
	end

	local earned, sold = InventoryService.sellDuplicates(profile, keep, filter)
	if sold <= 0 then
		ctx.notify(player, "Nothing to sell.", "info")
		return
	end

	profile.coins += earned
	profile.lifetimeCoins += earned
	ctx.dataService.markDirty(player)
	ctx.rollService.updateLeaderstats(player, profile)

	ctx.notify(player, `Sold {Format.comma(sold)} duplicates for {Format.comma(earned)} coins.`, "success")
end

function ShopService.equipBuddy(player: Player, speciesId: any, variantKey: any)
	local profile = guard(player, "equip", 4)
	if not profile then
		return
	end

	-- nil clears the buddy.
	if speciesId == nil then
		profile.buddy = nil
		ctx.dataService.markDirty(player)
		ctx.buddyService.refresh(player)
		return
	end

	if type(speciesId) ~= "number" or type(variantKey) ~= "string" then
		return
	end

	local species = Species.byId[speciesId]
	if not species then
		return
	end

	if InventoryService.countOf(profile, speciesId, variantKey) <= 0 then
		ctx.notify(player, "You don't own that one.", "error")
		return
	end

	profile.buddy = { speciesId = speciesId, variantKey = variantKey }
	ctx.dataService.markDirty(player)
	ctx.buddyService.refresh(player)

	local label = RollEngine.variantDisplayName(variantKey)
	label = label ~= "" and `{label} {species.name}` or species.name
	ctx.notify(player, `{label} is following you.`, "success")
end

function ShopService.prestige(player: Player)
	local profile = guard(player, "prestige", 1)
	if not profile then
		return
	end

	if profile.prestige >= Config.Prestige.MaxPrestige then
		ctx.notify(player, "You are at maximum prestige.", "error")
		return
	end

	if profile.level < Config.Prestige.RequiredLevel then
		ctx.notify(player, `Champion Rebirth needs trainer level {Config.Prestige.RequiredLevel}.`, "error")
		return
	end

	local bonuses = InventoryService.bonuses(profile)
	if bonuses.indexCount < Config.Prestige.RequiredIndexEntries then
		ctx.notify(
			player,
			`Champion Rebirth needs {Config.Prestige.RequiredIndexEntries} index entries (you have {bonuses.indexCount}).`,
			"error"
		)
		return
	end

	-- What is kept is the collection. What resets is progression: level, coins
	-- and the upgrades bought with them.
	profile.prestige += 1
	profile.level = 1
	profile.xp = 0
	profile.coins = 0
	profile.upgrades = {}
	profile.effects = {}
	profile.settings.autoRoll = false

	ctx.dataService.markDirty(player)
	ctx.rollService.updateLeaderstats(player, profile)

	ctx.notify(
		player,
		`Champion Rebirth {profile.prestige}! Permanent +{Format.percent(Config.Luck.PerPrestige * profile.prestige, 0)} luck.`,
		"success"
	)
end

--[[
	Display preferences live on the profile so they follow the player between
	devices. Only keys that already exist in the profile can be set, which keeps
	a client from inventing new fields to bloat the save with.
]]
function ShopService.setSetting(player: Player, key: string, value: boolean)
	if not RateLimit.check(player, "setting", 4, 8) then
		return
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end

	if key == "autoRoll" then
		-- Auto-roll has its own gated path; it must not be settable directly.
		return
	end

	if type(profile.settings[key]) ~= "boolean" then
		return
	end

	profile.settings[key] = value
	ctx.dataService.markDirty(player)
end

function ShopService.start()
	ctx.remotes.BuyUpgrade.OnServerEvent:Connect(function(player, upgradeId)
		if type(upgradeId) ~= "string" then
			return
		end
		ShopService.buyUpgrade(player, upgradeId)
	end)

	ctx.remotes.BuyPotion.OnServerEvent:Connect(function(player, potionId, action)
		if type(potionId) ~= "string" then
			return
		end
		if action == "use" then
			ShopService.usePotion(player, potionId)
		else
			ShopService.buyPotion(player, potionId, action == "buyuse")
		end
	end)

	ctx.remotes.SellDuplicates.OnServerEvent:Connect(function(player, keep, tierIds)
		ShopService.sellDuplicates(player, keep, tierIds)
	end)

	ctx.remotes.EquipBuddy.OnServerEvent:Connect(function(player, speciesId, variantKey)
		ShopService.equipBuddy(player, speciesId, variantKey)
	end)

	ctx.remotes.Prestige.OnServerEvent:Connect(function(player)
		ShopService.prestige(player)
	end)

	ctx.remotes.UpdateSetting.OnServerEvent:Connect(function(player, key, value)
		if type(key) ~= "string" or type(value) ~= "boolean" then
			return
		end
		ShopService.setSetting(player, key, value)
	end)

	ctx.remotes.PromptPurchase.OnServerEvent:Connect(function(player, kind, key)
		if type(kind) ~= "string" or type(key) ~= "string" then
			return
		end
		if not RateLimit.check(player, "prompt", 2, 4) then
			return
		end
		ctx.passService.prompt(player, kind, key)
	end)
end

return ShopService
