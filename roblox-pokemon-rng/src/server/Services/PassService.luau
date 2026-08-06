--!nonstrict
--[[
	PassService
	Game passes and developer products.

	Ownership is checked once per player per pass and then cached: the roll path
	reads it on every roll, and a web call per roll would be both slow and
	rate-limited. The cache is refreshed when a purchase completes in-game.

	Passes with an id of 0 are treated as unconfigured and quietly skipped, so a
	fresh clone of this project runs without a Creator Dashboard set up.
]]

local MarketplaceService = game:GetService("MarketplaceService")
local Players = game:GetService("Players")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Upgrades = require(Shared.Upgrades)

local Log = require(script.Parent.Parent.Util.Log)

local PassService = {}

-- owned[userId][passKey] = boolean
local owned: { [number]: { [string]: boolean } } = {}

local dataService
local notify

function PassService.init(deps)
	dataService = deps.dataService
	notify = deps.notify
end

local function passByKey(key: string)
	for _, pass in Config.Passes do
		if pass.key == key then
			return pass
		end
	end
	return nil
end

local function passById(id: number)
	for _, pass in Config.Passes do
		if pass.id == id and id ~= 0 then
			return pass
		end
	end
	return nil
end

local function refresh(player: Player, pass)
	if pass.id == 0 then
		return false
	end

	local ok, result = pcall(function()
		return MarketplaceService:UserOwnsGamePassAsync(player.UserId, pass.id)
	end)

	if not ok then
		Log.warn("Pass", "ownership check failed for %s / %s: %s", player.Name, pass.key, tostring(result))
		return false
	end
	return result == true
end

function PassService.loadFor(player: Player)
	local bucket = {}
	owned[player.UserId] = bucket

	for _, pass in Config.Passes do
		bucket[pass.key] = refresh(player, pass)
	end
end

function PassService.owns(player: Player, key: string): boolean
	local bucket = owned[player.UserId]
	if not bucket then
		return false
	end
	return bucket[key] == true
end

--[[
	Combined effect of every pass the player owns. Multiplicative across passes,
	which is the behaviour players expect when they buy two of them.
]]
function PassService.multipliers(player: Player)
	local result = {
		luckMult = 1,
		coinMult = 1,
		cooldownMult = 1,
		autoRoll = false,
	}

	local bucket = owned[player.UserId]
	if not bucket then
		return result
	end

	for _, pass in Config.Passes do
		if bucket[pass.key] then
			result.luckMult *= pass.luckMult or 1
			result.coinMult *= pass.coinMult or 1
			result.cooldownMult *= pass.cooldownMult or 1
			if pass.autoRoll then
				result.autoRoll = true
			end
		end
	end

	return result
end

--[[
	Client asked to buy something. The client never says what it is worth, only
	which key it wants, and the id comes from server config.
]]
function PassService.prompt(player: Player, kind: string, key: string)
	if kind == "pass" then
		local pass = passByKey(key)
		if not pass or pass.id == 0 then
			notify(player, "That pass is not available yet.", "error")
			return
		end
		MarketplaceService:PromptGamePassPurchase(player, pass.id)
	elseif kind == "product" then
		for _, product in Config.Products do
			if product.key == key then
				if product.id == 0 then
					notify(player, "That product is not available yet.", "error")
					return
				end
				MarketplaceService:PromptProductPurchase(player, product.id)
				return
			end
		end
		notify(player, "Unknown product.", "error")
	end
end

local function grantProduct(player: Player, product): boolean
	local profile = dataService.get(player)
	if not profile then
		return false
	end
	-- Refusing to grant onto a read-only profile is deliberate: the purchase is
	-- not consumed, so Roblox re-delivers the receipt on a later session where
	-- the grant can actually be saved.
	if dataService.isReadOnly(player) then
		return false
	end

	if product.coins then
		profile.coins += product.coins
		profile.lifetimeCoins += product.coins
	end

	if product.potion and Upgrades.potionsById[product.potion] then
		profile.potions[product.potion] = (profile.potions[product.potion] or 0) + 1
	end

	dataService.markDirty(player)
	notify(player, `Purchase delivered: {product.name}`, "success")
	return true
end

function PassService.start()
	Players.PlayerAdded:Connect(function(player)
		task.spawn(PassService.loadFor, player)
	end)

	for _, player in Players:GetPlayers() do
		task.spawn(PassService.loadFor, player)
	end

	Players.PlayerRemoving:Connect(function(player)
		owned[player.UserId] = nil
	end)

	MarketplaceService.PromptGamePassPurchaseFinished:Connect(function(player, gamePassId, wasPurchased)
		if not wasPurchased then
			return
		end
		local pass = passById(gamePassId)
		if not pass then
			return
		end

		local bucket = owned[player.UserId]
		if bucket then
			bucket[pass.key] = true
		end

		notify(player, `{pass.name} activated. Thanks!`, "success")
		if dataService.get(player) then
			dataService.markDirty(player)
		end
	end)

	MarketplaceService.ProcessReceipt = function(receipt)
		local player = Players:GetPlayerByUserId(receipt.PlayerId)
		if not player then
			-- Not in this server. Leave the receipt unconsumed so it is
			-- re-delivered wherever they are.
			return Enum.ProductPurchaseDecision.NotProcessedYet
		end

		for _, product in Config.Products do
			if product.id == receipt.ProductId and product.id ~= 0 then
				local granted = grantProduct(player, product)
				if granted then
					return Enum.ProductPurchaseDecision.PurchaseGranted
				end
				return Enum.ProductPurchaseDecision.NotProcessedYet
			end
		end

		Log.warn("Pass", "receipt for unknown product %d", receipt.ProductId)
		return Enum.ProductPurchaseDecision.NotProcessedYet
	end
end

return PassService
